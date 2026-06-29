import { Platform } from "react-native";
import notifee, { AndroidImportance } from "@notifee/react-native";
import type { VoipCallData } from "./NotificationManager";

const NOTIFICATION_ID_PREFIX = "stale-voip-missed";
const ANDROID_CHANNEL_ID = "voxo-call-events";
const FALLBACK_DELAY_MS = 5_000;

const MISSED_CALL_LABEL_RE =
  /^(missed call|you have a missed call)$/i;

function parseNameFromMissedCallPhrase(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^missed call from\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isMissedCallBoilerplate(text: string): boolean {
  return MISSED_CALL_LABEL_RE.test(text.trim());
}

function pickCallerString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || isMissedCallBoilerplate(trimmed)) {
    return null;
  }
  const parsed = parseNameFromMissedCallPhrase(trimmed);
  if (parsed) {
    return parsed;
  }
  return trimmed;
}

/** Shared label for stale/local and server-rendered missed-call notifications. */
export function resolveMissedCallCallerLabel(
  sources: Record<string, unknown>
): string {
  const directKeys = [
    "callerName",
    "caller_name",
    "payload_callerName",
    "localizedCallerName",
    "displayName",
    "name"
  ];
  for (const key of directKeys) {
    const picked = pickCallerString(sources[key]);
    if (picked) {
      return picked;
    }
  }

  const textKeys = ["title", "body", "message"];
  for (const key of textKeys) {
    const raw = sources[key];
    if (typeof raw === "string") {
      const parsed = parseNameFromMissedCallPhrase(raw);
      if (parsed) {
        return parsed;
      }
    }
  }

  const numberKeys = ["callerNumber", "caller_number", "payload_callerNumber", "handle"];
  for (const key of numberKeys) {
    const picked = pickCallerString(sources[key]);
    if (picked && picked !== "Unknown" && picked !== "Unknown Number") {
      return picked;
    }
  }

  return "Unknown caller";
}

export function resolveMissedCallCallerLabelFromVoipCall(
  callData: VoipCallData
): string {
  const payload =
    callData.payload && typeof callData.payload === "object"
      ? (callData.payload as Record<string, unknown>)
      : {};
  return resolveMissedCallCallerLabel({
    callerName: callData.callerName,
    callerNumber: callData.callerNumber,
    ...payload
  });
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const serverHandledUuids = new Set<string>();

let androidChannelReady: Promise<unknown> | null = null;

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }
  if (!androidChannelReady) {
    androidChannelReady = notifee.createChannel({
      id: ANDROID_CHANNEL_ID,
      name: "Call events",
      importance: AndroidImportance.HIGH,
      vibration: true,
      sound: "default"
    });
  }
  await androidChannelReady;
}

export function markMissedCallHandledByServer(callUuid: string): void {
  if (!callUuid) {
    return;
  }
  serverHandledUuids.add(callUuid);
  const timer = pendingTimers.get(callUuid);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(callUuid);
  }
}

function buildMissedCallBody(callData: VoipCallData): string {
  return resolveMissedCallCallerLabelFromVoipCall(callData);
}

async function displayStaleMissedCallNotification(
  callData: VoipCallData
): Promise<void> {
  const callUuid = callData.callUuid;
  if (!callUuid || serverHandledUuids.has(callUuid)) {
    return;
  }

  const callerLabel = buildMissedCallBody(callData);

  try {
    await ensureAndroidChannel();
    await notifee.displayNotification({
      id: `${NOTIFICATION_ID_PREFIX}-${callUuid}`,
      title: "Missed Call",
      body: callerLabel,
      data: {
        click_action: "CALL-EVENT-MISSED",
        callUUID: callUuid,
        callUuid,
        callerName: callerLabel,
        vm_payload_type: "missed_call"
      },
      android: {
        channelId: ANDROID_CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        pressAction: { id: "default" },
        smallIcon: "ic_launcher",
        timestamp: Date.now()
      },
      ios: {
        sound: "default",
        foregroundPresentationOptions: {
          alert: true,
          badge: true,
          sound: true,
          banner: true,
          list: true
        }
      }
    });
  } catch (e) {
    console.warn(
      "[staleVoipMissedCallFallback] displayNotification failed:",
      e
    );
  }
}

export function scheduleStaleVoipMissedCallFallback(
  callData: VoipCallData
): void {
  const callUuid = callData.callUuid;
  if (!callUuid) {
    return;
  }

  if (serverHandledUuids.has(callUuid)) {
    return;
  }

  const existing = pendingTimers.get(callUuid);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    pendingTimers.delete(callUuid);
    if (serverHandledUuids.has(callUuid)) {
      return;
    }
    void displayStaleMissedCallNotification(callData);
  }, FALLBACK_DELAY_MS);

  pendingTimers.set(callUuid, timer);
}

export function extractCallUuidFromMissedCallPayload(
  payload: Record<string, unknown>
): string | null {
  const raw =
    payload.callUUID ??
    payload.callUuid ??
    payload.uuid ??
    payload.payload_callUUID ??
    payload.payload_callUuid;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  return null;
}
