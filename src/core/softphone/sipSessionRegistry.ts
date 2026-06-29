import CallKeep from "react-native-callkeep";
import { SipSession } from "./jssip/SipSession";
import { SlimSipClient } from "./jssip/SlimSipClient";
import { VoipBridge } from "./VoipBridge.ts";
import { isAnsweredElsewhereSessionFailed } from "./utils/session-failed-reason";
import { showCallPickedElsewhereNotification } from "../notifications/callPickedElsewhereNotification";
import { notifySipBackendCallDiscovered } from "./sipBackendCallIdBridge.ts";
import { ForegroundSlimSipHub } from "./jssip/ForegroundSlimSipHub.ts";

const pendingSipSessions = new Map<string, SipSession>();
const pendingSipClients = new Map<string, SlimSipClient>();

const getSuppressedCallKeepEndSet = (): Set<string> => {
  const g = global as any;
  if (!g.__voxoSuppressCallKeepEndUuids) {
    g.__voxoSuppressCallKeepEndUuids = new Set<string>();
  }
  return g.__voxoSuppressCallKeepEndUuids as Set<string>;
};

export function storeSipSession(
  callUuid: string,
  session: SipSession,
  client: SlimSipClient
): void {
  console.log(`🔵 [sipSessionRegistry] Storing SIP session for ${callUuid}`);
  pendingSipSessions.set(callUuid, session);
  pendingSipClients.set(callUuid, client);

  const handleSessionEnded = (data?: any) => {
    const source = data?.cause || data?.originator || "remoteByeOrEnded";
    const suppressed = getSuppressedCallKeepEndSet();
    if (suppressed.has(callUuid)) {
      suppressed.delete(callUuid);
      return;
    }
    try {
      CallKeep.reportEndCallWithUUID(callUuid, 2);
      VoipBridge.getInstance().handleCallEnd(callUuid);
    } catch (e: any) {
      console.error(
        `📞 [sipSessionRegistry] Failed to dismiss on sessionEnded:`,
        e?.message || e
      );
    }
  };

  const handleSessionFailed = (data?: any) => {
    const suppressed = getSuppressedCallKeepEndSet();
    if (suppressed.has(callUuid)) {
      suppressed.delete(callUuid);
      return;
    }
    try {
      CallKeep.reportEndCallWithUUID(callUuid, 2);
      VoipBridge.getInstance().handleCallEnd(callUuid);
      if (isAnsweredElsewhereSessionFailed(data)) {
        void showCallPickedElsewhereNotification(callUuid).catch(() => {});
      }
    } catch (e: any) {
      console.error(
        `📞 [sipSessionRegistry] Failed to dismiss on sessionFailed:`,
        e?.message || e
      );
    }
  };

  if (!session.listenerCount || session.listenerCount("sessionEnded") === 0) {
    session.on("sessionEnded", handleSessionEnded);
  }
  if (!session.listenerCount || session.listenerCount("sessionFailed") === 0) {
    session.on("sessionFailed", handleSessionFailed);
  }

  session.on("backendCallIdUpdate", (id: string) => {
    notifySipBackendCallDiscovered(callUuid, id);
  });
}

export function getSipSession(callUuid: string): SipSession | undefined {
  const g = global as any;
  if (g.pendingSipSessions?.has(callUuid)) {
    return g.pendingSipSessions.get(callUuid);
  }
  return pendingSipSessions.get(callUuid);
}

export function getSipClient(callUuid: string): SlimSipClient | undefined {
  const g = global as any;
  if (g.pendingSipClients?.has(callUuid)) {
    return g.pendingSipClients.get(callUuid);
  }
  return pendingSipClients.get(callUuid);
}

export function removeSipSession(callUuid: string): void {
  const client = pendingSipClients.get(callUuid);
  const hubClient = ForegroundSlimSipHub.getInstance().getClient();
  if (client && client !== hubClient) {
    client.dispose().catch(() => {});
  }
  pendingSipSessions.delete(callUuid);
  pendingSipClients.delete(callUuid);

  const g = global as any;
  if (g.pendingSipClients?.has(callUuid)) {
    const globalClient = g.pendingSipClients.get(callUuid);
    globalClient?.dispose?.().catch(() => {});
    g.pendingSipClients.delete(callUuid);
  }
  if (g.pendingSipSessions) {
    g.pendingSipSessions.delete(callUuid);
  }
}

export function getAllSipSessionIds(): string[] {
  return [...pendingSipSessions.keys()];
}

/** Merges module-local and NotificationManager global pending session maps. */
export function getAllPendingSipSessionIds(): string[] {
  const ids = new Set<string>(pendingSipSessions.keys());
  const g = global as { pendingSipSessions?: Map<string, SipSession> };
  if (g.pendingSipSessions) {
    for (const k of g.pendingSipSessions.keys()) {
      ids.add(k);
    }
  }
  return [...ids];
}

export function disposeAllSipSessions(): void {
  for (const id of [...pendingSipSessions.keys()]) {
    removeSipSession(id);
  }
}
