import React, { useState, useCallback, useRef, useEffect } from "react";
import { useSelector } from "react-redux";
import { Platform, Alert, Linking, AppState } from "react-native";
import { toast } from "@backpackapp-io/react-native-toast";
import { Logger } from "shared/utils/Logger.ts";
import { getAppDisplayName } from "shared/branding/appBrand.ts";
import { SippyCup } from "./SippyCup.ts";
import { SessionManager } from "./SessionManager.ts";
import { ensurePermission } from "core/permissions/utils.ts";
import {
  SoftphoneContext,
  SoftphoneContextState,
  ContextCallInfo
} from "./SoftphoneContext.ts";
import {
  CallInfo,
  CallOptions,
  SipConfig,
  CallState,
  CallDirection,
  RemoteParty
} from "./types.ts";
import { State } from "store/types.ts";
import { VoipBridge } from "./VoipBridge.ts";
import { v4 as uuidv4 } from "uuid";
import Geolocation from "@react-native-community/geolocation";
import { useNavigation } from "@react-navigation/native";
import PendingCallManager from "../notifications/PendingCallManager";
import {
  getVoipPushAge,
  isVoipPushStaleDeclined
} from "../notifications/voipPushStaleCheck";
import { scheduleStaleVoipMissedCallFallback } from "../notifications/staleVoipMissedCallFallback";
import { USE_VOXO_MOBILE_APPROACH } from "../config/callApproach";
import { SlimSipClient, SipClientSettings } from "./jssip/SlimSipClient";
import { SipSession } from "./jssip/SipSession";
import { ForegroundSlimSipHub } from "./jssip/ForegroundSlimSipHub.ts";
import { buildSlimSipSettings } from "./slimSipSettings.ts";
import {
  storeSipSession,
  getSipSession,
  removeSipSession,
  disposeAllSipSessions,
  getAllPendingSipSessionIds
} from "./sipSessionRegistry.ts";
import {
  placeOutboundJsSipCall,
  holdAllJsSipCalls,
  handleForegroundWsIncoming
} from "./jsSipCallOrchestrator.ts";
import { store } from "../../store/global-store";
import {
  findContactByPhoneNumber,
  isCallKitLabelRedundantWithHandle
} from "features/calling/utils/contact-lookup.ts";
import CallKeep from "react-native-callkeep";
import InCallManager from "react-native-incall-manager";
import { isAnsweredElsewhereSessionFailed } from "./utils/session-failed-reason";
import { showCallPickedElsewhereNotification } from "../notifications/callPickedElsewhereNotification";
import { iosCallFlowError, iosCallFlowLog } from "./iosCallFlowLog.ts";
import {
  getOutboundStartupGraceRemainingMs,
  isOutboundStartupGraceActive,
  markIosAppForegrounded,
  shouldBlockStaleOutboundStartAction
} from "./iosOutboundStartupGuard.ts";
import { playDtmfSidetoneIos } from "./dtmfSidetoneIos.ts";
import {
  setSipBackendCallIdHandler,
  notifySipBackendCallDiscovered
} from "./sipBackendCallIdBridge.ts";
import { getCurrentRoute } from "core/navigation/utils/Ref.ts";
import { Routes } from "core/navigation/types/types.ts";

const logger = new Logger("SoftphoneProvider: ");
const OUTBOUND_INIT_TIMEOUT_MS = 12000;
const OUTBOUND_RETRYABLE_SETUP_TIMEOUT_MS = 15000;
const DIALING_WATCHDOG_TIMEOUT_MS = 20000;
const RESUME_REINIT_IDLE_MS = 90000;
/** Conference merge: longer hydration than generic call flows */
const MERGE_HYDRATE_MAX_MS = 2500;
/** Brief pause so server-side live channels settle before rebind + merge API */
const MERGE_PRE_REBIND_SETTLE_MS = 220;
/** Extra InCallManager refresh when CallKit UUID rebind fails (slow propagation) */
const MERGE_AUDIO_EXTRA_REFRESH_MS = 920;
/** CallKit Recents / Siri: wait for config + init instead of failing immediately. */
const IOS_CALLKIT_START_INIT_RETRY_MS = 38000;
const IOS_CALLKIT_START_POLL_MS = 300;
/** Coalesce parallel in-app makeCall taps to the same destination (iOS). */
const IOS_OUTBOUND_COALESCE_MS = 8000;

const useIosJsSipStack =
  Platform.OS === "ios" && USE_VOXO_MOBILE_APPROACH;

const normalizeOutboundDialString = (raw: string): string => {
  const trimmed = String(raw || "").trim();
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3 ? digits : trimmed.toLowerCase();
};

const getLiveCallCount = (calls: Record<string, ContextCallInfo>): number =>
  Object.values(calls).filter(
    (call) => call.state !== CallState.ENDED && call.state !== CallState.FAILED
  ).length;

const setConferenceMergeInProgress = (active: boolean): void => {
  (global as any).__voxoConferenceMergeInProgress = active;
};

const isConferenceMergeInProgress = (): boolean =>
  !!(global as any).__voxoConferenceMergeInProgress;

/** Keep foreground JsSIP hub up while another leg or merge is still active. */
const shouldKeepForegroundSipHubConnected = (
  calls: Record<string, ContextCallInfo>,
  activeCallId?: string
): boolean => {
  if (isConferenceMergeInProgress()) {
    return true;
  }
  if (getLiveCallCount(calls) > 0) {
    return true;
  }
  if (activeCallId && calls[activeCallId]) {
    const st = calls[activeCallId].state;
    if (
      st !== CallState.ENDED &&
      st !== CallState.FAILED &&
      st !== CallState.IDLE
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Phone → Recents redial: CallKit often passes only `handle` (extension/E.164/sip:…)
 * with no localized name — resolve from Redux directory so the active-call banner
 * and CallKeep.updateDisplay show the contact name.
 */
function resolveCallKitStartDisplayName(
  nativeName: string,
  handle: string
): string {
  const fromNative = String(nativeName || "").trim();
  if (
    fromNative &&
    !isCallKitLabelRedundantWithHandle(fromNative, String(handle || ""))
  ) {
    return fromNative;
  }
  try {
    const st = store.getState() as unknown as State;
    const dr = st.directoryReducer;
    const hit = findContactByPhoneNumber(
      String(handle || "").trim(),
      dr.personalContacts ?? [],
      dr.companyContacts ?? [],
      dr.directory ?? [],
      dr.phoneContacts
    );
    return (hit?.name ?? "").trim();
  } catch {
    return "";
  }
}

/** Merged conference: mute/unmute every SIP leg sharing the same conferenceId (mirrors UI flags). */
const getSessionIdsForConferenceMute = (
  callId: string,
  calls: Record<string, ContextCallInfo>
): string[] => {
  const target = calls[callId];
  if (
    !target?.conferencing ||
    !target.conferenceId ||
    target.state === CallState.ENDED ||
    target.state === CallState.FAILED
  ) {
    return [callId];
  }
  const legs = Object.values(calls).filter(
    (c) =>
      c.conferenceId === target.conferenceId &&
      c.state !== CallState.ENDED &&
      c.state !== CallState.FAILED
  );
  return legs.length > 1 ? legs.map((c) => c.sessionId) : [callId];
};

const isLiveCallState = (callState: CallState): boolean =>
  callState !== CallState.ENDED &&
  callState !== CallState.FAILED &&
  callState !== CallState.IDLE;

const IOS_VOIP_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isIosVoipUuid = (id: string): boolean => IOS_VOIP_UUID_RE.test(id);

const isSipSessionEnded = (sip: SipSession): boolean => {
  const rtc = (sip as { rtcSession?: { isEnded?: () => boolean } }).rtcSession;
  return !!rtc?.isEnded?.();
};

/** All non-ended call rows sharing a backend conference id. */
const getLiveConferenceLegs = (
  conferenceId: string,
  calls: Record<string, ContextCallInfo>
): ContextCallInfo[] =>
  Object.values(calls).filter(
    (c) => c.conferenceId === conferenceId && isLiveCallState(c.state)
  );

/**
 * Pick the next active call, but never resurrect a sibling conference leg when
 * a merged conference participant ends.
 */
const pickNextActiveCallIdFromMap = (
  calls: Record<string, ContextCallInfo>,
  excludeConferenceId?: string
): string | undefined => {
  const candidates = Object.values(calls).filter((call) => {
    if (!isLiveCallState(call.state)) {
      return false;
    }
    if (excludeConferenceId && call.conferenceId === excludeConferenceId) {
      return false;
    }
    return true;
  });

  if (!candidates.length) {
    return undefined;
  }

  const connectedOrHolding = candidates.find(
    (call) =>
      call.state === CallState.CONNECTED || call.state === CallState.HOLDING
  );
  if (connectedOrHolding) {
    return connectedOrHolding.sessionId;
  }

  const inProgress = candidates.find(
    (call) =>
      call.state === CallState.CONNECTING ||
      call.state === CallState.OUTGOING
  );
  return inProgress ? inProgress.sessionId : candidates[0].sessionId;
};

/**
 * Drop stale conference sibling rows from local state when the primary leg ends.
 * Never BYE peer SIP legs — the server may still play conference announcements
 * (e.g. "you have been kicked from this conference") on the survivor RTP path.
 */
const cleanupConferenceStaleLegRows = (
  endedCallId: string,
  activeCallId: string | undefined,
  calls: Record<string, ContextCallInfo>,
  opts: {
    updateCall: (id: string, patch: Partial<ContextCallInfo>) => void;
    removeCall: (id: string) => void;
    handledEndedIds: Set<string>;
  }
): void => {
  const endedCall = calls[endedCallId];
  if (!endedCall?.conferencing || !endedCall.conferenceId) {
    return;
  }

  // A non-primary leg ended (e.g. merged-away parent after a remote BYE) — only
  // remove that row; keep the survivor leg alive for telecom announcements.
  if (endedCallId !== activeCallId) {
    return;
  }

  const peers = getLiveConferenceLegs(endedCall.conferenceId, calls).filter(
    (c) => c.sessionId !== endedCallId
  );

  for (const peer of peers) {
    const peerId = peer.sessionId;
    if (opts.handledEndedIds.has(peerId)) {
      continue;
    }
    opts.handledEndedIds.add(peerId);

    VoipBridge.getInstance().clearVoipCallTracking(peerId);
    opts.updateCall(peerId, {
      state: CallState.ENDED,
      connected: false,
      endTime: new Date().toISOString(),
      conferencing: false,
      conferenceId: undefined
    });
    opts.removeCall(peerId);
  }
};

const withTimeout = async <T,>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const getSuppressedCallKeepEndSet = (): Set<string> => {
  const g = global as any;
  if (!g.__voxoSuppressCallKeepEndUuids) {
    g.__voxoSuppressCallKeepEndUuids = new Set<string>();
  }
  return g.__voxoSuppressCallKeepEndUuids as Set<string>;
};

export { getSipSession };

/**
 * Get current location for emergency calls
 */
const getCurrentLocation = (): Promise<{
  latitude: number;
  longitude: number;
}> => {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      (position: any) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      (error: any) => {
        logger.error("Error getting location:", error);
        reject(error);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
      }
    );
  });
};

const getMergeIdDiagnostics = (
  call: ContextCallInfo | null | undefined,
  sipSession?: SipSession
) => {
  const sipAny = sipSession as any;
  const rtcSession = sipAny?.rtcSession;
  const jssipInviteCallId = rtcSession?._request?.call_id;
  const dialogCallId = rtcSession?._dialog?._id;
  const isCallIdPlaceholder =
    !!call?.callId && !!call?.sessionId && call.callId === call.sessionId;

  return {
    sessionId: call?.sessionId,
    callId: call?.callId,
    parentSessionId: call?.parentSessionId,
    childSessionId: call?.childSessionId,
    isCallIdPlaceholder,
    // JsSIP transaction IDs are useful for debugging but are NOT backend merge IDs.
    jssipInviteCallId,
    jssipDialogId: dialogCallId
  };
};

type ConferenceMergeAttempt = {
  callId: string;
  mergeCallId: string;
  strategy: "primary" | "swapped";
};

const buildConferenceMergeAttempts = (params: {
  activeCallId?: string;
  parentCallId?: string;
  childCallId?: string;
}): ConferenceMergeAttempt[] => {
  const { activeCallId, parentCallId, childCallId } = params;
  if (!activeCallId || !parentCallId || !childCallId) return [];
  if (parentCallId === childCallId) return [];

  const nonActiveCallId =
    activeCallId === parentCallId ? childCallId : parentCallId;

  if (!nonActiveCallId || nonActiveCallId === activeCallId) {
    return [];
  }

  return [
    {
      callId: nonActiveCallId,
      mergeCallId: activeCallId,
      strategy: "primary"
    },
    {
      callId: activeCallId,
      mergeCallId: nonActiveCallId,
      strategy: "swapped"
    }
  ];
};

const getErrorStatusCode = (error: unknown): number | undefined => {
  const anyError = error as any;
  const rawStatus =
    anyError?.statusCode ??
    anyError?.status ??
    anyError?.error?.statusCode ??
    anyError?.error?.status ??
    anyError?.response?.statusCode ??
    anyError?.response?.status ??
    anyError?.error?.response?.statusCode ??
    anyError?.error?.response?.status ??
    anyError?.cause?.statusCode ??
    anyError?.cause?.status ??
    anyError?.cause?.response?.statusCode ??
    anyError?.cause?.response?.status ??
    anyError?.code;
  const numericStatus = Number(rawStatus);
  return Number.isFinite(numericStatus) ? numericStatus : undefined;
};

const isRetriableConferenceMergeError = (error: unknown): boolean => {
  const statusCode = getErrorStatusCode(error);
  const anyError = error as any;
  const message = String(anyError?.message || "").toLowerCase();
  const nestedMessage = String(anyError?.error?.message || "").toLowerCase();
  const causeMessage = String(anyError?.cause?.message || "").toLowerCase();
  const name = String(anyError?.name || "").toLowerCase();
  const nestedName = String(anyError?.error?.name || "").toLowerCase();
  const errorText = [
    message,
    nestedMessage,
    causeMessage,
    name,
    nestedName
  ].join(" ");

  return (
    statusCode === 500 ||
    errorText.includes("failed to merge") ||
    errorText.includes("internal server error") ||
    // Node/EventEmitter wrapper when SippyCup emits "error" with merge payload.
    errorText.includes("unhandled error") ||
    errorText.includes("conference call")
  );
};

const getSipRequestHeaderValue = (
  request: any,
  headerName: string
): string | undefined => {
  if (!request) return undefined;

  if (typeof request.getHeader === "function") {
    const direct = request.getHeader(headerName);
    if (direct) return String(direct);
  }

  const headers = request.headers;
  if (!headers || typeof headers !== "object") return undefined;

  const targetHeader = headerName.toLowerCase();
  const matchedKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === targetHeader
  );
  if (!matchedKey) return undefined;

  const headerValue = headers[matchedKey];
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const first = headerValue[0] as any;
    if (typeof first === "string") return first;
    if (typeof first?.raw === "string") return first.raw;
  }

  if (typeof headerValue === "string") return headerValue;
  if (typeof (headerValue as any)?.raw === "string")
    return (headerValue as any).raw;

  return undefined;
};

const extractServerCallIdFromSipSession = (
  sipSession?: SipSession,
  debugLabel?: string
): string | undefined => {
  const sipAny = sipSession as any;
  const rtcSession = sipAny?.rtcSession;
  const request = rtcSession?._request;

  // Diagnostic: dump all headers (expand arrays) to confirm Xcid presence/variant
  if (request?.headers) {
    const headers = request.headers;
    const keys = Object.keys(headers || {});
    const headerDump: Record<string, string | string[]> = {};
    keys.forEach((key) => {
      const val = headers[key];
      if (Array.isArray(val)) {
        headerDump[key] = val.map((item) => {
          if (typeof item === "string") return item;
          if (typeof (item as any)?.raw === "string") return (item as any).raw;
          return JSON.stringify(item);
        });
      } else if (typeof val === "string") {
        headerDump[key] = val;
      } else {
        headerDump[key] = String(val);
      }
    });
    console.warn(
      "[MERGE-DIAG-HEADERS] JsSIP request all headers (expanded)",
      JSON.stringify(
        {
          label: debugLabel ?? "(none)",
          headerKeys: keys,
          headers: headerDump,
          xcidLike: keys.filter((k) => /xcid|x-cid|call-id|call_id/i.test(k))
        },
        null,
        2
      )
    );
  }

  // Match web sessionToSoftphoneCall: incoming uses Xcid, outgoing uses Call-Id
  // Asterisk/VXM sends XCID (uppercase); try all variants for case-sensitive stacks
  const xcid =
    getSipRequestHeaderValue(request, "Xcid") ||
    getSipRequestHeaderValue(request, "X-Cid") ||
    getSipRequestHeaderValue(request, "XCID");
  const callIdFromRequest = request?.call_id;
  const callIdFromDialog = rtcSession?._dialog?._id?.call_id;
  const result = xcid || callIdFromRequest || callIdFromDialog;

  logger.debug("extractServerCallIdFromSipSession", {
    label: debugLabel,
    hasRequest: !!request,
    xcid: xcid || "(none)",
    "xcid-from-header": getSipRequestHeaderValue(request, "Xcid") || "(none)",
    "x-cid-from-header": getSipRequestHeaderValue(request, "X-Cid") || "(none)",
    "request.call_id": callIdFromRequest || "(none)",
    "dialog._id.call_id": callIdFromDialog || "(none)",
    result: result || "(none)",
    source: xcid ? "Xcid" : callIdFromRequest ? "request.call_id" : "dialog"
  });

  // Merge-diagnostic: log what we have (matches web: incoming=Xcid, outgoing=Call-Id)
  console.warn(
    "[MERGE-DIAG] extractServerCallIdFromSipSession",
    JSON.stringify({
      label: debugLabel ?? "(none)",
      hasXcid: !!xcid,
      xcid: xcid || null,
      request_call_id: callIdFromRequest || null,
      dialog_call_id: callIdFromDialog || null,
      result: result || null,
      source: xcid ? "Xcid" : callIdFromRequest ? "request.call_id" : "dialog"
    })
  );

  if (xcid) return xcid;
  return callIdFromRequest || callIdFromDialog;
};

function isSipRtcSessionEstablished(sip?: SipSession): boolean {
  if (!sip) return false;
  try {
    const rtc = (sip as any)?.rtcSession;
    if (rtc && typeof rtc.isEstablished === "function") {
      return rtc.isEstablished();
    }
  } catch {
    return false;
  }
  return false;
}

const isSipSessionConnected = (sip: SipSession): boolean => {
  if (isSipSessionEnded(sip)) {
    return false;
  }
  return sip.answered || isSipRtcSessionEstablished(sip);
};

const buildVoipCallEntry = (
  callId: string,
  sipSession: SipSession,
  voipBridge: VoipBridge,
  connected: boolean
): ContextCallInfo => {
  const voipCallData = voipBridge.getVoipCallData(callId);
  const incomingServerCallId =
    extractServerCallIdFromSipSession(sipSession, "buildVoipCallEntry") ||
    callId;
  return {
    callId: incomingServerCallId,
    sessionId: callId,
    state: connected ? CallState.CONNECTED : CallState.CONNECTING,
    direction: CallDirection.INCOMING,
    remoteDisplayName: voipCallData?.callerName || "Unknown",
    remoteUri: voipCallData
      ? `sip:${voipCallData.callerNumber}@dev-sip.voxo.co`
      : "",
    remoteParty: undefined,
    startTime: new Date().toISOString(),
    answerTime: new Date().toISOString(),
    endTime: undefined,
    isMuted: false,
    isOnHold: false,
    isSpeakerOn: false,
    isEmergency: false,
    connected,
    recording: false,
    conferencing: false,
    conferenceId: undefined,
    attendedTransfer: false,
    parentSessionId: undefined,
    childSessionId: undefined,
    totalCallDuration: 0,
    currentHoldDuration: 0,
    totalHoldDuration: 0,
    mutedConferenceParticipants: []
  };
};

const resolveBackendCallId = (
  call: ContextCallInfo | null | undefined,
  sipSession?: SipSession
): string | undefined => {
  const sessionDerivedId = extractServerCallIdFromSipSession(sipSession);
  if (sessionDerivedId) return sessionDerivedId;
  if (!call) return undefined;
  const isPlaceholder =
    !!call.callId && !!call.sessionId && call.callId === call.sessionId;
  if (!isPlaceholder && call.callId) {
    return call.callId;
  }
  return call.callId;
};

/**
 * Convert CallInfo to ContextCallInfo
 */
const callInfoToContextCall = (
  callInfo: CallInfo,
  callId?: string
): ContextCallInfo => ({
  // Use server call ID for API operations, fallback to session ID if not available
  callId: callInfo.serverCallId || callId || callInfo.id,
  sessionId: callInfo.id,
  state: callInfo.state,
  direction: callInfo.direction,
  remoteDisplayName: callInfo.remoteDisplayName,
  remoteUri: callInfo.remoteUri,
  remoteParty: undefined, // Will be set from SIP headers if available
  startTime: callInfo.startTime.toISOString(),
  answerTime: callInfo.answerTime?.toISOString(),
  endTime: callInfo.endTime?.toISOString(),
  isMuted: callInfo.isMuted,
  isOnHold: callInfo.isOnHold,
  isSpeakerOn: callInfo.isSpeakerOn,
  isEmergency: callInfo.isEmergency,
  connected: callInfo.state === CallState.CONNECTED,
  recording: false,
  conferencing: false,
  conferenceId: undefined,
  attendedTransfer: false,
  parentSessionId: undefined,
  childSessionId: undefined,
  totalCallDuration: 0,
  currentHoldDuration: 0,
  totalHoldDuration: 0,
  mutedConferenceParticipants: []
});

/**
 * Simplified SoftphoneProvider
 * Single source of truth: calls record
 * Computed properties for currentCall, incomingCalls, etc.
 */
export const SoftphoneProvider: React.FC<{ children: React.ReactNode }> = ({
  children
}) => {
  // Get user data from Redux
  const user = useSelector((state: State) => state.userReducer.user);
  const userRef = useRef(user);
  userRef.current = user;
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const accessToken = useSelector(
    (state: State) => state.authReducer.accessToken
  );
  const navigation = useNavigation<any>();

  // Simplified state - single source of truth
  const [state, setState] = useState<SoftphoneContextState>({
    isInitialized: false,
    isInitializing: false,
    isRegistered: false,
    isRegistering: false,
    config: null,
    calls: {},
    activeCallId: undefined,
    error: undefined
  });
  const stateRef = useRef(state);
  const appStateRef = useRef(AppState.currentState);
  /** Previous AppState for call-notifs-off foreground SIP register / background unregister. */
  const callNotifAppStatePrevRef = useRef(AppState.currentState);
  /** Detect 1→0 toggle for foreground WebSocket REGISTER + refresh. */
  const prevMobileCallNotifsRef = useRef<0 | 1 | undefined>(undefined);
  /** Serialize ensureInitialized so CallKit Recents + foreground AppState cannot reset SessionManager concurrently. */
  const ensureInitChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastBackgroundAtRef = useRef<number | null>(null);

  // SippyCup instance
  const sippyCupRef = useRef<SippyCup | null>(null);
  const handledEndedCallIdsRef = useRef<Set<string>>(new Set());
  const pendingOutgoingContactMetadataRef = useRef<{
    displayName?: string;
    avatarPath?: string | null;
  } | null>(null);
  const inCallScreenMinimizedRef = useRef(false);
  /** iOS: one outbound setup at a time per destination (double-tap / parallel UI). */
  const outboundSetupInFlightRef = useRef<{
    promise: Promise<string>;
    destination: string;
    startedAt: number;
  } | null>(null);

  const setInCallScreenMinimized = useCallback((minimized: boolean) => {
    inCallScreenMinimizedRef.current = minimized;
  }, []);

  const openInCallScreen = useCallback(
    (callId: string, options?: { force?: boolean }) => {
      const force = options?.force ?? false;
      if (!force && inCallScreenMinimizedRef.current) {
        iosCallFlowLog("navigation", "skip auto-open InCallScreen (minimized)", {
          callId
        });
        return;
      }
      inCallScreenMinimizedRef.current = false;
      navigation.navigate("InCallScreen", { callId });
    },
    [navigation]
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setSipBackendCallIdHandler((sessionId, callId) => {
      setState((prev) => {
        const c = prev.calls[sessionId];
        if (!c || !callId || callId === c.callId) return prev;
        return {
          ...prev,
          calls: {
            ...prev.calls,
            [sessionId]: { ...c, callId }
          }
        };
      });
    });
    return () => setSipBackendCallIdHandler(null);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (previousState === "active" && nextState !== "active") {
        lastBackgroundAtRef.current = Date.now();
        return;
      }

      if (nextState !== "active" || previousState === "active") {
        return;
      }

      markIosAppForegrounded();

      const lastBackgroundAt = lastBackgroundAtRef.current;
      if (!lastBackgroundAt) {
        return;
      }
      const idleMs = Date.now() - lastBackgroundAt;
      if (idleMs < RESUME_REINIT_IDLE_MS) {
        return;
      }

      const snapshot = stateRef.current;
      if (getLiveCallCount(snapshot.calls) > 0) {
        return;
      }

      iosCallFlowLog("resume", "long-idle foreground - resetting SIP stack", {
        idleMs,
        wasInitialized: snapshot.isInitialized,
        wasRegistered: snapshot.isRegistered
      });

      void (async () => {
        try {
          const instance = sippyCupRef.current;
          if (instance) {
            if (snapshot.isRegistered) {
              await instance.unregister();
            }
            instance.dispose();
            sippyCupRef.current = null;
          }
          await SessionManager.resetInstance();
        } catch (error) {
          logger.error(
            "Failed to reset SIP stack on foreground resume:",
            error
          );
        } finally {
          setState((prev) => ({
            ...prev,
            isInitialized: false,
            isInitializing: false,
            isRegistered: false,
            isRegistering: false,
            ...(prev.activeCallId === "dialing"
              ? { activeCallId: undefined }
              : {})
          }));
        }
      })();
    });

    return () => subscription.remove();
  }, []);

  // Derived state - compute from calls record
  const currentCall = state.activeCallId
    ? state.calls[state.activeCallId]
    : null;

  const incomingCalls = Object.values(state.calls).filter(
    (call) =>
      call.state === CallState.INCOMING &&
      call.direction === CallDirection.INCOMING
  );

  const callsOnHold = Object.values(state.calls).filter(
    (call) => call.isOnHold
  );

  /**
   * Update a call in the calls record
   */
  const updateCall = useCallback(
    (callId: string, updates: Partial<ContextCallInfo>) => {
      setState((prev) => {
        const call = prev.calls[callId];
        if (!call) return prev;

        return {
          ...prev,
          calls: {
            ...prev.calls,
            [callId]: { ...call, ...updates }
          }
        };
      });
    },
    []
  );

  /**
   * Apply SIP/VoIP callStateChanged without resetting the call timer.
   * First CONNECTED sets answerTime; hold/unhold must keep the original.
   */
  const applyCallStateChangeFromEvent = useCallback(
    (callId: string, callState: CallState) => {
      setState((prev) => {
        const existing = prev.calls[callId];
        if (!existing) return prev;
        const nextAnswerTime =
          callState === CallState.CONNECTED
            ? existing.answerTime ?? new Date().toISOString()
            : existing.answerTime;
        return {
          ...prev,
          calls: {
            ...prev.calls,
            [callId]: {
              ...existing,
              state: callState,
              connected: callState === CallState.CONNECTED,
              answerTime: nextAnswerTime
            }
          }
        };
      });
    },
    []
  );

  /**
   * Merge one call into a calls map (same rules as addCall). Used by addCall and incomingCall
   * so forked INVITEs apply sequentially in one React update chain.
   */
  const upsertCallInCalls = useCallback(
    (
      calls: Record<string, ContextCallInfo>,
      call: ContextCallInfo
    ): Record<string, ContextCallInfo> => {
      handledEndedCallIdsRef.current.delete(call.sessionId);
      const pending =
        call.direction === CallDirection.OUTGOING
          ? pendingOutgoingContactMetadataRef.current
          : null;
      const existing = calls[call.sessionId];
      const displayName =
        call.contactDisplayName ??
        existing?.contactDisplayName ??
        pending?.displayName;
      const avatarPath =
        call.contactAvatarPath !== undefined
          ? call.contactAvatarPath
          : existing?.contactAvatarPath !== undefined
            ? existing.contactAvatarPath
            : pending?.avatarPath;
      const mergedCall: ContextCallInfo = {
        ...call,
        ...(displayName != null && { contactDisplayName: displayName }),
        ...(avatarPath !== undefined && { contactAvatarPath: avatarPath })
      };
      if (pending) {
        pendingOutgoingContactMetadataRef.current = null;
      }
      return {
        ...calls,
        [call.sessionId]: mergedCall
      };
    },
    []
  );

  /**
   * Add a new call.
   * Preserves contactDisplayName/contactAvatarPath from existing call or pending ref
   * (from makeCall options) when the incoming call (from SIP/outgoingCall) doesn't have them.
   */
  const addCall = useCallback(
    (call: ContextCallInfo) => {
      setState((prev) => ({
        ...prev,
        calls: upsertCallInCalls(prev.calls, call)
      }));
    },
    [upsertCallInCalls]
  );

  /**
   * Resolve and persist backend/server call ID for a session.
   * Useful for incoming web->mobile calls where callId may start as session UUID.
   */
  const hydrateCallBackendId = useCallback(
    async (
      sessionId: string,
      maxWaitMs = 1200
    ): Promise<string | undefined> => {
      const resolveFromLatestState = () => {
        const latestCall = stateRef.current.calls[sessionId];
        const latestSipSession = getSipSession(sessionId);
        const resolvedId = resolveBackendCallId(latestCall, latestSipSession);
        return { latestCall, resolvedId };
      };

      const persistIfNeeded = (
        latestCall: ContextCallInfo | undefined,
        resolvedId: string | undefined
      ) => {
        if (
          latestCall &&
          resolvedId &&
          resolvedId !== latestCall.callId &&
          resolvedId !== latestCall.sessionId
        ) {
          updateCall(sessionId, { callId: resolvedId });
        }
      };

      let { latestCall, resolvedId } = resolveFromLatestState();
      persistIfNeeded(latestCall, resolvedId);
      if (resolvedId && resolvedId !== sessionId) {
        return resolvedId;
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        ({ latestCall, resolvedId } = resolveFromLatestState());
        persistIfNeeded(latestCall, resolvedId);
        if (resolvedId && resolvedId !== sessionId) {
          return resolvedId;
        }
      }

      return resolvedId;
    },
    [updateCall]
  );

  /**
   * Clean up transfer relationships when calls end unexpectedly
   */
  const cleanupTransferRelationships = useCallback((endedCallId: string) => {
    setState((prev) => {
      const endedCall = prev.calls[endedCallId];
      if (!endedCall) return prev;

      // Merged conferences must not fall back to a pre-merge 1:1 leg.
      if (endedCall.conferencing && endedCall.conferenceId) {
        return prev;
      }

      const updatedCalls = { ...prev.calls };
      let newActiveCallId = prev.activeCallId;

      // If this was a child call (has parentSessionId)
      if (endedCall.parentSessionId) {
        const parentCall = updatedCalls[endedCall.parentSessionId];
        if (parentCall) {
          // Show toast notification
          toast("Transfer call ended", {
            duration: 3000,
            icon: "📞"
          });

          // Clear childSessionId from parent call
          updatedCalls[endedCall.parentSessionId] = {
            ...parentCall,
            childSessionId: undefined
          };

          // Unhold parent call if it's on hold
          if (parentCall.isOnHold) {
            const parentSessionId = parentCall.sessionId;
            setTimeout(() => {
              if (sippyCupRef.current) {
                sippyCupRef.current
                  .unholdCall(parentSessionId)
                  .catch((error) => {
                    logger.error(
                      "Failed to unhold parent call after child ended:",
                      error
                    );
                  });
              }
            }, 0);
          }

          // Set parent as active call
          newActiveCallId = parentCall.sessionId;
        }
      }

      // If this was a parent call (has childSessionId)
      if (endedCall.childSessionId) {
        const childCall = updatedCalls[endedCall.childSessionId];
        if (childCall) {
          // Show toast notification
          toast("Original call ended", {
            duration: 3000,
            icon: "📞"
          });

          // Clear parentSessionId from child call
          updatedCalls[endedCall.childSessionId] = {
            ...childCall,
            parentSessionId: undefined
          };

          // Set child as active call
          newActiveCallId = childCall.sessionId;
        }
      }

      return {
        ...prev,
        calls: updatedCalls,
        activeCallId: newActiveCallId
      };
    });
  }, []);

  /**
   * Remove a call
   */
  const removeCall = useCallback((callId: string) => {
    setState((prev) => {
      const removed = prev.calls[callId];
      const { [callId]: _removedRow, ...remainingCalls } = prev.calls;
      const excludeConferenceId =
        removed?.conferencing && removed.conferenceId
          ? removed.conferenceId
          : undefined;

      const activeCallStillExists =
        prev.activeCallId && remainingCalls[prev.activeCallId];
      // If nothing was explicitly active, do not auto-promote a ringing/incoming leg.
      // Otherwise declining a duplicate forked INVITE sets activeCallId on the remaining
      // incoming call and CONNECTED skips openInCallScreen (CallKit-only ring until accept).
      const newActiveCallId =
        prev.activeCallId == null
          ? undefined
          : activeCallStillExists
            ? prev.activeCallId
            : pickNextActiveCallIdFromMap(
                remainingCalls,
                excludeConferenceId
              );

      return {
        ...prev,
        calls: remainingCalls,
        activeCallId: newActiveCallId
      };
    });
  }, []);

  /**
   * Set active call
   */
  const setActiveCallId = useCallback((callId: string | undefined) => {
    if (callId) {
      inCallScreenMinimizedRef.current = false;
    }
    setState((prev) => ({ ...prev, activeCallId: callId }));
  }, []);

  const runPlaceOutboundJsSipCall = useCallback(
    async (
      destination: string,
      options: {
        callUuid: string;
        displayName?: string;
        outboundNumberId?: string;
        origin: "inApp" | "callKitRecents";
        isEmergency?: boolean;
      }
    ): Promise<string> => {
      const cup = sippyCupRef.current;
      if (!cup) {
        throw new Error("Softphone not initialized");
      }
      return placeOutboundJsSipCall({
        destination,
        callUuid: options.callUuid,
        displayName: options.displayName,
        outboundNumberId: options.outboundNumberId,
        origin: options.origin,
        isEmergency: options.isEmergency,
        nativeIntegration: cup.getNativeIntegration(),
        holdOtherCalls: () =>
          holdAllJsSipCalls(stateRef.current.calls, updateCall),
        addCall,
        updateCall,
        setActiveCallId,
        openInCallScreen,
        removeCall,
        applyCallStateChange: applyCallStateChangeFromEvent,
        reportCallKitLocalizedName: (callId, name, dialHint) => {
          cup.reportCallKitLocalizedName(callId, name, dialHint);
        }
      });
    },
    [
      addCall,
      updateCall,
      setActiveCallId,
      openInCallScreen,
      removeCall,
      applyCallStateChangeFromEvent
    ]
  );

  /**
   * Initialize SippyCup with user config
   */
  useEffect(() => {
    if (user?.peerName && user?.peerSecret) {
      const config: SipConfig = {
        displayName: user.extName || "User",
        user: user.peerName,
        password: user.peerSecret,
        domain: "dev-sip.voxo.co",
        uri: "wss://api.voxo.co/webrtc",
        iceServers: [
          {
            urls: [
              "stun:stun.l.google.com:19302",
              "stun:stun1.l.google.com:19302"
            ]
          }
        ],
        useAudio: true,
        useVideo: false,
        useRinging: true,
        autoAnswer: false,
        autoReject: false
      };

      setState((prev) => ({ ...prev, config }));
    } else if (!user) {
      // Cleanup on logout
      if (sippyCupRef.current) {
        sippyCupRef.current.dispose();
        sippyCupRef.current = null;
      }
      setState({
        isInitialized: false,
        isInitializing: false,
        isRegistered: false,
        isRegistering: false,
        config: null,
        calls: {},
        activeCallId: undefined,
        error: undefined
      });
    }
  }, [user]);

  /**
   * Setup VoIP bridge for handling VoIP push notifications
   */
  const setupVoipBridge = useCallback(async (): Promise<VoipBridge> => {
    const voipBridge = VoipBridge.getInstance();
    await voipBridge.initialize();

    // Handle VoIP call state changes
    voipBridge.on(
      "callStateChanged",
      (callId: string, callState: CallState) => {
        iosCallFlowLog(
          "voipBridge.callStateChanged",
          "VoIP push / bridge state",
          {
            callId,
            callState,
            activeCallId: stateRef.current.activeCallId ?? null
          }
        );
        applyCallStateChangeFromEvent(callId, callState);

        // Auto-set active call for answered VoIP calls
        if (
          callState === CallState.CONNECTED &&
          !stateRef.current.activeCallId
        ) {
          setActiveCallId(callId);
          // Navigate to InCallScreen when call is answered
          openInCallScreen(callId);
        }
      }
    );

    // Handle incoming VoIP call event (Wake-up strategy)
    voipBridge.on(
      "incomingVoipCall",
      async (callUuid: string, callInfo: CallInfo) => {
        iosCallFlowLog(
          "incomingVoipCall",
          "setupVoipBridge listener — push wakeup",
          {
            callUuid,
            callInfoState: callInfo.state,
            remoteDisplayName: callInfo.remoteDisplayName,
            remoteUri: callInfo.remoteUri,
            hasVoipPayload: !!callInfo.voipPayload,
            activeCallId: stateRef.current.activeCallId ?? null
          }
        );
        console.log(
          "🟪 [SoftphoneProvider] 📞 incomingVoipCall event received - NEW CALL CREATED:",
          {
            callUuid,
            callInfoState: callInfo.state,
            remoteDisplayName: callInfo.remoteDisplayName,
            remoteUri: callInfo.remoteUri,
            hasVoipPayload: !!callInfo.voipPayload,
            platform: Platform.OS,
            timestamp: new Date().toISOString()
          }
        );
        logger.debug("Received incomingVoipCall in Provider", {
          callUuid,
          callInfo
        });

        if (Platform.OS === "ios") {
          try {
            const sippyCup = await ensureInitialized();
            sippyCup.registerCallKitUuidAlias(callUuid, callUuid);
            console.warn(
              `[END-ACCEPT-TRACE][ios-project][SP][incomingVoipCall-main] registeredCallKitAlias callUUID=${callUuid} callId=${callUuid}`
            );
          } catch (aliasError) {
            console.warn(
              `[END-ACCEPT-TRACE][ios-project][SP][incomingVoipCall-main] registerCallKitAlias failed callUUID=${callUuid}:`,
              aliasError
            );
          }
        }

        // CRITICAL: Use SlimSipClient from voxo-mobile (EXACT COPY)
        // This uses jssip (not sip.js) and follows voxo-mobile's proven pattern:
        // 1. Register with X-UUID, X-PUSH, X-IP headers
        // 2. Wait for INVITE (8-second timeout)
        // 3. Return SipSession when INVITE arrives
        // 4. Store session for CallKeep answer
        const payload = callInfo.voipPayload;
        const callerIp =
          payload?.callerIp ||
          payload?.ip ||
          payload?.data?.callerIp ||
          payload?.dictionaryPayload?.callerIp;

        console.log(
          `� [SoftphoneProvider] 📞 Extracted caller IP: ${callerIp}`
        );

        if (callerIp) {
          // CRITICAL: Check if NotificationManager is handling or has handled this call.
          // @ts-ignore
          const alreadyEstablished =
            global.pendingSipSessions &&
            global.pendingSipSessions.has(callUuid);
          // @ts-ignore
          const beingHandled = global.pendingVoipPushWakeup;
          console.warn(
            `📱 [SP] ${new Date().toISOString()} incomingVoipCall uuid=${callUuid} | alreadyEstablished=${alreadyEstablished} beingHandled=${beingHandled}`
          );
          if (alreadyEstablished || beingHandled) {
            iosCallFlowLog(
              "incomingVoipCall",
              "SKIP duplicate SlimSip — NM handling",
              {
                callUuid,
                alreadyEstablished: !!alreadyEstablished,
                beingHandled: !!beingHandled
              }
            );
            console.warn(
              `� [SP] ${new Date().toISOString()} SKIPPED duplicate SlimSipClient for ${callUuid} (NM handling)`
            );
            if (alreadyEstablished) {
              // @ts-ignore
              const existingSession = global.pendingSipSessions.get(callUuid);
              // @ts-ignore
              const existingClient = global.pendingSipClients?.get(callUuid);
              if (existingSession && existingClient) {
                console.warn(
                  `📱 [SP] ${new Date().toISOString()} Adopting existing session from NM for ${callUuid}`
                );
                storeSipSession(callUuid, existingSession, existingClient);
              }
            }
            return;
          }

          try {
            console.warn(
              `� [SP] ${new Date().toISOString()} Creating NEW SlimSipClient for ${callUuid} (no NM handler)`
            );

            // Get SIP credentials from Redux store (like voxo-mobile)
            const state = store.getState();
            const { authReducer, userReducer } = state;

            if (!authReducer.isLoggedIn || !userReducer.user) {
              console.error("🔵 [SoftphoneProvider] ❌ User not logged in");
              return;
            }

            const sipSettings: SipClientSettings = {
              routeOptions: {
                direction: "inbound",
                callUuid: callUuid
              },
              pcConfig: {
                bundlePolicy: "max-compat",
                iceServers: [
                  {
                    urls: [
                      "stun:stun.l.google.com:19302",
                      "stun:stun1.l.google.com:19302",
                      "stun:stun2.l.google.com:19302",
                      "stun:stun3.l.google.com:19302",
                      "stun:stun4.l.google.com:19302"
                    ]
                  }
                ],
                iceTransportPolicy: "all"
              },
              token: authReducer.accessToken,
              sipUri: `sip:${userReducer.user.peerName}@dev-sip.voxo.co`,
              name: "User", // Display name for SIP headers
              wsUrl: "wss://api.voxo.co/webrtc",
              password: userReducer.user.peerSecret
            };

            console.log(
              `🔵 [SoftphoneProvider] Creating SlimSipClient with settings:`,
              {
                sipUri: sipSettings.sipUri,
                wsUrl: sipSettings.wsUrl,
                callUuid
              }
            );

            const sipClient = new SlimSipClient(sipSettings);

            console.log(
              `🔵 [SoftphoneProvider] 📞 Calling sipClient.establishInboundSession (will wait for INVITE)...`
            );
            iosCallFlowLog("inbound", "registering SIP for incoming wake-up", {
              callUuid,
              callerIp
            });

            // This is voxo-mobile's EXACT CODE - waits for INVITE with 8-second timeout
            const sipSession = await sipClient.establishInboundSession(
              callUuid,
              callerIp
            );

            console.log(
              `� [SoftphoneProvider] 📞 ✅ Inbound session established, INVITE received`
            );
            iosCallFlowLog("inbound", "SIP INVITE received (SlimSip wake-up)", {
              callUuid
            });
            console.log(
              `� [SoftphoneProvider] 📞 SipSession ready for CallKeep answer`
            );

            // Store session for CallKeep answer (like voxo-mobile's GlobalCallManager)
            storeSipSession(callUuid, sipSession, sipClient);

            console.log(
              `🔵 [SoftphoneProvider] 📞 ✅ Session stored, waiting for user to answer via CallKeep`
            );
            iosCallFlowLog("inbound", "incoming call ready for user accept", {
              callUuid
            });
          } catch (e: any) {
            logger.error("Failed to establish inbound session", e);
            iosCallFlowError(
              "inbound",
              "failed to establish inbound session",
              e,
              {
                callUuid,
                callerIp
              }
            );

            // Handle specific errors like voxo-mobile does
            if (e.error === "RECEIVE_INVITE_TIMEOUT") {
              console.error(
                "� [SoftphoneProvider] ❌ INVITE timeout (8 seconds)"
              );
            } else if (e.error === "INVITE_ANSWERED_ELSEWHERE") {
              console.error("� [SoftphoneProvider] ❌ Call answered elsewhere");
              void showCallPickedElsewhereNotification(callUuid).catch(
                () => {}
              );
            } else if (e.error === "INVITE_CANCELLED_EARLY") {
              console.error("� [SoftphoneProvider] ❌ Call cancelled");
            } else if (e.error === "REGISTRATION_FAILED") {
              console.error("� [SoftphoneProvider] ❌ Registration failed");
            }
          }
        } else {
          logger.warn(
            "No caller IP found in payload, skipping wake-up registration"
          );
        }
      }
    );

    // Handle VoIP call end (from CallKit end button or in-app hangup)
    voipBridge.on("endVoipCall", (callId: string) => {
      const endedCall = stateRef.current.calls[callId];
      const excludeConferenceId =
        endedCall?.conferencing && endedCall.conferenceId
          ? endedCall.conferenceId
          : undefined;

      cleanupConferenceStaleLegRows(
        callId,
        stateRef.current.activeCallId,
        stateRef.current.calls,
        {
          updateCall,
          removeCall,
          handledEndedIds: handledEndedCallIdsRef.current
        }
      );

      // Terminate SIP session and dispose SlimSipClient — same as in-app hangup.
      // Without this, ending from CallKit leaves the SIP call connected (no BYE sent).
      const sipSession = getSipSession(callId);
      if (sipSession) {
        try {
          sipSession.sipTerminate();
        } catch (e) {
          console.warn(
            `📞 [SP] endVoipCall: sipTerminate error for ${callId}:`,
            e
          );
        }
        removeSipSession(callId);
      }

      updateCall(callId, {
        state: CallState.ENDED,
        connected: false,
        endTime: new Date().toISOString()
      });
      sippyCupRef.current?.emit("callStateChanged", callId, CallState.ENDED);

      if (stateRef.current.activeCallId === callId) {
        const { [callId]: _removed, ...remainingCalls } =
          stateRef.current.calls;
        const nextActiveId = pickNextActiveCallIdFromMap(
          remainingCalls,
          excludeConferenceId
        );
        if (nextActiveId) {
          setActiveCallId(nextActiveId);
        } else {
          setActiveCallId(undefined);
          if (getCurrentRoute()?.name === Routes.InCallScreen) {
            navigation.goBack();
          }
        }
      }

      // Remove the call after a short delay
      setTimeout(() => {
        removeCall(callId);
      }, 1000);
    });

    return voipBridge;
  }, [
    applyCallStateChangeFromEvent,
    updateCall,
    removeCall,
    setActiveCallId,
    navigation
  ]);

  /**
   * Initialize VoIP bridge
   */
  useEffect(() => {
    let voipBridge: VoipBridge;

    const initializeVoipBridge = async () => {
      voipBridge = await setupVoipBridge();
    };

    initializeVoipBridge();

    return () => {
      if (voipBridge) {
        voipBridge.dispose();
      }
    };
  }, [setupVoipBridge]);

  /**
   * Setup SippyCup event listeners
   */
  const setupEventListeners = useCallback(
    (sippyCup: SippyCup) => {
      if (useIosJsSipStack) {
        sippyCup.setOutboundJsSipHandler((dest, callUUID, displayName) =>
          runPlaceOutboundJsSipCall(dest, {
            callUuid: callUUID,
            displayName,
            origin: "callKitRecents"
          })
        );
      }

      // System events
      sippyCup.on("initialized", () => {
        setState((prev) => ({
          ...prev,
          isInitialized: true,
          isInitializing: false
        }));
      });

      sippyCup.on("registered", () => {
        setState((prev) => ({
          ...prev,
          isRegistered: true,
          isRegistering: false
        }));
      });

      sippyCup.on("unregistered", () => {
        setState((prev) => ({
          ...prev,
          isRegistered: false
        }));
      });

      sippyCup.on("error", (error) => {
        logger.error("SippyCup error:", error);
        setState((prev) => ({
          ...prev,
          isInitializing: false,
          isRegistering: false
        }));
      });

      // Call events
      sippyCup.on("incomingCall", (callId: string, callInfo: CallInfo) => {
        const wsForegroundIncomingWhenCallNotifsOff =
          Platform.OS === "ios" &&
          USE_VOXO_MOBILE_APPROACH &&
          AppState.currentState === "active" &&
          userRef.current?.enableMobileCallNotifications === 0;
        const skipSessionManagerAdd =
          Platform.OS === "ios" && USE_VOXO_MOBILE_APPROACH;
        iosCallFlowLog("incomingCall", "SessionManager INVITE (sip.js path)", {
          callId,
          state: callInfo.state,
          remoteUri: callInfo.remoteUri,
          skipSessionManager: skipSessionManagerAdd
        });
        // USE_VOXO_MOBILE_APPROACH: VoIP/SlimSip owns incoming — skip adding SessionManager call
        // to React state, except iOS foreground + mobile call notifications off (WebSocket INVITE).
        if (skipSessionManagerAdd) {
          console.warn(
            `📞 [SP] ${new Date().toISOString()} incomingCall: USE_VOXO_MOBILE_APPROACH - skipping SessionManager (SlimSipClient handles) callId=${callId}`
          );
          return;
        }
        // On iOS in background: skip adding SessionManager call. The VoIP push path
        // (SlimSipClient) will handle it. Adding it here causes a duplicate - when the
        // user answers from CallKit, the server CANCELs this INVITE with "Call completed
        // elsewhere", which can surface confusing behavior. Let VoIP path own the call.
        if (Platform.OS === "ios" && AppState.currentState !== "active") {
          console.warn(
            `📞 [SP] ${new Date().toISOString()} incomingCall: iOS background - skipping SessionManager call (VoIP path will handle) callId=${callId}`
          );
          return;
        }

        // Check if there's a pending VoIP call that matches this SIP INVITE
        // Match by caller number from the remote URI
        const voipBridge = VoipBridge.getInstance();
        const callerNumber =
          callInfo.remoteUri?.match(/sip:(\d+)@/)?.[1] ||
          callInfo.remoteDisplayName?.replace(/\D/g, "") ||
          "";

        logger.debug("Incoming SIP INVITE, checking for matching VoIP call", {
          sipCallId: callId,
          callerNumber,
          remoteUri: callInfo.remoteUri,
          remoteDisplayName: callInfo.remoteDisplayName
        });

        /** CallKit-only ring until accept: do not set activeCallId / open InCall here. */
        const deferInCallUiUntilAnswered =
          wsForegroundIncomingWhenCallNotifsOff;

        let openInCallAfterCommit: string | undefined;

        // Single functional update so forked INVITEs merge into `calls` sequentially.
        // Avoid setState(() => { addCall(); return prev }) — both legs saw callCount 0 and
        // CONNECTED could run with no context row ("call not in context yet").
        setState((prev) => {
          const allCalls = Object.values(prev.calls);
          logger.debug("Current calls in state", {
            callCount: allCalls.length,
            calls: allCalls.map((c) => ({
              sessionId: c.sessionId,
              isVoip: voipBridge.isVoipCall(c.sessionId),
              remoteUri: c.remoteUri,
              remoteDisplayName: c.remoteDisplayName,
              state: c.state
            }))
          });

          const matchingVoipCall = Object.values(prev.calls).find(
            (call) =>
              voipBridge.isVoipCall(call.sessionId) &&
              (call.remoteUri?.includes(callerNumber) ||
                call.remoteDisplayName?.includes(callerNumber) ||
                callInfo.remoteUri?.includes(
                  call.remoteDisplayName?.replace(/\D/g, "") || ""
                ))
          );

          if (matchingVoipCall) {
            logger.debug(
              "Matching VoIP call found, replacing with SIP session",
              {
                voipCallId: matchingVoipCall.sessionId,
                sipCallId: callId,
                callerNumber
              }
            );

            const { [matchingVoipCall.sessionId]: _removed, ...restCalls } =
              prev.calls;
            const call = callInfoToContextCall(
              callInfo,
              matchingVoipCall.callId || callId
            );
            const nextCalls = upsertCallInCalls(restCalls, call);
            let nextActive = prev.activeCallId;
            if (deferInCallUiUntilAnswered) {
              if (nextActive === matchingVoipCall.sessionId) {
                nextActive = undefined;
              }
            } else {
              nextActive = call.sessionId;
              openInCallAfterCommit = call.sessionId;
            }
            return { ...prev, calls: nextCalls, activeCallId: nextActive };
          }

          const call = callInfoToContextCall(callInfo, callId);
          const nextCalls = upsertCallInCalls(prev.calls, call);
          let nextActive = prev.activeCallId;
          if (!deferInCallUiUntilAnswered) {
            nextActive = call.sessionId;
            openInCallAfterCommit = call.sessionId;
            console.log(
              "📱 [SoftphoneProvider] Incoming call, navigating to InCallScreen:",
              {
                callId: call.sessionId,
                callerName: call.remoteDisplayName
              }
            );
          } else {
            iosCallFlowLog(
              "incomingCall",
              "call notifs off — addCall only; InCall after CallKit accept",
              { callId: call.sessionId }
            );
          }
          return { ...prev, calls: nextCalls, activeCallId: nextActive };
        });

        if (openInCallAfterCommit) {
          const sid = openInCallAfterCommit;
          queueMicrotask(() => {
            openInCallScreen(sid, { force: true });
          });
        }
      });

      sippyCup.on("outgoingCall", (callId: string, callInfo: CallInfo) => {
        console.warn("outgoingCall handler fired:", callId);
        iosCallFlowLog("outgoingCall", "event addCall", {
          callId,
          state: callInfo.state,
          activeCallId: stateRef.current.activeCallId ?? null
        });
        const call = callInfoToContextCall(callInfo, callId);
        addCall(call);
      });

      sippyCup.on(
        "callStateChanged",
        (callId: string, callState: CallState) => {
          console.log(
            "🟠 [SoftphoneProvider] 📞 callStateChanged event received:",
            {
              callId,
              callState,
              currentActiveCallId: stateRef.current.activeCallId,
              timestamp: new Date().toISOString()
            }
          );

          // Defer state updates to avoid "Cannot update component while rendering another" warning.
          setTimeout(() => {
            const snapBeforeApply = stateRef.current;
            const attendedTransferChild =
              !!snapBeforeApply.calls[callId]?.parentSessionId;

            iosCallFlowLog("callStateChanged", "apply", {
              callId,
              callState,
              activeCallId: stateRef.current.activeCallId ?? null
            });
            applyCallStateChangeFromEvent(callId, callState);

            const snap = stateRef.current;
            const hasActiveCall = !!snap.activeCallId;
            const callExistsInContext = !!snap.calls[callId];

            // First CONNECTED only: open InCall when nothing is active yet (cold start / first leg).
            // Never use stale `state.activeCallId` from the listener closure — it is often undefined
            // and wrongly navigates when the Add Person / attended-transfer child leg connects.
            // Also skip when this session is the second leg (parentSessionId set).
            // Require the call in context so we never open InCall with empty `calls` (e.g. missed addCall).
            if (
              callState === CallState.CONNECTED &&
              !hasActiveCall &&
              !attendedTransferChild &&
              callExistsInContext
            ) {
              console.log(
                "🟠 [SoftphoneProvider] 📞 ✅ Call CONNECTED, navigating to InCallScreen:",
                {
                  callId,
                  previousActiveCallId: snap.activeCallId
                }
              );
              setActiveCallId(callId);
              openInCallScreen(callId);
            } else if (
              callState === CallState.CONNECTED &&
              !hasActiveCall &&
              !attendedTransferChild &&
              !callExistsInContext
            ) {
              // Rare: CONNECTED event before incomingCall's setState committed; retry next tick.
              setTimeout(() => {
                const s2 = stateRef.current;
                if (
                  s2.calls[callId] &&
                  !s2.activeCallId &&
                  !s2.calls[callId]?.parentSessionId
                ) {
                  iosCallFlowLog(
                    "callStateChanged",
                    "CONNECTED deferred navigate (call row landed after apply)",
                    { callId }
                  );
                  setActiveCallId(callId);
                  openInCallScreen(callId, { force: true });
                }
              }, 0);
            } else {
              let reason: string;
              if (callState !== CallState.CONNECTED) {
                reason = "not CONNECTED";
              } else if (attendedTransferChild) {
                reason = "attended-transfer child (skip navigate)";
              } else if (hasActiveCall) {
                reason = "activeCallId already set";
              } else if (!callExistsInContext) {
                reason = "call not in context yet (skip navigate)";
              } else {
                reason = "unknown";
              }
              console.log(
                "🟠 [SoftphoneProvider] 📞 Call state changed but not navigating:",
                {
                  callId,
                  callState,
                  reason,
                  currentActiveCallId: snap.activeCallId
                }
              );
            }
          }, 0);
        }
      );

      sippyCup.on("callEnded", (callId: string, _reason: string) => {
        if (handledEndedCallIdsRef.current.has(callId)) {
          console.warn(
            `📞 [SP] ${new Date().toISOString()} duplicate callEnded ignored: callId=${callId} reason=${_reason}`
          );
          return;
        }
        handledEndedCallIdsRef.current.add(callId);
        if (handledEndedCallIdsRef.current.size > 500) {
          handledEndedCallIdsRef.current.clear();
        }

        console.warn(
          `📞 [SP] ${new Date().toISOString()} callEnded event: callId=${callId} reason=${_reason} activeCallId=${
            state.activeCallId
          }`
        );
        iosCallFlowLog("callEnded", "SessionManager / native ended", {
          callId,
          reason: _reason,
          activeCallId: state.activeCallId ?? null
        });

        const endedCallRow = stateRef.current.calls[callId];
        cleanupConferenceStaleLegRows(
          callId,
          stateRef.current.activeCallId,
          stateRef.current.calls,
          {
            updateCall,
            removeCall,
            handledEndedIds: handledEndedCallIdsRef.current
          }
        );

        // Attended-transfer only — never resurrect a pre-merge leg after conference end.
        if (!endedCallRow?.conferencing) {
          cleanupTransferRelationships(callId);
        }

        // Remove the call from state
        removeCall(callId);

        // Navigate back only when there is no promoted active call left.
        setTimeout(() => {
          setState((currentState) => {
            if (!currentState.activeCallId) {
              console.warn(
                `📞 [SP] ${new Date().toISOString()} callEnded: no active call remains, navigating back`
              );
              if (getCurrentRoute()?.name === Routes.InCallScreen) {
                navigation.goBack();
              }
            }
            return currentState;
          });
        }, 0);

        // USE_VOXO_MOBILE_APPROACH: Unregister when no SessionManager calls remain.
        // This closes the WebSocket so the next incoming comes only via VoIP push (SlimSipClient),
        // avoiding duplicate CallKit entries when web calls back after mobile→web.
        // Defer so SessionManager has finished removing the call from managedSessions (delete happens after emit).
        setTimeout(() => {
          const snap = stateRef.current;
          const keepWsRegisteredForForegroundCallNotifsOff =
            useIosJsSipStack &&
            AppState.currentState === "active" &&
            userRef.current?.enableMobileCallNotifications === 0;
          const keepHub = shouldKeepForegroundSipHubConnected(
            snap.calls,
            snap.activeCallId
          );
          if (useIosJsSipStack && !keepHub) {
            if (!keepWsRegisteredForForegroundCallNotifsOff) {
              console.warn(
                "📞 [SP] Foreground SlimSip hub disconnect (no live calls)"
              );
              void ForegroundSlimSipHub.getInstance().disconnect();
            }
          } else if (useIosJsSipStack && keepHub) {
            console.warn(
              "📞 [SP] Foreground SlimSip hub kept connected",
              JSON.stringify({
                reason: isConferenceMergeInProgress()
                  ? "conference_merge_in_progress"
                  : "live_calls_remain",
                liveCallCount: getLiveCallCount(snap.calls),
                activeCallId: snap.activeCallId ?? null
              })
            );
          } else if (
            USE_VOXO_MOBILE_APPROACH &&
            sippyCup.getActiveCalls().length === 0 &&
            !keepWsRegisteredForForegroundCallNotifsOff
          ) {
            sippyCup
              .unregister()
              .catch((e: any) =>
                console.warn(
                  "📞 [SP] Unregister after call end:",
                  e?.message || e
                )
              );
          }
        }, 0);
      });

      // Call property events
      sippyCup.on("callHeld", (callId: string) => {
        updateCall(callId, { isOnHold: true });
      });

      sippyCup.on("callUnheld", (callId: string) => {
        updateCall(callId, { isOnHold: false });
        setActiveCallId(callId); // Make unheld call active
      });

      sippyCup.on("callMuted", (callId: string) => {
        updateCall(callId, { isMuted: true });
      });

      sippyCup.on("callUnmuted", (callId: string) => {
        updateCall(callId, { isMuted: false });
      });

      sippyCup.on("callSpeakerOn", (callId: string) => {
        updateCall(callId, { isSpeakerOn: true });
      });

      sippyCup.on("callSpeakerOff", (callId: string) => {
        updateCall(callId, { isSpeakerOn: false });
      });

      sippyCup.on(
        "callRemotePartyUpdated",
        (
          callId: string,
          updates: { remoteDisplayName: string; remoteUri?: string }
        ) => {
          iosCallFlowLog("callRemotePartyUpdated", "SoftphoneProvider merge", {
            callId,
            remoteDisplayName: updates.remoteDisplayName,
            hasRemoteUri: !!updates.remoteUri
          });
          updateCall(callId, {
            remoteDisplayName: updates.remoteDisplayName,
            ...(updates.remoteUri
              ? { remoteUri: updates.remoteUri }
              : {})
          });
          if (Platform.OS === "ios") {
            const dialHint =
              updates.remoteUri ??
              stateRef.current.calls[callId]?.remoteUri ??
              "";
            sippyCup.reportCallKitLocalizedName(
              callId,
              updates.remoteDisplayName,
              dialHint
            );
          }
        }
      );

      // Note: Transfer state is now managed locally in the provider
      // SippyCup only handles SIP operations and emits standard call events
    },
    [
      addCall,
      removeCall,
      updateCall,
      applyCallStateChangeFromEvent,
      setActiveCallId,
      openInCallScreen,
      cleanupTransferRelationships,
      upsertCallInCalls,
      runPlaceOutboundJsSipCall
    ]
  );

  /**
   * Ensure SippyCup is initialized
   * @param forceRegisterForOutgoing Legacy: Android / sip.js; iOS JsSIP ignores SessionManager register
   */
  const ensureInitialized = useCallback(
    async (forceRegisterForOutgoing = false): Promise<SippyCup> => {
      const runEnsure = async (): Promise<SippyCup> => {
      const snap = stateRef.current;
      const cup0 = sippyCupRef.current;
      const callNotifsOff =
        userRef.current?.enableMobileCallNotifications === 0;
      const iosWsHubWhenCallNotifsOff =
        useIosJsSipStack && callNotifsOff;
      const iosWsHubForeground =
        iosWsHubWhenCallNotifsOff && AppState.currentState === "active";

      if (
        cup0 &&
        snap.isInitialized &&
        (useIosJsSipStack
          ? iosWsHubWhenCallNotifsOff
            ? ForegroundSlimSipHub.getInstance().isActive()
            : true
          : snap.isRegistered)
      ) {
        return cup0;
      }

      if (!state.config) {
        throw new Error("Softphone configuration not set");
      }

      try {
        if (!sippyCupRef.current) {
          setState((prev) => ({ ...prev, isInitializing: true }));
          await SessionManager.resetInstance();
          sippyCupRef.current = new SippyCup(state.config, getAppDisplayName(), {
            onSessionManagerReset: () => {
              if (sippyCupRef.current) {
                setupEventListeners(sippyCupRef.current);
              }
            }
          });
          // CallKit Recents / native UI outgoing calls (tap call log → start call action).
          sippyCupRef.current.setNativeStartCallHandler(
            async ({ callUUID, handle, name }) => {
              const safeHandle = String(handle || "").trim();
              const safeUUID = String(callUUID || "").trim().toLowerCase();
              const safeName = String(name || "").trim();
              if (!safeHandle || !safeUUID) return;

              const staleOutbound = shouldBlockStaleOutboundStartAction({
                callUUID: safeUUID,
                handle: safeHandle,
                hasLiveSipSession: !!getSipSession(safeUUID)
              });
              if (staleOutbound.blocked) {
                iosCallFlowLog(
                  "outbound.callkit",
                  "start handler ignored — stale replay",
                  {
                    callUUID: safeUUID,
                    handle: safeHandle,
                    reason: staleOutbound.reason
                  }
                );
                try {
                  CallKeep.endCall(safeUUID);
                } catch {
                  // ignore
                }
                return;
              }

              if (isOutboundStartupGraceActive()) {
                iosCallFlowLog(
                  "outbound.callkit",
                  "start handler ignored — startup grace",
                  {
                    callUUID: safeUUID,
                    remainingMs: getOutboundStartupGraceRemainingMs()
                  }
                );
                return;
              }

              const displayForCallKit = resolveCallKitStartDisplayName(
                safeName,
                safeHandle
              );

              const deadline = Date.now() + IOS_CALLKIT_START_INIT_RETRY_MS;
              let lastErr: unknown;
              while (Date.now() < deadline) {
                try {
                  const sippy = await ensureInitialized(false);
                  const callId = await sippy.makeCallFromCallKitStartAction(
                    safeHandle,
                    safeUUID,
                    displayForCallKit || undefined
                  );
                  setActiveCallId(callId);
                  openInCallScreen(callId, { force: true });
                  iosCallFlowLog("outbound.callkit", "navigate InCall after Recents start", {
                    callId,
                    callUUID: safeUUID
                  });
                  return;
                } catch (e) {
                  lastErr = e;
                  const msg = String((e as Error)?.message ?? e ?? "");
                  if (
                    msg.includes("already initializing") ||
                    msg.includes("Softphone configuration not set") ||
                    msg.includes("Connect aborted")
                  ) {
                    await new Promise((r) =>
                      setTimeout(r, IOS_CALLKIT_START_POLL_MS)
                    );
                    continue;
                  }
                  console.error(
                    "[SoftphoneProvider] CallKit Recents / Siri outbound failed:",
                    e
                  );
            iosCallFlowError(
              "outbound.callkit",
              "makeCallFromCallKitStartAction failed",
              e instanceof Error ? e : new Error(String(e)),
              {
                safeUUID,
                safeHandle,
                hasName: !!(safeName || displayForCallKit)
              }
            );
                  break;
                }
              }
              if (Date.now() >= deadline && lastErr) {
                console.error(
                  "[SoftphoneProvider] CallKit outbound timed out waiting for softphone:",
                  lastErr
                );
                iosCallFlowError(
                  "outbound.callkit",
                  "ensureInitialized timeout for CallKit start",
                  lastErr instanceof Error ? lastErr : new Error(String(lastErr)),
                  {
                    safeUUID,
                    safeHandle,
                    hasName: !!(safeName || displayForCallKit)
                  }
                );
              }
              try {
                CallKeep.endCall(safeUUID);
              } catch {
                // ignore
              }
            }
          );
          setupEventListeners(sippyCupRef.current);
        }

        // Always run SippyCup.initialize(): idempotent; avoids skipping init when React
        // state is stale after a new SippyCup instance (register() requires init).
        await sippyCupRef.current.initialize();

        if (useIosJsSipStack) {
          if (iosWsHubForeground) {
            iosCallFlowLog(
              "ensureInitialized",
              "iOS WebSocket hub connect (call notifs off, foreground)",
              { appState: AppState.currentState }
            );
            await ForegroundSlimSipHub.getInstance().connect();
            setState((prev) => ({
              ...prev,
              isInitialized: true,
              isInitializing: false,
              isRegistered: true,
              isRegistering: false
            }));
          } else {
            setState((prev) => ({
              ...prev,
              isInitialized: true,
              isInitializing: false,
              isRegistering: false
            }));
          }
          return sippyCupRef.current!;
        }

        if (!stateRef.current.isRegistered) {
          if (Platform.OS === "ios" && !forceRegisterForOutgoing) {
            // @ts-ignore
            if (global.pendingVoipPushWakeup) {
              return sippyCupRef.current!;
            }
            const pendingCalls = await PendingCallManager.getPendingCalls();
            if (Object.keys(pendingCalls).length > 0) {
              return sippyCupRef.current!;
            }
          }
          setState((prev) => ({ ...prev, isRegistering: true }));
          await sippyCupRef.current.register();
          iosCallFlowLog(
            "ensureInitialized",
            "SessionManager.register() completed",
            { forceRegisterForOutgoing }
          );
        }

        return sippyCupRef.current;
      } catch (error) {
        logger.error("Failed to initialize:", error);
        setState((prev) => ({
          ...prev,
          isInitializing: false,
          isRegistering: false
        }));
        throw error;
      }
      };

      const done = ensureInitChainRef.current.then(runEnsure);
      ensureInitChainRef.current = done.then(
        () => undefined,
        () => undefined
      );
      return done;
    },
    [
      state.config,
      state.isInitialized,
      state.isRegistered,
      setupEventListeners,
      setActiveCallId,
      openInCallScreen,
      user?.enableMobileCallNotifications
    ]
  );
  useEffect(() => {
    if (user) {
      ensureInitialized();
    }
  }, [user, ensureInitialized]);

  /**
   * iOS: user turned call notifications off while app is active — run an immediate
   * re-REGISTER after the first binding (same as sip.js refresh at 75% of expires).
   */
  useEffect(() => {
    if (Platform.OS !== "ios" || !USE_VOXO_MOBILE_APPROACH || !user) {
      return;
    }
    const next = user.enableMobileCallNotifications;
    const prev = prevMobileCallNotifsRef.current;
    prevMobileCallNotifsRef.current = next;
    if (prev === undefined) {
      return;
    }
    if (prev === 0 || next !== 0 || AppState.currentState !== "active") {
      return;
    }
    void (async () => {
      try {
        iosCallFlowLog(
          "call-notifs",
          "turned off — foreground SIP register + refresh binding",
          {}
        );
        await ensureInitialized(false);
        await ForegroundSlimSipHub.getInstance().connect();
        setState((p) => ({
          ...p,
          isInitialized: true,
          isRegistered: true,
          isRegistering: false
        }));
      } catch (err) {
        logger.warn(
          "call-notifs-off: foreground SlimSip hub connect failed:",
          err
        );
        iosCallFlowError(
          "call-notifs",
          "turned off SIP refresh failed",
          err,
          {}
        );
      }
    })();
  }, [user?.enableMobileCallNotifications, user?.id, ensureInitialized]);

  /**
   * iOS + USE_VOXO_MOBILE_APPROACH: when mobile call notifications are off, keep SessionManager
   * registered only while the app is foreground (WebSocket) — no SIP register in background
   * so killed/background incoming stays VoIP-free (server stops push; native also gates CallKit).
   */
  useEffect(() => {
    if (Platform.OS !== "ios" || !USE_VOXO_MOBILE_APPROACH) {
      return;
    }
    callNotifAppStatePrevRef.current = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const prev = callNotifAppStatePrevRef.current;
      callNotifAppStatePrevRef.current = next;
      const u = userRef.current;
      if (!u || u.enableMobileCallNotifications !== 0) {
        return;
      }

      if (next === "active" && prev !== "active") {
        markIosAppForegrounded();
        iosCallFlowLog(
          "foreground-sip",
          "became active — ensure SessionManager (call notifs off)",
          {}
        );
        void (async () => {
          try {
            await ensureInitialized(false);
            await ForegroundSlimSipHub.getInstance().connect();
          } catch (err) {
            logger.warn(
              "foreground-sip: hub connect after resume failed:",
              err
            );
          }
        })();
        return;
      }

      if (prev === "active" && next !== "active") {
        const snap = stateRef.current;
        if (getLiveCallCount(snap.calls) > 0) {
          return;
        }
        iosCallFlowLog(
          "foreground-sip",
          "left foreground — disconnect WS hub (call notifs off)",
          {}
        );
        void ForegroundSlimSipHub.getInstance().disconnect();
        setState((prev) => ({
          ...prev,
          isRegistered: false
        }));
      }
    });
    return () => sub.remove();
  }, [ensureInitialized]);

  /** Foreground WebSocket INVITE when mobile call notifications are off. */
  useEffect(() => {
    if (!useIosJsSipStack) {
      return;
    }
    const hub = ForegroundSlimSipHub.getInstance();
    hub.setIncomingHandler(
      ({ sipSession, callUuid, remoteUri, remoteDisplayName }) => {
        if (AppState.currentState !== "active") {
          return;
        }
        const client = hub.getClient();
        if (!client) {
          return;
        }
        handleForegroundWsIncoming({
          callUuid,
          remoteUri,
          remoteDisplayName,
          sipSession,
          client,
          addCall,
          removeCall,
          applyCallStateChange: applyCallStateChangeFromEvent,
          reportCallKitLocalizedName: (id, name, dialHint) => {
            sippyCupRef.current?.reportCallKitLocalizedName(id, name, dialHint);
          },
          displayIncomingCall: async (id, info) => {
            const cup = sippyCupRef.current;
            if (!cup) {
              return;
            }
            await cup.displayIncomingCall(id, {
              id,
              state: CallState.INCOMING,
              direction: CallDirection.INCOMING,
              remoteDisplayName: info.remoteDisplayName,
              remoteUri: info.remoteUri,
              startTime: new Date(),
              isMuted: false,
              isOnHold: false,
              isSpeakerOn: false,
              isEmergency: false
            });
          }
        });
      }
    );
    return () => hub.setIncomingHandler(null);
  }, [addCall, removeCall, applyCallStateChangeFromEvent]);

  // Retry SessionManager registration after VoIP push call is handled.
  // When ensureInitialized defers due to pendingVoipPushWakeup or pending UserDefaults,
  // this polls until cleared, then triggers registration for future foreground calls.
  // Skip when USE_VOXO_MOBILE_APPROACH: we don't register SessionManager at startup.
  useEffect(() => {
    if (
      USE_VOXO_MOBILE_APPROACH ||
      Platform.OS !== "ios" ||
      state.isRegistered ||
      !state.isInitialized ||
      !sippyCupRef.current
    ) {
      return;
    }

    const retryInterval = setInterval(async () => {
      // @ts-ignore
      if (
        !global.pendingVoipPushWakeup &&
        sippyCupRef.current &&
        !state.isRegistered
      ) {
        console.warn(
          `📱 [SP] ${new Date().toISOString()} Retry: VoIP push handled, now registering SessionManager`
        );
        clearInterval(retryInterval);
        try {
          await ensureInitialized();
        } catch (error) {
          logger.error(
            "Failed to register SessionManager after VoIP push:",
            error
          );
        }
      }
    }, 2000);

    return () => clearInterval(retryInterval);
  }, [state.isRegistered, state.isInitialized, ensureInitialized]);

  // Public API methods
  const makeCall = useCallback(
    async (destination: string, options?: CallOptions): Promise<string> => {
      if (useIosJsSipStack) {
        const normDest = normalizeOutboundDialString(destination);
        const inFlight = outboundSetupInFlightRef.current;
        if (inFlight) {
          const sameDest =
            normalizeOutboundDialString(inFlight.destination) === normDest;
          const recent =
            Date.now() - inFlight.startedAt < IOS_OUTBOUND_COALESCE_MS;
          if (sameDest && recent) {
            iosCallFlowLog("makeCall", "COALESCED — outbound already in flight", {
              destination: normDest
            });
            return inFlight.promise;
          }
        }
      }

      const runMakeCall = async (): Promise<string> => {
      const snap = stateRef.current;
      const liveCalls = Object.values(snap.calls).filter(
        (c) => c.state !== CallState.ENDED && c.state !== CallState.FAILED
      );
      iosCallFlowLog("makeCall", "START outbound", {
        destination,
        activeCallId: snap.activeCallId ?? null,
        isInitializing: snap.isInitializing,
        isRegistering: snap.isRegistering,
        isRegistered: snap.isRegistered,
        isInitialized: snap.isInitialized,
        liveCallCount: liveCalls.length,
        liveSessionIds: liveCalls.map((c) => c.sessionId)
      });

      if (useIosJsSipStack) {
        if (
          snap.activeCallId === "dialing" ||
          (snap.activeCallId &&
            snap.activeCallId !== "testing" &&
            liveCalls.length > 0)
        ) {
          throw new Error("Call already in progress");
        }
        setActiveCallId("dialing");
      }

      const resetSipStackForRetry = async (reason: string) => {
        iosCallFlowLog("makeCall", "reset SIP stack before retry", { reason });
        if (useIosJsSipStack) {
          disposeAllSipSessions();
          await ForegroundSlimSipHub.getInstance().disconnect();
          return;
        }
        const current = sippyCupRef.current;
        if (current) {
          try {
            if (stateRef.current.isRegistered) {
              await current.unregister();
            }
          } catch (unregisterError) {
            logger.warn(
              "Failed to unregister during outbound retry reset:",
              unregisterError
            );
          } finally {
            current.dispose();
            sippyCupRef.current = null;
          }
        }
        await SessionManager.resetInstance();
        setState((prev) => ({
          ...prev,
          isInitialized: false,
          isInitializing: false,
          isRegistered: false,
          isRegistering: false
        }));
      };

      const shouldRetryOutboundSetup = (error: unknown): boolean => {
        const msg =
          error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();
        return (
          msg.includes("timed out") ||
          msg.includes("timeout") ||
          msg.includes("already initializing") ||
          msg.includes("transport")
        );
      };

      let dialingWatchdog: ReturnType<typeof setTimeout> | null = null;
      try {
        // Check permissions on Android before making call.
        if (Platform.OS === "android") {
          logger.debug("Checking Android permissions before making call");

          // Check microphone permission.
          const micPermission = await ensurePermission("microphone");
          if (!micPermission.granted) {
            logger.error("Microphone permission not granted");
            Alert.alert(
              "Microphone Permission Required",
              "Please enable microphone permission in your device settings to make calls.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Open Settings", onPress: () => Linking.openSettings() }
              ]
            );
            throw new Error("Microphone permission denied");
          }

          // Check phone permission (READ_PHONE_STATE).
          const phonePermission = await ensurePermission("phone");
          if (!phonePermission.granted) {
            logger.error("Phone permission not granted");
            Alert.alert(
              "Phone Permission Required",
              "Please enable phone permission in your device settings to make calls.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Open Settings", onPress: () => Linking.openSettings() }
              ]
            );
            throw new Error("Phone permission denied");
          }

          logger.debug("All Android permissions granted for calling");
        }

        if (!useIosJsSipStack) {
          setActiveCallId("dialing");
        }
        iosCallFlowLog("makeCall", "set activeCallId=dialing", {
          destination
        });
        dialingWatchdog = setTimeout(() => {
          iosCallFlowLog(
            "makeCall",
            "dialing watchdog fired; clearing stale state",
            {
              destination,
              activeCallIdAtWatchdog: stateRef.current.activeCallId ?? null
            }
          );
          setState((prev) => ({
            ...prev,
            ...(prev.activeCallId === "dialing"
              ? {
                  activeCallId: undefined,
                  error: new Error("Call setup timed out. Please try again.")
                }
              : {})
          }));
        }, DIALING_WATCHDOG_TIMEOUT_MS);

        // Generate call UUID if not provided
        const callUuid = options?.callUuid || uuidv4();

        // Enhanced options with VoxoConnect-specific headers
        const enhancedOptions: CallOptions = {
          ...options,
          callUuid
        };

        // Handle emergency calls (911/933) - get location
        if (destination === "911" || destination === "933") {
          try {
            const location = await getCurrentLocation();
            enhancedOptions.locationData = location;
            enhancedOptions.isEmergency = true;
          } catch (error) {
            logger.error("Failed to get location for emergency call:", error);
            // Continue with call even if location fails
          }
        }

        if (
          enhancedOptions.displayName != null ||
          enhancedOptions.avatarPath != null
        ) {
          pendingOutgoingContactMetadataRef.current = {
            displayName: enhancedOptions.displayName ?? undefined,
            avatarPath: enhancedOptions.avatarPath
          };
        }
        let sessionId: string | null = null;
        let lastSetupError: unknown;

        if (useIosJsSipStack) {
          iosCallFlowLog("makeCall", "invoking placeOutboundJsSipCall", {
            destination,
            callUuid: enhancedOptions.callUuid
          });
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              await withTimeout(
                ensureInitialized(false),
                OUTBOUND_INIT_TIMEOUT_MS,
                "ensureInitialized"
              );
              sessionId = await withTimeout(
                runPlaceOutboundJsSipCall(destination, {
                  callUuid: enhancedOptions.callUuid!,
                  displayName: enhancedOptions.displayName,
                  outboundNumberId: enhancedOptions.outboundNumberId,
                  origin: "inApp",
                  isEmergency: enhancedOptions.isEmergency
                }),
                OUTBOUND_RETRYABLE_SETUP_TIMEOUT_MS,
                "placeOutboundJsSipCall"
              );
              break;
            } catch (setupError) {
              lastSetupError = setupError;
              if (attempt >= 2 || !shouldRetryOutboundSetup(setupError)) {
                throw setupError;
              }
              await resetSipStackForRetry(String(setupError));
            }
          }
        } else {
          iosCallFlowLog("makeCall", "invoking SippyCup.makeCall", {
            destination,
            callUuid: enhancedOptions.callUuid
          });
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              const sippyCup = await withTimeout(
                ensureInitialized(true),
                OUTBOUND_INIT_TIMEOUT_MS,
                "ensureInitialized(true)"
              );
              sessionId = await withTimeout(
                sippyCup.makeCall(destination, enhancedOptions),
                OUTBOUND_RETRYABLE_SETUP_TIMEOUT_MS,
                "SippyCup.makeCall"
              );
              break;
            } catch (setupError) {
              lastSetupError = setupError;
              if (attempt >= 2 || !shouldRetryOutboundSetup(setupError)) {
                throw setupError;
              }
              await resetSipStackForRetry(String(setupError));
            }
          }

          if (sessionId && !stateRef.current.calls[sessionId]) {
            setState((prev) => {
              if (prev.calls[sessionId!]) return prev;
              const fallbackCall: ContextCallInfo = {
                callId: sessionId!,
                sessionId: sessionId!,
                state: CallState.OUTGOING,
                direction: CallDirection.OUTGOING,
                remoteDisplayName: destination,
                remoteUri: `sip:${destination}@dev-sip.voxo.co`,
                startTime: new Date().toISOString(),
                isMuted: false,
                isOnHold: false,
                isSpeakerOn: false,
                isEmergency: enhancedOptions.isEmergency ?? false,
                connected: false,
                recording: false,
                conferencing: false,
                attendedTransfer: false,
                totalCallDuration: 0,
                currentHoldDuration: 0,
                totalHoldDuration: 0,
                mutedConferenceParticipants: [],
                ...(enhancedOptions.displayName != null && {
                  contactDisplayName: enhancedOptions.displayName
                }),
                ...(enhancedOptions.avatarPath != null && {
                  contactAvatarPath: enhancedOptions.avatarPath
                })
              };
              return {
                ...prev,
                calls: { ...prev.calls, [sessionId!]: fallbackCall }
              };
            });
            setActiveCallId(sessionId);
          }
        }

        if (!sessionId) {
          throw (
            lastSetupError ??
            new Error("Failed to establish outbound SIP session")
          );
        }

        if (
          (enhancedOptions.displayName != null ||
            enhancedOptions.avatarPath != null) &&
          updateCall
        ) {
          updateCall(sessionId, {
            ...(enhancedOptions.displayName != null && {
              contactDisplayName: enhancedOptions.displayName
            }),
            ...(enhancedOptions.avatarPath != null && {
              contactAvatarPath: enhancedOptions.avatarPath
            })
          });
        }

        return sessionId;
      } catch (error) {
        logger.error("Failed to make call:", error);
        const msg = error instanceof Error ? error.message : String(error);
        iosCallFlowLog("makeCall", "FAILED — clearing dialing if stuck", {
          destination,
          errorMessage: msg,
          activeCallIdAtFail: stateRef.current.activeCallId ?? null,
          callKeys: Object.keys(stateRef.current.calls)
        });
        setState((prev) => ({
          ...prev,
          error: error as Error,
          ...(prev.activeCallId === "dialing"
            ? { activeCallId: undefined }
            : {})
        }));
        throw error;
      } finally {
        if (dialingWatchdog) {
          clearTimeout(dialingWatchdog);
        }
      }
      };

      const promise = runMakeCall();
      if (useIosJsSipStack) {
        outboundSetupInFlightRef.current = {
          promise,
          destination,
          startedAt: Date.now()
        };
        try {
          return await promise;
        } finally {
          if (outboundSetupInFlightRef.current?.promise === promise) {
            outboundSetupInFlightRef.current = null;
          }
        }
      }
      return promise;
    },
    [
      ensureInitialized,
      addCall,
      setActiveCallId,
      updateCall,
      runPlaceOutboundJsSipCall
    ]
  );

  const answerCall = useCallback(
    async (callId: string): Promise<void> => {
      const sipSession = getSipSession(callId);
      if (sipSession) {
        sipSession.answer();
        applyCallStateChangeFromEvent(callId, CallState.CONNECTED);
        setActiveCallId(callId);
        openInCallScreen(callId, { force: true });
        if (Platform.OS === "ios") {
          const call = stateRef.current.calls[callId];
          const cup = sippyCupRef.current;
          if (cup && call) {
            cup.reportCallKitLocalizedName(
              callId,
              call.remoteDisplayName ?? "",
              call.remoteUri ?? ""
            );
          }
        }
        return;
      }
      const sippyCup = await ensureInitialized();
      await sippyCup.answerCall(callId);
      setActiveCallId(callId);
    },
    [
      ensureInitialized,
      setActiveCallId,
      applyCallStateChangeFromEvent,
      openInCallScreen
    ]
  );

  const answerCallViaCallKeep = useCallback(
    async (callId: string): Promise<void> => {
      const sippyCup = await ensureInitialized();
      await sippyCup.answerCallViaCallKeep(callId);
      // Don't set active call ID here - it will be set when CallKeep triggers the answer event
    },
    [ensureInitialized]
  );

  /**
   * Killed-state / deferred expo boot: SIP may be connected while React `calls` is still empty
   * (accept ran before SoftphoneProvider mounted, or pending answer used onAnswerCall path).
   */
  const adoptOrphanedVoipCalls = useCallback(async (): Promise<void> => {
    if (Platform.OS !== "ios") {
      return;
    }

    const snap = stateRef.current;
    if (getLiveCallCount(snap.calls) > 0) {
      return;
    }

    const voipBridge = VoipBridge.getInstance();
    const candidateIds = new Set<string>([
      ...getAllPendingSipSessionIds(),
      ...voipBridge.getTrackedVoipCallIds()
    ]);

    for (const callId of candidateIds) {
      const existing = snap.calls[callId];
      if (existing && isLiveCallState(existing.state)) {
        continue;
      }

      const sipSession = getSipSession(callId);
      if (!sipSession || isSipSessionEnded(sipSession)) {
        continue;
      }

      const connected = isSipSessionConnected(sipSession);
      const isVoipCandidate =
        voipBridge.isVoipCall(callId) ||
        voipBridge.hasPendingAnswer(callId) ||
        isIosVoipUuid(callId);

      if (!isVoipCandidate || !connected) {
        continue;
      }

      iosCallFlowLog(
        "adoptVoipCall",
        "orphaned killed-state call → React state + InCallScreen",
        { callId, connected }
      );
      console.warn(
        `📞 [SP] ${new Date().toISOString()} adoptOrphanedVoipCalls: adopting ${callId} (connected=${connected})`
      );

      const entry = buildVoipCallEntry(
        callId,
        sipSession,
        voipBridge,
        connected
      );
      addCall(entry);
      setActiveCallId(callId);
      openInCallScreen(callId, { force: true });
      voipBridge.clearPendingAnswer(callId);
      sippyCupRef.current?.emit(
        "callStateChanged",
        callId,
        CallState.CONNECTED
      );
      return;
    }
  }, [addCall, setActiveCallId, openInCallScreen]);

  /**
   * Check for pending VoIP calls on app launch (iOS killed state)
   * When user answers from CallKit in killed state, the call data is stored in UserDefaults
   * We retrieve it here and establish the SIP session immediately
   */
  useEffect(() => {
    const checkPendingCalls = async () => {
      if (Platform.OS !== "ios") return;

      try {
        // @ts-ignore
        console.warn(
          `� [SP] ${new Date().toISOString()} checkPendingCalls | wakeupFlag=${!!global.pendingVoipPushWakeup}`
        );
        const pendingCalls = await PendingCallManager.getPendingCalls();

        if (Object.keys(pendingCalls).length === 0) {
          console.warn(
            `� [SP] ${new Date().toISOString()} checkPendingCalls: no pending calls`
          );
          await adoptOrphanedVoipCalls();
          return;
        }

        console.warn(
          `� [SP] ${new Date().toISOString()} checkPendingCalls: found ${
            Object.keys(pendingCalls).length
          } pending: ${Object.keys(pendingCalls).join(", ")}`
        );

        // Process each pending call
        for (const [callUuid, callData] of Object.entries(pendingCalls)) {
          const stalePayload = {
            sentAt: callData.sentAt,
            staleDeclined: callData.staleDeclined
          };
          const { stale } = getVoipPushAge(stalePayload);
          if (stale || isVoipPushStaleDeclined(stalePayload)) {
            console.warn(
              `📞 [SP] ${new Date().toISOString()} checkPendingCalls SKIP stale ${callUuid}`
            );
            scheduleStaleVoipMissedCallFallback({
              callUuid,
              callerName: callData.callerName || "Unknown Caller",
              callerNumber: callData.callerNumber || "Unknown Number",
              payload: callData
            });
            await PendingCallManager.clearPendingCall(callUuid);
            continue;
          }

          console.warn(
            `� [SP] ${new Date().toISOString()} checkPendingCalls processing: uuid=${callUuid} ip=${
              callData.callerIp
            }`
          );

          // CRITICAL: Skip if NotificationManager is already handling this call via
          // didLoadWithEvents. Creating a second session here causes duplicate REGISTER.
          // @ts-ignore
          const alreadyHandled =
            global.pendingVoipPushWakeup ||
            // @ts-ignore
            (global.pendingSipSessions &&
              global.pendingSipSessions.has(callUuid));
          if (alreadyHandled) {
            console.warn(
              `� [SP] ${new Date().toISOString()} checkPendingCalls SKIPPED ${callUuid} (NM handling)`
            );
            await PendingCallManager.clearPendingCall(callUuid);
            continue;
          }

          // Establish SIP session only if NotificationManager didn't handle it
          if (callData.callerIp) {
            try {
              const sippyCup = await ensureInitialized();
              console.warn(
                `� [SP] ${new Date().toISOString()} checkPendingCalls establishing SIP session for ${callUuid}`
              );
              await sippyCup.establishInboundSession(
                callUuid,
                callData.callerIp
              );
              console.warn(
                `� [SP] ${new Date().toISOString()} checkPendingCalls ✅ SIP session established for ${callUuid}`
              );

              // Clear this pending call from storage
              await PendingCallManager.clearPendingCall(callUuid);
            } catch (error) {
              console.error(
                `� [SP] ${new Date().toISOString()} checkPendingCalls ❌ Failed for ${callUuid}:`,
                error
              );
            }
          }
        }

        await adoptOrphanedVoipCalls();
      } catch (error) {
        console.error(
          "🟪 [SoftphoneProvider] 📞 ❌ Error checking pending calls:",
          error
        );
      }
    };

    // Check for pending calls shortly after component mounts
    const timer = setTimeout(checkPendingCalls, 1000);
    return () => clearTimeout(timer);
  }, [ensureInitialized, adoptOrphanedVoipCalls]);

  /** Retry adoption while expo shell / navigation finish loading after killed-state accept. */
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }
    const timers = [800, 2000, 4000].map((ms) =>
      setTimeout(() => {
        void adoptOrphanedVoipCalls();
      }, ms)
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [adoptOrphanedVoipCalls]);

  /** Foreground: adopt connected SIP leg if CallKit is active but React state is empty. */
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }
      setTimeout(() => {
        void adoptOrphanedVoipCalls();
      }, 300);
    });
    return () => sub.remove();
  }, [adoptOrphanedVoipCalls]);

  const hangupSingleLeg = useCallback(
    async (callId: string): Promise<void> => {
      const voipBridge = VoipBridge.getInstance();
      const sipSession = getSipSession(callId);

      // VoIP call (SlimSipClient) — not in SessionManager
      if (voipBridge.isVoipCall(callId) || sipSession) {
        console.warn(
          `📞 [SP] ${new Date().toISOString()} hangupSingleLeg: JsSIP/VoIP path for callId=${callId}`
        );
        const sippyCup = await ensureInitialized();
        if (voipBridge.isVoipCall(callId)) {
          if (sipSession) {
            sipSession.sipTerminate();
          }
          voipBridge.handleCallEnd(callId);
        } else {
          getSuppressedCallKeepEndSet().add(callId);
          try {
            await sippyCup
              .getNativeIntegration()
              .updateCallState(callId, CallState.ENDED);
          } catch (endNativeErr) {
            logger.warn(
              "hangupSingleLeg: failed to end CallKit for JsSIP leg:",
              endNativeErr
            );
          }
          if (sipSession) {
            sipSession.sipTerminate();
          }
          sippyCup.emit("callEnded", callId, "hangup");
        }
        removeSipSession(callId);
        return;
      }

      const sippyCup = await ensureInitialized();
      await sippyCup.hangupCall(callId);
    },
    [ensureInitialized]
  );

  const hangupCall = useCallback(
    async (callId: string): Promise<void> => {
      console.warn(
        `📞 [SP] ${new Date().toISOString()} hangupCall called: callId=${callId}`
      );

      const call = stateRef.current.calls[callId];
      if (call?.conferencing && call.conferenceId) {
        const legIds = getLiveConferenceLegs(
          call.conferenceId,
          stateRef.current.calls
        ).map((c) => c.sessionId);
        for (const legId of legIds) {
          await hangupSingleLeg(legId);
        }
        return;
      }

      await hangupSingleLeg(callId);
    },
    [hangupSingleLeg]
  );

  const holdCall = useCallback(
    async (callId: string): Promise<void> => {
      const sipSession = getSipSession(callId);
      if (sipSession) {
        sipSession.sipHold();
        updateCall(callId, { isOnHold: true });
        return;
      }
      if (useIosJsSipStack) {
        return;
      }

      const voipBridge = VoipBridge.getInstance();
      if (voipBridge.isVoipCall(callId)) {
        return;
      }

      const sippyCup = await ensureInitialized();
      await sippyCup.holdCall(callId);
    },
    [ensureInitialized, updateCall]
  );

  const unholdCall = useCallback(
    async (callId: string): Promise<void> => {
      const sipSession = getSipSession(callId);

      if (sipSession) {
        sipSession.sipUnhold();
        updateCall(callId, { isOnHold: false });
          const callsMap = stateRef.current.calls;
          const unheld = callsMap[callId];
          const hasConferencePeer =
            !!unheld?.conferencing &&
            !!unheld.conferenceId &&
            Object.values(callsMap).some(
              (c) =>
                c.sessionId !== callId &&
                c.conferenceId === unheld.conferenceId &&
                c.state !== CallState.ENDED &&
                c.state !== CallState.FAILED
            );
          if (!hasConferencePeer) {
            setActiveCallId(callId);
          }
        return;
      }
      if (useIosJsSipStack) {
        return;
      }

      const voipBridge = VoipBridge.getInstance();
      if (voipBridge.isVoipCall(callId)) {
        return;
      }

      const sippyCup = await ensureInitialized();
      await sippyCup.unholdCall(callId);
    },
    [ensureInitialized, updateCall, setActiveCallId]
  );

  const muteCall = useCallback(
    async (callId: string): Promise<void> => {
      const voipBridge = VoipBridge.getInstance();
      const ids = getSessionIdsForConferenceMute(
        callId,
        stateRef.current.calls
      );
      const needsSippy: string[] = [];

      for (const id of ids) {
        const sipSession = getSipSession(id);
        if (voipBridge.isVoipCall(id) || sipSession) {
          if (sipSession) {
            sipSession.webRTCmute();
            updateCall(id, { isMuted: true });
          }
        } else {
          needsSippy.push(id);
        }
      }

      if (needsSippy.length > 0) {
        const sippyCup = await ensureInitialized();
        for (const id of needsSippy) {
          await sippyCup.muteCall(id);
        }
      }
    },
    [ensureInitialized, updateCall]
  );

  const unmuteCall = useCallback(
    async (callId: string): Promise<void> => {
      const voipBridge = VoipBridge.getInstance();
      const ids = getSessionIdsForConferenceMute(
        callId,
        stateRef.current.calls
      );
      const needsSippy: string[] = [];

      for (const id of ids) {
        const sipSession = getSipSession(id);
        if (voipBridge.isVoipCall(id) || sipSession) {
          if (sipSession) {
            sipSession.webRTCunmute();
            updateCall(id, { isMuted: false });
          }
        } else {
          needsSippy.push(id);
        }
      }

      if (needsSippy.length > 0) {
        const sippyCup = await ensureInitialized();
        for (const id of needsSippy) {
          await sippyCup.unmuteCall(id);
        }
      }
    },
    [ensureInitialized, updateCall]
  );

  const setSpeaker = useCallback(
    async (callId: string, enabled: boolean): Promise<void> => {
      const voipBridge = VoipBridge.getInstance();
      const sipSession = getSipSession(callId);

      // VoIP call — use InCallManager (global audio routing) + update UI state
      if (voipBridge.isVoipCall(callId) || sipSession) {
        InCallManager.setForceSpeakerphoneOn(enabled);
        updateCall(callId, { isSpeakerOn: enabled });
        return;
      }

      const sippyCup = await ensureInitialized();
      await sippyCup.setSpeaker(callId, enabled);
    },
    [ensureInitialized, updateCall]
  );

  const sendDTMF = useCallback(
    async (callId: string, tones: string): Promise<void> => {
      playDtmfSidetoneIos(tones);

      const voipBridge = VoipBridge.getInstance();
      const sipSession = getSipSession(callId);
      const isVoip = voipBridge.isVoipCall(callId);
      const hasSipSession = !!sipSession;

      console.warn("[DTMF-TRACE] 2 SoftphoneProvider.sendDTMF enter", {
        callId,
        tones,
        isVoipCall: isVoip,
        hasSipSession,
        project: "ios-project",
        branch:
          isVoip || hasSipSession
            ? "voip_or_slimSip"
            : "sessionManager_sippyCup"
      });

      if (isVoip || sipSession) {
        if (sipSession && tones) {
          for (const tone of tones) {
            sipSession.sendSipInfoDtmf(tone);
          }
          console.warn(
            "[DTMF-TRACE] 2 SoftphoneProvider.sendDTMF done (SIP INFO DTMF)",
            {
              callId,
              tones,
              project: "ios-project"
            }
          );
        } else {
          console.warn(
            "[DTMF-TRACE] 2 SoftphoneProvider.sendDTMF voip branch but no sipSession or empty tones — no DTMF sent",
            { callId, tones, isVoip, hasSipSession, project: "ios-project" }
          );
        }
        return;
      }

      const sippyCup = await ensureInitialized();
      console.warn("[DTMF-TRACE] 2 SoftphoneProvider → sippyCup.sendDTMF", {
        callId,
        tones,
        project: "ios-project"
      });
      await sippyCup.sendDTMF(callId, tones);
    },
    [ensureInitialized]
  );

  const transferCall = useCallback(
    async (callId: string, target: string): Promise<void> => {
      const voipBridge = VoipBridge.getInstance();
      const sipSession = getSipSession(callId);

      // VoIP call (SlimSipClient) — use SipSession.blindTransfer
      if (voipBridge.isVoipCall(callId) || sipSession) {
        if (!sipSession) {
          throw new Error("Session not found");
        }
        await sipSession.blindTransfer(target);
        sipSession.sipTerminate();
        const sippyCup = await ensureInitialized();
        sippyCup.emit("callStateChanged", callId, CallState.ENDED);
        voipBridge.handleCallEnd(callId);
        removeSipSession(callId);
        return;
      }

      const sippyCup = await ensureInitialized();
      await sippyCup.transfer(callId, target);
    },
    [ensureInitialized]
  );

  const startAttendedTransfer = useCallback(
    async (
      callId: string,
      target: string,
      options?: { displayName?: string }
    ): Promise<string> => {
      const displayName = options?.displayName?.trim() || undefined;
      const voipBridge = VoipBridge.getInstance();
      const parentSipSession = getSipSession(callId);

      // Get the original call
      const originalCall = state.calls[callId];
      logger.debug("startAttendedTransfer: Original call lookup", {
        callId,
        callFound: !!originalCall,
        isOnHold: originalCall?.isOnHold,
        hasDisplayName: !!displayName
      });

      if (!originalCall) {
        logger.error("startAttendedTransfer: Original call not found", {
          callId,
          availableCallIds: Object.keys(state.calls)
        });
        throw new Error("Cannot start transfer - original call not found");
      }

      // VoIP path (SlimSipClient sessions): create transfer leg with SlimSipClient
      // so merge can use SIP attended transfer (REFER with Replaces) like voxo-mobile.
      if (voipBridge.isVoipCall(callId) || parentSipSession) {
        if (!parentSipSession) {
          throw new Error(
            "Cannot start transfer - parent SIP session not found"
          );
        }

        const resolvedParentCallId = resolveBackendCallId(
          originalCall,
          parentSipSession
        );
        if (
          resolvedParentCallId &&
          resolvedParentCallId !== originalCall.callId
        ) {
          updateCall(callId, { callId: resolvedParentCallId });
        }

        // Hold current call before dialing transfer target.
        parentSipSession.sipHold();
        updateCall(callId, { isOnHold: true });

        const transferCallUuid = uuidv4();
        const sipSettings = buildSlimSipSettings(transferCallUuid, "outbound");
        if (!sipSettings) {
          throw new Error("Cannot start transfer - missing SIP credentials");
        }

        const transferClient = new SlimSipClient(sipSettings);
        const transferSession = await transferClient.call(
          target,
          transferCallUuid
        );
        storeSipSession(transferCallUuid, transferSession, transferClient);
        const childServerCallId =
          extractServerCallIdFromSipSession(
            transferSession,
            "startAttendedTransfer-child"
          ) || transferCallUuid;

        console.warn(
          "[MERGE-DIAG] startAttendedTransfer (child/Add People leg)",
          {
            parentSessionId: callId,
            parentCallId: originalCall.callId,
            childSessionId: transferCallUuid,
            childServerCallId,
            "web-uses":
              "invite.request.getHeader('Call-Id') for outgoing - setup.ts:124"
          }
        );

        setState((prev) => ({
          ...prev,
          activeCallId: transferCallUuid,
          calls: {
            ...prev.calls,
            [callId]: {
              ...prev.calls[callId],
              childSessionId: transferCallUuid,
              isOnHold: true
            },
            [transferCallUuid]: {
              sessionId: transferCallUuid,
              callId: childServerCallId,
              parentSessionId: callId,
              state: CallState.OUTGOING,
              direction: CallDirection.OUTGOING,
              remoteDisplayName: displayName || target,
              remoteUri: target,
              ...(displayName ? { contactDisplayName: displayName } : {}),
              remoteParty: {
                cidNum: target,
                cidName: displayName || target
              },
              startTime: new Date().toISOString(),
              isMuted: false,
              isOnHold: false,
              isSpeakerOn: false,
              isEmergency: false,
              connected: false,
              recording: false,
              conferencing: false,
              attendedTransfer: true,
              childSessionId: undefined,
              totalCallDuration: 0,
              currentHoldDuration: 0,
              totalHoldDuration: 0,
              mutedConferenceParticipants: []
            }
          }
        }));
        sippyCupRef.current?.emit(
          "callStateChanged",
          transferCallUuid,
          CallState.OUTGOING
        );

        // Update child state when the transfer leg is fully connected.
        transferSession
          .established()
          .then(() => {
            const resolvedChildCallId =
              extractServerCallIdFromSipSession(
                transferSession,
                "startAttendedTransfer-child-established"
              ) || transferCallUuid;
            updateCall(transferCallUuid, {
              callId: resolvedChildCallId,
              state: CallState.CONNECTED,
              connected: true
            });
            sippyCupRef.current?.emit(
              "callStateChanged",
              transferCallUuid,
              CallState.CONNECTED
            );
          })
          .catch(() => {
            // callFailed/sessionEnded listeners will handle cleanup.
          });

        return transferCallUuid;
      }

      try {
        const sippyCup = await ensureInitialized();
        // Start the transfer in SippyCup (this will handle the SIP operations)
        logger.debug("startAttendedTransfer: Starting SIP transfer operation", {
          callId,
          target,
          displayName: displayName ?? null
        });

        if (displayName) {
          pendingOutgoingContactMetadataRef.current = {
            displayName
          };
        }

        // Generate UUID for transfer call
        const transferCallUuid = uuidv4();
        const transferOptions: CallOptions = {
          callUuid: transferCallUuid,
          ...(displayName ? { displayName } : {}),
          skipCallKitOutboundUi: true,
          attendedTransferParentSessionId: callId
        };

        const transferCallId = await sippyCup.makeCall(target, transferOptions);

        // Link parent ↔ child in one synchronous update. The old setTimeout(100) caused
        // MergeCallDrawer to mount before parent.childSessionId existed (blank / "Unknown").
        // outgoingCall may have already added the child row — merge with it if present.
        setState((prev) => {
          const parent = prev.calls[callId];
          if (!parent) {
            logger.warn(
              "startAttendedTransfer: parent call missing after makeCall — cannot link child",
              { callId, transferCallId }
            );
            return prev;
          }
          const existingChild = prev.calls[transferCallId];
          const childMerged: ContextCallInfo = existingChild
            ? {
                ...existingChild,
                parentSessionId: callId,
                ...(displayName ? { contactDisplayName: displayName } : {})
              }
            : {
                sessionId: transferCallId,
                callId: transferCallId,
                parentSessionId: callId,
                state: CallState.OUTGOING,
                direction: CallDirection.OUTGOING,
                remoteDisplayName: displayName || target,
                remoteUri: target,
                ...(displayName ? { contactDisplayName: displayName } : {}),
                remoteParty: {
                  cidNum: target,
                  cidName: displayName || target
                },
                startTime: new Date().toISOString(),
                isMuted: false,
                isOnHold: false,
                isSpeakerOn: false,
                isEmergency: false,
                connected: false,
                recording: false,
                conferencing: false,
                attendedTransfer: false,
                childSessionId: undefined,
                totalCallDuration: 0,
                currentHoldDuration: 0,
                totalHoldDuration: 0,
                mutedConferenceParticipants: []
              };

          return {
            ...prev,
            calls: {
              ...prev.calls,
              [callId]: {
                ...parent,
                childSessionId: transferCallId
              },
              [transferCallId]: childMerged
            }
          };
        });

        logger.debug("startAttendedTransfer: Transfer process completed", {
          originalCallId: callId,
          transferCallId,
          target,
          displayName: displayName ?? null,
          linkedParentChild: true
        });

        return transferCallId;
      } catch (error) {
        logger.error("startAttendedTransfer: Failed to start transfer", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          callId,
          target,
          displayName: displayName ?? null
        });
        throw error;
      }
    },
    [ensureInitialized, state.calls, updateCall]
  );

  const completeAttendedTransfer = useCallback(async (): Promise<void> => {
    const parentCall = Object.values(state.calls).find(
      (call) => call.childSessionId
    );
    if (parentCall?.childSessionId) {
      const childCall = state.calls[parentCall.childSessionId];
      if (childCall) {
        const parentSipSession = getSipSession(parentCall.sessionId);
        const childSipSession = getSipSession(childCall.sessionId);
        if (parentSipSession && childSipSession) {
          logger.debug("completeAttendedTransfer: VoIP handoff path", {
            parentSessionId: parentCall.sessionId,
            childSessionId: childCall.sessionId
          });
          try {
            await parentSipSession.attendedTransferTo(childSipSession);
            logger.debug("completeAttendedTransfer: REFER accepted");
            parentSipSession.sipTerminate();
            // Delay child termination so the backend can complete the REFER handoff
            // before we tear down the child leg. Prevents third party and original caller
            // from being disconnected prematurely.
            await new Promise((resolve) => setTimeout(resolve, 800));
            childSipSession.sipTerminate();
            logger.debug("completeAttendedTransfer: VoIP handoff completed");
          } catch (err) {
            logger.error("completeAttendedTransfer: VoIP REFER failed", {
              error: err instanceof Error ? err.message : String(err)
            });
            throw err;
          }
        } else {
          const sippyCup = await ensureInitialized();
          await sippyCup.completeAttendedTransfer(
            parentCall.sessionId,
            childCall.sessionId,
            { terminateLocalLegs: true }
          );
        }
      }
    }
  }, [ensureInitialized, state.calls]);

  const swapAttendedTransferCalls = useCallback(
    async (originalCallId: string, transferCallId: string): Promise<void> => {
      logger.debug("swapAttendedTransferCalls: Starting call swap", {
        originalCallId,
        transferCallId,
        timestamp: new Date().toISOString()
      });

      return new Promise<void>((resolve, reject) => {
        setState((currentState) => {
          (async () => {
            try {
              // Validate both calls exist before attempting swap
              const originalCall = currentState.calls[originalCallId];
              const transferCall = currentState.calls[transferCallId];

              logger.debug("swapAttendedTransferCalls: Call states", {
                originalCall: {
                  exists: !!originalCall,
                  isOnHold: originalCall?.isOnHold
                },
                transferCall: {
                  exists: !!transferCall,
                  isOnHold: transferCall?.isOnHold
                },
                totalCalls: Object.keys(currentState.calls).length
              });

              if (!originalCall || !transferCall) {
                logger.warn(
                  "swapAttendedTransferCalls: Cannot swap - one or both calls no longer exist",
                  {
                    originalCallExists: !!originalCall,
                    transferCallExists: !!transferCall,
                    originalCallId,
                    transferCallId
                  }
                );
                resolve();
                return;
              }

              // Simple swap: determine active call and set the opposite as active
              const currentActiveCall = !originalCall.isOnHold
                ? originalCallId
                : transferCallId;
              const newActiveCall =
                currentActiveCall === originalCallId
                  ? transferCallId
                  : originalCallId;

              logger.debug(
                "swapAttendedTransferCalls: Determined call swap direction",
                {
                  currentActiveCall,
                  newActiveCall,
                  originalCallOnHold: originalCall.isOnHold,
                  transferCallOnHold: transferCall.isOnHold
                }
              );

              // Update active call optimistically - the actual swap will be handled by hold/unhold events
              setState((prev) => {
                logger.debug(
                  "swapAttendedTransferCalls: Updating state with new active call",
                  {
                    previousActiveCall: prev.activeCallId,
                    newActiveCall
                  }
                );

                return {
                  ...prev,
                  activeCallId: newActiveCall
                };
              });

              // Hold/unhold via provider paths (VoIP/SlimSip + SessionManager).
              // SippyCup.swapAttendedTransferCalls only used SessionManager.getCallState and failed for web/incoming VoIP legs.
              logger.debug(
                "swapAttendedTransferCalls: Executing hold/unhold swap (VoIP-aware)"
              );
              if (!originalCall.isOnHold) {
                await holdCall(originalCallId);
                await unholdCall(transferCallId);
              } else {
                await holdCall(transferCallId);
                await unholdCall(originalCallId);
              }
              logger.debug(
                "swapAttendedTransferCalls: Hold/unhold swap completed successfully",
                {
                  originalCallId,
                  transferCallId,
                  newActiveCall
                }
              );

              resolve();
            } catch (error) {
              logger.error(
                "swapAttendedTransferCalls: Failed to perform hold/unhold swap",
                {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                  originalCallId,
                  transferCallId
                }
              );
              reject(error);
            }
          })();

          return currentState;
        });
      });
    },
    [holdCall, unholdCall]
  );

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: undefined }));
  }, []);

  // Additional methods to match the original interface
  const setConfig = useCallback((config: SipConfig) => {
    setState((prev) => ({ ...prev, config }));
  }, []);

  const cleanup = useCallback(async () => {
    return new Promise<void>((resolve) => {
      setState((currentState) => {
        (async () => {
          if (sippyCupRef.current) {
            if (currentState.isRegistered) {
              await sippyCupRef.current.unregister();
            }
            sippyCupRef.current.dispose();
            sippyCupRef.current = null;
          }
          setState({
            isInitialized: false,
            isInitializing: false,
            isRegistered: false,
            isRegistering: false,
            config: null,
            calls: {},
            activeCallId: undefined,
            error: undefined
          });
          resolve();
        })();
        return currentState;
      });
    });
  }, []);

  // Stub methods for compatibility - should be refactored out
  const setCurrentCall = useCallback(
    async (call: ContextCallInfo) => {
      if (call) {
        setActiveCallId(call.sessionId);
      }
    },
    [setActiveCallId]
  );

  const setCurrentCallConnected = useCallback(
    (call: ContextCallInfo) => {
      updateCall(call.sessionId, { connected: true });
    },
    [updateCall]
  );

  const updateCurrentCallData = useCallback(
    (data: RemoteParty) => {
      setState((currentState) => {
        if (currentState.activeCallId) {
          updateCall(currentState.activeCallId, {
            remoteParty: data,
            remoteDisplayName: data.cidName || data.cidNum
          });
        }
        return currentState;
      });
    },
    [updateCall]
  );

  const clearCurrentCall = useCallback(() => {
    setActiveCallId(undefined);
  }, [setActiveCallId]);

  const addIncomingCall = useCallback(
    (call: ContextCallInfo) => {
      addCall(call);
    },
    [addCall]
  );

  const removeIncomingCall = useCallback(
    (sessionId: string) => {
      removeCall(sessionId);
    },
    [removeCall]
  );

  const addCallOnHold = useCallback(
    (call: ContextCallInfo) => {
      updateCall(call.sessionId, { isOnHold: true });
    },
    [updateCall]
  );

  const removeCallOnHold = useCallback(
    (sessionId: string) => {
      updateCall(sessionId, { isOnHold: false });
    },
    [updateCall]
  );

  const holdCurrentCall = useCallback(async () => {
    return new Promise<void>((resolve, reject) => {
      setState((currentState) => {
        (async () => {
          try {
            if (currentState.activeCallId) {
              await holdCall(currentState.activeCallId);
              resolve();
            } else {
              resolve(); // No active call, nothing to hold
            }
          } catch (error) {
            reject(error);
          }
        })();
        return currentState;
      });
    });
  }, [holdCall]);

  const getCallById = useCallback((sessionId: string) => {
    return stateRef.current.calls[sessionId];
  }, []);

  const getChildCallBySessionId = useCallback((sessionId: string) => {
    const parentCall = stateRef.current.calls[sessionId];
    if (parentCall?.childSessionId) {
      return stateRef.current.calls[parentCall.childSessionId] ?? null;
    }
    return null;
  }, []);

  const getParentCallBySessionId = useCallback((sessionId: string) => {
    const childCall = stateRef.current.calls[sessionId];
    if (childCall?.parentSessionId) {
      return stateRef.current.calls[childCall.parentSessionId] ?? null;
    }
    return null;
  }, []);

  const updateCallDurations = useCallback((_seconds: number) => {
    // This should be handled by a separate timer/interval
    // For now, just a stub
  }, []);

  const setConferencing = useCallback(
    (conferenceId: string) => {
      // Use setState callback to always read the latest state
      setState((currentState) => {
        if (currentState.activeCallId) {
          logger.debug("Setting conference state", {
            activeCallId: currentState.activeCallId,
            conferenceId,
            previousState: currentState.calls[currentState.activeCallId]
          });

          updateCall(currentState.activeCallId, {
            conferencing: true,
            conferenceId
          });
        } else {
          logger.warn("Cannot set conferencing: no active call", {
            callsCount: Object.keys(currentState.calls).length
          });
        }

        return currentState;
      });
    },
    [updateCall]
  );

  const startConference = useCallback(
    async (childCall: ContextCallInfo, parentCall: ContextCallInfo) => {
      if (!accessToken) {
        logger.error("Cannot start conference: no access token");
        return;
      }

      return new Promise<void>((resolve, reject) => {
        setState((currentState) => {
          (async () => {
            try {
              if (!currentState.activeCallId) {
                logger.error("Cannot start conference: no active call");
                reject(new Error("No active call"));
                return;
              }

              const sippyCup = await ensureInitialized();

              // The first callId has to be the call that is not active, merge will always be the active call
              const currentCall = currentState.calls[currentState.activeCallId];
              if (!currentCall) {
                logger.error("Cannot start conference: active call not found");
                reject(new Error("Active call not found"));
                return;
              }

              const currentSipSession = getSipSession(currentCall.sessionId);
              let currentCallResolvedId = resolveBackendCallId(
                currentCall,
                currentSipSession
              );
              if (
                !currentCallResolvedId ||
                currentCallResolvedId === currentCall.sessionId
              ) {
                currentCallResolvedId =
                  (await hydrateCallBackendId(
                    currentCall.sessionId,
                    MERGE_HYDRATE_MAX_MS
                  )) || currentCallResolvedId;
              }
              if (
                currentCallResolvedId &&
                currentCallResolvedId !== currentCall.callId
              ) {
                updateCall(currentCall.sessionId, {
                  callId: currentCallResolvedId
                });
              }

              let parentCallId = parentCall.callId;
              let childCallId = childCall.callId;
              const hydratedParentCallId =
                (await hydrateCallBackendId(
                  parentCall.sessionId,
                  MERGE_HYDRATE_MAX_MS
                )) || parentCallId;
              const hydratedChildCallId =
                (await hydrateCallBackendId(
                  childCall.sessionId,
                  MERGE_HYDRATE_MAX_MS
                )) || childCallId;
              if (
                hydratedParentCallId &&
                hydratedParentCallId !== parentCallId &&
                hydratedParentCallId !== parentCall.sessionId
              ) {
                parentCallId = hydratedParentCallId;
                updateCall(parentCall.sessionId, { callId: parentCallId });
              }
              if (
                hydratedChildCallId &&
                hydratedChildCallId !== childCallId &&
                hydratedChildCallId !== childCall.sessionId
              ) {
                childCallId = hydratedChildCallId;
                updateCall(childCall.sessionId, { callId: childCallId });
              }

              const callId =
                currentCallResolvedId === parentCallId
                  ? childCallId
                  : parentCallId;

              const mergeId = currentCallResolvedId;

              const mergeAttempts = buildConferenceMergeAttempts({
                activeCallId: currentCallResolvedId,
                parentCallId,
                childCallId
              });

              // Merge diagnostic: log everything we're sending to backend (matches web setup.ts)
              const parentSess = getSipSession(parentCall.sessionId);
              const childSess = getSipSession(childCall.sessionId);
              const parentReq = (parentSess as any)?.rtcSession?._request;
              const childReq = (childSess as any)?.rtcSession?._request;
              console.warn(
                "[MERGE-DIAG] startConference - about to call backend merge API",
                {
                  parent: {
                    sessionId: parentCall.sessionId,
                    callId: parentCallId,
                    hasXcid: !!(
                      getSipRequestHeaderValue(parentReq, "Xcid") ||
                      getSipRequestHeaderValue(parentReq, "X-Cid")
                    ),
                    xcid:
                      getSipRequestHeaderValue(parentReq, "Xcid") ||
                      getSipRequestHeaderValue(parentReq, "X-Cid") ||
                      null,
                    request_call_id: parentReq?.call_id || null
                  },
                  child: {
                    sessionId: childCall.sessionId,
                    callId: childCallId,
                    hasXcid: !!(
                      getSipRequestHeaderValue(childReq, "Xcid") ||
                      getSipRequestHeaderValue(childReq, "X-Cid")
                    ),
                    xcid:
                      getSipRequestHeaderValue(childReq, "Xcid") ||
                      getSipRequestHeaderValue(childReq, "X-Cid") ||
                      null,
                    request_call_id: childReq?.call_id || null
                  },
                  mergeAttempts: mergeAttempts.map((a) => ({
                    callId: a.callId,
                    mergeCallId: a.mergeCallId,
                    strategy: a.strategy
                  })),
                  "backend-expects":
                    "callId and mergeCallId must match liveChannels.ch_callid"
                }
              );

              if (
                !callId ||
                !mergeId ||
                callId === mergeId ||
                mergeAttempts.length === 0
              ) {
                logger.error("Invalid conference merge id ordering", {
                  callId,
                  mergeId,
                  currentCallId: currentCallResolvedId,
                  parentCallId,
                  childCallId,
                  mergeAttemptsCount: mergeAttempts.length
                });
                reject(new Error("Invalid merge call mapping"));
                return;
              }

              let mergeSession: { conferenceId: string } | void | undefined;
              let lastMergeError: unknown;

              for (let i = 0; i < mergeAttempts.length; i++) {
                const attempt = mergeAttempts[i];
                const attemptIndex = i + 1;
                const isFinalAttempt = i === mergeAttempts.length - 1;

                try {
                  mergeSession = await sippyCup.attendedTransferMergeNew(
                    attempt.callId,
                    attempt.mergeCallId,
                    accessToken
                  );
                  console.warn(
                    "[IOS-MERGE-IDS] startConference — merge succeeded (filter: IOS-MERGE-IDS)",
                    JSON.stringify({
                      scenario:
                        "First 3-way: two backend ids merged into conferenceId",
                      conferenceId: mergeSession?.conferenceId,
                      winningAttempt: attemptIndex,
                      strategy: attempt.strategy,
                      callId: attempt.callId,
                      mergeCallId: attempt.mergeCallId,
                      parentBackendCallId: parentCallId,
                      childBackendCallId: childCallId,
                      activeBackendCallId: currentCallResolvedId
                    })
                  );
                  break;
                } catch (error) {
                  lastMergeError = error;
                  const statusCode = getErrorStatusCode(error);
                  const canRetry =
                    !isFinalAttempt && isRetriableConferenceMergeError(error);

                  logger.warn("startConference: merge attempt failed", {
                    attempt: attemptIndex,
                    totalAttempts: mergeAttempts.length,
                    strategy: attempt.strategy,
                    callId: attempt.callId,
                    mergeCallId: attempt.mergeCallId,
                    statusCode,
                    message: (error as any)?.message,
                    willRetryWithSwappedIds: canRetry
                  });

                  if (!canRetry) {
                    throw error;
                  }
                }
              }

              if (!mergeSession) {
                throw lastMergeError || new Error("Failed to start conference");
              }

              if (mergeSession) {
                updateCall(parentCall.sessionId, {
                  conferencing: true,
                  conferenceId: mergeSession.conferenceId
                });
                updateCall(childCall.sessionId, {
                  conferencing: true,
                  conferenceId: mergeSession.conferenceId
                });
                setConferencing(mergeSession.conferenceId);
              }

              resolve();
            } catch (error) {
              logger.error("Failed to start conference:", error);
              reject(error);
            }
          })();

          return currentState;
        });
      });
    },
    [
      accessToken,
      ensureInitialized,
      hydrateCallBackendId,
      setConferencing,
      updateCall
    ]
  );

  const addParticipantToConferenceCall = useCallback(
    async (childCall: ContextCallInfo, parentCall: ContextCallInfo) => {
      if (!accessToken) {
        logger.error("Cannot add participant: no access token");
        return;
      }

      return new Promise<void>((resolve, reject) => {
        setState((currentState) => {
          (async () => {
            try {
              if (!currentState.activeCallId) {
                logger.error("Cannot add participant: no active call");
                reject(new Error("No active call"));
                return;
              }

              const sippyCup = await ensureInitialized();
              const currentCall = currentState.calls[currentState.activeCallId];

              if (!currentCall) {
                logger.error("Cannot add participant: active call not found");
                reject(new Error("Active call not found"));
                return;
              }

              logger.debug("Adding participant to conference", {
                activeCallId: currentState.activeCallId,
                parentCallId: parentCall.callId,
                childCallId: childCall.callId,
                conferenceId: parentCall.conferenceId
              });

              const currentSipSession = getSipSession(currentCall.sessionId);
              let currentCallResolvedId = resolveBackendCallId(
                currentCall,
                currentSipSession
              );
              if (
                !currentCallResolvedId ||
                currentCallResolvedId === currentCall.sessionId
              ) {
                currentCallResolvedId =
                  (await hydrateCallBackendId(
                    currentCall.sessionId,
                    MERGE_HYDRATE_MAX_MS
                  )) || currentCallResolvedId;
              }
              if (
                currentCallResolvedId &&
                currentCallResolvedId !== currentCall.callId
              ) {
                updateCall(currentCall.sessionId, {
                  callId: currentCallResolvedId
                });
              }
              if (!currentCallResolvedId) {
                reject(
                  new Error(
                    "Cannot add participant: active call backend ID is not ready"
                  )
                );
                return;
              }

              const parentSipForAdd = getSipSession(parentCall.sessionId);
              const childSipForAdd = getSipSession(childCall.sessionId);
              const parentReqAdd = (parentSipForAdd as any)?.rtcSession
                ?._request;
              const childReqAdd = (childSipForAdd as any)?.rtcSession?._request;
              const branchUsesActiveLeg =
                currentCallResolvedId !== parentCall.callId;
              const mergeCallIdForApi = branchUsesActiveLeg
                ? currentCallResolvedId
                : childCall.callId;
              console.warn(
                "[IOS-MERGE-IDS] addParticipantToConferenceCall — 3rd+ party into existing conference (filter: IOS-MERGE-IDS)",
                JSON.stringify({
                  scenario:
                    "Already on conference; API adds one more live channel into conferenceId",
                  conferenceId: parentCall.conferenceId,
                  parentSessionId: parentCall.sessionId,
                  parentBackendCallId: parentCall.callId,
                  childSessionId: childCall.sessionId,
                  childBackendCallId: childCall.callId,
                  activeSessionId: currentCall.sessionId,
                  activeBackendCallId: currentCallResolvedId,
                  branch: branchUsesActiveLeg
                    ? "mergeCallId = active leg (not parent callId)"
                    : "mergeCallId = child leg callId",
                  mergeCallIdSentToApi: mergeCallIdForApi,
                  parent: {
                    xcid:
                      getSipRequestHeaderValue(parentReqAdd, "Xcid") ||
                      getSipRequestHeaderValue(parentReqAdd, "X-Cid") ||
                      null,
                    sipCallId: parentReqAdd?.call_id ?? null
                  },
                  child: {
                    xcid:
                      getSipRequestHeaderValue(childReqAdd, "Xcid") ||
                      getSipRequestHeaderValue(childReqAdd, "X-Cid") ||
                      null,
                    sipCallId: childReqAdd?.call_id ?? null
                  }
                })
              );

              // We need to set the conference call to the active call
              if (currentCallResolvedId !== parentCall.callId) {
                await sippyCup.addParticipantToConference(
                  parentCall.conferenceId!,
                  currentCallResolvedId!,
                  accessToken
                );

                if (parentCall.currentHoldDuration === 0) {
                  await sippyCup.unholdCall(parentCall.sessionId);
                  setActiveCallId(parentCall.sessionId);
                }
              } else {
                await sippyCup.addParticipantToConference(
                  parentCall.conferenceId!,
                  childCall.callId,
                  accessToken
                );
              }

              updateCall(parentCall.sessionId, {
                conferencing: true,
                conferenceId: parentCall.conferenceId
              });
              updateCall(childCall.sessionId, {
                conferencing: true,
                conferenceId: parentCall.conferenceId
              });

              resolve();
            } catch (error) {
              logger.error("Failed to add participant to conference:", error);
              reject(error);
            }
          })();

          return currentState;
        });
      });
    },
    [accessToken, ensureInitialized, setActiveCallId, updateCall]
  );

  const mergeAttendedTransfer = useCallback(
    async (
      mode: "conferenceMerge" | "attendedTransfer" = "conferenceMerge"
    ) => {
      // Use setState callback to always read the latest state
      // This prevents stale closure issues when called from drawers/modals
      return new Promise<void>((resolve, reject) => {
        setState((currentState) => {
          // Perform merge asynchronously but read state synchronously
          (async () => {
            try {
              if (!currentState.activeCallId) {
                logger.warn("Cannot merge: no active call", {
                  callsCount: Object.keys(currentState.calls).length
                });
                reject(new Error("No active call"));
                return;
              }

              const currentCall = currentState.calls[currentState.activeCallId];
              if (!currentCall) {
                logger.warn("Cannot merge: active call not found", {
                  activeCallId: currentState.activeCallId,
                  availableCalls: Object.keys(currentState.calls)
                });
                reject(new Error("Active call not found"));
                return;
              }

              // Find the parent and child calls
              // The parent call has a childSessionId
              // The child call has a parentSessionId
              let parentCall: ContextCallInfo | null = null;
              let childCall: ContextCallInfo | null = null;

              // Check if current call is the parent (has childSessionId)
              if (currentCall.childSessionId) {
                parentCall = currentCall;
                childCall =
                  currentState.calls[currentCall.childSessionId] || null;
              }
              // Check if current call is the child (has parentSessionId)
              else if (currentCall.parentSessionId) {
                childCall = currentCall;
                parentCall =
                  currentState.calls[currentCall.parentSessionId] || null;
              }
              // Fallback: search all calls for parent/child relationship
              else {
                // Find parent call (has childSessionId)
                parentCall =
                  Object.values(currentState.calls).find(
                    (call) => call.childSessionId
                  ) || null;

                // Find child call using parent's childSessionId
                if (parentCall?.childSessionId) {
                  childCall =
                    currentState.calls[parentCall.childSessionId] || null;
                }
              }

              if (!parentCall || !childCall) {
                logger.error("Cannot merge: parent or child call not found", {
                  currentCallId: currentCall.sessionId,
                  hasChild: !!currentCall.childSessionId,
                  hasParent: !!currentCall.parentSessionId,
                  allCallIds: Object.keys(currentState.calls),
                  callsCount: Object.keys(currentState.calls).length,
                  foundParent: !!parentCall,
                  foundChild: !!childCall
                });
                reject(new Error("Parent or child call not found"));
                return;
              }

              logger.debug("Merging attended transfer", {
                mode,
                parentCallId: parentCall.callId,
                parentSessionId: parentCall.sessionId,
                childCallId: childCall.callId,
                childSessionId: childCall.sessionId,
                activeCallId: currentState.activeCallId,
                currentCallId: currentCall.callId,
                parentConferenceId: parentCall.conferenceId,
                totalCallsInState: Object.keys(currentState.calls).length
              });

              const voipBridge = VoipBridge.getInstance();
              const parentSipSession = getSipSession(parentCall.sessionId);
              const childSipSession = getSipSession(childCall.sessionId);
              let parentResolvedCallId = resolveBackendCallId(
                parentCall,
                parentSipSession
              );
              let childResolvedCallId = resolveBackendCallId(
                childCall,
                childSipSession
              );
              const isVoipRelationship =
                voipBridge.isVoipCall(parentCall.sessionId) ||
                voipBridge.isVoipCall(childCall.sessionId) ||
                !!parentSipSession ||
                !!childSipSession;

              // For web->mobile incoming legs, allow a short hydration window to resolve
              // real backend call IDs before deciding merge readiness.
              if (
                isVoipRelationship &&
                (!parentResolvedCallId ||
                  parentResolvedCallId === parentCall.sessionId ||
                  !childResolvedCallId ||
                  childResolvedCallId === childCall.sessionId)
              ) {
                const hydratedParentCallId = await hydrateCallBackendId(
                  parentCall.sessionId,
                  MERGE_HYDRATE_MAX_MS
                );
                const hydratedChildCallId = await hydrateCallBackendId(
                  childCall.sessionId,
                  MERGE_HYDRATE_MAX_MS
                );
                parentResolvedCallId =
                  hydratedParentCallId || parentResolvedCallId;
                childResolvedCallId =
                  hydratedChildCallId || childResolvedCallId;
              }

              const resolvedParentCall: ContextCallInfo = {
                ...parentCall,
                callId: parentResolvedCallId || parentCall.callId
              };
              const resolvedChildCall: ContextCallInfo = {
                ...childCall,
                callId: childResolvedCallId || childCall.callId
              };

              if (
                parentResolvedCallId &&
                parentResolvedCallId !== parentCall.callId
              ) {
                updateCall(parentCall.sessionId, {
                  callId: parentResolvedCallId
                });
              }
              if (
                childResolvedCallId &&
                childResolvedCallId !== childCall.callId
              ) {
                updateCall(childCall.sessionId, {
                  callId: childResolvedCallId
                });
              }

              if (mode === "attendedTransfer") {
                // Transfer handoff path: REFER-with-Replaces and local teardown.
                if (parentSipSession && childSipSession) {
                  logger.debug("mergeAttendedTransfer: REFER request started", {
                    parentSessionId: parentCall.sessionId,
                    childSessionId: childCall.sessionId
                  });
                  await parentSipSession.attendedTransferTo(childSipSession);
                  logger.debug("mergeAttendedTransfer: REFER accepted");
                  parentSipSession.sipTerminate();
                } else {
                  const sippyCup = await ensureInitialized();
                  await sippyCup.completeAttendedTransfer(
                    parentCall.sessionId,
                    childCall.sessionId,
                    { terminateLocalLegs: true }
                  );
                }
              } else {
                // Conference merge path: keep user in conference, do not teardown via REFER.
                if (!resolvedParentCall.callId || !resolvedChildCall.callId) {
                  reject(
                    new Error("Cannot merge call: missing call identifiers")
                  );
                  return;
                }
                if (resolvedParentCall.callId === resolvedChildCall.callId) {
                  reject(
                    new Error("Cannot merge call: duplicate merge identifiers")
                  );
                  return;
                }

                // Only block when it's a TRUE placeholder: callId === sessionId but NOT from SIP request.
                // When callId matches the SIP request's call_id, it's a valid backend ID (not a placeholder).
                const isRealSipId = (
                  call: ContextCallInfo,
                  sip: SipSession | undefined
                ) => {
                  if (!sip || !call.callId) return false;
                  const reqCallId = (sip as any)?.rtcSession?._request?.call_id;
                  return reqCallId === call.callId;
                };
                const parentPlaceholder =
                  resolvedParentCall.callId === resolvedParentCall.sessionId &&
                  !isRealSipId(resolvedParentCall, parentSipSession);
                const childPlaceholder =
                  resolvedChildCall.callId === resolvedChildCall.sessionId &&
                  !isRealSipId(resolvedChildCall, childSipSession);

                if (
                  isVoipRelationship &&
                  (!parentSipSession ||
                    !childSipSession ||
                    parentPlaceholder ||
                    childPlaceholder)
                ) {
                  logger.error(
                    "mergeAttendedTransfer: conference merge blocked",
                    {
                      reason:
                        "VoIP relationship exists but at least one callId is still placeholder (equal to sessionId) or SIP sessions are not ready",
                      parent: getMergeIdDiagnostics(
                        resolvedParentCall,
                        parentSipSession
                      ),
                      child: getMergeIdDiagnostics(
                        resolvedChildCall,
                        childSipSession
                      ),
                      expectedForBackend: {
                        callId: "backend/server call ID",
                        mergeCallId: "backend/server call ID"
                      }
                    }
                  );
                  reject(
                    new Error(
                      "Conference merge is not ready yet. Please wait a moment and try Merge again."
                    )
                  );
                  return;
                }

                let mergeReboundUuid: string | undefined;

                if (isVoipRelationship && Platform.OS === "ios") {
                  setConferenceMergeInProgress(true);
                }

                if (isVoipRelationship) {
                  const parentAlive =
                    parentCall.state !== CallState.ENDED &&
                    parentCall.state !== CallState.FAILED;
                  const childAlive =
                    childCall.state !== CallState.ENDED &&
                    childCall.state !== CallState.FAILED;
                  const sipParentOk =
                    isSipRtcSessionEstablished(parentSipSession);
                  const sipChildOk =
                    isSipRtcSessionEstablished(childSipSession);
                  if (
                    !parentAlive ||
                    !childAlive ||
                    !sipParentOk ||
                    !sipChildOk
                  ) {
                    logger.error(
                      "[MERGE-AUDIO] mergeAttendedTransfer blocked: VoIP SIP not established or call not alive",
                      {
                        parentAlive,
                        childAlive,
                        sipParentOk,
                        sipChildOk,
                        parentState: parentCall.state,
                        childState: childCall.state
                      }
                    );
                    reject(
                      new Error(
                        "Conference merge is not ready yet. Please wait a moment and try Merge again."
                      )
                    );
                    return;
                  }

                  const preflightParentExtract =
                    extractServerCallIdFromSipSession(
                      parentSipSession,
                      "merge-preflight-parent"
                    );
                  const preflightChildExtract =
                    extractServerCallIdFromSipSession(
                      childSipSession,
                      "merge-preflight-child"
                    );
                  const parentStillSessionUuid =
                    resolvedParentCall.callId === resolvedParentCall.sessionId;
                  const childStillSessionUuid =
                    resolvedChildCall.callId === resolvedChildCall.sessionId;
                  if (
                    (parentStillSessionUuid && !preflightParentExtract) ||
                    (childStillSessionUuid && !preflightChildExtract)
                  ) {
                    logger.error(
                      "[MERGE-AUDIO] mergeAttendedTransfer blocked: backend id still session UUID with no SIP-derived Xcid/Call-Id",
                      {
                        parentStillSessionUuid,
                        childStillSessionUuid,
                        hasPreflightParentExtract: !!preflightParentExtract,
                        hasPreflightChildExtract: !!preflightChildExtract
                      }
                    );
                    reject(
                      new Error(
                        "Conference merge is not ready yet. Please wait a moment and try Merge again."
                      )
                    );
                    return;
                  }

                  logger.debug("[MERGE-AUDIO] pre-merge settle", {
                    settleMs: MERGE_PRE_REBIND_SETTLE_MS,
                    parentSessionId: parentCall.sessionId,
                    childSessionId: childCall.sessionId
                  });
                  await new Promise((r) =>
                    setTimeout(r, MERGE_PRE_REBIND_SETTLE_MS)
                  );
                }

                const sippyCup = await ensureInitialized();

                if (isVoipRelationship) {
                  console.warn(
                    "[MERGE-AUDIO] pre_rebind_snapshot",
                    JSON.stringify({
                      timestamp: new Date().toISOString(),
                      activeCallIdAtMerge: currentState.activeCallId,
                      parentSessionId: parentCall.sessionId,
                      childSessionId: childCall.sessionId,
                      sipEstablished: {
                        parent: isSipRtcSessionEstablished(parentSipSession),
                        child: isSipRtcSessionEstablished(childSipSession)
                      },
                      localHold: {
                        parent: (parentSipSession as any)?.localHold ?? false,
                        child: (childSipSession as any)?.localHold ?? false
                      },
                      nativeCallKitUuidBeforeRebind: {
                        parent:
                          sippyCup.getIosCallKitUuidForSession(
                            parentCall.sessionId
                          ) ?? null,
                        child:
                          sippyCup.getIosCallKitUuidForSession(
                            childCall.sessionId
                          ) ?? null
                      },
                      backendCallId: {
                        parent: resolvedParentCall.callId,
                        child: resolvedChildCall.callId
                      }
                    })
                  );
                }

                const parentReq = (parentSipSession as any)?.rtcSession
                  ?._request;
                const childReq = (childSipSession as any)?.rtcSession?._request;
                console.warn(
                  "[MERGE-DIAG] mergeAttendedTransfer: about to call backend merge (VoIP path)",
                  JSON.stringify({
                    parent: {
                      sessionId: parentCall.sessionId,
                      callId: resolvedParentCall.callId,
                      hasXcid: !!(
                        getSipRequestHeaderValue(parentReq, "Xcid") ||
                        getSipRequestHeaderValue(parentReq, "X-Cid")
                      ),
                      xcid:
                        getSipRequestHeaderValue(parentReq, "Xcid") ||
                        getSipRequestHeaderValue(parentReq, "X-Cid") ||
                        null,
                      request_call_id: parentReq?.call_id || null
                    },
                    child: {
                      sessionId: childCall.sessionId,
                      callId: resolvedChildCall.callId,
                      hasXcid: !!(
                        getSipRequestHeaderValue(childReq, "Xcid") ||
                        getSipRequestHeaderValue(childReq, "X-Cid")
                      ),
                      xcid:
                        getSipRequestHeaderValue(childReq, "Xcid") ||
                        getSipRequestHeaderValue(childReq, "X-Cid") ||
                        null,
                      request_call_id: childReq?.call_id || null
                    },
                    "backend-expects":
                      "callId/mergeCallId must match liveChannels.ch_callid",
                    "web-incoming": "Xcid (setup.ts:117)",
                    "web-outgoing": "Call-Id (setup.ts:124)"
                  })
                );

                // Carry over native CallKeep UUID from parent leg to child leg before
                // backend merge tears down the parent, so child audio route stays active.
                if (isVoipRelationship) {
                  // storeSipSession registers sessionEnded with the SIP session id — suppress
                  // spurious CallKit teardown when the merged-away parent leg ends (matches UUID space).
                  getSuppressedCallKeepEndSet().add(parentCall.sessionId);

                  mergeReboundUuid = sippyCup.rebindNativeCallUUID(
                    parentCall.sessionId,
                    childCall.sessionId
                  );
                  logger.debug("[MERGE-AUDIO] native UUID rebind", {
                    parentSessionId: parentCall.sessionId,
                    childSessionId: childCall.sessionId,
                    reboundUUID: mergeReboundUuid ?? null
                  });
                  if (!mergeReboundUuid) {
                    logger.warn(
                      "[MERGE-AUDIO] native UUID rebind returned undefined — scheduling extra audio refresh",
                      {
                        parentSessionId: parentCall.sessionId,
                        childSessionId: childCall.sessionId
                      }
                    );
                  }
                  // Always nudge NativeIntegration: dual-UUID merge may succeed without a new string id.
                  sippyCup.emit(
                    "callStateChanged",
                    childCall.sessionId,
                    CallState.CONNECTED
                  );
                }

                // Check if we are already on a conference call
                console.warn(
                  "[IOS-MERGE-IDS] mergeAttendedTransfer — which merge path (filter: IOS-MERGE-IDS)",
                  JSON.stringify({
                    path: resolvedParentCall.conferenceId
                      ? "addParticipantToConferenceCall (3rd+ party)"
                      : "startConference (first merge to 3-way)",
                    conferenceIdIfAny: resolvedParentCall.conferenceId ?? null,
                    parentSessionId: parentCall.sessionId,
                    childSessionId: childCall.sessionId,
                    parentBackendCallId: resolvedParentCall.callId,
                    childBackendCallId: resolvedChildCall.callId
                  })
                );
                if (resolvedParentCall.conferenceId) {
                  await addParticipantToConferenceCall(
                    resolvedChildCall,
                    resolvedParentCall
                  );
                } else {
                  await startConference(resolvedChildCall, resolvedParentCall);
                }

                if (isVoipRelationship && Platform.OS === "ios") {
                  const survivingSessionId = resolvedChildCall.sessionId;
                  logger.debug("[MERGE-AUDIO] post-merge audio refresh", {
                    survivingSessionId,
                    delayedRefresh320ms: true,
                    extraDelayedRefreshMs: !mergeReboundUuid
                      ? MERGE_AUDIO_EXTRA_REFRESH_MS
                      : null
                  });
                  sippyCup.ensureIosVoipAudioRouteForCall(survivingSessionId);
                  setTimeout(() => {
                    sippyCup.ensureIosVoipAudioRouteForCall(survivingSessionId);
                  }, 320);
                  if (!mergeReboundUuid) {
                    setTimeout(() => {
                      sippyCup.ensureIosVoipAudioRouteForCall(
                        survivingSessionId
                      );
                    }, MERGE_AUDIO_EXTRA_REFRESH_MS);
                  }
                }

                const survivorSip = getSipSession(resolvedChildCall.sessionId);
                const survivorHadLocalHold = !!survivorSip?.localHold;
                let survivorUnholdRan = false;
                if (isVoipRelationship && survivorHadLocalHold) {
                  logger.debug(
                    "[MERGE-AUDIO] unholding survivor leg after merge",
                    {
                      sessionId: resolvedChildCall.sessionId
                    }
                  );
                  await unholdCall(resolvedChildCall.sessionId);
                  survivorUnholdRan = true;
                }

                if (isVoipRelationship) {
                  console.warn(
                    "[MERGE-AUDIO] post_merge_survivor_snapshot",
                    JSON.stringify({
                      timestamp: new Date().toISOString(),
                      mergeReboundUuid: mergeReboundUuid ?? null,
                      survivingSessionId: resolvedChildCall.sessionId,
                      survivorHadLocalHold,
                      survivorUnholdRan,
                      nativeCallKitUuidForSurvivor:
                        sippyCup.getIosCallKitUuidForSession(
                          resolvedChildCall.sessionId
                        ) ?? null,
                      nativeCallKitUuidForParentSession:
                        sippyCup.getIosCallKitUuidForSession(
                          parentCall.sessionId
                        ) ?? null,
                      expectedActiveLeg: "childSessionId_survivor",
                      note: "If survivor has no CallKit UUID but audio is dead, native map may not match SlimSip/SessionManager leg."
                    })
                  );
                }
              }

              // Cleanup transfer state on both calls; normalize hold/state so UI matches media
              updateCall(parentCall.sessionId, {
                childSessionId: undefined,
                isOnHold: false,
                state: CallState.CONNECTED,
                connected: true
              });
              updateCall(childCall.sessionId, {
                parentSessionId: undefined,
                attendedTransfer: false,
                isOnHold: false,
                state: CallState.CONNECTED,
                connected: true
              });
              // Native UUID rebind uses child leg; keep primary activeCallId aligned with that path.
              setActiveCallId(childCall.sessionId);

              console.warn(
                "[MERGE-AUDIO] merge_state_finalized",
                JSON.stringify({
                  timestamp: new Date().toISOString(),
                  activeCallIdSetTo: childCall.sessionId,
                  parentSessionId: parentCall.sessionId,
                  childSessionId: childCall.sessionId,
                  survivorIsChildLeg: true
                })
              );

              logger.debug("[MERGE-AUDIO] merge completed successfully", {
                parentSessionId: parentCall.sessionId,
                childSessionId: childCall.sessionId
              });
              if (Platform.OS === "ios") {
                setTimeout(() => setConferenceMergeInProgress(false), 3000);
              }
              resolve();
            } catch (error) {
              logger.error("[MERGE-AUDIO] merge failed", error);
              if (Platform.OS === "ios") {
                setConferenceMergeInProgress(false);
              }
              reject(error);
            }
          })();

          // Return current state unchanged - we're just reading it
          return currentState;
        });
      });
    },
    [
      addParticipantToConferenceCall,
      ensureInitialized,
      hydrateCallBackendId,
      setActiveCallId,
      startConference,
      unholdCall,
      updateCall
    ]
  );

  // const completeAttendedTransferNew = useCallback(async () => {
  //   // Find parent and child calls using session ID pointers
  //   const parentCall = Object.values(state.calls).find(
  //     (call) => call.childSessionId
  //   );
  //   if (parentCall?.childSessionId) {
  //     const childCall = state.calls[parentCall.childSessionId];
  //     if (childCall) {
  //       const sippyCup = await ensureInitialized();
  //       setState((prev) => ({
  //         ...prev,
  //         activeCallId: undefined
  //       }));
  //
  //       await sippyCup.completeAttendedTransfer(
  //         parentCall.sessionId,
  //         childCall.sessionId
  //       );
  //       await completeAttendedTransfer(
  //         parentCall.sessionId,
  //         childCall.sessionId
  //       );
  //     }
  //   }
  // }, [state.calls, completeAttendedTransfer]);
  //
  /**
   * Cancel an attended transfer
   * @param sessionId - Either the parent (original) call ID or child (transfer) call ID
   */
  const cancelAttendedTransfer = useCallback(
    async (sessionId: string) => {
      logger.debug("cancelAttendedTransfer: Starting cancel process", {
        sessionId,
        timestamp: new Date().toISOString()
      });

      try {
        const currentState = stateRef.current;

        // Determine if we were given a parent or child session ID
        let parentSessionId: string;
        let childSessionId: string;
        let parentCall;

        const providedCall = currentState.calls[sessionId];
        if (!providedCall) {
          logger.error("cancelAttendedTransfer: Call not found", {
            sessionId,
            availableCallIds: Object.keys(currentState.calls),
            totalCalls: Object.keys(currentState.calls).length
          });
          throw new Error("Cannot cancel transfer - call not found");
        }

        // Check if this is a parent call (has childSessionId)
        if (providedCall.childSessionId) {
          logger.debug("cancelAttendedTransfer: Provided ID is parent call", {
            parentSessionId: sessionId,
            childSessionId: providedCall.childSessionId
          });
          parentSessionId = sessionId;
          childSessionId = providedCall.childSessionId;
          parentCall = providedCall;
        }
        // Check if this is a child call (has parentSessionId)
        else if (providedCall.parentSessionId) {
          logger.debug(
            "cancelAttendedTransfer: Provided ID is child call, finding parent",
            {
              childSessionId: sessionId,
              parentSessionId: providedCall.parentSessionId
            }
          );
          parentSessionId = providedCall.parentSessionId;
          childSessionId = sessionId;
          parentCall = currentState.calls[parentSessionId];
        }
        // Neither parent nor child - not in a transfer
        else {
          logger.warn(
            "cancelAttendedTransfer: Call is not part of a transfer",
            {
              sessionId
            }
          );
          return;
        }

        if (!parentCall || !childSessionId) {
          logger.error("cancelAttendedTransfer: Invalid transfer state", {
            parentFound: !!parentCall,
            childSessionId
          });
          throw new Error("Cannot cancel transfer - invalid state");
        }

        const childCall = currentState.calls[childSessionId];
        logger.debug("cancelAttendedTransfer: Found calls", {
          parentCall: {
            sessionId: parentCall.sessionId,
            isOnHold: parentCall.isOnHold,
            childSessionId: parentCall.childSessionId
          },
          childCall: {
            exists: !!childCall,
            sessionId: childCall?.sessionId,
            parentSessionId: childCall?.parentSessionId
          }
        });

        // Clean up state relationships
        setState((prev) => {
          const updatedCalls = { ...prev.calls };

          // Clear childSessionId from parent call
          if (updatedCalls[parentSessionId]) {
            updatedCalls[parentSessionId] = {
              ...updatedCalls[parentSessionId],
              childSessionId: undefined
            };
            logger.debug(
              "cancelAttendedTransfer: Cleared childSessionId from parent"
            );
          }

          // Clear parentSessionId from child call if it still exists
          if (updatedCalls[childSessionId]) {
            updatedCalls[childSessionId] = {
              ...updatedCalls[childSessionId],
              parentSessionId: undefined
            };
            logger.debug(
              "cancelAttendedTransfer: Cleared parentSessionId from child"
            );
          }

          // Set parent call as active
          logger.debug(
            "cancelAttendedTransfer: Setting parent as active call",
            {
              parentSessionId
            }
          );

          return {
            ...prev,
            calls: updatedCalls,
            activeCallId: parentSessionId
          };
        });

        // Call SippyCup to handle SIP operations (hangup child, unhold parent)
        const voipBridge = VoipBridge.getInstance();
        const parentSipSession = getSipSession(parentSessionId);
        const childSipSession = getSipSession(childSessionId);
        const isVoipTransfer =
          voipBridge.isVoipCall(parentSessionId) ||
          voipBridge.isVoipCall(childSessionId) ||
          !!parentSipSession ||
          !!childSipSession;

        if (isVoipTransfer) {
          // VoIP path: sessionEnded can fire before React commits activeCallId = parent.
          // Suppress handleCallEnd for the child so we don't pop InCall / dismiss the parent leg.
          if (childSipSession) {
            getSuppressedCallKeepEndSet().add(childSessionId);
            childSipSession.sipTerminate();
            removeSipSession(childSessionId);
          }
          if (parentSipSession) {
            parentSipSession.sipUnhold();
          }
          updateCall(parentSessionId, { isOnHold: false });

          const endTime = new Date().toISOString();
          updateCall(childSessionId, {
            state: CallState.ENDED,
            connected: false,
            endTime
          });
          sippyCupRef.current?.emit(
            "callStateChanged",
            childSessionId,
            CallState.ENDED
          );
          setActiveCallId(parentSessionId);
          voipBridge.clearVoipCallTracking(childSessionId);
          try {
            CallKeep.reportEndCallWithUUID(childSessionId, 2);
          } catch (e: any) {
            console.warn(
              `📞 [SP] cancelAttendedTransfer: CallKeep.reportEnd for child leg:`,
              e?.message || e
            );
          }
          setTimeout(() => {
            removeCall(childSessionId);
          }, 1000);
        } else {
          const sippyCup = await ensureInitialized();
          const preferSpeakerOnAtEnd = !!parentCall?.isSpeakerOn;
          await sippyCup.cancelAttendedTransfer(
            parentSessionId,
            childSessionId,
            { preferSpeakerOnAtEnd }
          );
          updateCall(parentSessionId, {
            isOnHold: false,
            isSpeakerOn: preferSpeakerOnAtEnd
          });
        }

        logger.debug(
          "cancelAttendedTransfer: Transfer cancelled successfully",
          {
            parentSessionId,
            childSessionId,
            timestamp: new Date().toISOString()
          }
        );
      } catch (error) {
        logger.error("cancelAttendedTransfer: Failed to cancel transfer", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }
    },
    [ensureInitialized, updateCall, removeCall, setActiveCallId]
  );

  const addParticipantToConference = useCallback(async () => {
    // TODO: Implement participant addition to conference
  }, []);

  const setMutedConferenceParticipant = useCallback(
    (sessionId: string, channel: string) => {
      setState((currentState) => {
        const call = currentState.calls[sessionId];
        if (call) {
          updateCall(sessionId, {
            mutedConferenceParticipants: [
              ...call.mutedConferenceParticipants,
              channel
            ]
          });
        }
        return currentState;
      });
    },
    [updateCall]
  );

  const removeMutedConferenceParticipant = useCallback(
    (sessionId: string, channel: string) => {
      setState((currentState) => {
        const call = currentState.calls[sessionId];
        if (call) {
          updateCall(sessionId, {
            mutedConferenceParticipants:
              call.mutedConferenceParticipants.filter((c) => c !== channel)
          });
        }
        return currentState;
      });
    },
    [updateCall]
  );

  const unMuteAllConferenceParticipants = useCallback(
    async (sessionId: string) => {
      updateCall(sessionId, { mutedConferenceParticipants: [] });
    },
    [updateCall]
  );

  const getAllCalls = useCallback(() => {
    let result: ContextCallInfo[] = [];
    setState((currentState) => {
      result = Object.values(currentState.calls);
      return currentState;
    });
    return result;
  }, []);

  const getShowActiveCallBar = useCallback(() => {
    return !!currentCall || callsOnHold.length > 0;
  }, [currentCall, callsOnHold]);

  const getConferenceCall = useCallback(() => {
    let result: ContextCallInfo | null = null;
    setState((currentState) => {
      result =
        Object.values(currentState.calls).find((call) => call.conferencing) ||
        null;
      return currentState;
    });
    return result;
  }, []);

  const getOriginalCallOnHold = useCallback(() => {
    // Simplified implementation
    return false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sippyCupRef.current) {
        sippyCupRef.current.dispose();
      }
    };
  }, []);

  /**
   * Handle VoIP call display in native UI - needs to be separate to avoid circular dependency
   */
  useEffect(() => {
    const voipBridge = VoipBridge.getInstance();

    const handleVoipCallDisplay = async (
      callId: string,
      callInfo: CallInfo
    ) => {
      iosCallFlowLog(
        "handleVoipCallDisplay",
        "incoming VoIP — native display path",
        {
          callId,
          callInfoState: callInfo.state,
          remoteDisplayName: callInfo.remoteDisplayName,
          remoteUri: callInfo.remoteUri,
          activeCallId: stateRef.current.activeCallId ?? null,
          skipDisplayOnIos: Platform.OS === "ios"
        }
      );
      console.log(
        "🟪 [SoftphoneProvider] 📞 handleVoipCallDisplay called - DISPLAYING NEW CALL:",
        {
          callId,
          callInfoState: callInfo.state,
          remoteDisplayName: callInfo.remoteDisplayName,
          remoteUri: callInfo.remoteUri,
          platform: Platform.OS,
          timestamp: new Date().toISOString()
        }
      );
      try {
        // DON'T add VoIP call to UI state - it's just a placeholder waiting for SIP INVITE
        // The VoIP bridge tracks it internally via voipCalls Set

        // IMPORTANT: On iOS, skip displayIncomingCall because AppDelegate.mm already
        // reported the call to CallKit natively via RNCallKeep.reportNewIncomingCall.
        // Calling displayIncomingCall again would launch the app unnecessarily.
        // The call will stay in native CallKit UI until user answers/declines.
        if (Platform.OS === "ios") {
          try {
            const sippyCup = await ensureInitialized();
            sippyCup.registerCallKitUuidAlias(callId, callId);
            console.warn(
              `[END-ACCEPT-TRACE][ios-project][SP][incomingVoipCall-display] registeredCallKitAlias callUUID=${callId} callId=${callId}`
            );
          } catch (aliasError) {
            console.warn(
              `[END-ACCEPT-TRACE][ios-project][SP][incomingVoipCall-display] registerCallKitAlias failed callUUID=${callId}:`,
              aliasError
            );
          }
          console.log(
            "🟪 [SoftphoneProvider] 📞 iOS: Skipping displayIncomingCall (already handled by AppDelegate)"
          );
          console.log(
            "🟪 [SoftphoneProvider] 📞 VoIP call registered, waiting for SIP INVITE:",
            {
              callId
            }
          );
          logger.debug("iOS VoIP call registered, waiting for SIP INVITE", {
            callId
          });
          return;
        }

        console.log(
          "🟪 [SoftphoneProvider] 📞 Android: Calling sippyCup.displayIncomingCall..."
        );
        // Only display in native CallKeep for Android
        const sippyCup = await ensureInitialized();
        await sippyCup.displayIncomingCall(callId, callInfo);
        console.log(
          "🟪 [SoftphoneProvider] 📞 ✅ sippyCup.displayIncomingCall completed"
        );

        // The actual call will be added when the SIP INVITE arrives and matches this VoIP call
        // Navigation will happen in the incomingCall handler when SIP session is established
        console.log(
          "🟪 [SoftphoneProvider] 📞 VoIP call registered, waiting for SIP INVITE:",
          {
            callId
          }
        );
        logger.debug("VoIP call registered, waiting for SIP INVITE", {
          callId
        });
      } catch (error) {
        console.error(
          "🟪 [SoftphoneProvider] 📞 ❌ Error handling VoIP call:",
          error
        );
        logger.error("Error handling VoIP call:", error);
      }
    };

    voipBridge.on("incomingVoipCall", handleVoipCallDisplay);

    return () => {
      voipBridge.off("incomingVoipCall", handleVoipCallDisplay);
    };
  }, [ensureInitialized, addCall]);

  /**
   * Handle VoIP call answering - needs to be separate to avoid circular dependency
   */
  useEffect(() => {
    const voipBridge = VoipBridge.getInstance();

    const handleVoipAnswer = async (callId: string) => {
      iosCallFlowLog("handleVoipAnswer", "user answered VoIP (SlimSip)", {
        callId,
        activeCallId: stateRef.current.activeCallId ?? null,
        hasPendingSipSession: !!(global as any).pendingSipSessions?.has?.(
          callId
        )
      });
      console.log(
        "� [SoftphoneProvider] 📞 handleVoipAnswer called (SlimSipClient):",
        {
          callId,
          platform: Platform.OS,
          timestamp: new Date().toISOString()
        }
      );
      try {
        const voipBridge = VoipBridge.getInstance();
        const sipSessionAtEntry = getSipSession(callId);
        const activeCallIdSnapshot = stateRef.current.activeCallId;
        console.warn(
          `[END-ACCEPT-TRACE][ios-project][SP][handleVoipAnswer] entry callId=${callId} hasSipSession=${!!sipSessionAtEntry} activeCallId=${
            activeCallIdSnapshot || "none"
          }`
        );

        if (!voipBridge.isVoipCall(callId)) {
          console.log(
            "🔵 [SoftphoneProvider] 📞 Not a VoIP call, skipping:",
            callId
          );
          return;
        }

        // CRITICAL: Get the stored SipSession from SlimSipClient
        const sipSession = sipSessionAtEntry;

        if (!sipSession) {
          console.error(
            "� [SoftphoneProvider] 📞 ❌ No SipSession found for callId:",
            callId
          );
          logger.error("No SipSession found to answer", { callId });

          // Update state to show error
          updateCall(callId, {
            state: CallState.FAILED,
            connected: false
          });
          return;
        }

        const existingLive = stateRef.current.calls[callId];
        if (
          existingLive &&
          isLiveCallState(existingLive.state) &&
          isSipSessionConnected(sipSession)
        ) {
          setActiveCallId(callId);
          openInCallScreen(callId, { force: true });
          voipBridge.clearPendingAnswer(callId);
          return;
        }

        console.log(
          "� [SoftphoneProvider] 📞 ✅ Found SipSession, calling sipSession.answer()..."
        );

        // CRITICAL: Add the VoIP call to the provider's calls state.
        // Without this, updateCall silently no-ops (call doesn't exist in state),
        // and when the server CANCELs the SessionManager INVITE, allCalls becomes
        // empty → InCallScreen shows "call ended" and navigates away.
        const voipCallData = voipBridge.getVoipCallData(callId);
        const incomingServerCallId =
          extractServerCallIdFromSipSession(
            sipSession,
            "handleVoipAnswer-incoming"
          ) || callId;
        const req = (sipSession as any)?.rtcSession?._request;
        const xcidVal =
          getSipRequestHeaderValue(req, "Xcid") ||
          getSipRequestHeaderValue(req, "X-Cid");
        console.warn("[MERGE-DIAG] handleVoipAnswer (incoming VoIP call)", {
          sessionId: callId,
          incomingServerCallId,
          hasXcid: !!xcidVal,
          xcid: xcidVal || null,
          "web-uses":
            "invite.request.getHeader('Xcid') for incoming - setup.ts:117",
          "for-merge": "callId must match backend liveChannels.ch_callid"
        });
        logger.debug("handleVoipAnswer: merge-readiness for incoming call", {
          sessionId: callId,
          incomingServerCallId,
          hasXcid: !!(
            getSipRequestHeaderValue(
              (sipSession as any)?.rtcSession?._request,
              "Xcid"
            ) ||
            getSipRequestHeaderValue(
              (sipSession as any)?.rtcSession?._request,
              "X-Cid"
            )
          ),
          "for-merge":
            "need this callId to match backend liveChannels.ch_callid",
          "web-uses":
            "invite.request.getHeader('Xcid') for incoming (setup.ts:117)"
        });
        const voipCallEntry: ContextCallInfo = {
          callId: incomingServerCallId,
          sessionId: callId,
          state: CallState.CONNECTING,
          direction: CallDirection.INCOMING,
          remoteDisplayName: voipCallData?.callerName || "Unknown",
          remoteUri: voipCallData
            ? `sip:${voipCallData.callerNumber}@dev-sip.voxo.co`
            : "",
          remoteParty: undefined,
          startTime: new Date().toISOString(),
          answerTime: new Date().toISOString(),
          endTime: undefined,
          isMuted: false,
          isOnHold: false,
          isSpeakerOn: false,
          isEmergency: false,
          connected: false,
          recording: false,
          conferencing: false,
          conferenceId: undefined,
          attendedTransfer: false,
          parentSessionId: undefined,
          childSessionId: undefined,
          totalCallDuration: 0,
          currentHoldDuration: 0,
          totalHoldDuration: 0,
          mutedConferenceParticipants: []
        };
        addCall(voipCallEntry);
        console.warn(
          `📞 [SP] ${new Date().toISOString()} handleVoipAnswer: added VoIP call ${callId} to provider state`
        );
        sippyCupRef.current?.emit(
          "callStateChanged",
          callId,
          CallState.CONNECTING
        );

        // Set as active call and navigate to InCallScreen
        const previousActiveCallId = state.activeCallId;
        if (previousActiveCallId && previousActiveCallId !== callId) {
          console.warn(
            `[END-ACCEPT-TRACE][ios-project][SP][handleVoipAnswer] terminatingPreviousCall previousActiveCallId=${previousActiveCallId} incomingCallId=${callId}`
          );
          try {
            await hangupCall(previousActiveCallId);
          } catch (endErr) {
            console.warn(
              `[END-ACCEPT-TRACE][ios-project][SP][handleVoipAnswer] terminatePreviousCall failed previousActiveCallId=${previousActiveCallId}:`,
              endErr
            );
          }
        }

        setActiveCallId(callId);
        openInCallScreen(callId);

        const alreadyConnected = isSipSessionConnected(sipSession);

        // CRITICAL: Answer the SIP session (voxo-mobile's exact pattern)
        if (!alreadyConnected) {
          sipSession.answer();
          console.warn(
            `[END-ACCEPT-TRACE][ios-project][SP][handleVoipAnswer] answerDispatched callId=${callId}`
          );

          console.log(
            " [SoftphoneProvider] sipSession.answer() called, waiting for call to establish..."
          );

          await sipSession.established();

          console.log(
            " [SoftphoneProvider] Call established successfully!"
          );
          iosCallFlowLog("inbound", "call established", { callId });
        } else {
          console.warn(
            `[END-ACCEPT-TRACE][ios-project][SP][handleVoipAnswer] session already connected callId=${callId}`
          );
          iosCallFlowLog("inbound", "call already connected (killed-state adopt path)", {
            callId
          });
        }

        // Update call state to CONNECTED
        const connectedServerCallId =
          extractServerCallIdFromSipSession(
            sipSession,
            "handleVoipAnswer-connected"
          ) || incomingServerCallId;
        updateCall(callId, {
          callId: connectedServerCallId,
          state: CallState.CONNECTED,
          connected: true
        });
        sippyCupRef.current?.emit(
          "callStateChanged",
          callId,
          CallState.CONNECTED
        );
        voipBridge.clearPendingAnswer(callId);
      } catch (error) {
        console.error(
          "� [SoftphoneProvider] 📞 ❌ Error answering VoIP call:",
          error
        );
        iosCallFlowError("inbound", "error answering VoIP call", error, {
          callId
        });
        logger.error("Error answering VoIP call:", error);

        // Update state to show error
        updateCall(callId, {
          state: CallState.FAILED,
          connected: false
        });

        // Cleanup
        removeSipSession(callId);
      }
    };

    voipBridge.on("answerVoipCall", handleVoipAnswer);
    voipBridge.drainPendingAnswerCallIds();
    void (async () => {
      await ensureInitialized();
      setTimeout(() => {
        void adoptOrphanedVoipCalls();
      }, 400);
    })();

    return () => {
      voipBridge.off("answerVoipCall", handleVoipAnswer);
    };
  }, [
    ensureInitialized,
    addCall,
    updateCall,
    setActiveCallId,
    state.activeCallId,
    hangupCall,
    openInCallScreen,
    adoptOrphanedVoipCalls
  ]);

  // Context value
  const contextValue = {
    // State
    ...state,

    // Computed properties
    currentCall,
    incomingCalls,
    callsOnHold,

    // Core actions
    setInCallScreenMinimized,
    setConfig,
    makeCall,
    answerCall,
    answerCallViaCallKeep,
    declineCall: hangupCall,
    hangupCall,
    holdCall,
    unholdCall,
    muteCall,
    unmuteCall,
    setSpeaker,
    sendDTMF,
    transferCall,
    startAttendedTransfer,
    completeAttendedTransfer,
    cancelAttendedTransfer,
    swapAttendedTransferCalls,
    clearError,
    cleanup,

    // Compatibility methods (should be refactored out)
    setCurrentCall,
    setCurrentCallConnected,
    updateCurrentCallData,
    clearCurrentCall,
    addIncomingCall,
    removeIncomingCall,
    addCallOnHold,
    removeCallOnHold,
    holdCurrentCall,
    getCallById,
    getChildCallBySessionId,
    getParentCallBySessionId,
    updateCallDurations,
    setConferencing,
    startConference,
    addParticipantToConferenceCall,
    mergeAttendedTransfer,
    addParticipantToConference,
    setMutedConferenceParticipant,
    removeMutedConferenceParticipant,
    unMuteAllConferenceParticipants,
    getAllCalls,
    getShowActiveCallBar,
    getConferenceCall,
    getOriginalCallOnHold
  };

  return (
    <SoftphoneContext.Provider value={contextValue}>
      {children}
    </SoftphoneContext.Provider>
  );
};
