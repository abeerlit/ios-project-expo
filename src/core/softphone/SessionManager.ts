import { EventEmitter } from "events";
import {
  SessionState,
  Inviter,
  Registerer,
  RegistererState,
  RegistererOptions,
  UserAgent,
  UserAgentOptions,
  InvitationAcceptOptions,
  Invitation,
  SessionInviteOptions,
  URI,
  InviterInviteOptions,
  Session,
  SessionReferOptions,
  Grammar
} from "sip.js";
import {
  mediaDevices,
  MediaStream,
  RTCRtpSender
} from "@daily-co/react-native-webrtc";
import InCallManager from "react-native-incall-manager";
import {
  SipConfig,
  CallState,
  CallDirection,
  CallInfo,
  CallOptions
} from "./types";
import RTCTrackEvent from "@daily-co/react-native-webrtc/lib/typescript/RTCTrackEvent";
import { ManagedSession } from "./ManagedSession";
import { USE_VOXO_MOBILE_APPROACH } from "../config/callApproach";
import { iosCallFlowError, iosCallFlowLog } from "./iosCallFlowLog.ts";

/** Minimal shape for parsing P-Asserted-Identity / Remote-Party-ID from SIP responses. */
type SipLikeResponse = {
  hasHeader?: (name: string) => boolean;
  getHeader?: (name: string) => string | undefined;
  getHeaders?: (name: string) => string[];
};

function tryParseNameAddrDisplay(
  raw: string
): { displayName?: string; uri?: string } | undefined {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Grammar.nameAddrHeaderParse(trimmed);
  if (!parsed) {
    return undefined;
  }
  const friendly =
    typeof (parsed as { friendlyName?: string }).friendlyName === "string"
      ? String((parsed as { friendlyName?: string }).friendlyName).trim()
      : "";
  if (friendly) {
    return { displayName: friendly, uri: parsed.uri?.toString?.() };
  }
  const uriStr = parsed.uri?.toString?.();
  if (uriStr) {
    return { displayName: uriStr, uri: uriStr };
  }
  return undefined;
}

function parseDisplayFromSipResponseMessage(
  msg: SipLikeResponse
): { displayName: string; uri?: string } | undefined {
  const trySingle = (headerName: string) => {
    if (!msg.hasHeader?.(headerName)) {
      return undefined;
    }
    const raw = msg.getHeader?.(headerName);
    if (!raw) {
      return undefined;
    }
    return tryParseNameAddrDisplay(raw);
  };
  const pai = trySingle("P-Asserted-Identity");
  if (pai?.displayName) {
    return { displayName: pai.displayName, uri: pai.uri };
  }
  const rpiSingle = trySingle("Remote-Party-ID");
  if (rpiSingle?.displayName) {
    return { displayName: rpiSingle.displayName, uri: rpiSingle.uri };
  }
  if (msg.hasHeader?.("Remote-Party-ID") && msg.getHeaders) {
    for (const line of msg.getHeaders("Remote-Party-ID")) {
      const p = tryParseNameAddrDisplay(line);
      if (p?.displayName) {
        return { displayName: p.displayName, uri: p.uri };
      }
    }
  }
  return undefined;
}

/**
 * SessionManager interfaces with the SIP.js library to manage SIP sessions
 * Singleton pattern ensures only one SIP User Agent exists across app lifecycle
 */
export class SessionManager {
  private static instance: SessionManager | null = null;

  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private config: SipConfig;
  private eventEmitter: EventEmitter;
  private managedSessions: Map<string, ManagedSession> = new Map();
  private localStream: MediaStream | null = null;
  private wakeUpUAs: Set<UserAgent> = new Set();
  private terminalEventsEmitted: Set<string> = new Set();

  // Removed transfer state - handled by SippyCup now

  /**
   * Get singleton instance of SessionManager
   * @param eventEmitter EventEmitter to emit events to
   * @param config SIP configuration
   * @returns SessionManager singleton instance
   */
  public static getInstance(
    eventEmitter: EventEmitter,
    config: SipConfig
  ): SessionManager {
    if (!SessionManager.instance) {
      console.log("📱 [SessionManager] Creating new singleton instance");
      SessionManager.instance = new SessionManager(eventEmitter, config);
    } else {
      console.log(
        "📱 [SessionManager] Reusing existing singleton instance, updating eventEmitter"
      );
      // Update eventEmitter to route events to current SippyCup instance
      SessionManager.instance.eventEmitter = eventEmitter;
      // Update config if it has changed (e.g., user credentials updated)
      SessionManager.instance.config = config;
    }
    return SessionManager.instance;
  }

  /**
   * Reset singleton instance (for logout or testing)
   * This will dispose of the current instance and allow a new one to be created
   */
  public static async resetInstance(): Promise<void> {
    if (SessionManager.instance) {
      console.log("📱 [SessionManager] Resetting singleton instance");
      await SessionManager.instance.dispose();
      SessionManager.instance = null;
    }
  }

  /**
   * Returns true if the singleton instance exists and has a usable UserAgent
   * (transport connected). Used to detect a torn-down instance that needs reset.
   */
  public static isInstanceUsable(): boolean {
    return !!SessionManager.instance?.userAgent;
  }

  /**
   * Create a new SessionManager (private constructor for singleton pattern)
   * @param eventEmitter EventEmitter to emit events to
   * @param config SIP configuration
   */
  private constructor(eventEmitter: EventEmitter, config: SipConfig) {
    this.eventEmitter = eventEmitter;
    this.config = config;
  }

  private resetTerminalEmissionGuard(callId: string): void {
    this.terminalEventsEmitted.delete(callId);
  }

  private emitTerminalCallEventsOnce(
    callId: string,
    reason: string,
    source: string
  ): void {
    if (this.terminalEventsEmitted.has(callId)) {
      console.log(
        `📞 [SM] ${new Date().toISOString()} skipping duplicate terminal emit for ${callId} from ${source}`
      );
      return;
    }

    this.terminalEventsEmitted.add(callId);
    if (this.terminalEventsEmitted.size > 500) {
      this.terminalEventsEmitted.clear();
    }

    // callStateChanged(ENDED) is emitted once by ManagedSession.setCallState — avoid duplicating here.
    this.eventEmitter.emit("callEnded", callId, reason);
  }

  /**
   * Initialize the SIP stack
   */
  public async initialize(): Promise<void> {
    try {
      // Create the SIP user agent
      const userAgentOptions: UserAgentOptions = {
        uri: new URI("sip", this.config.user, this.config.domain),
        authorizationUsername: this.config.user,
        authorizationPassword: this.config.password,
        transportOptions: {
          server: this.config.uri
        },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: this.config.iceServers || [
              { urls: "stun:stun.l.google.com:19302" }
            ]
          }
        },
        displayName: this.config.displayName
      };

      this.userAgent = new UserAgent(userAgentOptions);

      // Set up user agent event listeners
      this.userAgent.delegate = {
        onInvite: (invitation: Invitation) => {
          this.handleIncomingCall(invitation);
        }
      };

      // Connect the user agent
      await this.userAgent.start();
    } catch (error) {
      console.error("Error initializing SIP user agent:", error);
      throw error;
    }
  }

  /**
   * Register with the SIP server
   */
  public async register(): Promise<void> {
    if (!this.userAgent) {
      throw new Error("User agent not initialized");
    }

    try {
      // Create the registerer
      const registererOptions: RegistererOptions = {
        expires: this.config.registrationExpiration || 600
      };

      this.registerer = new Registerer(this.userAgent, registererOptions);

      // Set up registerer event listeners
      this.registerer.stateChange.addListener((state: RegistererState) => {
        switch (state) {
          case RegistererState.Registered:
            this.eventEmitter.emit("registered");
            break;
          case RegistererState.Unregistered:
            this.eventEmitter.emit("unregistered");
            break;
          case RegistererState.Terminated:
            // Handle terminated state
            break;
        }
      });

      // Register
      await this.registerer.register();
    } catch (error) {
      console.error("Error registering with SIP server:", error);
      throw error;
    }
  }

  /**
   * Unregister from the SIP server
   */
  public async unregister(): Promise<void> {
    if (!this.registerer) {
      return;
    }

    try {
      await this.registerer.unregister();
    } catch (error) {
      console.error("Error unregistering from SIP server:", error);
      throw error;
    }
  }

  /**
   * Make an outgoing call
   * @param destination SIP URI or phone number to call
   * @param options Additional options for the call
   * @returns Promise that resolves with the call ID
   */
  public async makeCall(
    destination: string,
    options: CallOptions = {}
  ): Promise<string> {
    iosCallFlowLog("SessionManager.makeCall", "start INVITE flow", {
      destination,
      hasUserAgent: !!this.userAgent,
      managedSessionCount: this.managedSessions?.size ?? 0
    });
    if (!this.userAgent) {
      iosCallFlowLog("SessionManager.makeCall", "FAIL no UserAgent", {
        destination
      });
      throw new Error("User agent not initialized");
    }

    try {
      // Get local media stream
      const stream = await this.getLocalStream();
      this.localStream = stream;

      // Format the destination URI
      let targetUri: URI;
      if (destination.includes("@")) {
        // Parse full SIP URI
        const parts = destination.split("@");
        targetUri = new URI("sip", parts[0], parts[1]);
      } else {
        // Create SIP URI from phone number
        targetUri = new URI("sip", destination, this.config.domain);
      }

      // Create the session options
      const inviteOptions: SessionInviteOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: this.config.useAudio !== false,
            video: this.config.useVideo === true
          }
        }
      };

      // Create invite options with custom headers
      const inviteRequestOptions: InviterInviteOptions = {};
      let extraHeaders: string[] = [];

      // Add custom headers if provided
      if (options.customHeaders) {
        extraHeaders = Object.entries(options.customHeaders).map(
          ([key, value]) => `${key}: ${value}`
        );
      }

      // Add VoxoConnect-specific headers
      if (options.callUuid) {
        extraHeaders.push(`X-VoxoConnect-Call-Uuid: ${options.callUuid}`);
      }

      if (options.outboundNumberId) {
        extraHeaders.push(
          `X-VoxoConnect-Outbound-Number-ID: ${options.outboundNumberId}`
        );
      }

      // Add location header for emergency calls
      if (
        (destination === "911" || destination === "933") &&
        options.locationData
      ) {
        const { latitude, longitude } = options.locationData;
        extraHeaders.push(`X-Location: geo:${latitude},${longitude}`);
      }

      // Add emergency call header if needed
      if (options.isEmergency) {
        extraHeaders.push("Priority: emergency");

        // Add location data if available and not already added
        if (
          options.locationData &&
          !extraHeaders.some((h) => h.startsWith("X-Location:"))
        ) {
          const { latitude, longitude } = options.locationData;
          extraHeaders.push(`Geolocation: geo:${latitude},${longitude}`);
        }
      }

      // Set the final extra headers
      if (extraHeaders.length > 0) {
        inviteRequestOptions.requestOptions = {
          extraHeaders
        };
      }

      // Create the inviter with session options
      const inviter = new Inviter(this.userAgent, targetUri, inviteOptions);
      iosCallFlowLog("outbound", "prepared SIP INVITER", {
        destination,
        targetUri: targetUri.toString()
      });

      // Start InCallManager
      InCallManager.start({ media: "audio" });

      // Create call info
      const sessionId = inviter.id;

      // Extract server-side call ID from SIP Call-ID header (used by API)
      // Note: For outgoing calls, we'll extract this after the INVITE is created
      let serverCallId: string | undefined;
      try {
        // Access the internal request to get Call-ID header
        const inviterAny = inviter as any;
        if (inviterAny.request) {
          serverCallId = inviterAny.request.callId;
        }
      } catch (error) {
        console.warn(
          "Could not extract Call-ID header from outgoing call:",
          error
        );
      }

      const initialRemoteDisplay =
        typeof options.displayName === "string" &&
        options.displayName.trim() !== ""
          ? options.displayName.trim()
          : destination;

      const callInfo: CallInfo = {
        id: sessionId,
        serverCallId: serverCallId || sessionId, // Fallback to session ID if extraction fails
        state: CallState.OUTGOING,
        direction: CallDirection.OUTGOING,
        remoteDisplayName: initialRemoteDisplay,
        remoteUri: targetUri.toString(),
        startTime: new Date(),
        isMuted: false,
        isOnHold: false,
        isSpeakerOn: false,
        isEmergency: options.isEmergency || false,
        localStream: stream
      };

      // Create ManagedSession and store it
      const managedSession = new ManagedSession(
        inviter,
        callInfo,
        this.eventEmitter
      );
      this.resetTerminalEmissionGuard(sessionId);
      this.managedSessions.set(sessionId, managedSession);

      // Set up session event listeners
      this.setupSessionListeners(managedSession);

      if (options.prepareNativeOutboundUi) {
        await options.prepareNativeOutboundUi(sessionId);
      }

      if (options.onManagedSessionReady) {
        try {
          options.onManagedSessionReady(sessionId);
        } catch (cbErr) {
          console.warn(
            "[SessionManager] onManagedSessionReady threw:",
            cbErr
          );
        }
      }

      // Emit outgoing call event with full call info
      this.eventEmitter.emit("outgoingCall", sessionId, callInfo);

      // Emit call state change
      this.eventEmitter.emit("callStateChanged", sessionId, CallState.OUTGOING);

      // Merge identity from 1xx/2xx (P-Asserted-Identity, Remote-Party-ID) into UI / CallInfo
      const userInviteDelegate = inviteRequestOptions.requestDelegate;
      const sipReplyIdentityHandler = (
        source: "sipProgress" | "sipAccept",
        inviteResponse: { message?: SipLikeResponse }
      ) => {
        this.tryApplySipResponseIdentityToOutbound(
          sessionId,
          inviteResponse,
          source
        );
      };
      inviteRequestOptions.requestDelegate = {
        ...userInviteDelegate,
        onProgress: (inviteResponse) => {
          sipReplyIdentityHandler("sipProgress", inviteResponse);
          userInviteDelegate?.onProgress?.(inviteResponse);
        },
        onAccept: (inviteResponse) => {
          sipReplyIdentityHandler("sipAccept", inviteResponse);
          userInviteDelegate?.onAccept?.(inviteResponse);
        }
      };

      // Send the invite with invite options
      iosCallFlowLog("outbound", "sending SIP INVITE", {
        sessionId,
        destination
      });
      await inviter.invite(inviteRequestOptions);
      iosCallFlowLog("SessionManager.makeCall", "INVITE sent", {
        sessionId,
        destination
      });

      return sessionId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      iosCallFlowLog("SessionManager.makeCall", "FAILED", {
        destination,
        errorMessage: msg
      });
      console.error("Error making call:", error);
      throw error;
    }
  }

  /**
   * Answer an incoming call
   * @param callId ID of the call to answer
   */
  public async answerCall(callId: string): Promise<void> {
    console.log("🟡 [SessionManager] 📞 answerCall called:", {
      callId,
      timestamp: new Date().toISOString(),
      managedSessionsCount: this.managedSessions.size,
      managedSessionsKeys: Array.from(this.managedSessions.keys())
    });
    iosCallFlowLog("inbound", "accept button hit (SessionManager.answerCall)", {
      callId,
      managedSessionsCount: this.managedSessions.size
    });

    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      console.error("🟡 [SessionManager] 📞 ❌ No managedSession found:", {
        callId,
        availableSessions: Array.from(this.managedSessions.keys())
      });
      throw new Error(`No incoming call found with ID ${callId}`);
    }

    console.log("🟡 [SessionManager] 📞 ManagedSession found:", {
      callId,
      state: managedSession.getCallInfo().state,
      timestamp: new Date().toISOString()
    });

    const session = managedSession.getUnderlyingSession();
    if (!(session instanceof Invitation)) {
      console.error("🟡 [SessionManager] 📞 ❌ Session is not an Invitation:", {
        callId,
        sessionType: session.constructor.name
      });
      throw new Error(`Session ${callId} is not an incoming call`);
    }

    try {
      console.log("🟡 [SessionManager] 📞 Getting local media stream...");
      // Get local media stream
      const stream = await this.getLocalStream();
      this.localStream = stream;
      console.log("🟡 [SessionManager] 📞 ✅ Local media stream obtained");

      // Update call state and stream
      managedSession.setCallState(CallState.CONNECTING);
      managedSession.setLocalStream(stream);
      console.log("🟡 [SessionManager] 📞 Setting call state to CONNECTING...");

      // Start InCallManager
      console.log("🟡 [SessionManager] 📞 Starting InCallManager...");
      InCallManager.start({ media: "audio" });
      console.log("🟡 [SessionManager] 📞 ✅ InCallManager started");

      // Accept the invitation
      const acceptOptions: InvitationAcceptOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: {
            audio: this.config.useAudio !== false,
            video: this.config.useVideo === true
          }
        }
      };

      console.log("🟡 [SessionManager] 📞 Accepting SIP invitation...");
      iosCallFlowLog("inbound", "sending SIP 200 OK (accept)", { callId });
      await (session as Invitation).accept(acceptOptions);
      console.log("🟡 [SessionManager] 📞 ✅ SIP 200 OK sent");
    } catch (error) {
      console.error("🟡 [SessionManager] 📞 ❌ Error answering call:", error);
      iosCallFlowError("inbound", "answerCall failed", error, {
        callId
      });
      throw error;
    }
  }

  /**
   * Decline an incoming call
   * @param callId ID of the call to decline
   */
  public async declineCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No incoming call found with ID ${callId}`);
    }

    const session = managedSession.getUnderlyingSession();
    if (!(session instanceof Invitation)) {
      throw new Error(`Session ${callId} is not an incoming call`);
    }

    try {
      await (session as Invitation).reject();

      // Update call state
      managedSession.setCallState(CallState.ENDED);
      managedSession.setEndTime(new Date());

      // Emit terminal events once so CallKit cleanup only runs once.
      this.emitTerminalCallEventsOnce(callId, "declined", "declineCall");

      // Clean up
      this.managedSessions.delete(callId);
      InCallManager.stop();
    } catch (error) {
      console.error("Error declining call:", error);
      throw error;
    }
  }

  /**
   * Hang up a call with proper state-based termination
   * @param callId ID of the call to hang up
   */
  public async hangupCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }

    const session = managedSession.getUnderlyingSession();
    const sessionState = session.state;

    console.log(
      `Attempting to hang up call ${callId} in state: ${sessionState}`
    );

    try {
      // Use the appropriate termination method based on session type and state
      if (session instanceof Inviter) {
        // Outgoing call
        if (
          sessionState === SessionState.Initial ||
          sessionState === SessionState.Establishing
        ) {
          // Cancel outgoing call that hasn't been established yet
          console.log(
            `Canceling outgoing call ${callId} in ${sessionState} state`
          );
          await session.cancel();
        } else if (sessionState === SessionState.Established) {
          // Hang up established outgoing call
          console.log(`Hanging up established outgoing call ${callId}`);
          await session.bye();
        } else {
          // Handle other states (Terminating, Terminated, etc.)
          console.log(
            `Attempting bye() for outgoing call ${callId} in ${sessionState} state`
          );
          await session.bye();
        }
      } else if (session instanceof Invitation) {
        // Incoming call
        if (sessionState === SessionState.Initial) {
          // Reject incoming call that hasn't been answered
          console.log(
            `Rejecting incoming call ${callId} in ${sessionState} state`
          );
          await session.reject();
        } else if (sessionState === SessionState.Established) {
          // Hang up established incoming call
          console.log(`Hanging up established incoming call ${callId}`);
          await session.bye();
        } else {
          // Handle other states
          console.log(
            `Attempting bye() for incoming call ${callId} in ${sessionState} state`
          );
          await session.bye();
        }
      } else {
        // Fallback for other session types
        console.log(
          `Using fallback bye() for call ${callId} (session type: ${session.constructor.name})`
        );
        await session.bye();
      }

      // Update call state
      managedSession.setCallState(CallState.ENDED);
      managedSession.setEndTime(new Date());

      // Emit state change so NativeIntegration calls CallKeep.endCall()
      console.warn(
        `📞 [SM] ${new Date().toISOString()} hangupCall: emitting callStateChanged ENDED for ${callId}`
      );
      this.emitTerminalCallEventsOnce(callId, "hung up", "hangupCall");
      console.warn(
        `📞 [SM] ${new Date().toISOString()} hangupCall: emitting callEnded for ${callId}`
      );

      console.warn(
        `📞 [SM] ${new Date().toISOString()} Successfully terminated call ${callId}`
      );

      // Clean up
      this.managedSessions.delete(callId);

      // Stop InCallManager if no active calls
      if (this.managedSessions.size === 0) {
        InCallManager.stop();
      }
    } catch (error) {
      console.error(
        `Error hanging up call ${callId} (state: ${sessionState}):`,
        error
      );

      // Even if termination fails, clean up local state to prevent stuck calls
      console.log(
        `Forcing cleanup of call ${callId} after termination failure`
      );

      managedSession.setCallState(CallState.ENDED);
      managedSession.setEndTime(new Date());

      this.emitTerminalCallEventsOnce(
        callId,
        "terminated with error",
        "hangupCall-catch"
      );
      this.managedSessions.delete(callId);

      if (this.managedSessions.size === 0) {
        InCallManager.stop();
      }

      throw error;
    }
  }

  /**
   * Hold a call using SIP re-INVITE
   * @param callId ID of the call to hold
   */
  public async holdCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }
    await managedSession.hold();
  }

  /**
   * Unhold a call using SIP re-INVITE
   * @param callId ID of the call to unhold
   */
  public async unholdCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }
    await managedSession.unhold();
  }

  /**
   * Mute a call
   * @param callId ID of the call to mute
   */
  public async muteCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }
    await managedSession.mute();
  }

  /**
   * Unmute a call
   * @param callId ID of the call to unmute
   */
  public async unmuteCall(callId: string): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }
    await managedSession.unmute();
  }

  /**
   * Set speakerphone on/off for a call
   * @param callId ID of the call to control speaker for
   * @param enabled Whether to enable speakerphone
   */
  public async setSpeaker(callId: string, enabled: boolean): Promise<void> {
    const managedSession = this.managedSessions.get(callId);
    if (!managedSession) {
      throw new Error(`No call found with ID ${callId}`);
    }

    try {
      // Use InCallManager to control the actual speaker
      InCallManager.setForceSpeakerphoneOn(enabled);

      // Update session state
      managedSession.setSpeaker(enabled);
    } catch (error) {
      console.error(`Error setting speaker for call ${callId}:`, error);
      throw error;
    }
  }

  /**
   * Send DTMF tones
   * Tries WebRTC inband DTMF first; falls back to SIP INFO (application/dtmf-relay)
   * for IVRs/service numbers that expect out-of-band DTMF.
   * @param callId ID of the call to send DTMF tones to
   * @param tones DTMF tones to send (0-9, *, #, A-D)
   */
  public async sendDTMF(callId: string, tones: string): Promise<void> {
    const managedIds = Array.from(this.managedSessions.keys());
    const managedSession = this.managedSessions.get(callId);
    console.warn("[DTMF-TRACE] 4 SessionManager.sendDTMF enter", {
      callId,
      tones,
      hasManagedSession: !!managedSession,
      managedSessionIds: managedIds,
      project: "ios-project"
    });

    if (!managedSession) {
      const err = new Error(`No call found with ID ${callId}`);
      console.error(
        "[DTMF-TRACE] 4 SessionManager.sendDTMF abort — no session",
        {
          callId,
          managedSessionIds: managedIds,
          project: "ios-project"
        }
      );
      throw err;
    }

    const session = managedSession.getUnderlyingSession();

    // Try WebRTC inband DTMF first (works for peer-to-peer / simple user)
    const webrtcSuccess = await this.sendDTMFViaWebRTC(managedSession, tones);
    console.warn("[DTMF-TRACE] 4 SessionManager.sendDTMF WebRTC path", {
      callId,
      webrtcSuccess,
      next: webrtcSuccess ? "done" : "SIP INFO fallback",
      project: "ios-project"
    });
    if (webrtcSuccess) {
      this.eventEmitter.emit("dtmfSent", callId, tones);
      return;
    }

    // Fallback: SIP INFO (application/dtmf-relay) - required by many IVRs/service numbers
    console.warn(
      "[DTMF-TRACE] 4 SessionManager.sendDTMF SIP INFO fallback start",
      {
        callId,
        tones,
        project: "ios-project"
      }
    );
    await this.sendDTMFViaSipInfo(session, tones);
    console.warn(
      "[DTMF-TRACE] 4 SessionManager.sendDTMF SIP INFO fallback done",
      {
        callId,
        tones,
        project: "ios-project"
      }
    );
    this.eventEmitter.emit("dtmfSent", callId, tones);
  }

  private async sendDTMFViaWebRTC(
    managedSession: ManagedSession,
    tones: string
  ): Promise<boolean> {
    try {
      const sdh = managedSession.sessionDescriptionHandler;
      if (!sdh) {
        console.warn(
          "[DTMF-TRACE] 4b sendDTMFViaWebRTC false: no sessionDescriptionHandler",
          {
            project: "ios-project"
          }
        );
        return false;
      }

      const pc = (sdh as any).peerConnection;
      if (!pc) {
        console.warn(
          "[DTMF-TRACE] 4b sendDTMFViaWebRTC false: no peerConnection",
          {
            project: "ios-project"
          }
        );
        return false;
      }

      const senders = pc.getSenders();
      const audioSender = senders.find(
        (sender: RTCRtpSender) => sender.track && sender.track.kind === "audio"
      );
      if (!audioSender || !audioSender.dtmf) {
        console.warn(
          "[DTMF-TRACE] 4b sendDTMFViaWebRTC false: no audio dtmf sender",
          {
            hasAudioSender: !!audioSender,
            hasDtmf: !!(audioSender && audioSender.dtmf),
            senderCount: senders.length,
            project: "ios-project"
          }
        );
        return false;
      }

      for (const tone of tones) {
        audioSender.dtmf.insertDTMF(tone, 100, 70);
        await new Promise((resolve) => setTimeout(resolve, 170));
      }
      console.warn("[DTMF-TRACE] 4b sendDTMFViaWebRTC true: insertDTMF sent", {
        tones,
        project: "ios-project"
      });
      return true;
    } catch (e) {
      console.warn("[DTMF-TRACE] 4b sendDTMFViaWebRTC exception", e, {
        project: "ios-project"
      });
      return false;
    }
  }

  private async sendDTMFViaSipInfo(
    session: Session,
    tones: string
  ): Promise<void> {
    if (typeof (session as any).info !== "function") {
      console.error(
        "[DTMF-TRACE] 4c sendDTMFViaSipInfo abort: session.info is not a function",
        { project: "ios-project" }
      );
      throw new Error("DTMF not supported (no WebRTC DTMF or SIP INFO)");
    }

    for (const tone of tones) {
      console.warn("[DTMF-TRACE] 4c sendDTMFViaSipInfo sending INFO", {
        tone,
        project: "ios-project"
      });
      await (session as any).info({
        requestOptions: {
          body: {
            contentDisposition: "render",
            contentType: "application/dtmf-relay",
            content: `Signal=${tone}\r\nDuration=100`
          }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 120)); // inter-digit gap
    }
  }

  /**
   * Transfer a call
   * @param session - Session with the transferee to transfer
   * @param target - The referral target (Session for attended transfer, string for blind transfer)
   * @param options - Optional refer options
   * @remarks
   * If target is a Session this is an attended transfer completion (REFER with Replaces),
   * otherwise this is a blind transfer (REFER). Attempting an attended transfer
   * completion on a call that has not been answered will be rejected. To implement
   * an attended transfer with early completion, hangup the call with the target
   * and execute a blind transfer to the target.
   */
  public async transfer(
    session: Session,
    target: Session | string,
    options?: SessionReferOptions
  ): Promise<void> {
    console.log(`[${session.id}] Referring session...`);

    if (target instanceof Session) {
      return session.refer(target, options).then(() => {
        return;
      });
    }

    const uri = UserAgent.makeURI(target);
    if (!uri) {
      return Promise.reject(
        new Error(`Failed to create a valid URI from "${target}"`)
      );
    }

    return session.refer(uri, options).then(() => {
      return;
    });
  }

  /**
   * Get the active calls
   * @returns Array of active call IDs
   */
  public getActiveCalls(): string[] {
    return Array.from(this.managedSessions.keys());
  }

  /**
   * Get the call state
   * @param callId ID of the call to get the state for
   * @returns Call state
   */
  public getCallState(callId: string): CallInfo | undefined {
    const managedSession = this.managedSessions.get(callId);
    return managedSession ? managedSession.getCallInfo() : undefined;
  }

  /**
   * Hold all active calls
   * @returns Promise that resolves with array of call IDs that were successfully helr
   */
  public async holdAllCalls(): Promise<string[]> {
    const heldCallIds: string[] = [];
    const failedCallIds: string[] = [];
    const activeCalls = Array.from(this.managedSessions.keys());

    if (activeCalls.length === 0) {
      console.log("No active calls to hold");
      return heldCallIds;
    }

    console.log(
      `Attempting to hold ${activeCalls.length} active calls:`,
      activeCalls
    );

    // Hold each active call
    for (const callId of activeCalls) {
      try {
        const managedSession = this.managedSessions.get(callId);

        if (!managedSession) {
          console.log(`Skipping call ${callId} - session not found`);
          continue;
        }

        // Check if call is already held
        if (managedSession.isHeld) {
          heldCallIds.push(callId);
          console.log(`Call ${callId} was already on hold`);
          continue;
        }

        // Only hold calls that are connected
        if (managedSession.callState !== CallState.CONNECTED) {
          console.log(
            `Skipping call ${callId} - not connected (state: ${managedSession.callState})`
          );
          continue;
        }

        // Check if session has recent re-INVITE activity
        const session = managedSession.getUnderlyingSession() as any;
        if (session._inviteOutgoing || session._inviteIncoming) {
          console.log(`Skipping call ${callId} - SIP re-INVITE in progress`);
          continue;
        }

        // Attempt to hold the call
        await this.holdCall(callId);
        heldCallIds.push(callId);
        console.log(
          `Successfully held call ${callId} (was ${managedSession.callState})`
        );
      } catch (error) {
        failedCallIds.push(callId);
        console.error(`Failed to hold call ${callId}:`, error);
        // Continue with other calls even if one fails
      }
    }

    // Log summary of operation
    const summary = {
      successful: heldCallIds,
      failed: failedCallIds
    };

    if (failedCallIds.length > 0) {
      console.warn(
        `Hold operation completed with ${failedCallIds.length} failures:`,
        summary
      );
    } else {
      console.log(summary);
    }

    return heldCallIds;
  }

  /**
   * Clean up and dispose of resources
   */
  public dispose(): void {
    // Hang up all active calls
    for (const [callId, managedSession] of this.managedSessions.entries()) {
      try {
        managedSession.bye();
      } catch (error) {
        console.error(`Error hanging up call ${callId}:`, error);
      }
    }

    // Unregister
    if (this.registerer) {
      try {
        this.registerer.unregister();
      } catch (error) {
        console.error("Error unregistering:", error);
      }
    }

    // Stop the user agent
    if (this.userAgent) {
      try {
        this.userAgent.stop();
      } catch (error) {
        console.error("Error stopping user agent:", error);
      }
    }

    // Stop InCallManager
    InCallManager.stop();

    // Clear map
    this.managedSessions.clear();
    this.terminalEventsEmitted.clear();

    // Stop all wake-up UAs
    for (const ua of this.wakeUpUAs) {
      try {
        ua.stop();
      } catch (error) {
        console.error("Error stopping wake-up UA:", error);
      }
    }
    this.wakeUpUAs.clear();

    // Clear references so a fresh instance can be created via resetInstance
    this.registerer = null;
    this.userAgent = null;
  }

  /**
   * Establish an inbound session for a specific call UUID using custom headers
   * This implements the "wake-up" strategy for robust incoming call delivery
   */
  /**
   * Establish inbound session for killed-state calling
   * This follows voxo-mobile's SlimSipClient.establishInboundSession pattern:
   * 1. Create wake-up UA with X-UUID, X-PUSH, X-IP headers
   * 2. Register and wait for INVITE (8-second timeout)
   * 3. Return Session when INVITE arrives
   * 4. Handle registration failures (404, answered elsewhere, cancelled)
   */
  public async establishInboundSession(
    callUuid: string,
    callerIp: string
  ): Promise<Session> {
    console.log(
      `🔶 [SessionManager] ESTABLISHING INBOUND SESSION for UUID: ${callUuid}, IP: ${callerIp}`
    );
    iosCallFlowLog("inbound", "start establishInboundSession", {
      callUuid,
      callerIp
    });

    return new Promise<Session>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let wakeUpUA: UserAgent | null = null;
      let registerer: Registerer | null = null;

      void (async () => {
        try {
          // Create wake-up UserAgent
          const userAgentOptions: UserAgentOptions = {
            uri: new URI("sip", this.config.user, this.config.domain),
            authorizationUsername: this.config.user,
            authorizationPassword: this.config.password,
            transportOptions: {
              server: this.config.uri
            },
            displayName: this.config.displayName,
            delegate: {
              onInvite: (invitation: Invitation) => {
                console.log(
                  `🔶 [SessionManager] ✅ WakeUp UA received INVITE for ${callUuid}`
                );
                iosCallFlowLog("inbound", "SIP INVITE received", {
                  callUuid,
                  sessionId: invitation.id
                });

                // Clear timeout since we got the INVITE
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }

                // Create CallInfo for this incoming call
                const sessionId = invitation.id;
                const remoteUri = invitation.remoteIdentity.uri.toString();
                const remoteDisplayName =
                  invitation.remoteIdentity.displayName || remoteUri;

                const callInfo: CallInfo = {
                  id: callUuid || sessionId,
                  state: CallState.INCOMING,
                  direction: CallDirection.INCOMING,
                  remoteDisplayName: remoteDisplayName,
                  remoteUri: remoteUri,
                  startTime: new Date(),
                  isMuted: false,
                  isOnHold: false,
                  isSpeakerOn: false,
                  isEmergency: false,
                  audioState: "active"
                };

                // Create ManagedSession
                const managedSession = new ManagedSession(
                  invitation,
                  callInfo,
                  this.eventEmitter
                );

                // Store the session
                this.resetTerminalEmissionGuard(sessionId);
                this.managedSessions.set(sessionId, managedSession);

                console.log(
                  `🔶 [SessionManager] Created ManagedSession for ${callUuid}, resolving promise`
                );

                // Resolve with the SIP.js Session
                resolve(invitation);
              }
            }
          };

          console.log(`🔶 [SessionManager] Creating new UserAgent for wake-up`);
          wakeUpUA = new UserAgent(userAgentOptions);
          this.wakeUpUAs.add(wakeUpUA);

          console.log(`🔶 [SessionManager] Starting UserAgent...`);
          iosCallFlowLog("inbound", "starting wake-up SIP user agent", {
            callUuid
          });
          await wakeUpUA.start();

          // Create registerer with wake-up headers (like voxo-mobile)
          console.log(
            `🔶 [SessionManager] Creating Registerer with X-UUID, X-PUSH, X-IP headers`
          );
          registerer = new Registerer(wakeUpUA, {
            extraHeaders: [
              `X-UUID: ${callUuid}`,
              `X-PUSH: 1`,
              `X-IP: ${callerIp}`
            ],
            expires: 120
          });

          // Handle registration state changes
          registerer.stateChange.addListener((state) => {
            console.log(
              `🔶 [SessionManager] Registerer state changed: ${state}`
            );
            iosCallFlowLog("inbound", "wake registerer state changed", {
              callUuid,
              registererState: String(state)
            });

            if (state === RegistererState.Registered) {
              console.log(
                `🔶 [SessionManager] ✅ SUCCESSFULLY REGISTERED WAKEUP UA`
              );
              iosCallFlowLog("inbound", "SIP registered for inbound wake-up", {
                callUuid
              });

              // Set timeout for receiving INVITE (8 seconds like voxo-mobile)
              timeoutHandle = setTimeout(() => {
                console.error(
                  `🔶 [SessionManager] ❌ RECEIVE_INVITE_TIMEOUT (8 seconds)`
                );
                iosCallFlowError(
                  "inbound",
                  "timeout waiting for INVITE",
                  new Error("RECEIVE_INVITE_TIMEOUT"),
                  {
                    callUuid
                  }
                );
                reject({
                  error: "RECEIVE_INVITE_TIMEOUT",
                  message: "Timeout waiting for invite after 8 seconds"
                });

                // Cleanup
                if (wakeUpUA) {
                  wakeUpUA.stop().catch(() => {});
                  this.wakeUpUAs.delete(wakeUpUA);
                }
              }, 8000);
            } else if (
              state === RegistererState.Terminated ||
              state === RegistererState.Unregistered
            ) {
              console.error(
                `🔶 [SessionManager] ❌ Registration failed or terminated: ${state}`
              );
              iosCallFlowError(
                "inbound",
                "registration failed or terminated",
                new Error(`REGISTRATION_${state}`),
                {
                  callUuid,
                  registererState: String(state)
                }
              );

              // Check for specific error codes (like voxo-mobile does)
              // In sip.js, we need to check the registerer's last response
              reject({
                error: "REGISTRATION_FAILED",
                message: `Registration ${state}`
              });

              // Cleanup
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
              }
              if (wakeUpUA) {
                wakeUpUA.stop().catch(() => {});
                this.wakeUpUAs.delete(wakeUpUA);
              }
            }
          });

          // Register
          console.log(
            `🔶 [SessionManager] Registering WakeUp UA with headers...`
          );
          await registerer.register();
        } catch (error) {
          console.error(
            `🔶 [SessionManager] ❌ Error in establishInboundSession:`,
            error
          );
          iosCallFlowError("inbound", "establishInboundSession threw", error, {
            callUuid
          });

          // Cleanup
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          if (wakeUpUA) {
            wakeUpUA.stop().catch(() => {});
            if (wakeUpUA) this.wakeUpUAs.delete(wakeUpUA);
          }

          reject(error);
        }
      })();
    });
  }

  /**
   * Handle an incoming call
   * @param invitation Incoming call invitation
   * @param callUuid Optional native call UUID from wake-up process
   */
  private handleIncomingCall(invitation: Invitation, callUuid?: string): void {
    // Get session ID (SIP.js internal ID)
    const sessionId = invitation.id;

    if (USE_VOXO_MOBILE_APPROACH) {
      const sipCallId = invitation.request.callId || invitation.request.call_id;
      const xcid =
        invitation.request.getHeader("Xcid") ||
        invitation.request.getHeader("XCID") ||
        invitation.request.getHeader("X-Cid");
      console.warn(
        `[SessionManager] USE_VOXO_MOBILE_APPROACH: rejecting SessionManager INVITE; SlimSip/PushKit owns incoming (sessionId=${sessionId})`
      );
      console.warn(
        `[END-ACCEPT-TRACE][ios-project][SessionManager][incomingReject486] sessionId=${sessionId} sipCallId=${
          sipCallId || "unknown"
        } xcid=${xcid || "none"} callUuid=${callUuid || "none"}`
      );
      void invitation
        .reject({ statusCode: 486, reasonPhrase: "Busy Here" })
        .catch((err) => {
          console.error(
            "[SessionManager] invitation.reject after USE_VOXO_MOBILE_APPROACH:",
            err
          );
        });
      return;
    }

    const remoteUri = invitation.remoteIdentity.uri.toString();
    const remoteDisplayName =
      invitation.remoteIdentity.displayName || remoteUri;

    // Extract SIP headers
    const headers = invitation.request.headers;

    // If callUuid was not passed, try to extract from X-UUID header if present
    if (!callUuid) {
      // Some servers might reflect it back
      callUuid = invitation.request.getHeader("X-UUID");
    }

    // Check if this is an auto-reject call type
    if (this.config.autoReject && this.config.autoRejectTypes) {
      for (const type of this.config.autoRejectTypes) {
        if (headers[type.toLowerCase()]) {
          // Auto-reject the call
          invitation.reject();
          return;
        }
      }
    }

    // Extract server-side call ID from Xcid header (used by API)
    // Asterisk/VXM sends XCID (uppercase); try both variants for case-sensitive stacks
    const serverCallId =
      invitation.request.getHeader("Xcid") ||
      invitation.request.getHeader("XCID") ||
      sessionId;

    // Create call info
    const callInfo: CallInfo = {
      id: sessionId, // Use session ID as the primary ID for local tracking
      callUuid, // Store native call UUID
      state: CallState.INCOMING,
      direction: CallDirection.INCOMING,
      remoteDisplayName,
      remoteUri,
      startTime: new Date(),
      isMuted: false,
      isOnHold: false,
      isSpeakerOn: false,
      isEmergency: false, // Check headers for emergency status
      // Store server call ID for API calls
      serverCallId
    };

    // Create ManagedSession and store it
    const managedSession = new ManagedSession(
      invitation,
      callInfo,
      this.eventEmitter
    );
    this.resetTerminalEmissionGuard(sessionId);
    this.managedSessions.set(sessionId, managedSession);

    // Set up session event listeners
    this.setupSessionListeners(managedSession);

    // Emit incoming call event
    this.eventEmitter.emit("incomingCall", sessionId, callInfo);
    this.eventEmitter.emit("callStateChanged", sessionId, CallState.INCOMING);

    // Auto-answer if configured
    if (this.config.autoAnswer) {
      this.answerCall(sessionId).catch((error) => {
        console.error("Error auto-answering call:", error);
      });
    }
  }

  private emitRemotePartyIfChanged(
    ms: ManagedSession,
    displayName: string,
    uri: string | undefined,
    source: string
  ): void {
    if (!ms.applyRemotePartyFromSip(displayName, uri)) {
      return;
    }
    const ci = ms.getCallInfo();
    iosCallFlowLog("outbound", "callRemotePartyUpdated", {
      callId: ms.id,
      source,
      remoteDisplayName: ci.remoteDisplayName
    });
    this.eventEmitter.emit("callRemotePartyUpdated", ms.id, {
      remoteDisplayName: ci.remoteDisplayName,
      remoteUri: ci.remoteUri
    });
  }

  private tryApplySipResponseIdentityToOutbound(
    sessionId: string,
    inviteResponse: { message?: SipLikeResponse },
    source: "sipProgress" | "sipAccept"
  ): void {
    const msg = inviteResponse?.message;
    if (!msg?.hasHeader || !msg.getHeader) {
      iosCallFlowLog("outbound", "SIP identity parse skipped (no message)", {
        sessionId,
        source
      });
      return;
    }
    const parsed = parseDisplayFromSipResponseMessage(msg);
    if (!parsed) {
      iosCallFlowLog("outbound", "SIP identity parse: no PAI/RPI display", {
        sessionId,
        source
      });
      return;
    }
    const ms = this.managedSessions.get(sessionId);
    if (!ms) {
      return;
    }
    this.emitRemotePartyIfChanged(ms, parsed.displayName, parsed.uri, source);
  }

  private refreshEstablishedRemotePartyFromAsserted(
    managedSession: ManagedSession,
    callId: string
  ): void {
    if (managedSession.direction !== CallDirection.OUTGOING) {
      return;
    }
    const session = managedSession.getUnderlyingSession() as Session & {
      assertedIdentity?: { friendlyName?: string; uri?: { toString(): string } };
    };
    try {
      const ai = session.assertedIdentity;
      if (!ai) {
        iosCallFlowLog("outbound", "established: no assertedIdentity", {
          callId
        });
        return;
      }
      const fn =
        typeof ai.friendlyName === "string" ? ai.friendlyName.trim() : "";
      if (!fn) {
        return;
      }
      this.emitRemotePartyIfChanged(
        managedSession,
        fn,
        ai.uri?.toString?.(),
        "assertedIdentity@Established"
      );
    } catch (e) {
      console.warn(
        "[SessionManager] refreshEstablishedRemotePartyFromAsserted failed:",
        e
      );
    }
  }

  /**
   * Set up event listeners for a session
   * @param managedSession Session to set up listeners for
   */
  private setupSessionListeners(managedSession: ManagedSession): void {
    const callId = managedSession.id;
    const session = managedSession.getUnderlyingSession();

    session.stateChange.addListener((state: SessionState) => {
      console.log(
        `🟡 [SessionManager] 📞 Call ${callId} session state changed to ${state}`,
        {
          callId,
          sessionState: state,
          timestamp: new Date().toISOString()
        }
      );

      switch (state) {
        case SessionState.Establishing:
          managedSession.setCallState(CallState.CONNECTING);
          break;
        case SessionState.Established:
          managedSession.setCallState(CallState.CONNECTED);
          iosCallFlowLog("outbound", "call established", {
            callId
          });
          iosCallFlowLog("inbound", "call established", {
            callId
          });
          managedSession.setAnswerTime(new Date());
          this.refreshEstablishedRemotePartyFromAsserted(managedSession, callId);
          this.eventEmitter.emit("callConnected", callId);
          console.log(
            "🟡 [SessionManager] 📞 Session established, setting call state to CONNECTED..."
          );

          // Set up remote media handling when connected
          this.setupRemoteMedia(managedSession, callId);

          // Call connected - let SippyCup handle any transfer logic
          break;
        case SessionState.Terminating:
        case SessionState.Terminated: {
          managedSession.setCallState(CallState.ENDED);
          managedSession.setEndTime(new Date());
          this.emitTerminalCallEventsOnce(
            callId,
            state === SessionState.Terminated ? "terminated" : "terminating",
            `sessionState:${state}`
          );

          // Bidirectional relationship cleanup - clear from both sides
          const childSessionId = managedSession.childSession;
          const parentSessionId = managedSession.parentSession;

          // Clear relationship from child if this was a parent
          if (childSessionId) {
            const childSession = this.managedSessions.get(childSessionId);
            if (childSession) {
              console.log(
                `[${callId}] Clearing child relationship from ${childSessionId}`
              );
              childSession.clearRelationships();
            }
          }

          // Clear relationship from parent if this was a child
          if (parentSessionId) {
            const parentSession = this.managedSessions.get(parentSessionId);
            if (parentSession) {
              console.log(
                `[${callId}] Clearing parent relationship from ${parentSessionId}`
              );
              parentSession.clearRelationships();
            }
          }

          // Clean up session relationships for this session
          managedSession.clearRelationships();

          // Clean up
          this.managedSessions.delete(callId);

          // Stop InCallManager if no active calls
          if (this.managedSessions.size === 0) {
            InCallManager.stop();
          }

          // Cleanup this session's wake-up UA if it exists
          const session = managedSession.getUnderlyingSession();
          const ua = session.userAgent;
          if (ua && this.wakeUpUAs.has(ua)) {
            console.log(
              "[SessionManager] Stopping WakeUp UA for terminated session"
            );
            try {
              ua.stop();
            } catch (e) {
              console.error("Error stopping wake-up UA:", e);
            }
            this.wakeUpUAs.delete(ua);
          }
          break;
        }
      }
    });
  }

  /**
   * Set up remote media handling for a session
   * @param session Session to set up remote media for
   * @param callId Call ID
   */
  private setupRemoteMedia(
    managedSession: ManagedSession,
    callId: string
  ): void {
    try {
      const session = managedSession.getUnderlyingSession();
      const sdh = session.sessionDescriptionHandler;
      if (!sdh) return;

      const pc = (sdh as any).peerConnection;
      if (!pc) return;

      // Handle remote tracks
      pc.ontrack = (event: RTCTrackEvent<"track">) => {
        // Create remote stream if it doesn't exist
        if (!managedSession.remoteStream) {
          managedSession.setRemoteStream(new MediaStream());
        }

        // Add track to remote stream
        if (event.track) {
          managedSession.remoteStream?.addTrack(event.track);

          // Emit remote stream event
          this.eventEmitter.emit(
            "remoteStream",
            callId,
            managedSession.remoteStream
          );
        }
      };
    } catch (error) {
      console.error("Error setting up remote media:", error);
    }
  }

  /**
   * Get the local media stream
   * @returns Promise that resolves with the local media stream
   */
  private async getLocalStream(): Promise<MediaStream> {
    try {
      const constraints = {
        audio: this.config.useAudio !== false,
        video: this.config.useVideo === true
      };

      const stream = await mediaDevices.getUserMedia(constraints);
      return stream;
    } catch (error) {
      console.error("Error getting local media stream:", error);
      throw error;
    }
  }
}
