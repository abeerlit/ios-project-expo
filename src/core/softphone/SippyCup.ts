import CallKeep from "react-native-callkeep";
import { SessionManager } from "./SessionManager.ts";
import { NativeIntegration } from "./NativeIntegration.ts";
import { SipConfig, CallInfo, CallState } from "./types.ts";
import { EventEmitter } from "events";
import { Platform } from "react-native";
import { Logger } from "shared/utils/Logger.ts";
import {
  mergeCalls,
  addParticipantToCall
} from "shared/api/call-actions/methods.ts";
import { USE_VOXO_MOBILE_APPROACH } from "../config/callApproach";
import { VoipBridge } from "./VoipBridge.ts";
import { getSipSession } from "./sipSessionRegistry.ts";
import { getAppDisplayName } from "shared/branding/appBrand.ts";
import { iosCallFlowError, iosCallFlowLog } from "./iosCallFlowLog.ts";
import { v4 as uuid } from "uuid";

const logger = new Logger("SippyCup: ");

/**
 * SippyCup is a high-level class that manages SIP sessions and provides a clean API
 * for making and receiving calls, handling call state, and managing media.
 *
 * It extends EventEmitter to provide an event-based architecture for call state changes.
 */
export class SippyCup extends EventEmitter {
  sessionManager: SessionManager;
  private nativeIntegration: NativeIntegration;
  private config: SipConfig;
  private isInitialized: boolean = false;
  private isRegistered: boolean = false;
  private readonly appName: string = getAppDisplayName();
  private isHoldOperationInProgress: boolean = false;
  private isMuteOperationInProgress: boolean = false;
  /** True after unregister — transport is torn down, next register must reset SessionManager first */
  private transportTornDown: boolean = false;
  /**
   * iOS CallKit Recents: two JS paths can start the same outbound (pending queue flush +
   * `didReceiveStartCallAction`). Coalesce concurrent work per CallKit UUID to one INVITE.
   */
  private callKitRecentsStartInFlight = new Map<string, Promise<string>>();

  /**
   * While set, ignore `onSendDTMF` from CallKit (programmatic `CallKeep.sendDTMF` echoes as
   * `didPerformDTMFAction`). Real SIP/WebRTC DTMF is sent only via `sessionManager.sendDTMF`.
   */
  private dtmfSuppressNativeSipUntil: number = 0;

  /** Called after SessionManager reset so SoftphoneProvider can re-attach its listeners */
  private onSessionManagerReset?: () => void;

  /**
   * iOS one-stack: when set, CallKit Recents outbound uses JsSIP instead of SessionManager.
   */
  private outboundJsSipHandler?: (
    destination: string,
    callUUID: string,
    displayNameFromCallKit?: string
  ) => Promise<string>;

  // Transfer state is now managed in SoftphoneProvider
  // SippyCup only handles SIP operations

  /**
   * Create a new SippyCup instance
   * @param config SIP configuration
   * @param appName Application name for native UI (default: tenant DISPLAY_NAME)
   * @param callbacks Optional callbacks, e.g. onSessionManagerReset to re-attach external listeners
   */
  constructor(
    config: SipConfig,
    appName?: string,
    callbacks?: { onSessionManagerReset?: () => void }
  ) {
    super();
    this.config = config;
    if (appName) {
      this.appName = appName;
    }
    this.onSessionManagerReset = callbacks?.onSessionManagerReset;

    // Use singleton instance to prevent duplicate SIP User Agents
    this.sessionManager = SessionManager.getInstance(this, config);
    this.nativeIntegration = new NativeIntegration({
      appName: this.appName
    });

    // Set up event handlers for native integration
    this.nativeIntegration.onAnswerCall = (callId) => {
      console.log(
        "🟢 [SippyCup] 📞 onAnswerCall called from NativeIntegration:",
        {
          callId,
          timestamp: new Date().toISOString()
        }
      );
      this.answerCall(callId).catch((error) => {
        console.error(
          "🟢 [SippyCup] 📞 ❌ Error answering call from native UI:",
          error
        );
      });
    };

    this.nativeIntegration.onEndCall = (callId) => {
      this.hangupCall(callId).catch((error) => {
        console.error("Error hanging up call from native UI:", error);
      });
    };

    this.nativeIntegration.onMuteCall = (callId) => {
      this.muteCall(callId).catch((error) => {
        console.error("Error muting call from native UI:", error);
      });
    };

    this.nativeIntegration.onUnmuteCall = (callId) => {
      this.unmuteCall(callId).catch((error) => {
        console.error("Error unmuting call from native UI:", error);
      });
    };

    this.nativeIntegration.onSendDTMF = (callId, digits) => {
      if (Date.now() < this.dtmfSuppressNativeSipUntil) {
        console.warn(
          "[DTMF-TRACE] 3b SippyCup onSendDTMF suppressed (programmatic echo)",
          {
            callId,
            digits,
            project: "ios-project"
          }
        );
        return;
      }
      console.warn("[DTMF-TRACE] 3b SippyCup onSendDTMF (native CallKit)", {
        callId,
        digits,
        project: "ios-project"
      });
      const sip = getSipSession(callId);
      if (sip) {
        for (const tone of digits) {
          sip.sendSipInfoDtmf(tone);
        }
        return;
      }
      this.sessionManager.sendDTMF(callId, digits).catch((error) => {
        console.error("Error sending DTMF from native UI:", error);
      });
    };
    // Note: Outgoing calls initiated from CallKit Recents are handled by SoftphoneProvider
    // (so we can ensure registration) and should call `makeCallFromCallKitStartAction`.

    this.attachInternalListeners();
  }

  /**
   * Outgoing call initiated by CallKit (Recents / Siri). CallKit already created the UUID,
   * so we must NOT call CallKeep.startCall() again. We only start SIP and report progress.
   */
  public async makeCallFromCallKitStartAction(
    destination: string,
    callUUID: string,
    displayNameFromCallKit?: string
  ): Promise<string> {
    const dest = String(destination || "").trim();
    const uuidStr = String(callUUID || "").trim().toLowerCase();
    if (!dest || !uuidStr) {
      throw new Error("Invalid destination or callUUID");
    }

    const existing = this.callKitRecentsStartInFlight.get(uuidStr);
    if (existing) {
      iosCallFlowLog("outbound", "makeCallFromCallKitStartAction coalesced (same uuid)", {
        callUUID: uuidStr
      });
      return existing;
    }

    const work = (async (): Promise<string> => {
      try {
        return await this.executeMakeCallFromCallKitStartAction(
          dest,
          uuidStr,
          displayNameFromCallKit
        );
      } finally {
        this.callKitRecentsStartInFlight.delete(uuidStr);
      }
    })();

    this.callKitRecentsStartInFlight.set(uuidStr, work);
    return await work;
  }

  private async executeMakeCallFromCallKitStartAction(
    dest: string,
    uuidStr: string,
    displayNameFromCallKit?: string
  ): Promise<string> {
    iosCallFlowLog("outbound", "makeCallFromCallKitStartAction entry", {
      destination: dest,
      callUUID: uuidStr,
      isRegistered: this.isRegistered,
      useJsSipHandler: !!(
        Platform.OS === "ios" &&
        USE_VOXO_MOBILE_APPROACH &&
        this.outboundJsSipHandler
      ),
      hasCallKitDisplayName: !!(
        displayNameFromCallKit && displayNameFromCallKit.trim()
      )
    });

    if (
      Platform.OS === "ios" &&
      USE_VOXO_MOBILE_APPROACH &&
      this.outboundJsSipHandler
    ) {
      return this.outboundJsSipHandler(
        dest,
        uuidStr,
        displayNameFromCallKit
      );
    }

    if (!this.isRegistered) {
      throw new Error("SippyCup must be registered before making calls");
    }

    await this.holdAllCalls();
    this.nativeIntegration.markIosOutboundCallKitUuid(uuidStr);
    CallKeep.reportConnectingOutgoingCallWithUUID(uuidStr);
    if (Platform.OS === "ios") {
      this.nativeIntegration.startIosCallKitOriginatedRingback();
    }

    const callId = await this.sessionManager.makeCall(dest, {
      callUuid: uuidStr,
      displayName:
        typeof displayNameFromCallKit === "string" &&
        displayNameFromCallKit.trim() !== ""
          ? displayNameFromCallKit.trim()
          : undefined,
      onManagedSessionReady: (sessionId) => {
        this.nativeIntegration.registerCallUuidAlias(uuidStr, sessionId);
      }
    });
    this.nativeIntegration.registerCallUuidAlias(uuidStr, callId);
    if (Platform.OS === "ios") {
      this.nativeIntegration.primeIosCallKitRecentsEndSnapshot(
        uuidStr,
        dest,
        displayNameFromCallKit?.trim()
      );
    }
    iosCallFlowLog("outbound", "makeCallFromCallKitStartAction started", {
      destination: dest,
      callUUID: uuidStr,
      callId
    });
    if (Platform.OS === "ios") {
      const ckName = displayNameFromCallKit?.trim();
      if (ckName) {
        this.nativeIntegration.reportLocalizedCallerNameForActiveCall(
          callId,
          ckName,
          dest
        );
      }
    }
    return callId;
  }

  public getNativeIntegration(): NativeIntegration {
    return this.nativeIntegration;
  }

  public setOutboundJsSipHandler(
    handler:
      | ((
          destination: string,
          callUUID: string,
          displayNameFromCallKit?: string
        ) => Promise<string>)
      | undefined
  ): void {
    this.outboundJsSipHandler = handler;
  }

  /** Wire CallKit "start call" to caller-owned handler (SoftphoneProvider). */
  public setNativeStartCallHandler(
    handler: (args: {
      callUUID: string;
      handle: string;
      name?: string;
    }) => void | Promise<void>
  ): void {
    this.nativeIntegration.attachStartCallHandler(handler);
  }

  /**
   * Re-attach internal listeners after removeAllListeners.
   * Called after SessionManager reset so we avoid duplicate listeners.
   */
  private attachInternalListeners(): void {
    this.on("incomingCall", (callId, callInfo) => {
      if (USE_VOXO_MOBILE_APPROACH) {
        console.warn(
          `📞 [SippyCup] incomingCall: USE_VOXO_MOBILE_APPROACH — skipping displayIncomingCall (SlimSip/PushKit owns CallKit) callId=${callId}`
        );
        return;
      }
      this.nativeIntegration
        .displayIncomingCall(callId, callInfo)
        .catch((error) => {
          console.error("Error displaying incoming call in native UI:", error);
        });
    });

    this.on("callStateChanged", (callId, state) => {
      console.warn(
        `📞 [SippyCup] ${new Date().toISOString()} callStateChanged: callId=${callId} state=${state} → forwarding to NativeIntegration`
      );
      this.nativeIntegration.updateCallState(callId, state).catch((error) => {
        console.error("Error updating call state in native UI:", error);
      });
    });

    this.on("callMuted", (callId) => {
      this.nativeIntegration.updateMuteState(callId, true).catch((error) => {
        console.error("Error updating mute state in native UI:", error);
      });
    });

    this.on("callUnmuted", (callId) => {
      this.nativeIntegration.updateMuteState(callId, false).catch((error) => {
        console.error("Error updating unmute state in native UI:", error);
      });
    });

    this.on("callSpeakerOn", (_callId) => {
      // Speaker enabled for call
    });

    this.on("callSpeakerOff", (_callId) => {
      // Speaker disabled for call
    });
  }

  /**
   * Remove all listeners, re-attach internal listeners, then notify external
   * listener (SoftphoneProvider) to re-attach. Prevents duplicate listeners.
   */
  private reattachListeners(): void {
    this.removeAllListeners();
    this.attachInternalListeners();
    this.onSessionManagerReset?.();
  }

  /**
   * Initialize the SIP stack and register with the SIP server
   * @returns Promise that resolves when initialization is complete
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // iOS JsSIP stack: SessionManager sip.js must not open a second WebSocket
      // (ForegroundSlimSipHub / per-call SlimSipClient own REGISTER).
      if (!(Platform.OS === "ios" && USE_VOXO_MOBILE_APPROACH)) {
        await this.sessionManager.initialize();
      }

      // Initialize the native integration
      await this.nativeIntegration.initialize();

      this.isInitialized = true;
      this.emit("initialized");
    } catch (error) {
      logger.error("Initialize Error:", error);
      this.emit("error", { type: "initialization", error });
      throw error;
    }
  }

  /**
   * Establish an inbound session for a specific call UUID
   * @param callUuid Unique Call UUID
   * @param callerIp IP address of the caller/server
   */
  public async establishInboundSession(
    callUuid: string,
    callerIp: string
  ): Promise<void> {
    try {
      await this.sessionManager.establishInboundSession(callUuid, callerIp);
    } catch (error) {
      this.emit("error", { type: "establishInboundSession", error });
      throw error;
    }
  }

  private isTransportDisconnectedError(error: unknown): boolean {
    const msg =
      error instanceof Error
        ? error.message
        : String(error ?? "").toLowerCase();
    return (
      msg.includes("not connected") ||
      msg.includes("503") ||
      msg.includes("transport error") ||
      msg.includes("transport") ||
      msg.includes("unhandled error") ||
      msg.includes("(undefined)") ||
      msg.includes("unspecified transport")
    );
  }

  /**
   * Ensure we are ready for an outgoing call: registered with a live transport.
   * Resets and reinitializes SessionManager when:
   * - We previously unregistered (transport torn down), or
   * - The singleton exists but UserAgent was disposed (e.g. SippyCup recreated after teardown).
   */
  private async ensureReadyForOutgoingCall(): Promise<void> {
    const needsReset =
      this.transportTornDown || !SessionManager.isInstanceUsable();

    if (needsReset) {
      logger.debug(
        "Transport torn down or SessionManager not usable, resetting before register"
      );
      await SessionManager.resetInstance();
      this.sessionManager = SessionManager.getInstance(this, this.config);
      await this.sessionManager.initialize();
      this.transportTornDown = false;
      this.reattachListeners();
    }
  }

  /**
   * Register with the SIP server
   * @returns Promise that resolves when registration is complete
   */
  public async register(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("SippyCup must be initialized before registering");
    }

    if (this.isRegistered) {
      return;
    }

    await this.ensureReadyForOutgoingCall();

    iosCallFlowLog("outbound", "registering SIP for outgoing", {});

    try {
      await this.sessionManager.register();
      this.isRegistered = true;
      iosCallFlowLog("outbound", "SIP registered for outgoing", {});
      this.emit("registered");
    } catch (error) {
      // After unregister or long background, the transport can be disconnected.
      // Reset SessionManager and retry with a fresh UserAgent once.
      if (this.isTransportDisconnectedError(error)) {
        logger.debug(
          "Registration failed due to disconnected transport, resetting SessionManager and retrying"
        );
        try {
          iosCallFlowLog(
            "outbound",
            "retrying register after transport reset",
            {}
          );
          await SessionManager.resetInstance();
          this.sessionManager = SessionManager.getInstance(this, this.config);
          await this.sessionManager.initialize();
          this.reattachListeners();
          await this.sessionManager.register();
          this.isRegistered = true;
          iosCallFlowLog("outbound", "SIP register retry succeeded", {});
          this.emit("registered");
          return;
        } catch (retryError) {
          iosCallFlowError("outbound", "SIP register retry failed", retryError);
          this.emit("error", { type: "registration", error: retryError });
          throw retryError;
        }
      }
      iosCallFlowError("outbound", "SIP register failed", error);
      this.emit("error", { type: "registration", error });
      throw error;
    }
  }

  /**
   * Unregister from the SIP server
   * @returns Promise that resolves when unregistration is complete
   */
  public async unregister(): Promise<void> {
    if (!this.isRegistered) {
      return;
    }

    try {
      await this.sessionManager.unregister();
      this.isRegistered = false;
      this.transportTornDown = true;
      this.emit("unregistered");
    } catch (error) {
      this.emit("error", { type: "unregistration", error });
      throw error;
    }
  }

  /**
   * Make an outgoing call
   * @param destination SIP URI or phone number to call
   * @param options Additional options for the call
   * @param skipHold Whether to skip holding all active calls (used for attended transfer)
   * @returns Promise that resolves with the call ID
   */
  public async makeCall(
    destination: string,
    options: any = {}
  ): Promise<string> {
    iosCallFlowLog("SippyCup.makeCall", "entry", {
      destination,
      isRegistered: this.isRegistered,
      hasCallUuid: !!options?.callUuid
    });

    if (
      Platform.OS === "ios" &&
      USE_VOXO_MOBILE_APPROACH
    ) {
      throw new Error(
        "iOS outbound must use placeOutboundJsSipCall (SoftphoneProvider), not SippyCup.makeCall"
      );
    }

    if (!this.isRegistered) {
      iosCallFlowLog("SippyCup.makeCall", "REJECT not registered", {
        destination
      });
      throw new Error("SippyCup must be registered before making calls");
    }

    try {
      await this.holdAllCalls();
      // Hold existing calls before making new outbound call

      const displayLabel =
        typeof options?.displayName === "string" && options.displayName.trim()
          ? options.displayName.trim()
          : undefined;

      const outboundCkUuid =
        typeof options?.callUuid === "string" && options.callUuid.trim()
          ? options.callUuid.trim()
          : uuid();

      const sessionOptions =
        Platform.OS === "ios"
          ? {
              ...options,
              callUuid: outboundCkUuid,
              prepareNativeOutboundUi: async (sessionId: string) => {
                await this.nativeIntegration.startOutgoingCall(
                  sessionId,
                  destination,
                  displayLabel,
                  outboundCkUuid
                );
              }
            }
          : { ...options, callUuid: outboundCkUuid };

      const callId = await this.sessionManager.makeCall(
        destination,
        sessionOptions
      );
      iosCallFlowLog("SippyCup.makeCall", "SessionManager.makeCall OK", {
        callId,
        destination
      });

      if (Platform.OS !== "ios") {
        await this.nativeIntegration.startOutgoingCall(
          callId,
          destination,
          displayLabel,
          outboundCkUuid
        );
      }
      iosCallFlowLog("SippyCup.makeCall", "native startOutgoingCall OK", {
        callId,
        destination,
        displayLabel: displayLabel ?? null
      });

      return callId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      iosCallFlowLog("SippyCup.makeCall", "FAILED", {
        destination,
        errorMessage: msg
      });
      this.emit("error", { type: "call", error });
      throw error;
    }
  }

  /**
   * Answer an incoming call
   * @param callId ID of the call to answer
   * @returns Promise that resolves when the call is answered
   */
  public async answerCall(callId: string): Promise<void> {
    console.log("🟢 [SippyCup] 📞 answerCall called:", {
      callId,
      timestamp: new Date().toISOString()
    });
    iosCallFlowLog("inbound", "accept button hit", { callId });
    try {
      const sip = getSipSession(callId);
      if (sip) {
        sip.answer();
        this.emit("callStateChanged", callId, CallState.CONNECTED);
        await this.nativeIntegration
          .updateCallState(callId, CallState.CONNECTED)
          .catch(() => {});
        iosCallFlowLog("inbound", "JsSIP answer sent (foreground/VoIP session)", {
          callId
        });
        return;
      }

      await this.sessionManager.answerCall(callId);
      console.log("🟢 [SippyCup] 📞 ✅ answerCall completed for:", callId);
      iosCallFlowLog("inbound", "answer request sent to SIP stack", { callId });
    } catch (error) {
      const errorMessage = `${(error as Error)?.message || error || ""}`;
      const isNoManagedSessionError =
        /No incoming call found|No managed session/i.test(errorMessage);
      const isIosUuidStyleId =
        Platform.OS === "ios" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          callId
        );

      if (isNoManagedSessionError && isIosUuidStyleId) {
        console.warn(
          `[END-ACCEPT-TRACE][ios-project][SippyCup][answerCall] sessionManagerFallbackToVoip callId=${callId} error=${errorMessage}`
        );
        VoipBridge.getInstance().handleCallAnswer(callId);
        return;
      }

      iosCallFlowError("inbound", "answerCall failed", error, { callId });
      this.emit("error", { type: "answer", error });
      console.error("🟢 [SippyCup] 📞 ❌ Error in answerCall:", error);
      throw error;
    }
  }

  /**
   * Answer an incoming call via CallKeep (recommended for foreground calls)
   * This triggers CallKeep's native answer flow, ensuring proper audio routing
   * and notification dismissal, especially on iOS.
   * @param callId ID of the call to answer
   * @returns Promise that resolves when CallKeep is notified
   */
  public async answerCallViaCallKeep(callId: string): Promise<void> {
    console.log("🟢 [SippyCup] 📞 answerCallViaCallKeep called:", {
      callId,
      timestamp: new Date().toISOString()
    });
    try {
      await this.nativeIntegration.answerCallViaCallKeep(callId);
      console.log("🟢 [SippyCup] 📞 ✅ CallKeep answer triggered for:", callId);
    } catch (error) {
      this.emit("error", { type: "answer", error });
      console.error(
        "🟢 [SippyCup] 📞 ❌ Error in answerCallViaCallKeep:",
        error
      );
      throw error;
    }
  }

  /**
   * Map an alternate CallKit UUID (e.g. PushKit) to the same logical call id
   * so native answer/end events resolve when JS and native used different UUIDs.
   */
  public registerCallKitUuidAlias(aliasUuid: string, callId: string): void {
    this.nativeIntegration.registerCallUuidAlias(aliasUuid, callId);
  }

  /**
   * Rebind existing CallKeep UUID mapping from one SIP call to another.
   * Helpful for attended transfer/conference merge on mobile VoIP legs.
   */
  public rebindNativeCallUUID(
    fromCallId: string,
    toCallId: string
  ): string | undefined {
    return this.nativeIntegration.rebindCallUUID(fromCallId, toCallId);
  }

  /**
   * iOS: refresh CallKit active call + AVAudioSession after merge/rebind (no-op on other platforms).
   */
  public ensureIosVoipAudioRouteForCall(sessionId: string): void {
    if (Platform.OS !== "ios") {
      return;
    }
    this.nativeIntegration.ensureVoipAudioRouteForCall(sessionId);
  }

  /**
   * iOS diagnostics: native CallKit UUID mapped to this SIP session id (if any).
   */
  public getIosCallKitUuidForSession(sessionId: string): string | undefined {
    if (Platform.OS !== "ios") {
      return undefined;
    }
    return this.nativeIntegration.getCallUUIDForCallId(sessionId);
  }

  /**
   * iOS: mirror SIP-resolved remote display name to CallKit so Phone → Recents shows the label.
   */
  public reportCallKitLocalizedName(
    sessionId: string,
    localizedCallerName: string,
    dialHint?: string
  ): void {
    if (Platform.OS !== "ios") {
      return;
    }
    this.nativeIntegration.reportLocalizedCallerNameForActiveCall(
      sessionId,
      localizedCallerName,
      dialHint
    );
  }

  /**
   * Decline an incoming call
   * @param callId ID of the call to decline
   * @returns Promise that resolves when the call is declined
   */
  public async declineCall(callId: string): Promise<void> {
    try {
      await this.sessionManager.declineCall(callId);
    } catch (error) {
      this.emit("error", { type: "decline", error });
      throw error;
    }
  }

  /**
   * Hang up a call
   * @param callId ID of the call to hang up
   * @returns Promise that resolves when the call is hung up
   */
  public async hangupCall(callId: string): Promise<void> {
    const sip = getSipSession(callId);
    if (sip) {
      sip.sipTerminate();
      this.emit("callEnded", callId, "hangup");
      return;
    }
    try {
      await this.sessionManager.hangupCall(callId);
    } catch (error) {
      this.emit("error", { type: "hangup", error });
      throw error;
    }
  }

  /**
   * Hold a call
   * @param callId ID of the call to hold
   * @returns Promise that resolves when the call is held
   */
  public async holdCall(callId: string): Promise<void> {
    const sip = getSipSession(callId);
    if (sip) {
      sip.sipHold();
      this.emit("callHeld", callId);
      return;
    }
    try {
      await this.sessionManager.holdCall(callId);
    } catch (error) {
      this.emit("error", { type: "hold", error });
      throw error;
    }
  }

  /**
   * Unhold a call
   * @param callId ID of the call to unhold
   * @returns Promise that resolves when the call is unheld
   */
  public async unholdCall(callId: string): Promise<void> {
    const sip = getSipSession(callId);
    if (sip) {
      sip.sipUnhold();
      this.emit("callUnheld", callId);
      return;
    }
    try {
      await this.sessionManager.unholdCall(callId);
    } catch (error) {
      this.emit("error", { type: "unhold", error });
      throw error;
    }
  }

  /**
   * Mute a call
   * @param callId ID of the call to mute
   * @returns Promise that resolves when the call is muted
   */
  public async muteCall(callId: string): Promise<void> {
    // Prevent concurrent mute operations
    if (this.isMuteOperationInProgress) {
      console.warn("Mute operation already in progress, ignoring request");
      return;
    }

    try {
      this.isMuteOperationInProgress = true;
      const sip = getSipSession(callId);
      if (sip) {
        if (sip.muted) {
          return;
        }
        sip.webRTCmute();
        this.emit("callMuted", callId);
        return;
      }
      await this.sessionManager.muteCall(callId);
    } catch (error) {
      this.emit("error", { type: "mute", error });
      throw error;
    } finally {
      this.isMuteOperationInProgress = false;
    }
  }

  /**
   * Unmute a call
   * @param callId ID of the call to unmute
   * @returns Promise that resolves when the call is unmuted
   */
  public async unmuteCall(callId: string): Promise<void> {
    // Prevent concurrent mute operations
    if (this.isMuteOperationInProgress) {
      console.warn("Mute operation already in progress, ignoring request");
      return;
    }

    try {
      this.isMuteOperationInProgress = true;
      const sip = getSipSession(callId);
      if (sip) {
        if (!sip.muted) {
          return;
        }
        sip.webRTCunmute();
        this.emit("callUnmuted", callId);
        return;
      }
      await this.sessionManager.unmuteCall(callId);
    } catch (error) {
      this.emit("error", { type: "unmute", error });
      throw error;
    } finally {
      this.isMuteOperationInProgress = false;
    }
  }

  /**
   * Set speakerphone on/off for a call
   * @param callId ID of the call to control a speaker for
   * @param enabled Whether to enable speakerphone
   * @returns Promise that resolves when the speaker state is set
   */
  public async setSpeaker(callId: string, enabled: boolean): Promise<void> {
    try {
      await this.sessionManager.setSpeaker(callId, enabled);
    } catch (error) {
      this.emit("error", { type: "speaker", error });
      throw error;
    }
  }

  /**
   * Perform blind transfer
   * @param sessionId ID of the session to transfer
   * @param number Phone number to transfer to
   */
  public async transfer(sessionId: string, number: string): Promise<void> {
    const session = this.findSession(sessionId);

    if (!session) {
      throw new Error("Session not found");
    }

    const uri = `sip:${number}@dev-sip.voxo.co`;

    try {
      await this.sessionManager.transfer(session, uri);
      await this.hangupCall(sessionId);
    } catch (error) {
      logger.error("Transfer failed:", error);
      this.emit("error", {
        type: "transfer",
        error,
        message: "There was an error transferring your call."
      });
      throw error;
    }
  }

  // This will start the 3-way conference call
  public async attendedTransferMergeNew(
    callId: string,
    mergeCallId: string,
    accessToken: string
  ): Promise<{ conferenceId: string } | void> {
    try {
      logger.debug("attendedTransferMergeNew: calling backend merge API", {
        callId,
        mergeCallId,
        hasAccessToken: !!accessToken
      });
      console.warn(
        "[IOS-MERGE-IDS] mergeCalls request — first merge (2 legs → conference)",
        JSON.stringify({
          step: "attendedTransferMergeNew",
          api: "mergeCalls",
          callId,
          mergeCallId,
          meaning:
            "Two backend call ids merged; callId is one leg, mergeCallId is the other (active vs held)"
        })
      );
      const { conferenceId } = await mergeCalls(
        accessToken,
        callId,
        mergeCallId
      );
      logger.debug("attendedTransferMergeNew: backend merge API success", {
        callId,
        mergeCallId,
        conferenceId
      });
      console.warn(
        "[IOS-MERGE-IDS] mergeCalls OK — filter Metro/Xcode by IOS-MERGE-IDS",
        JSON.stringify({
          step: "attendedTransferMergeNew",
          api: "mergeCalls",
          callId,
          mergeCallId,
          conferenceIdReturned: conferenceId,
          meaning:
            "Backend joins two live channel IDs; conferenceId is the conference session id"
        })
      );

      return { conferenceId };
    } catch (error) {
      console.error(`Error starting merge:`, error);

      // Emit error event for context to handle
      this.emit("error", {
        type: "attendedTransferMerge",
        error,
        message: "There was an error starting your conference call."
      });

      throw error;
    }
  }

  public async addParticipantToConference(
    conferenceId: string,
    mergeCallId: string,
    accessToken: string
  ): Promise<void> {
    try {
      logger.debug("addParticipantToConference: calling backend add API", {
        conferenceId,
        mergeCallId,
        hasAccessToken: !!accessToken
      });
      console.warn(
        "[IOS-MERGE-IDS] addParticipantToCall request — filter Metro/Xcode by IOS-MERGE-IDS",
        JSON.stringify({
          step: "addParticipantToConference",
          api: "addParticipantToCall",
          conferenceId,
          mergeCallId,
          meaning:
            "Existing conference; mergeCallId is the new leg’s backend/live channel id to pull in"
        })
      );
      await addParticipantToCall(accessToken, conferenceId, mergeCallId);
      logger.debug("addParticipantToConference: backend add API success", {
        conferenceId,
        mergeCallId
      });
      console.warn(
        "[IOS-MERGE-IDS] addParticipantToCall success",
        JSON.stringify({ conferenceId, mergeCallId })
      );
    } catch (error) {
      console.error(`Error adding participant to conference call:`, error);

      // Emit error event for context to handle
      this.emit("error", {
        type: "addParticipantToConference",
        error,
        message:
          "There was an error adding a participant to the conference call."
      });

      throw error;
    }
  }

  // -- sessionId: sessionId of the current call
  public async completeAttendedTransfer(
    originalCallId: string,
    transferCallId: string,
    options?: { terminateLocalLegs?: boolean }
  ): Promise<void> {
    try {
      const originalSession = this.findSession(originalCallId);
      const transferSession = this.findSession(transferCallId);

      if (!originalSession || !transferSession) {
        throw new Error("Session not found for attended transfer");
      }

      // Perform the SIP transfer
      await this.sessionManager.transfer(originalSession, transferSession);

      const terminateLocalLegs = options?.terminateLocalLegs ?? true;
      if (terminateLocalLegs) {
        // Transfer completion (handoff): terminate local legs once REFER succeeds.
        await this.sessionManager.hangupCall(originalCallId);
        await this.sessionManager.hangupCall(transferCallId);
      }

      // Emit completion event for context to handle (optional)
      this.emit("attendedTransferCompleted", {
        originalCallId,
        transferCallId,
        terminateLocalLegs
      });

      logger.debug(
        "Attended transfer completed successfully - all calls ended"
      );
    } catch (error) {
      logger.error("Failed to complete attended transfer:", error);

      this.emit("error", {
        type: "attendedTransferComplete",
        error,
        message: "There was an error completing the attended transfer."
      });

      throw error;
    }
  }

  /**
   * Cancel attended transfer
   * @param originalCallId Original call ID
   * @param transferCallId Transfer call ID to cancel
   */
  public async cancelAttendedTransfer(
    originalCallId: string,
    transferCallId: string
  ): Promise<void> {
    try {
      // Hang up the child call
      await this.hangupCall(transferCallId);

      // Unhold the parent call
      await this.unholdCall(originalCallId);

      // Attended transfer cancelled successfully
    } catch (error) {
      logger.error("Failed to cancel attended transfer:", error);
      this.emit("error", {
        type: "attendedTransferCancel",
        error,
        message: "There was an error cancelling the attended transfer."
      });
      throw error;
    }
  }

  /**
   * Send DTMF tones (0-9, *, #, A-D).
   * Local tone: CallKit (`CallKeep.sendDTMF`) when a native UUID exists. Far-end: always
   * `sessionManager` (WebRTC / SIP INFO). Suppresses duplicate `onSendDTMF` from programmatic
   * CallKeep. Native-only keypad: `didPerformDTMFAction` → onSendDTMF → sessionManager only.
   */
  public async sendDTMF(callId: string, tones: string): Promise<void> {
    const toSend = Array.from(tones)
      .filter((c) => /[0-9*#ABCD]/i.test(c))
      .map((c) => (/[abcd]/i.test(c) ? c.toUpperCase() : c))
      .join("");

    console.warn("[DTMF-TRACE] 3 SippyCup.sendDTMF enter", {
      callId,
      tones,
      toSend,
      activeCalls: this.getActiveCalls(),
      project: "ios-project"
    });

    if (!toSend) {
      return;
    }

    const callUUID = this.nativeIntegration.getCallUUIDForCallId(callId);
    const digitDelayMs = 120;
    const postSipSuppressMs = 500;

    if (callUUID) {
      this.dtmfSuppressNativeSipUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
    }

    try {
      if (callUUID) {
        for (const char of toSend) {
          try {
            CallKeep.sendDTMF(callUUID, char);
          } catch (e) {
            console.warn("[DTMF-TRACE] 3 SippyCup CallKeep.sendDTMF failed", {
              callId,
              callUUID,
              char,
              e,
              project: "ios-project"
            });
          }
          await new Promise((r) => setTimeout(r, digitDelayMs));
        }
      }

      const sip = getSipSession(callId);
      if (sip) {
        for (const char of toSend) {
          sip.sendSipInfoDtmf(char);
        }
      } else {
        await this.sessionManager.sendDTMF(callId, toSend);
      }
    } catch (error) {
      console.error("[DTMF-TRACE] 3 SippyCup.sendDTMF error", {
        callId,
        toSend,
        error,
        project: "ios-project"
      });
      this.emit("error", { type: "dtmf", error });
      throw error;
    } finally {
      if (callUUID) {
        this.dtmfSuppressNativeSipUntil = Date.now() + postSipSuppressMs;
      }
    }
  }

  /**
   * Get the active calls
   * @returns Array of active call IDs
   */
  public getActiveCalls(): string[] {
    return this.sessionManager.getActiveCalls();
  }

  /**
   * Get the call state
   * @param callId ID of the call to get the state for
   * @returns Call state
   */
  public getCallState(callId: string): any {
    return this.sessionManager.getCallState(callId);
  }

  /**
   * Hold all active calls with mutex protection
   * @returns Promise that resolves with an array of call IDs that were successfully held
   */
  public async holdAllCalls(): Promise<string[]> {
    // Prevent concurrent hold operations
    if (this.isHoldOperationInProgress) {
      console.warn(
        "Hold operation already in progress, skipping concurrent request"
      );
      return [];
    }

    try {
      this.isHoldOperationInProgress = true;

      const heldCallIds = await this.sessionManager.holdAllCalls();

      // Emit events for each held call
      for (const callId of heldCallIds) {
        this.emit("callHeld", callId);
      }

      return heldCallIds;
    } catch (error) {
      this.emit("error", { type: "holdAllCalls", error });
      throw error;
    } finally {
      this.isHoldOperationInProgress = false;
    }
  }

  /**
   * Get current transfer state - now managed in SoftphoneProvider
   * This method is deprecated
   */
  public getTransferState() {
    console.warn(
      "getTransferState is deprecated - transfer state is now managed in SoftphoneProvider"
    );
    return {
      isTransferring: false,
      parentCallId: null,
      childCallId: null,
      activeCallId: null
    };
  }

  /**
   * Display an incoming call in the native UI
   * @param callId ID of the call
   * @param callInfo Call information
   * @returns Promise that resolves when the call is displayed
   */
  public async displayIncomingCall(
    callId: string,
    callInfo: CallInfo
  ): Promise<void> {
    try {
      await this.nativeIntegration.displayIncomingCall(callId, callInfo);
    } catch (error) {
      this.emit("error", { type: "displayCall", error });
      throw error;
    }
  }

  /**
   * Clean up and dispose of resources.
   * Resets SessionManager singleton so the next SippyCup gets a fresh instance
   * (avoids "Unhandled error" when making calls after teardown).
   */
  public dispose(): void {
    this.removeAllListeners();
    void SessionManager.resetInstance().catch(() => {});
  }

  /**
   * Find session by ID
   * @param sessionId Session ID to find
   * @returns Session or undefined if not found
   */
  private findSession(sessionId: string): any {
    const callState = this.sessionManager.getCallState(sessionId);
    if (!callState) {
      return undefined;
    }

    // Return the managed session to access the underlying session
    const managedSessions = (this.sessionManager as any).managedSessions;
    const managedSession = managedSessions.get(sessionId);
    return managedSession ? managedSession.getUnderlyingSession() : undefined;
  }
}
