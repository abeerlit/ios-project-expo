import CallKeep from "react-native-callkeep";
import { SlimSipClient } from "./jssip/SlimSipClient";
import { SipSession } from "./jssip/SipSession";
import { NativeIntegration } from "./NativeIntegration.ts";
import { CallDirection, CallState } from "./types.ts";
import { ContextCallInfo } from "./SoftphoneContext.ts";
import { buildSlimSipSettings } from "./slimSipSettings.ts";
import {
  getSipSession,
  storeSipSession,
  removeSipSession
} from "./sipSessionRegistry.ts";
import { AppState, Platform } from "react-native";
import { iosCallFlowLog } from "./iosCallFlowLog.ts";
import { ForegroundSlimSipHub } from "./jssip/ForegroundSlimSipHub.ts";

export type OutboundJsSipOrigin = "inApp" | "callKitRecents";

export interface PlaceOutboundJsSipCallParams {
  destination: string;
  callUuid: string;
  displayName?: string;
  outboundNumberId?: string;
  origin: OutboundJsSipOrigin;
  nativeIntegration: NativeIntegration;
  isEmergency?: boolean;
  /** Hold other live JsSIP legs before placing a new outbound call. */
  holdOtherCalls?: () => void;
  addCall: (call: ContextCallInfo) => void;
  updateCall: (callId: string, updates: Partial<ContextCallInfo>) => void;
  setActiveCallId: (callId: string | undefined) => void;
  openInCallScreen: (callId: string, options?: { force?: boolean }) => void;
  removeCall: (callId: string) => void;
  applyCallStateChange: (callId: string, callState: CallState) => void;
  reportCallKitLocalizedName?: (
    callId: string,
    name: string,
    dialHint: string
  ) => void;
}

function buildOutboundContextCall(
  callUuid: string,
  destination: string,
  displayName?: string,
  isEmergency?: boolean
): ContextCallInfo {
  return {
    callId: callUuid,
    sessionId: callUuid,
    state: CallState.OUTGOING,
    direction: CallDirection.OUTGOING,
    remoteDisplayName: displayName || destination,
    remoteUri: `sip:${destination}@dev-sip.voxo.co`,
    remoteParty: undefined,
    startTime: new Date().toISOString(),
    isMuted: false,
    isOnHold: false,
    isSpeakerOn: false,
    isEmergency: !!isEmergency,
    connected: false,
    recording: false,
    conferencing: false,
    attendedTransfer: false,
    totalCallDuration: 0,
    currentHoldDuration: 0,
    totalHoldDuration: 0,
    mutedConferenceParticipants: [],
    ...(displayName != null && { contactDisplayName: displayName })
  };
}

export function wireOutboundSipSessionListeners(
  callUuid: string,
  sipSession: SipSession,
  params: Pick<
    PlaceOutboundJsSipCallParams,
    | "destination"
    | "displayName"
    | "nativeIntegration"
    | "updateCall"
    | "setActiveCallId"
    | "openInCallScreen"
    | "removeCall"
    | "applyCallStateChange"
    | "reportCallKitLocalizedName"
  >
): void {
  const {
    destination,
    displayName,
    nativeIntegration,
    updateCall,
    setActiveCallId,
    openInCallScreen,
    removeCall,
    applyCallStateChange,
    reportCallKitLocalizedName
  } = params;

  let navigatedConnected = false;

  const onConnected = () => {
    applyCallStateChange(callUuid, CallState.CONNECTED);
    updateCall(callUuid, { connected: true });
    void nativeIntegration.updateCallState(callUuid, CallState.CONNECTED);
    if (!navigatedConnected) {
      navigatedConnected = true;
      setActiveCallId(callUuid);
      openInCallScreen(callUuid, { force: true });
    }
    const remoteName =
      (sipSession as any)?.rtcSession?.remote_identity?.display_name;
    if (remoteName && reportCallKitLocalizedName) {
      reportCallKitLocalizedName(
        callUuid,
        String(remoteName).trim(),
        destination
      );
    } else if (displayName && reportCallKitLocalizedName) {
      reportCallKitLocalizedName(callUuid, displayName, destination);
    }
  };

  sipSession.on("remoteRinging", () => {
    applyCallStateChange(callUuid, CallState.OUTGOING);
    updateCall(callUuid, { state: CallState.OUTGOING });
  });

  sipSession.on("remoteProgress", () => {
    applyCallStateChange(callUuid, CallState.OUTGOING);
  });

  sipSession.on("accepted", onConnected);
  sipSession.on("confirmed", onConnected);

  let nativeDismissed = false;
  const dismissNativeCall = (state: CallState.ENDED | CallState.FAILED) => {
    if (nativeDismissed) {
      return;
    }
    nativeDismissed = true;
    void nativeIntegration.updateCallState(callUuid, state).catch(() => {});
  };

  sipSession.on("sessionEnded", () => {
    dismissNativeCall(CallState.ENDED);
    removeCall(callUuid);
    removeSipSession(callUuid);
  });

  sipSession.on("sessionFailed", () => {
    applyCallStateChange(callUuid, CallState.FAILED);
    dismissNativeCall(CallState.FAILED);
    removeCall(callUuid);
    removeSipSession(callUuid);
  });
}

/** Coalesce parallel outbound INVITEs for the same CallKit / SIP UUID. */
const outboundInviteInFlight = new Map<string, Promise<string>>();
/** While an invite is in flight, map normalized dial string → active UUID. */
const outboundInviteByDest = new Map<string, string>();

function normalizeOutboundDestKey(destination: string): string {
  const trimmed = String(destination || "").trim();
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3 ? digits : trimmed.toLowerCase();
}

async function executePlaceOutboundJsSipCall(
  params: PlaceOutboundJsSipCallParams,
  dest: string,
  uuidStr: string
): Promise<string> {
  const {
    displayName,
    outboundNumberId,
    origin,
    nativeIntegration,
    holdOtherCalls,
    addCall,
    updateCall,
    setActiveCallId,
    openInCallScreen,
    removeCall,
    applyCallStateChange,
    reportCallKitLocalizedName,
    isEmergency
  } = params;

  iosCallFlowLog("jsSip.outbound", "placeOutboundJsSipCall", {
    destination: dest,
    callUuid: uuidStr,
    origin
  });

  holdOtherCalls?.();

  if (Platform.OS === "ios") {
    if (origin === "callKitRecents") {
      nativeIntegration.markIosOutboundCallKitUuid(uuidStr);
      nativeIntegration.registerCallUuidAlias(uuidStr, uuidStr);
      CallKeep.reportConnectingOutgoingCallWithUUID(uuidStr);
      nativeIntegration.startIosCallKitOriginatedRingback();
      nativeIntegration.primeIosCallKitRecentsEndSnapshot(
        uuidStr,
        dest,
        displayName?.trim()
      );
    } else {
      await nativeIntegration.startOutgoingCall(
        uuidStr,
        dest,
        displayName,
        uuidStr
      );
    }
  }

  const hub = ForegroundSlimSipHub.getInstance();
  let sipSession: SipSession;
  let client: SlimSipClient;

  if (hub.isActive()) {
    sipSession = await hub.placeOutboundCall(dest, uuidStr, outboundNumberId);
    client = hub.getClient()!;
  } else {
    const settings = buildSlimSipSettings(uuidStr, "outbound");
    if (!settings) {
      throw new Error("Not logged in — cannot place JsSIP outbound call");
    }
    client = new SlimSipClient(settings);
    sipSession = await client.call(dest, uuidStr, outboundNumberId);
  }

  storeSipSession(uuidStr, sipSession, client);

  const outboundCall = buildOutboundContextCall(
    uuidStr,
    dest,
    displayName,
    isEmergency
  );
  addCall(outboundCall);
  setActiveCallId(uuidStr);

  wireOutboundSipSessionListeners(uuidStr, sipSession, {
    destination: dest,
    displayName,
    nativeIntegration,
    updateCall,
    setActiveCallId,
    openInCallScreen,
    removeCall,
    applyCallStateChange,
    reportCallKitLocalizedName
  });

  if (Platform.OS === "ios" && origin === "callKitRecents" && displayName?.trim()) {
    reportCallKitLocalizedName?.(uuidStr, displayName.trim(), dest);
  }

  return uuidStr;
}

export async function placeOutboundJsSipCall(
  params: PlaceOutboundJsSipCallParams
): Promise<string> {
  const dest = String(params.destination || "").trim();
  const uuidStr = String(params.callUuid || "").trim().toLowerCase();
  if (!dest || !uuidStr) {
    throw new Error("Invalid destination or call UUID");
  }

  if (getSipSession(uuidStr)) {
    iosCallFlowLog("jsSip.outbound", "SKIP — SIP session already exists", {
      callUuid: uuidStr,
      destination: dest
    });
    return uuidStr;
  }

  const existingByUuid = outboundInviteInFlight.get(uuidStr);
  if (existingByUuid) {
    iosCallFlowLog("jsSip.outbound", "COALESCED — invite in flight (uuid)", {
      callUuid: uuidStr,
      destination: dest
    });
    return existingByUuid;
  }

  const destKey = normalizeOutboundDestKey(dest);
  const inflightUuidForDest = outboundInviteByDest.get(destKey);
  if (inflightUuidForDest) {
    const existingByDest = outboundInviteInFlight.get(inflightUuidForDest);
    if (existingByDest) {
      iosCallFlowLog("jsSip.outbound", "COALESCED — invite in flight (dest)", {
        callUuid: inflightUuidForDest,
        destination: dest
      });
      return existingByDest;
    }
    outboundInviteByDest.delete(destKey);
  }

  const work = (async (): Promise<string> => {
    try {
      return await executePlaceOutboundJsSipCall(params, dest, uuidStr);
    } finally {
      outboundInviteInFlight.delete(uuidStr);
      if (outboundInviteByDest.get(destKey) === uuidStr) {
        outboundInviteByDest.delete(destKey);
      }
    }
  })();

  outboundInviteInFlight.set(uuidStr, work);
  outboundInviteByDest.set(destKey, uuidStr);
  return work;
}

export interface ForegroundWsIncomingParams {
  callUuid: string;
  remoteUri: string;
  remoteDisplayName: string;
  sipSession: SipSession;
  client: SlimSipClient;
  addCall: (call: ContextCallInfo) => void;
  removeCall: (callId: string) => void;
  applyCallStateChange: (callId: string, callState: CallState) => void;
  displayIncomingCall?: (
    callId: string,
    callInfo: {
      remoteDisplayName: string;
      remoteUri: string;
    }
  ) => Promise<void>;
  reportCallKitLocalizedName?: (
    callId: string,
    name: string,
    dialHint: string
  ) => void;
}

function wireForegroundWsIncomingListeners(
  callUuid: string,
  sipSession: SipSession,
  params: Pick<
    ForegroundWsIncomingParams,
    | "removeCall"
    | "applyCallStateChange"
    | "remoteUri"
    | "remoteDisplayName"
    | "reportCallKitLocalizedName"
  >
): void {
  const {
    removeCall,
    applyCallStateChange,
    remoteUri,
    remoteDisplayName,
    reportCallKitLocalizedName
  } = params;

  const onConnected = () => {
    const remoteName =
      (sipSession as any)?.rtcSession?.remote_identity?.display_name;
    if (remoteName && reportCallKitLocalizedName) {
      reportCallKitLocalizedName(
        callUuid,
        String(remoteName).trim(),
        remoteUri
      );
    } else if (remoteDisplayName && reportCallKitLocalizedName) {
      reportCallKitLocalizedName(callUuid, remoteDisplayName, remoteUri);
    }
  };

  sipSession.on("accepted", onConnected);
  sipSession.on("confirmed", onConnected);

  const onEnded = () => {
    applyCallStateChange(callUuid, CallState.ENDED);
    removeCall(callUuid);
    removeSipSession(callUuid);
  };

  sipSession.on("sessionEnded", onEnded);
  sipSession.on("sessionFailed", () => {
    applyCallStateChange(callUuid, CallState.FAILED);
    removeCall(callUuid);
    removeSipSession(callUuid);
  });
}

/** WebSocket INVITE on foreground hub (call notifications off). */
export function handleForegroundWsIncoming(params: ForegroundWsIncomingParams): void {
  const {
    callUuid,
    remoteUri,
    remoteDisplayName,
    sipSession,
    client,
    addCall,
    removeCall,
    applyCallStateChange,
    displayIncomingCall
  } = params;

  if (AppState.currentState !== "active") {
    iosCallFlowLog("foreground-hub", "skip CallKit — app not foreground", {
      callUuid
    });
    try {
      (sipSession as any)?.rtcSession?.terminate?.({
        status_code: 480,
        reason_phrase: "Temporarily Unavailable"
      });
    } catch {
      // ignore
    }
    return;
  }

  storeSipSession(callUuid, sipSession, client);
  wireForegroundWsIncomingListeners(callUuid, sipSession, {
    removeCall,
    applyCallStateChange,
    remoteUri,
    remoteDisplayName,
    reportCallKitLocalizedName: params.reportCallKitLocalizedName
  });

  const incomingCall: ContextCallInfo = {
    callId: callUuid,
    sessionId: callUuid,
    state: CallState.INCOMING,
    direction: CallDirection.INCOMING,
    remoteDisplayName,
    remoteUri,
    startTime: new Date().toISOString(),
    isMuted: false,
    isOnHold: false,
    isSpeakerOn: false,
    isEmergency: false,
    connected: false,
    recording: false,
    conferencing: false,
    attendedTransfer: false,
    totalCallDuration: 0,
    currentHoldDuration: 0,
    totalHoldDuration: 0,
    mutedConferenceParticipants: []
  };

  addCall(incomingCall);

  void displayIncomingCall?.(callUuid, {
    remoteDisplayName,
    remoteUri
  });
}

export function holdAllJsSipCalls(
  calls: Record<string, ContextCallInfo>,
  updateCall: (callId: string, updates: Partial<ContextCallInfo>) => void
): void {
  for (const [sessionId, call] of Object.entries(calls)) {
    if (
      call.state === CallState.ENDED ||
      call.state === CallState.FAILED
    ) {
      continue;
    }
    const sip = getSipSession(sessionId);
    if (sip) {
      sip.sipHold();
      updateCall(sessionId, { isOnHold: true });
    }
  }
}
