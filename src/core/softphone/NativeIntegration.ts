import { NativeModules, Platform, AppState, AppStateStatus } from "react-native";
import CallKeep from "react-native-callkeep";
import InCallManager from "react-native-incall-manager";
import { CallInfo, CallState } from "./types";
import { v4 as uuid } from "uuid";
import { Logger } from "shared/utils/Logger.ts";
import { VoipBridge } from "./VoipBridge";
import { getSipSession } from "./sipSessionRegistry.ts";
import BackgroundTaskManager from "../background/BackgroundTaskManager.ts";
import { iosCallFlowError, iosCallFlowLog } from "./iosCallFlowLog.ts";
import {
  drainAndRemoveRecentsEarlyCapture,
  pullNativePendingRecentsIntent,
  type PendingRecentsStart
} from "./iosRecentsEarly.ts";
import {
  dedupePendingRecentsStarts,
  getOutboundStartupGraceRemainingMs,
  isOutboundStartupGraceActive,
  normalizeOutboundRecentsHandle
} from "./iosOutboundStartupGuard.ts";

const logger = new Logger("NativeIntegration: ");

/** Filter Xcode / Console.app / Metro with: VOXO_RECENTS_TRACE (Phone → Recents → app). */
const RECENTS_TRACE = "[VOXO_RECENTS_TRACE]";

/** Resolves when iOS ringback warm-up has completed (so first outgoing call gets reliable ringback). */
const RINGBACK_WARMUP_TIMEOUT_MS = 2500;

/** True if dial string is strict E.164 (+ then digits only, 8–15 subscriber digits). */
function iosDialStringIsStrictE164(d: string): boolean {
  const t = String(d || "").trim();
  if (!t.startsWith("+") || t.length < 9 || t.length > 16) {
    return false;
  }
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 48 || c > 57) {
      return false;
    }
  }
  return true;
}

/** SIP user-part or raw dial hint (e.g. `sip:1015@host`, `sip:+1555@host`, `+1555`). */
function extractDialUserFromUriOrHint(raw?: string): string {
  const s = String(raw || "").trim();
  if (!s) {
    return "";
  }
  const m = s.match(/^sip:([^@;>]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return m[1].trim();
    }
  }
  return s;
}

/**
 * Best-effort strict E.164 for CallKit `updateDisplay`. Native RNCallKeep only sets
 * `CXHandleTypePhoneNumber` when the URI is strict +digits (see VoxoCallKeepHandleTypeForUpdateDisplayUri).
 */
function iosNormalizeDialHintToStrictE164(raw?: string): string | null {
  let t = extractDialUserFromUriOrHint(raw).trim();
  if (!t) {
    return null;
  }
  if (/^tel:/i.test(t)) {
    t = t.replace(/^tel:/i, "").trim();
  }
  if (iosDialStringIsStrictE164(t)) {
    return t;
  }
  const digits = t.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return null;
  }
  // NANP 10-digit national (leading NPA digit 2–9).
  if (digits.length === 10) {
    const first = digits.charCodeAt(0);
    if (first >= 50 && first <= 57) {
      return `+1${digits}`;
    }
    return null;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.charAt(0) === "0") {
    return null;
  }
  return `+${digits}`;
}

/**
 * Value for CallKit `updateDisplay` / Recents snapshot `remoteHandle` (Phone row):
 * strict E.164 when possible, else 3–8 digit PBX extension from dial hint / SIP user-part.
 */
function iosCallKitPhoneHandleForRecents(raw?: string): string | null {
  const e164 = iosNormalizeDialHintToStrictE164(raw);
  if (e164) {
    return e164;
  }
  let t = extractDialUserFromUriOrHint(raw).trim();
  if (!t) {
    return null;
  }
  if (/^tel:/i.test(t)) {
    t = t.replace(/^tel:/i, "").trim();
  }
  const d = t.replace(/\D/g, "");
  if (d.length >= 3 && d.length <= 8 && /^\d+$/.test(d)) {
    return d;
  }
  return null;
}

const PENDING_RECENTS_MAX = 5;

const getSuppressedCallKeepEndSet = (): Set<string> => {
  const g = global as any;
  if (!g.__voxoSuppressCallKeepEndUuids) {
    g.__voxoSuppressCallKeepEndUuids = new Set<string>();
  }
  return g.__voxoSuppressCallKeepEndUuids as Set<string>;
};

const normalizeCallKeepKey = (value: string | undefined): string =>
  String(value || "").trim().toLowerCase();

/** CallKit UUID was rebound to a different SIP session (conference merge survivor). */
function isCallKitUuidMappedToOtherSession(
  activeCalls: Map<string, string>,
  callUUID: string,
  endedCallId: string
): boolean {
  const needle = normalizeCallKeepKey(callUUID);
  if (!needle) {
    return false;
  }
  for (const [uuid, sipSessionId] of activeCalls.entries()) {
    if (uuid.toLowerCase() === needle && sipSessionId !== endedCallId) {
      return true;
    }
  }
  return false;
}

function shouldSuppressCallKeepEndForLeg(
  activeCalls: Map<string, string>,
  callId: string,
  callUUID: string
): boolean {
  const suppressed = getSuppressedCallKeepEndSet();
  const idKey = String(callId || "").trim();
  const uuidKey = normalizeCallKeepKey(callUUID);
  if (idKey && suppressed.has(idKey)) {
    return true;
  }
  if (uuidKey && suppressed.has(uuidKey)) {
    return true;
  }
  if (callUUID && suppressed.has(callUUID)) {
    return true;
  }
  return isCallKitUuidMappedToOtherSession(activeCalls, callUUID, callId);
}

function consumeCallKeepEndSuppressionForEndedLeg(
  activeCalls: Map<string, string>,
  callId: string,
  callUUID: string
): void {
  const suppressed = getSuppressedCallKeepEndSet();
  const idKey = String(callId || "").trim();
  if (idKey) {
    suppressed.delete(idKey);
  }
  if (!isCallKitUuidMappedToOtherSession(activeCalls, callUUID, callId)) {
    const uuidKey = normalizeCallKeepKey(callUUID);
    if (uuidKey) {
      suppressed.delete(uuidKey);
    }
    if (callUUID) {
      suppressed.delete(callUUID);
    }
  }
}

/**
 * Options for initializing native call integration
 */
interface NativeIntegrationOptions {
  appName: string;
}

/**
 * NativeIntegration handles integration with native call UI
 * using CallKit on iOS and the equivalent on Android
 */
export class NativeIntegration {
  private initialized: boolean = false;
  private options: NativeIntegrationOptions;
  private activeCalls: Map<string, string> = new Map(); // Maps callUUID to callId
  // Tracks active SIP calls even when CallKeep UUID mapping is missing.
  private activeSipCallIds: Set<string> = new Set();
  /** De-dupe CallKit start-call actions by UUID to avoid double INVITEs. */
  private startedOutgoingCallUuids: Map<string, number> = new Map();
  /** CallKit UUIDs (lowercase) for app-originated outbound calls — drives reportConnected on iOS. */
  private outboundCallKitUuids: Set<string> = new Set();
  /**
   * iOS: UUIDs (lowercase) for which we invoked CallKeep.endCall from updateCallState after SIP
   * teardown. When performEndCallAction fires, we skip onEndCall/hangupCall (symmetric CXEndCallAction).
   */
  private iosSymmetricEndCallPendingAck: Set<string> = new Set();
  /**
   * iOS: latest display name + dial hint for a CallKit UUID — sent to native immediately before
   * `endCall` / `reportEndCallWithUUID` so Phone → Recents snapshots `localizedCallerName` + E.164 handle.
   */
  private iosCallKitRecentsEndSnapshotByUuidLower = new Map<
    string,
    { displayName: string; dialHint: string }
  >();
  private pendingActions: Map<string, Array<{ type: string; payload?: any }>> =
    new Map();
  private appState: AppStateStatus = AppState.currentState;

  /** True after SoftphoneProvider wires CallKit Recents → SIP via attachStartCallHandler. */
  private startCallHandlerAttached = false;
  /** Recents starts received before attachStartCallHandler (killed-process race). */
  private pendingRecentsStarts: PendingRecentsStart[] = [];
  private pendingRecentsFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * While set, ignore `didPerformSetMutedCallAction` (programmatic `CallKeep.setMutedCall`
   * echoes as user mute actions via CXSetMutedCallAction).
   */
  private muteSuppressCallKitEchoUntil = 0;
  /** Last mute state synced to CallKit per UUID (lowercase). */
  private callKitSyncedMuteByUuidLower = new Map<string, boolean>();
  private ringbackWarmUpPromise: Promise<void> | null = null;
  private ringbackWarmUpResolve: (() => void) | null = null;

  private static readonly MUTE_ECHO_SUPPRESS_MS = 500;

  /**
   * Create a new NativeIntegration instance
   * @param options Options for initializing native call integration
   */
  constructor(options: NativeIntegrationOptions) {
    this.options = options;
  }

  /**
   * Initialize native call integration
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      if (Platform.OS === "ios") {
        const early = drainAndRemoveRecentsEarlyCapture();
        for (const item of early) {
          this.enqueuePendingRecentsStart(item);
        }
        const nativeQueued = await pullNativePendingRecentsIntent();
        if (nativeQueued) {
          this.enqueuePendingRecentsStart(nativeQueued);
        }
      }

      // Request display over other apps permission for Android
      if (Platform.OS === "android") {
        const hasPermission = await CallKeep.checkPhoneAccountEnabled();
        console.log(
          "📞 [NativeIntegration] Phone account enabled:",
          hasPermission
        );

        if (!hasPermission) {
          console.log(
            "⚠️ [NativeIntegration] Requesting phone account permission..."
          );
          await CallKeep.setAvailable(true);
        }
      }

      // Configure CallKeep
      await CallKeep.setup({
        ios: {
          appName: this.options.appName,
          maximumCallGroups: "3",
          maximumCallsPerCallGroup: "1",
          includesCallsInRecents: true,
          supportsVideo: false
        },
        android: {
          alertTitle: "Permissions required",
          alertDescription:
            "This application needs to access your phone accounts",
          cancelButton: "Cancel",
          okButton: "OK",
          additionalPermissions: [],
          foregroundService: {
            channelId: "co.voxo.softphone",
            channelName: "Softphone Service",
            notificationTitle: this.options.appName,
            notificationIcon: "phone_account"
          },
          imageName: "iconmask",
          selfManaged: true
        }
      });

      // Set up CallKeep event listeners
      this.setupCallKeepListeners();

      // Set up app state monitoring for background call handling
      this.setupAppStateMonitoring();

      // Initialize background task manager
      await BackgroundTaskManager.initialize();

      this.initialized = true;

      this.flushPendingRecentsStarts();

      // iOS: prime InCallManager + ringback so first outgoing call gets ringback (no audible play at launch).
      if (Platform.OS === "ios") {
        this.warmUpRingbackSilent();
      }
    } catch (error) {
      console.error("Error initializing native call integration:", error);
      throw error;
    }
  }

  /**
   * iOS only: warm up InCallManager and ringback path without playing sound.
   * Run once after init so the first outgoing call plays ringback.
   * Resolves ringbackWarmUpPromise when done so startOutgoingCall can wait for it.
   */
  private warmUpRingbackSilent(): void {
    this.ringbackWarmUpPromise = new Promise<void>((resolve) => {
      this.ringbackWarmUpResolve = resolve;
    });
    const run = async () => {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        InCallManager.stop();
        InCallManager.start({ media: "audio", auto: true });
        await new Promise((r) => setTimeout(r, 250));
        InCallManager.startRingback("_BUNDLE_");
        // Stop immediately so user does not hear any ring at launch — ringback only when call is placed.
        setTimeout(() => {
          InCallManager.stopRingback();
          InCallManager.stop();
          this.ringbackWarmUpResolve?.();
          this.ringbackWarmUpResolve = null;
        }, 0);
      } catch (_) {
        this.ringbackWarmUpResolve?.();
        this.ringbackWarmUpResolve = null;
      }
    };
    run();
  }

  /**
   * iOS: ringback for CallKit Recents / Siri outbound (CallKit already showed UI — no second startCall).
   */
  public startIosCallKitOriginatedRingback(): void {
    if (Platform.OS !== "ios") return;
    void this.startIosOutboundRingback().catch((e) => {
      console.warn("[NI-RINGBACK] startIosCallKitOriginatedRingback failed:", e);
    });
  }

  public ensureOutboundRingbackPlaying(): void {
    if (Platform.OS !== "ios") return;
    try {
      InCallManager.stopRingback();
      InCallManager.start({ media: "audio", auto: true });
      setTimeout(() => {
        try {
          InCallManager.startRingback("_BUNDLE_");
        } catch (e) {
          console.warn(
            "[NI-RINGBACK] ensureOutboundRingbackPlaying startRingback failed:",
            e
          );
        }
      }, 220);
    } catch (e) {
      console.warn("[NI-RINGBACK] ensureOutboundRingbackPlaying failed:", e);
    }
  }

  /**
   * iOS: play bundled "brrr brrr" ringback (incallmanager_ringback.mp3) for outgoing calls.
   */
  private async startIosOutboundRingback(): Promise<void> {
    const ts = () => new Date().toISOString();
    await Promise.race([
      this.ringbackWarmUpPromise ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, RINGBACK_WARMUP_TIMEOUT_MS))
    ]);
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: InCallManager.stop() to ensure fresh audio session for ringback...`
    );
    InCallManager.stop();
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: stopping any existing ringtone/ringback...`
    );
    InCallManager.stopRingtone();
    InCallManager.stopRingback();
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: stopRingtone/stopRingback done`
    );
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: InCallManager.start({ media: 'audio', auto: true }) — no ringback yet...`
    );
    InCallManager.start({
      media: "audio",
      auto: true
    });
    console.log(`🔊 [NI-RINGBACK] ${ts()} iOS: InCallManager.start() done`);
    await new Promise((r) => setTimeout(r, 220));
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: InCallManager.startRingback('_BUNDLE_')...`
    );
    InCallManager.startRingback("_BUNDLE_");
    console.log(
      `🔊 [NI-RINGBACK] ${ts()} iOS: startRingback() returned. If no sound: check Xcode console for RNInCallManager.startRingback() and 'no available media' (bundle file missing) or session errors.`
    );
  }

  /** Mark a CallKit UUID as belonging to an outbound leg (Recents/Siri or in-app). */
  public markIosOutboundCallKitUuid(uuid: string): void {
    if (Platform.OS !== "ios") return;
    const k = String(uuid || "").trim().toLowerCase();
    if (k) this.outboundCallKitUuids.add(k);
  }

  /**
   * Display an incoming call in the native UI
   * @param callId SIP call ID
   * @param callInfo Call information
   * @returns Promise that resolves with the native call UUID
   */
  public async displayIncomingCall(
    callId: string,
    callInfo: CallInfo
  ): Promise<string> {
    if (!this.initialized) {
      throw new Error("Native call integration not initialized");
    }

    try {
      // Use existing UUID if provided (Wake-up strategy), otherwise generate new one
      const callUUID = callInfo.callUuid || uuid();

      // On iOS when NOT in foreground, skip CallKit display — the native push
      // handler (AppDelegate) already reported the call to CallKit. Creating a
      // duplicate entry causes CallKit to end the JS entry when the user answers
      // the push entry, which REJECTS the SIP INVITE (480 Temporarily Unavailable).
      // if (Platform.OS === "ios" && AppState.currentState !== "active") {
      //   console.warn(`📞 [NI] ${new Date().toISOString()} displayIncomingCall: iOS background (${AppState.currentState}) — skipping CallKeep + activeCalls (AppDelegate handles it). callId=${callId}`);
      //   return callUUID;
      // }

      const callerName = String(callInfo.remoteDisplayName || "").trim();
      const remoteUriTrim = String(callInfo.remoteUri || "").trim();

      // Display the incoming call in the native UI
      console.log("📞 [NativeIntegration] Displaying incoming call:", {
        callUUID,
        callerName,
        remoteUriLen: remoteUriTrim.length,
        platform: Platform.OS
      });

      // Match outbound startOutgoingCall: use CXHandleTypePhoneNumber when remoteUri
      // normalizes to E.164/extension so Phone → Recents shows the Phone row.
      let callKitHandleValue = callerName || remoteUriTrim;
      let callKitHandleType: "generic" | "number" | "phone" = "generic";
      if (Platform.OS === "ios") {
        const phoneForCk = iosCallKitPhoneHandleForRecents(remoteUriTrim);
        if (phoneForCk != null) {
          callKitHandleValue = phoneForCk;
          callKitHandleType = "number";
        }
        console.warn(
          `${RECENTS_TRACE} displayIncomingCall: handleType=${callKitHandleType} ckHandleLen=${callKitHandleValue.length} remoteUriLen=${remoteUriTrim.length} uuid=${callUUID}`
        );
      }

      // Show native CallKit UI (explicit iOS caps: avoid react-native-callkeep defaults
      // that enable hold/grouping and cause "Hold & Accept" on second incoming call).
      CallKeep.displayIncomingCall(
        callUUID,
        callerName || callKitHandleValue,
        callKitHandleValue,
        callKitHandleType,
        false, // hasVideo
        {
          ios: {
            supportsHolding: false,
            supportsDTMF: true,
            supportsGrouping: false,
            supportsUngrouping: false
          }
        }
      );

      if (Platform.OS === "ios") {
        try {
          const phone = iosCallKitPhoneHandleForRecents(remoteUriTrim);
          if (phone) {
            const displayForCk = callerName || phone;
            console.warn(
              `${RECENTS_TRACE} displayIncomingCall: updateDisplay (phone handle) uuid=${callUUID} displayLen=${displayForCk.length}`
            );
            CallKeep.updateDisplay(callUUID, displayForCk, phone);
          } else if (callerName) {
            const ckAny = CallKeep as unknown as {
              reportUpdatedCall?: (
                uuid: string,
                localizedCallerName: string
              ) => Promise<unknown>;
            };
            console.warn(
              `${RECENTS_TRACE} displayIncomingCall: reportUpdatedCall (name only) uuid=${callUUID} nameLen=${callerName.length}`
            );
            void ckAny.reportUpdatedCall?.(callUUID, callerName);
          }
        } catch (updateErr) {
          console.warn(
            `📞 [NI] displayIncomingCall: CallKeep display update failed (non-fatal):`,
            updateErr
          );
        }
        this.mergeIosCallKitRecentsEndSnapshot(
          callUUID,
          callerName,
          remoteUriTrim
        );
      }

      console.log(
        "✅ [NativeIntegration] Displayed incoming call via CallKeep"
      );

      // Play device default incoming ringtone. Stopped when call is answered or ended in updateCallState.
      if (Platform.OS === "ios") {
        console.warn(
          `🔊 [NI-RINGBACK] ${new Date().toISOString()} displayIncomingCall: iOS starting ringtone (_DEFAULT_)`
        );
        InCallManager.startRingtone("_DEFAULT_", [], "default", -1);
        console.warn(
          `🔊 [NI-RINGBACK] ${new Date().toISOString()} displayIncomingCall: startRingtone() done`
        );
      }

      // Map the native call UUID to the SIP call ID
      this.activeCalls.set(callUUID, callId);
      console.warn(
        `📞 [NI] ${new Date().toISOString()} displayIncomingCall: stored mapping callUUID=${callUUID} → callId=${callId} | activeCalls size=${
          this.activeCalls.size
        }`
      );

      this.processPendingActionsForUuid(callUUID, callId);

      return callUUID;
    } catch (error) {
      console.error("Error displaying incoming call:", error);
      throw error;
    }
  }

  /**
   * Start an outgoing call in the native UI
   * @param callId SIP call ID
   * @param destination Destination phone number or SIP URI
   * @param localizedCallerName Optional contact name (e.g. attended transfer / address book)
   * @param preferredCallUUID Optional CallKit UUID (must match SIP X-VoxoConnect-Call-Uuid when both are used)
   * @returns Promise that resolves with the native call UUID
   */
  public async startOutgoingCall(
    callId: string,
    destination: string,
    localizedCallerName?: string,
    preferredCallUUID?: string
  ): Promise<string> {
    const ts = () => new Date().toISOString();
    const label = localizedCallerName?.trim();
    console.warn(
      `🔊 [NI-RINGBACK] ${ts()} startOutgoingCall ENTER platform=${
        Platform.OS
      } callId=${callId} destination=${destination} label=${
        label ?? "none"
      } initialized=${this.initialized}`
    );

    if (!this.initialized) {
      throw new Error("Native call integration not initialized");
    }

    try {
      const trimmedPreferred = preferredCallUUID?.trim();
      const usePreferred =
        trimmedPreferred &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          trimmedPreferred
        );
      // Generate a UUID for the native call (or reuse caller-supplied for SIP header alignment)
      const callUUID = usePreferred ? trimmedPreferred : uuid();
      // Mark this UUID as app-initiated so CallKit's didReceiveStartCallAction doesn't
      // start the SIP call a second time.
      this.startedOutgoingCallUuids.set(callUUID.toLowerCase(), Date.now());
      this.outboundCallKitUuids.add(callUUID.toLowerCase());

      // Third param: contact identifier; use display name when provided so CallKit shows the name.
      const contactIdentifier = label || destination;
      const destTrim = String(destination || "").trim();
      // Match Phone → Recents: first CXStartCallAction should use CXHandleTypePhoneNumber when the
      // dial string normalizes to E.164 or short extension — otherwise Recents rows miss the Phone field.
      let callKitHandleValue = String(destination || "");
      let callKitHandleType: "generic" | "number" | "phone" = "generic";
      if (Platform.OS === "ios") {
        const phoneForCk = iosCallKitPhoneHandleForRecents(destTrim);
        if (phoneForCk != null) {
          callKitHandleValue = phoneForCk;
          callKitHandleType = "number";
        }
        console.warn(
          `${RECENTS_TRACE} startOutgoingCall: CallKeep.startCall handleType=${callKitHandleType} ckHandleLen=${callKitHandleValue.length} destLen=${destTrim.length} uuid=${callUUID}`
        );
      }
      CallKeep.startCall(
        callUUID,
        callKitHandleValue,
        contactIdentifier,
        callKitHandleType,
        false
      );
      console.warn(`🔊 [NI-RINGBACK] ${ts()} CallKeep.startCall done`);
      if (Platform.OS === "ios") {
        try {
          const phone = iosCallKitPhoneHandleForRecents(destTrim);
          if (phone) {
            const displayForCk =
              (label && label.trim()) ||
              phone ||
              destTrim ||
              String(contactIdentifier || "").trim();
            console.warn(
              `${RECENTS_TRACE} startOutgoingCall: updateDisplay (phone handle) uuid=${callUUID} displayLen=${displayForCk.length}`
            );
            CallKeep.updateDisplay(callUUID, displayForCk, phone);
          } else if (label && label.trim()) {
            console.warn(
              `${RECENTS_TRACE} startOutgoingCall: reportUpdatedCall (name only) uuid=${callUUID} label=${label} destLen=${destTrim.length}`
            );
            const ckAny = CallKeep as unknown as {
              reportUpdatedCall?: (
                uuid: string,
                localizedCallerName: string
              ) => Promise<unknown>;
            };
            void ckAny.reportUpdatedCall?.(callUUID, label);
          }
        } catch (updateErr) {
          console.warn(
            `🔊 [NI-RINGBACK] ${ts()} CallKeep display update failed (non-fatal):`,
            updateErr
          );
        }
      }

      if (Platform.OS === "ios") {
        try {
          await this.startIosOutboundRingback();
        } catch (ringbackError) {
          console.error(
            `🔊 [NI-RINGBACK] ${ts()} iOS: ERROR during ringback setup:`,
            ringbackError
          );
        }
      } else {
        console.warn(
          `🔊 [NI-RINGBACK] ${ts()} Skipping ringback (not iOS, platform=${
            Platform.OS
          })`
        );
      }

      // Map the native call UUID to the SIP call ID
      this.activeCalls.set(callUUID, callId);
      this.mergeIosCallKitRecentsEndSnapshot(
        callUUID,
        label ?? "",
        String(destination || "")
      );
      console.warn(
        `📞 [NI] ${ts()} startOutgoingCall: stored mapping callUUID=${callUUID} → callId=${callId} | activeCalls size=${
          this.activeCalls.size
        }`
      );
      this.processPendingActionsForUuid(callUUID, callId);

      return callUUID;
    } catch (error) {
      console.error(`🔊 [NI-RINGBACK] ${ts()} startOutgoingCall ERROR:`, error);
      throw error;
    }
  }

  /**
   * Update the call state in the native UIs
   * @param callId SIP call ID
   * @param state Call states
   */
  public async updateCallState(
    callId: string,
    state: CallState
  ): Promise<void> {
    console.warn(
      `📞 [NI] ${new Date().toISOString()} updateCallState called: callId=${callId} state=${state} initialized=${
        this.initialized
      }`
    );
    if (!this.initialized) {
      console.warn(`📞 [NI] ⚠️ updateCallState SKIPPED - not initialized`);
      return;
    }

    // Keep SIP-level active call tracking independent from CallKeep UUID mapping.
    if (state === CallState.ENDED || state === CallState.FAILED) {
      this.activeSipCallIds.delete(callId);
    } else if (state !== CallState.IDLE) {
      this.activeSipCallIds.add(callId);
    }

    // Find the native call UUID for the SIP call ID
    const callUUID = this.getCallUUID(callId);
    console.warn(
      `📞 [NI] ${new Date().toISOString()} getCallUUID result: callId=${callId} → callUUID=${callUUID} activeCalls=${JSON.stringify(
        Array.from(this.activeCalls.entries())
      )}`
    );
    if (!callUUID) {
      // Some attended-transfer legs can exist without CallKeep mapping.
      // Keep audio session healthy based on SIP state even if UUID is missing.
      if (state === CallState.CONNECTED) {
        InCallManager.start({
          media: "audio",
          auto: true,
          ringback: ""
        });
        InCallManager.stopRingtone();
        InCallManager.stopRingback();
      } else if (state === CallState.ENDED || state === CallState.FAILED) {
        InCallManager.stopRingtone();
        InCallManager.stopRingback();
        const suppressEnd = shouldSuppressCallKeepEndForLeg(
          this.activeCalls,
          callId,
          ""
        );
        if (!suppressEnd && this.activeSipCallIds.size === 0) {
          InCallManager.stop();
          BackgroundTaskManager.endBackgroundTask();
        } else if (suppressEnd) {
          console.warn(
            "[MERGE-AUDIO] NI.updateCallState ENDED without CallKit UUID — keeping audio (merge leg)",
            JSON.stringify({ callId, activeSipCallIds: this.activeSipCallIds.size })
          );
        }
      }
      console.warn(
        `📞 [NI] ⚠️ updateCallState SKIPPED - no UUID found for callId=${callId}`
      );
      return;
    }

    try {
      if (state === CallState.ENDED || state === CallState.FAILED) {
        console.warn(
          `🔊 [NI-RINGBACK] ${new Date().toISOString()} updateCallState received ENDED/FAILED — will stop ringback soon. If this appears right after startRingback, the call failed immediately.`
        );
      }
      switch (state) {
        case CallState.CONNECTED: {
          // Call is connected
          const isIosOutboundCallKit =
            Platform.OS === "ios" &&
            this.outboundCallKitUuids.has(callUUID.toLowerCase());
          if (isIosOutboundCallKit) {
            try {
              CallKeep.reportConnectedOutgoingCallWithUUID(callUUID);
              console.warn(
                `📞 [NI] ${new Date().toISOString()} CallKeep.reportConnectedOutgoingCallWithUUID(${callUUID})`
              );
            } catch (reportErr) {
              console.warn(
                `📞 [NI] reportConnectedOutgoingCallWithUUID failed (non-fatal):`,
                reportErr
              );
            }
            // reportConnectedOutgoing already updates CallKit's connected state; setCurrentCallActive
            // on the same UUID can double-apply and contribute to CXEndCallAction Code=4 on hang-up.
            console.warn(
              `📞 [NI][CK-SYM] ${new Date().toISOString()} iOS outbound CallKit CONNECTED — skipping setCurrentCallActive (reportConnectedOutgoing is sufficient) uuid=${callUUID}`
            );
          } else {
            console.warn(
              `📞 [NI] ${new Date().toISOString()} CallKeep.setCurrentCallActive(${callUUID})`
            );
            CallKeep.setCurrentCallActive(callUUID);
          }

          console.warn(
            `🔊 [NI-RINGBACK] ${new Date().toISOString()} CONNECTED: starting InCallManager (no ringback), then stopping ringtone/ringback`
          );
          InCallManager.start({
            media: "audio",
            auto: true,
            ringback: "" // Empty ringback since call is connected
          });
          InCallManager.stopRingtone();
          InCallManager.stopRingback();
          console.warn(
            `🔊 [NI-RINGBACK] ${new Date().toISOString()} CONNECTED: stopRingtone/stopRingback done`
          );
          break;
        }

        case CallState.ENDED:
        case CallState.FAILED: {
          const suppressCallKeepEnd = shouldSuppressCallKeepEndForLeg(
            this.activeCalls,
            callId,
            callUUID
          );
          if (suppressCallKeepEnd) {
            console.warn(
              "[MERGE-AUDIO] NI.updateCallState skip CallKeep end — UUID kept for merge survivor",
              JSON.stringify({
                endedCallId: callId,
                callUUID,
                mappedSipSessionId:
                  this.activeCalls.get(callUUID) ??
                  Array.from(this.activeCalls.entries()).find(
                    ([u]) => u.toLowerCase() === callUUID.toLowerCase()
                  )?.[1] ??
                  null,
                activeSipCallIds: this.activeSipCallIds.size,
                activeCallsSize: this.activeCalls.size
              })
            );
            consumeCallKeepEndSuppressionForEndedLeg(
              this.activeCalls,
              callId,
              callUUID
            );
            InCallManager.stopRingtone();
            InCallManager.stopRingback();
            for (const sipSessionId of this.activeCalls.values()) {
              if (sipSessionId && sipSessionId !== callId) {
                this.activeSipCallIds.add(sipSessionId);
                this.ensureVoipAudioRouteForCall(sipSessionId);
              }
            }
            for (const sipSessionId of this.activeSipCallIds) {
              if (sipSessionId !== callId) {
                this.ensureVoipAudioRouteForCall(sipSessionId);
              }
            }
            break;
          }

          if (Platform.OS === "ios") {
            if (state === CallState.FAILED) {
              console.warn(
                `📞 [NI][CK-SYM] ${new Date().toISOString()} iOS FAILED → reportEndCallWithUUID(${callUUID}, failed) | callId=${callId}`
              );
              this.pushIosRecentsEndSnapshotNativeIfNeeded(callUUID);
              CallKeep.reportEndCallWithUUID(callUUID, 1);
            } else {
              // Symmetric lifecycle: CXStartCallAction → CXEndCallAction (see RNCallKeep performEndCallAction).
              console.warn(
                `📞 [NI][CK-SYM] ${new Date().toISOString()} iOS ENDED → CallKeep.endCall(${callUUID}) after SIP ended | callId=${callId}`
              );
              this.pushIosRecentsEndSnapshotNativeIfNeeded(callUUID);
              const ackKey = callUUID.toLowerCase();
              this.iosSymmetricEndCallPendingAck.add(ackKey);
              try {
                CallKeep.endCall(callUUID);
              } catch (endErr) {
                this.iosSymmetricEndCallPendingAck.delete(ackKey);
                console.warn(
                  `📞 [NI][CK-SYM] CallKeep.endCall failed, falling back to reportEndCallWithUUID:`,
                  endErr
                );
                CallKeep.reportEndCallWithUUID(callUUID, 2);
              }
            }
          } else {
            console.warn(
              `📞 [NI] ${new Date().toISOString()} Android ENDED/FAILED → reportEndCallWithUUID + endCall | callId=${callId} state=${state}`
            );
            CallKeep.reportEndCallWithUUID(
              callUUID,
              state === CallState.FAILED ? 1 : 2
            );
            CallKeep.endCall(callUUID);
          }

          console.warn(
            `🔊 [NI-RINGBACK] ${new Date().toISOString()} ENDED/FAILED: stopping ringtone/ringback for callId=${callId}`
          );
          InCallManager.stopRingtone();
          InCallManager.stopRingback();

          this.removeActiveCallsEntriesForCallKitUuid(callUUID);
          console.warn(
            `📞 [NI] ${new Date().toISOString()} Removed ${callUUID} from activeCalls (case-insensitive). Remaining: ${
              this.activeCalls.size
            }`
          );

          if (this.activeSipCallIds.size === 0) {
            console.warn(
              `🔊 [NI-RINGBACK] ${new Date().toISOString()} No active calls left: calling InCallManager.stop() so next call gets fresh audio session`
            );
            InCallManager.stop();
          }

          // End background task if no more active calls
          if (this.activeSipCallIds.size === 0) {
            // Do not call endAllCalls here. It races with iOS End & Accept and
            // can clear the incoming CallKit row before answerCall(newUuid).
            BackgroundTaskManager.endBackgroundTask();
          }
          break;
        }

        case CallState.HOLDING:
          // Call is on hold
          CallKeep.setOnHold(callUUID, true);
          break;
      }
    } catch (error) {
      console.error("📞 [NI] ❌ Error updating call state:", error);
    }
  }

  /**
   * Update the mute state in the native UI
   * @param callId SIP call ID
   * @param muted Whether the call should be muted
   */
  public async updateMuteState(callId: string, muted: boolean): Promise<void> {
    if (!this.initialized) {
      return;
    }

    // Find the native call UUID for the SIP call ID
    const callUUID = this.getCallUUID(callId);
    if (!callUUID) {
      return;
    }

    const uuidLower = callUUID.toLowerCase();
    if (this.callKitSyncedMuteByUuidLower.get(uuidLower) === muted) {
      return;
    }

    try {
      this.muteSuppressCallKitEchoUntil =
        Date.now() + NativeIntegration.MUTE_ECHO_SUPPRESS_MS;
      CallKeep.setMutedCall(callUUID, muted);
      this.callKitSyncedMuteByUuidLower.set(uuidLower, muted);
    } catch (error) {
      console.error("Error updating mute state:", error);
    }
  }

  /**
   * Resolve CallKeep / CallKit UUID for a SIP session id (DTMF, native UI).
   */
  public getCallUUIDForCallId(callId: string): string | undefined {
    return this.getCallUUID(callId);
  }

  /**
   * Push a resolved display name to CallKit (Phone → Recents, lock screen) for an active call.
   * When `dialHint` normalizes to strict E.164, also sets `remoteHandle` via `updateDisplay` so Recents
   * shows a Phone row; otherwise name-only `reportUpdatedCall` (extension / opaque SIP user).
   */
  public reportLocalizedCallerNameForActiveCall(
    sipSessionId: string,
    localizedCallerName: string,
    dialHint?: string
  ): void {
    if (Platform.OS !== "ios" || !this.initialized) {
      return;
    }
    const name = String(localizedCallerName || "").trim();
    if (!name) {
      return;
    }
    const callUUID = this.getCallUUID(sipSessionId);
    if (!callUUID) {
      iosCallFlowLog(
        "outbound",
        "CallKit display name skip (no UUID map for session)",
        { sipSessionId, nameLen: name.length }
      );
      return;
    }
    this.mergeIosCallKitRecentsEndSnapshot(callUUID, name, dialHint ?? "");
    const phone = iosCallKitPhoneHandleForRecents(dialHint);
    try {
      if (phone) {
        console.warn(
          `${RECENTS_TRACE} reportLocalizedCallerName: updateDisplay (phone handle) uuid=${callUUID} labelLen=${name.length}`
        );
        CallKeep.updateDisplay(callUUID, name, phone);
        iosCallFlowLog("outbound", "CallKit updateDisplay (resolved name)", {
          callUUID: callUUID.toLowerCase(),
          nameLen: name.length
        });
      } else {
        const ckAny = CallKeep as unknown as {
          reportUpdatedCall?: (
            uuid: string,
            localizedCallerName: string
          ) => Promise<unknown>;
        };
        const dest = extractDialUserFromUriOrHint(dialHint);
        console.warn(
          `${RECENTS_TRACE} reportLocalizedCallerName: reportUpdatedCall uuid=${callUUID} labelLen=${name.length} dialHintLen=${dest.length}`
        );
        void ckAny.reportUpdatedCall?.(callUUID, name);
        iosCallFlowLog("outbound", "CallKit reportUpdatedCall (resolved name)", {
          callUUID: callUUID.toLowerCase(),
          nameLen: name.length
        });
      }
    } catch (e) {
      console.warn(
        "[NativeIntegration] reportLocalizedCallerNameForActiveCall failed:",
        e
      );
    }
  }

  /**
   * Event handlers - these should be overridden by the softphone
   */
  public onAnswerCall: (callId: string) => void = () => {};

  public onEndCall: (callId: string) => void = () => {};

  public onMuteCall: (callId: string) => void = () => {};

  public onUnmuteCall: (callId: string) => void = () => {};

  public onSendDTMF: (callId: string, digits: string) => void = () => {};

  /** Outgoing call initiated from native UI (CallKit Recents / contacts). */
  public onStartCall: (args: {
    callUUID: string;
    handle: string;
    /** From CallKit when available (maps to CXStartCallAction.contactIdentifier / RN `name`). */
    name?: string;
  }) => void | Promise<void> = () => {};

  /** Wire Recents/Siri handler and flush any starts queued during killed-process launch. */
  public attachStartCallHandler(
    handler: (args: {
      callUUID: string;
      handle: string;
      name?: string;
    }) => void | Promise<void>
  ): void {
    this.onStartCall = handler;
    this.startCallHandlerAttached = true;
    this.flushPendingRecentsStarts();
  }

  private flushPendingRecentsStarts(): void {
    void this.flushPendingRecentsStartsAsync();
  }

  private async flushPendingRecentsStartsAsync(): Promise<void> {
    if (!this.startCallHandlerAttached || this.pendingRecentsStarts.length === 0) {
      return;
    }

    const graceRemainingMs = getOutboundStartupGraceRemainingMs();
    if (graceRemainingMs > 0) {
      if (this.pendingRecentsFlushTimer != null) {
        return;
      }
      iosCallFlowLog("outbound", "defer recents flush — startup grace", {
        remainingMs: graceRemainingMs,
        queued: this.pendingRecentsStarts.length
      });
      this.pendingRecentsFlushTimer = setTimeout(() => {
        this.pendingRecentsFlushTimer = null;
        void this.flushPendingRecentsStartsAsync();
      }, graceRemainingMs);
      return;
    }

    const rawBatch = [...this.pendingRecentsStarts];
    const batch = dedupePendingRecentsStarts(rawBatch);
    this.pendingRecentsStarts = [];
    if (batch.length < rawBatch.length) {
      iosCallFlowLog("outbound", "deduped pending Recents flush", {
        before: rawBatch.length,
        after: batch.length
      });
      console.warn(
        `${RECENTS_TRACE} flushPendingRecents deduped ${rawBatch.length} → ${batch.length}`
      );
    }
    for (const item of batch) {
      try {
        await Promise.resolve(this.onStartCall(item));
      } catch (e) {
        console.error(
          "🔵 [NativeIntegration] 📞 flush pending Recents onStartCall threw:",
          e
        );
      }
    }
  }

  private enqueuePendingRecentsStart(item: PendingRecentsStart): void {
    const handleKey = normalizeOutboundRecentsHandle(item.handle);
    if (handleKey) {
      this.pendingRecentsStarts = this.pendingRecentsStarts.filter(
        (x) => normalizeOutboundRecentsHandle(x.handle) !== handleKey
      );
    }
    this.pendingRecentsStarts = this.pendingRecentsStarts.filter(
      (x) => x.callUUID !== item.callUUID
    );
    this.pendingRecentsStarts.push(item);
    while (this.pendingRecentsStarts.length > PENDING_RECENTS_MAX) {
      this.pendingRecentsStarts.shift();
    }
  }

  /**
   * Set up app state monitoring for background call handling
   */
  private setupAppStateMonitoring(): void {
    AppState.addEventListener("change", (nextAppState: AppStateStatus) => {
      logger.debug(
        `App state changed from ${this.appState} to ${nextAppState}`
      );

      if (
        this.appState.match(/inactive|background/) &&
        nextAppState === "active"
      ) {
        // App has come to the foreground
        logger.debug("App resumed from background - checking active calls");
        this.handleAppResume();
      } else if (
        this.appState === "active" &&
        nextAppState.match(/inactive|background/)
      ) {
        // App is going to background
        logger.debug("App going to background - maintaining call state");
        this.handleAppBackground();
      }

      this.appState = nextAppState;
    });
  }

  /**
   * Handle app resuming from background
   */
  private handleAppResume(): void {
    // Check if there are any active calls that need to be restored
    if (this.activeCalls.size > 0) {
      logger.debug(
        `Restoring ${this.activeCalls.size} active calls from background`
      );
      // The call state should be maintained by CallKit and the softphone
    }
  }

  /**
   * Handle app going to background
   */
  private handleAppBackground(): void {
    if (this.activeCalls.size > 0) {
      logger.debug(
        `Maintaining ${this.activeCalls.size} active calls in background`
      );
      // Start background task to maintain call state
      BackgroundTaskManager.startBackgroundTask();
    }
  }

  /**
   * Set up CallKeep event listeners
   */
  private setupCallKeepListeners(): void {
    // Handle incoming calls answered from native UI
    // Handle incoming calls answered from native UI
    CallKeep.addEventListener("answerCall", ({ callUUID }) => {
      iosCallFlowLog("inbound", "accept button hit (CallKeep/native)", {
        callUUID,
        appState: this.appState,
        activeCallsSize: this.activeCalls.size
      });
      console.warn(
        `[END-ACCEPT-TRACE][ios-project][NI][answerCall] tapAcceptCallUUID=${callUUID} activeCallsCount=${
          this.activeCalls.size
        } activeCalls=${JSON.stringify(Array.from(this.activeCalls.entries()))}`
      );
      console.log(
        "🔵 [NativeIntegration] 📞 ⚡ CallKeep answerCall event received:",
        {
          callUUID,
          timestamp: new Date().toISOString(),
          appState: this.appState,
          activeCallsSize: this.activeCalls.size,
          activeCallsKeys: Array.from(this.activeCalls.keys()),
          activeCallsEntries: Array.from(this.activeCalls.entries()).map(
            ([uuid, id]) => ({ uuid, id })
          )
        }
      );

      // Handle answer call from native UI
      let callId = this.activeCalls.get(callUUID);

      // iOS CallKit may uppercase the UUID. Try case-insensitive lookup.
      if (!callId) {
        const lowerUUID = callUUID.toLowerCase();
        for (const [storedUUID, storedCallId] of this.activeCalls.entries()) {
          if (storedUUID.toLowerCase() === lowerUUID) {
            callId = storedCallId;
            break;
          }
        }
      }

      // iOS killed state: displayIncomingCall was skipped so activeCalls has no mapping.
      // Check VoipBridge directly - it tracks VoIP calls by UUID from the push payload.
      if (!callId && Platform.OS === "ios") {
        const voipBridge = VoipBridge.getInstance();
        const lowerUUID = callUUID.toLowerCase();

        // Try exact match first, then lowercase
        if (voipBridge.isVoipCall(callUUID)) {
          callId = callUUID;
        } else if (voipBridge.isVoipCall(lowerUUID)) {
          callId = lowerUUID;
        }

        if (callId) {
          console.log(
            "🔵 [NativeIntegration] 📞 iOS: Found VoIP call via VoipBridge (killed state):",
            { callUUID, resolvedCallId: callId }
          );
          iosCallFlowLog(
            "inbound.killed",
            "resolved VoIP call via bridge in killed/locked path",
            {
              callUUID,
              resolvedCallId: callId
            }
          );
          // Register the mapping for future use
          this.activeCalls.set(callUUID, callId);
          this.processPendingActionsForUuid(callUUID, callId);
        }
      }

      console.log("🔵 [NativeIntegration] 📞 UUID to callId mapping:", {
        callUUID,
        callId,
        found: !!callId
      });
      console.warn(
        `[END-ACCEPT-TRACE][ios-project][NI][answerCall] resolvedIncomingCallUUID=${callUUID} resolvedIncomingCallId=${
          callId || "undefined"
        }`
      );

      if (callId) {
        const oldCallEntries = Array.from(this.activeCalls.entries()).filter(
          ([uuid]) => uuid.toLowerCase() !== callUUID.toLowerCase()
        );
        console.warn(
          `[END-ACCEPT-TRACE][ios-project][NI][answerCall] oldCallEntriesToEnd=${JSON.stringify(
            oldCallEntries
          )}`
        );
        const voipBridge = VoipBridge.getInstance();
        const isVoipFromBridge = voipBridge.isVoipCall(callId);
        const isIosUuidStyleVoip =
          Platform.OS === "ios" &&
          callId.toLowerCase() === callUUID.toLowerCase();
        const isVoip = isVoipFromBridge || isIosUuidStyleVoip;
        console.log("🔵 [NativeIntegration] 📞 Call type check:", {
          callId,
          callUUID,
          isVoip,
          isVoipFromBridge,
          isIosUuidStyleVoip,
          platform: Platform.OS,
          willCall: isVoip ? "voipBridge.handleCallAnswer" : "this.onAnswerCall"
        });
        console.warn(
          `[END-ACCEPT-TRACE][ios-project][NI][answerCall] routeDecision callUUID=${callUUID} callId=${callId} isVoip=${isVoip} isVoipFromBridge=${isVoipFromBridge} isIosUuidStyleVoip=${isIosUuidStyleVoip} target=${
            isVoip ? "voipBridge.handleCallAnswer" : "this.onAnswerCall"
          }`
        );

        if (isVoip) {
          console.log(
            "🔵 [NativeIntegration] 📞 VoIP call answered, calling voipBridge.handleCallAnswer:",
            callId
          );
          iosCallFlowLog("inbound", "routing answer to VoIP bridge", {
            callUUID,
            callId
          });
          voipBridge.handleCallAnswer(callId);
          console.log(
            "🔵 [NativeIntegration] 📞 ✅ voipBridge.handleCallAnswer called"
          );

          // Return for VoIP calls on both platforms.
          // The SIP session establishment and answering is handled by
          // handleVoipAnswer in SoftphoneProvider (via answerVoipCall event).
          // Calling onAnswerCall here would fail because the SIP session
          // doesn't exist yet (especially in killed state).
          return;
        }

        console.log(
          "🔵 [NativeIntegration] 📞 Calling this.onAnswerCall:",
          callId
        );
        this.onAnswerCall(callId);
        iosCallFlowLog(
          "inbound",
          "routing answer to SessionManager.onAnswerCall",
          {
            callUUID,
            callId
          }
        );
        console.log("🔵 [NativeIntegration] 📞 ✅ this.onAnswerCall called");
      } else {
        logger.warn(
          `Received answerCall for unknown UUID ${callUUID}, queuing`
        );
        iosCallFlowError(
          "inbound",
          "answer tapped for unknown UUID",
          new Error("UNKNOWN_UUID"),
          {
            callUUID
          }
        );
        console.log(
          "🔵 [NativeIntegration] 📞 ⚠️ Unknown UUID, queuing answerCall action:",
          {
            callUUID,
            activeCallsMap: Array.from(this.activeCalls.entries())
          }
        );
        if (!this.pendingActions.has(callUUID)) {
          this.pendingActions.set(callUUID, []);
        }
        this.pendingActions.get(callUUID)?.push({ type: "answerCall" });
      }
    });

    // Handle calls ended from native UI (RNCallKeepPerformEndCallAction)
    CallKeep.addEventListener("endCall", ({ callUUID }) => {
      const lowerUuid = callUUID.toLowerCase();
      if (
        Platform.OS === "ios" &&
        this.iosSymmetricEndCallPendingAck.has(lowerUuid)
      ) {
        this.iosSymmetricEndCallPendingAck.delete(lowerUuid);
        console.warn(
          `📞 [NI][CK-SYM] ${new Date().toISOString()} performEndCallAction → JS endCall event — SIP already ended via app hangup, skip onEndCall | uuid=${callUUID}`
        );
        return;
      }

      console.warn(
        `[END-ACCEPT-TRACE][ios-project][NI][endCall] tapEndCallUUID=${callUUID} activeCallsCount=${
          this.activeCalls.size
        } activeCalls=${JSON.stringify(Array.from(this.activeCalls.entries()))}`
      );
      console.warn(
        `📞 [NI] ${new Date().toISOString()} CallKeep endCall event: callUUID=${callUUID} activeCalls=${JSON.stringify(
          Array.from(this.activeCalls.entries())
        )}`
      );
      let callId = this.activeCalls.get(callUUID);

      // Case-insensitive UUID lookup (iOS CallKit may uppercase)
      if (!callId) {
        const lowerUUID = callUUID.toLowerCase();
        for (const [storedUUID, storedCallId] of this.activeCalls.entries()) {
          if (storedUUID.toLowerCase() === lowerUUID) {
            callId = storedCallId;
            console.warn(
              `📞 [NI] endCall: case-insensitive match found: ${storedUUID} → ${storedCallId}`
            );
            break;
          }
        }
      }

      // iOS killed state fallback: check VoipBridge directly
      if (!callId && Platform.OS === "ios") {
        const voipBridge = VoipBridge.getInstance();
        const lowerUUID = callUUID.toLowerCase();
        if (voipBridge.isVoipCall(callUUID)) {
          callId = callUUID;
        } else if (voipBridge.isVoipCall(lowerUUID)) {
          callId = lowerUUID;
        }
        if (callId) {
          console.warn(
            `📞 [NI] endCall: VoipBridge fallback found callId=${callId}`
          );
        }
      }

      if (callId) {
        // Check if this is a VoIP call
        // VoIP calls use callUUID as callId; SessionManager uses different IDs.
        // When callId === callUUID (case-insensitive), treat as VoIP so we properly
        // terminate the SIP session when user hangs up from lock screen or power button.
        const voipBridge = VoipBridge.getInstance();
        const hasJsSipSession = !!getSipSession(callId);
        const isVoipCall =
          voipBridge.isVoipCall(callId) ||
          (Platform.OS === "ios" &&
            !hasJsSipSession &&
            callId.toLowerCase() === callUUID.toLowerCase());

        if (isVoipCall) {
          console.warn(
            `📞 [NI] endCall: VoIP call → voipBridge.handleCallEnd(${callId})`
          );
          voipBridge.handleCallEnd(callId);
        } else {
          console.warn(`📞 [NI] endCall: SIP call → this.onEndCall(${callId})`);
          this.onEndCall(callId);
        }
        this.removeActiveCallsEntriesForCallKitUuid(callUUID);
        console.warn(
          `📞 [NI] endCall: removed ${callUUID} from activeCalls. Remaining: ${this.activeCalls.size}`
        );
      } else {
        console.warn(`📞 [NI] ⚠️ endCall: unknown UUID ${callUUID}, queuing`);
        logger.warn(`Received endCall for unknown UUID ${callUUID}, queuing`);
        if (!this.pendingActions.has(callUUID)) {
          this.pendingActions.set(callUUID, []);
        }
        this.pendingActions.get(callUUID)?.push({ type: "endCall" });
      }
    });

    // Handle calls muted from native UI
    CallKeep.addEventListener(
      "didPerformSetMutedCallAction",
      ({ callUUID, muted }) => {
        if (Date.now() < this.muteSuppressCallKitEchoUntil) {
          return;
        }

        const uuidLower = String(callUUID || "").trim().toLowerCase();
        const callId = this.getMappedCallIdForCallKitUuidLower(uuidLower);
        if (!callId) {
          return;
        }

        this.callKitSyncedMuteByUuidLower.set(uuidLower, muted);

        const sip = getSipSession(callId);
        if (sip) {
          if (muted && sip.muted) {
            return;
          }
          if (!muted && !sip.muted) {
            return;
          }
        }

        if (muted) {
          this.onMuteCall(callId);
        } else {
          this.onUnmuteCall(callId);
        }
      }
    );

    // Handle DTMF tones from native UI
    CallKeep.addEventListener(
      "didReceiveStartCallAction",
      (ev: {
        callUUID?: string;
        handle?: string;
        name?: string;
        localizedCallerName?: string;
      }) => {
        const { callUUID, handle } = ev;
        const contactName = String(
          ev.name ?? ev.localizedCallerName ?? ""
        ).trim();
        const now = Date.now();
        const rawUUID =
          typeof callUUID === "string" && callUUID.trim().length > 0
            ? callUUID.trim().toLowerCase()
            : "";

        iosCallFlowLog("outbound", "CallKeep didReceiveStartCallAction", {
          callUUID: callUUID ?? "",
          handle: handle ?? "",
          nameLen: contactName.length,
          appState: this.appState
        });
        console.log(
          "🔵 [NativeIntegration] 📞 Outgoing startCall from native UI:",
          {
            callUUID: callUUID ?? "",
            handle: handle ?? "",
            name: contactName || undefined,
            timestamp: new Date().toISOString(),
            appState: this.appState
          }
        );

        if (Platform.OS === "ios" && isOutboundStartupGraceActive()) {
          const deferUuid = rawUUID || uuid();
          this.enqueuePendingRecentsStart({
            callUUID: deferUuid,
            handle: String(handle || ""),
            ...(contactName ? { name: contactName } : {})
          });
          iosCallFlowLog("outbound", "didReceiveStartCallAction deferred (startup grace)", {
            callUUID: deferUuid,
            remainingMs: getOutboundStartupGraceRemainingMs()
          });
          console.warn(
            `${RECENTS_TRACE} didReceiveStartCallAction DEFER startup_grace uuid=${deferUuid} remainingMs=${getOutboundStartupGraceRemainingMs()}`
          );
          this.flushPendingRecentsStarts();
          return;
        }

        // If this UUID is already mapped to a real SIP session, ignore. Do NOT treat the
        // temporary uuid→uuid placeholder (Recents) as "handled" — a second native
        // callback would otherwise skip SIP entirely.
        if (rawUUID) {
          if (getSipSession(rawUUID)) {
            console.warn(
              `${RECENTS_TRACE} didReceiveStartCallAction SKIP sip_session_exists uuid=${rawUUID}`
            );
            iosCallFlowLog(
              "outbound",
              "didReceiveStartCallAction ignored (SIP session exists)",
              { callUUID: rawUUID }
            );
            return;
          }
          if (
            this.outboundCallKitUuids.has(rawUUID) &&
            this.startedOutgoingCallUuids.has(rawUUID)
          ) {
            console.warn(
              `${RECENTS_TRACE} didReceiveStartCallAction SKIP app_outbound_in_progress uuid=${rawUUID}`
            );
            iosCallFlowLog(
              "outbound",
              "didReceiveStartCallAction ignored (app outbound in progress)",
              { callUUID: rawUUID }
            );
            return;
          }
          const existingCallId =
            this.getMappedCallIdForCallKitUuidLower(rawUUID);
          const isRecentsPlaceholderMapping =
            typeof existingCallId === "string" &&
            existingCallId.trim().toLowerCase() === rawUUID;
          if (existingCallId != null && !isRecentsPlaceholderMapping) {
            console.warn(
              `${RECENTS_TRACE} didReceiveStartCallAction SKIP already_mapped uuid=${rawUUID} existingCallId=${existingCallId}`
            );
            console.warn(
              `📞 [NI] didReceiveStartCallAction ignored (already mapped to SIP session) uuid=${rawUUID} callId=${existingCallId}`
            );
            return;
          }
          const lastAppInitiatedAt = this.startedOutgoingCallUuids.get(rawUUID);
          if (lastAppInitiatedAt && now - lastAppInitiatedAt < 15000) {
            console.warn(
              `${RECENTS_TRACE} didReceiveStartCallAction SKIP app_initiated_window uuid=${rawUUID} dtMs=${now - lastAppInitiatedAt}`
            );
            console.warn(
              `📞 [NI] didReceiveStartCallAction ignored (app-initiated) uuid=${rawUUID} handle=${String(
                handle || ""
              )} dtMs=${now - lastAppInitiatedAt}`
            );
            return;
          }
        }

        const safeUUID = rawUUID || uuid();
        const lastStartedAt = this.startedOutgoingCallUuids.get(safeUUID);
        if (lastStartedAt && now - lastStartedAt < 5000) {
          console.warn(
            `${RECENTS_TRACE} didReceiveStartCallAction SKIP duplicate uuid=${safeUUID} dtMs=${now - lastStartedAt}`
          );
          console.warn(
            `📞 [NI] Duplicate didReceiveStartCallAction ignored uuid=${safeUUID} handle=${String(
              handle || ""
            )} dtMs=${now - lastStartedAt}`
          );
          return;
        }
        this.startedOutgoingCallUuids.set(safeUUID, now);
        // Keep map bounded
        if (this.startedOutgoingCallUuids.size > 50) {
          const oldest = Array.from(this.startedOutgoingCallUuids.entries()).sort(
            (a, b) => a[1] - b[1]
          )[0];
          if (oldest) this.startedOutgoingCallUuids.delete(oldest[0]);
        }

        // For CallKit-initiated calls (Recents/Siri), we don't have a SIP callId yet.
        // Store a temporary mapping until SoftphoneProvider/SippyCup registers the real callId.
        if (!this.activeCalls.has(safeUUID)) {
          this.activeCalls.set(safeUUID, safeUUID);
        }
        this.activeSipCallIds.add(safeUUID);

        if (Platform.OS === "ios") {
          const phone = iosCallKitPhoneHandleForRecents(String(handle || ""));
          if (phone && contactName.length > 0) {
            try {
              CallKeep.updateDisplay(safeUUID, contactName, phone);
              console.warn(
                `${RECENTS_TRACE} didReceiveStartCallAction early updateDisplay uuid=${safeUUID} nameLen=${contactName.length}`
              );
              iosCallFlowLog("outbound", "CallKit updateDisplay after Recents start", {
                callUUID: safeUUID,
                nameLen: contactName.length,
                dialLen: phone.length
              });
            } catch (e) {
              console.warn(
                `${RECENTS_TRACE} didReceiveStartCallAction updateDisplay failed`,
                e
              );
            }
          }
        }

        if (Platform.OS === "ios" && !this.startCallHandlerAttached) {
          this.enqueuePendingRecentsStart({
            callUUID: safeUUID,
            handle: String(handle || ""),
            ...(contactName ? { name: contactName } : {})
          });
          console.warn(
            `${RECENTS_TRACE} didReceiveStartCallAction QUEUED until attachStartCallHandler uuid=${safeUUID}`
          );
          console.warn(
            `📞 [NI] didReceiveStartCallAction queued until attachStartCallHandler uuid=${safeUUID}`
          );
          return;
        }

        try {
          console.warn(
            `${RECENTS_TRACE} didReceiveStartCallAction → onStartCall uuid=${safeUUID} handleLen=${String(handle || "").length}`
          );
          void this.onStartCall({
            callUUID: safeUUID,
            handle: String(handle || ""),
            ...(contactName ? { name: contactName } : {})
          });
        } catch (e) {
          console.error(
            "🔵 [NativeIntegration] 📞 onStartCall handler threw:",
            e
          );
        }
      }
    );

    // Handle DTMF tones from native UI
    CallKeep.addEventListener(
      "didPerformDTMFAction",
      ({ callUUID, digits }) => {
        const callId = this.resolveCallIdForCallKeepUUID(callUUID);
        console.warn("[DTMF-TRACE] N NativeIntegration.didPerformDTMFAction", {
          callUUID,
          digits,
          resolvedCallId: callId ?? null,
          activeCallKeys: Array.from(this.activeCalls.keys()),
          project: "ios-project"
        });
        if (callId && digits != null && String(digits).length > 0) {
          this.onSendDTMF(callId, String(digits));
        }
      }
    );
  }

  private resolveCallIdForCallKeepUUID(callUUID: string): string | undefined {
    const callId = this.activeCalls.get(callUUID);
    if (callId) {
      return callId;
    }
    const lowerUUID = callUUID.toLowerCase();
    for (const [storedUUID, storedCallId] of this.activeCalls.entries()) {
      if (storedUUID.toLowerCase() === lowerUUID) {
        return storedCallId;
      }
    }
    return undefined;
  }

  private processPendingActionsForUuid(callUUID: string, callId: string): void {
    const pending = this.pendingActions.get(callUUID);
    if (!pending || pending.length === 0) {
      return;
    }

    logger.debug(
      `Processing ${pending.length} pending actions for ${callUUID}`
    );
    for (const action of pending) {
      switch (action.type) {
        case "answerCall": {
          const voipBridge = VoipBridge.getInstance();
          const isVoipFromBridge =
            voipBridge.isVoipCall(callId) ||
            voipBridge.isVoipCall(callUUID) ||
            voipBridge.hasPendingAnswer(callId);
          const isIosUuidVoip =
            Platform.OS === "ios" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              callId
            ) &&
            !!getSipSession(callId);
          if (isVoipFromBridge || isIosUuidVoip) {
            iosCallFlowLog(
              "inbound",
              "pending answer routed to VoipBridge (killed/deferred boot)",
              { callUUID, callId }
            );
            voipBridge.handleCallAnswer(callId);
          } else {
            this.onAnswerCall(callId);
          }
          break;
        }
        case "endCall":
          this.onEndCall(callId);
          break;
        case "setMutedCall":
          if (action.payload?.muted) {
            this.onMuteCall(callId);
          } else {
            this.onUnmuteCall(callId);
          }
          break;
        case "DTMF":
          this.onSendDTMF(callId, action.payload?.digits);
          break;
      }
    }
    this.pendingActions.delete(callUUID);
  }

  /**
   * iOS: remember display + dial hint for a CallKit UUID so we can merge into the archived Recents row
   * immediately before native end (see RNCallKeep setCallRecentsEndSnapshot / pre-end CXCallUpdate).
   */
  private mergeIosCallKitRecentsEndSnapshot(
    callUUID: string,
    displayName?: string,
    dialHint?: string
  ): void {
    if (Platform.OS !== "ios") {
      return;
    }
    const key = String(callUUID || "").trim().toLowerCase();
    if (!key) {
      return;
    }
    const prev = this.iosCallKitRecentsEndSnapshotByUuidLower.get(key) ?? {
      displayName: "",
      dialHint: ""
    };
    const d = String(displayName ?? "").trim();
    const h = String(dialHint ?? "").trim();
    this.iosCallKitRecentsEndSnapshotByUuidLower.set(key, {
      displayName: d.length > 0 ? d : prev.displayName,
      dialHint: h.length > 0 ? h : prev.dialHint
    });
  }

  /** iOS: push merged snapshot to native so the next `endCall` / `reportEndCallWithUUID` freezes it into Recents. */
  private pushIosRecentsEndSnapshotNativeIfNeeded(callUUID: string): void {
    if (Platform.OS !== "ios") {
      return;
    }
    const key = String(callUUID || "").trim().toLowerCase();
    if (!key) {
      return;
    }
    const meta = this.iosCallKitRecentsEndSnapshotByUuidLower.get(key);
    const display = (meta?.displayName ?? "").trim();
    const dialHint = (meta?.dialHint ?? "").trim();
    const phone = dialHint ? iosCallKitPhoneHandleForRecents(dialHint) ?? "" : "";
    if (!display && !phone) {
      return;
    }
    const mod = NativeModules.RNCallKeep as
      | { setCallRecentsEndSnapshot?: (u: string, d: string, h: string) => void }
      | undefined;
    if (typeof mod?.setCallRecentsEndSnapshot !== "function") {
      return;
    }
    mod.setCallRecentsEndSnapshot(callUUID, display, phone);
    iosCallFlowLog("outbound", "CallKit setCallRecentsEndSnapshot (pre native end)", {
      callUUID: key,
      nameLen: display.length,
      hasPhoneHandle: phone.length > 0
    });
  }

  /**
   * Drop CallKit UUID keys case-insensitively (native may change casing).
   * Keeps activeCalls.size accurate so background / resume logs match reality.
   */
  private removeActiveCallsEntriesForCallKitUuid(uuidFromNative: string): void {
    const needle = String(uuidFromNative || "").trim().toLowerCase();
    if (!needle) return;
    const keysToRemove: string[] = [];
    for (const k of this.activeCalls.keys()) {
      if (k.toLowerCase() === needle) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      const sipOrPlaceholderId = this.activeCalls.get(k);
      if (sipOrPlaceholderId != null) {
        this.activeSipCallIds.delete(sipOrPlaceholderId);
      }
      this.activeCalls.delete(k);
      this.startedOutgoingCallUuids.delete(k.toLowerCase());
      this.iosCallKitRecentsEndSnapshotByUuidLower.delete(k.toLowerCase());
      this.callKitSyncedMuteByUuidLower.delete(k.toLowerCase());
    }
    this.activeSipCallIds.delete(needle);
    this.outboundCallKitUuids.delete(needle);
    this.iosCallKitRecentsEndSnapshotByUuidLower.delete(needle);
    this.callKitSyncedMuteByUuidLower.delete(needle);
    for (const pk of this.pendingActions.keys()) {
      if (pk.toLowerCase() === needle) {
        this.pendingActions.delete(pk);
      }
    }
  }

  /** Resolve activeCalls value by CallKit UUID (case-insensitive key match). */
  private getMappedCallIdForCallKitUuidLower(lowerUuid: string): string | undefined {
    const direct = this.activeCalls.get(lowerUuid);
    if (direct !== undefined) return direct;
    for (const [storedUuid, id] of this.activeCalls.entries()) {
      if (storedUuid.toLowerCase() === lowerUuid) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Get the native call UUID for a SIP call ID
   * @param callId SIP call ID
   * @returns Native call UUID or undefined if not found
   */
  private getCallUUID(callId: string): string | undefined {
    for (const [uuid, id] of this.activeCalls.entries()) {
      if (id === callId) {
        return uuid;
      }
    }
    if (Platform.OS === "ios") {
      const needle = String(callId || "").trim().toLowerCase();
      if (needle && this.outboundCallKitUuids.has(needle)) {
        return needle;
      }
    }
    return undefined;
  }

  /**
   * iOS: seed Recents end snapshot for CallKit-originated calls (e.g. Phone → Recents redial) so
   * `pushIosRecentsEndSnapshotNativeIfNeeded` has dial hint before `callRemotePartyUpdated`.
   */
  public primeIosCallKitRecentsEndSnapshot(
    callUUID: string,
    dialHint: string,
    displayName?: string
  ): void {
    if (Platform.OS !== "ios") {
      return;
    }
    this.mergeIosCallKitRecentsEndSnapshot(
      callUUID,
      String(displayName ?? "").trim(),
      String(dialHint ?? "").trim()
    );
  }

  /**
   * Map an alternate CallKit UUID (e.g. from PushKit) to the same SIP session id
   * so answerCall/endCall from CallKit resolve when native and JS used different UUIDs.
   */
  public registerCallUuidAlias(aliasUuid: string, callId: string): void {
    this.activeCalls.set(aliasUuid, callId);
    console.warn(
      `📞 [NI] registerCallUuidAlias: ${aliasUuid} → callId=${callId} | activeCalls size=${this.activeCalls.size}`
    );
    this.processPendingActionsForUuid(aliasUuid, callId);
  }

  /**
   * Rebind an existing native CallKeep UUID from one SIP call ID to another.
   * Used for attended transfer conference merge where parent leg ends but
   * child leg must keep the same native call/audio session.
   */
  public rebindCallUUID(
    fromCallId: string,
    toCallId: string
  ): string | undefined {
    let sourceUUID = this.getCallUUID(fromCallId);
    if (!sourceUUID && this.activeCalls.size === 1) {
      sourceUUID = Array.from(this.activeCalls.keys())[0];
      console.warn(
        `📞 [NI] rebindCallUUID: single-call fallback from=${fromCallId} to=${toCallId} uuid=${sourceUUID}`
      );
    }

    const existingTargetUUID = this.getCallUUID(toCallId);

    // Parent and Add-Person child often each have their own CallKit UUID. The old
    // early-return when the child was already mapped skipped reassigning the
    // parent's UUID to the surviving leg, leaving a stale map entry that could
    // tear down the wrong native call when the parent SIP session ends.
    if (existingTargetUUID && sourceUUID && existingTargetUUID !== sourceUUID) {
      this.activeCalls.set(sourceUUID, toCallId);
      getSuppressedCallKeepEndSet().add(sourceUUID);
      getSuppressedCallKeepEndSet().add(existingTargetUUID);
      console.warn(
        `📞 [NI] rebindCallUUID: dual-UUID merge parentUUID=${sourceUUID} childUUID=${existingTargetUUID} → callId=${toCallId}`
      );
      console.warn(
        "[MERGE-AUDIO] NI.rebindCallUUID",
        JSON.stringify({
          branch: "dualUuidConsolidated",
          fromCallId,
          toCallId,
          returnedUuid: sourceUUID,
          existingTargetUUID,
          activeCallsSize: this.activeCalls.size
        })
      );
      this.processPendingActionsForUuid(sourceUUID, toCallId);
      return sourceUUID;
    }

    if (existingTargetUUID && !sourceUUID) {
      console.warn(
        "[MERGE-AUDIO] NI.rebindCallUUID",
        JSON.stringify({
          branch: "childAlreadyMappedNoParentUuid",
          fromCallId,
          toCallId,
          returnedUuid: existingTargetUUID,
          activeCallsSize: this.activeCalls.size
        })
      );
      return existingTargetUUID;
    }

    if (!sourceUUID) {
      console.warn(
        `📞 [NI] rebindCallUUID: no source UUID found for fromCallId=${fromCallId} toCallId=${toCallId}`
      );
      console.warn(
        "[MERGE-AUDIO] NI.rebindCallUUID",
        JSON.stringify({
          branch: "noSourceUuid",
          fromCallId,
          toCallId,
          returnedUuid: null,
          activeCallsSize: this.activeCalls.size,
          activeCallIdEntries: Array.from(this.activeCalls.entries()).map(
            ([uuid, id]) => ({ callKitUuid: uuid, sipSessionId: id })
          )
        })
      );
      return undefined;
    }

    this.activeCalls.set(sourceUUID, toCallId);
    // Parent leg can emit sessionEnded shortly after merge; suppress direct
    // CallKeep end for this UUID so child leg keeps native audio/call state.
    getSuppressedCallKeepEndSet().add(sourceUUID);
    console.warn(
      `📞 [NI] rebindCallUUID: reassigned callUUID=${sourceUUID} from ${fromCallId} to ${toCallId}`
    );
    console.warn(
      "[MERGE-AUDIO] NI.rebindCallUUID",
      JSON.stringify({
        branch: "reassignedParentUuidToChild",
        fromCallId,
        toCallId,
        returnedUuid: sourceUUID,
        activeCallsSize: this.activeCalls.size
      })
    );
    this.processPendingActionsForUuid(sourceUUID, toCallId);
    return sourceUUID;
  }

  /**
   * Re-apply CallKit + InCallManager audio routing for a connected SIP session.
   * Use after conference merge / UUID rebind when iOS sometimes drops capture or playback.
   */
  public ensureVoipAudioRouteForCall(callId: string): void {
    if (Platform.OS !== "ios" || !this.initialized) {
      return;
    }

    try {
      const callUUID = this.getCallUUID(callId);
      if (callUUID) {
        CallKeep.setCurrentCallActive(callUUID);
      }
      InCallManager.start({
        media: "audio",
        auto: true,
        ringback: ""
      });
      InCallManager.stopRingtone();
      InCallManager.stopRingback();
      console.warn(
        "[MERGE-AUDIO] NI.ensureVoipAudioRouteForCall",
        JSON.stringify({
          sipSessionId: callId,
          hasCallKitUuid: !!callUUID,
          callKitUuid: callUUID ?? null,
          didCallKeepSetCurrentCallActive: !!callUUID,
          inCallManagerStarted: true
        })
      );
    } catch (e: any) {
      console.warn(
        "[MERGE-AUDIO] NI.ensureVoipAudioRouteForCall FAILED",
        JSON.stringify({
          sipSessionId: callId,
          error: e?.message || String(e)
        })
      );
      console.warn(
        `📞 [NI] ensureVoipAudioRouteForCall failed callId=${callId}:`,
        e?.message || e
      );
    }
  }

  /**
   * Answer a call via CallKeep (triggers native answer flow)
   * This should be used instead of calling answerCall directly to ensure
   * CallKeep is properly notified and audio routing works correctly
   * @param callId SIP call ID
   */
  public async answerCallViaCallKeep(callId: string): Promise<void> {
    const callUUID = this.getCallUUID(callId);
    if (!callUUID) {
      console.error(
        "📞 [NativeIntegration] Cannot answer via CallKeep - no UUID found for callId:",
        callId
      );
      throw new Error(`No CallKeep UUID found for call ${callId}`);
    }

    console.log("📞 [NativeIntegration] Answering call via CallKeep:", {
      callId,
      callUUID
    });

    // On iOS, this triggers the answerCall event which will call onAnswerCall
    // On Android, this also ensures proper audio routing
    CallKeep.answerIncomingCall(callUUID);
  }
}
