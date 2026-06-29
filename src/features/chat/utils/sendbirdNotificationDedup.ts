import messaging from "@react-native-firebase/messaging";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";

/** Parse Sendbird chat message id from FCM remoteMessage.data (iOS APNs). */
export function extractSendbirdMessageIdFromRemoteMessage(
  remoteMessage: { data?: Record<string, unknown> } | null | undefined
): number | null {
  try {
    const d = remoteMessage?.data;
    if (!d) return null;
    const raw = d.sendbird;
    let sb: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      sb = JSON.parse(raw) as Record<string, unknown>;
    } else if (raw && typeof raw === "object") {
      sb = raw as Record<string, unknown>;
    }
    const mid = sb?.message_id ?? sb?.messageId ?? d.messageId ?? d.message_id;
    if (mid == null) return null;
    const n = typeof mid === "number" ? mid : parseInt(String(mid), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const storage = new MMKV({ id: "sendbird-notif-dedup" });

const KEY_IDS = "push_or_local_message_ids";
const MAX_IDS = 400;

/** Skip local Notifee if message is older than this (replay after push / cold start). */
export const IOS_STALE_MESSAGE_SKIP_MS = 12_000;

function parseIdList(): number[] {
  try {
    const s = storage.getString(KEY_IDS);
    if (!s) return [];
    const arr = JSON.parse(s) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n)
    );
  } catch {
    return [];
  }
}

function persistIds(ids: number[]) {
  const trimmed = ids.slice(-MAX_IDS);
  storage.set(KEY_IDS, JSON.stringify(trimmed));
}

/**
 * Call when iOS delivered an APNs/FCM Sendbird push (user opened app from notification
 * or brought app from background via notification). Prevents a second Notifee banner
 * for the same message when Sendbird SDK fires onMessageReceived after connect.
 */
export function recordSendbirdMessageFromSystemPush(messageId: number): void {
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  const ids = parseIdList();
  if (!ids.includes(messageId)) {
    ids.push(messageId);
    persistIds(ids);
  }
}

/** Call after successfully showing a local Notifee chat notification on iOS. */
export function recordSendbirdLocalNotifeeShown(messageId: number): void {
  recordSendbirdMessageFromSystemPush(messageId);
}

/**
 * Remove a message id from the dedup list (e.g. Notifee display failed after we reserved early).
 */
export function forgetSendbirdNotifeeDedupMessageId(messageId: number): void {
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  try {
    const ids = parseIdList().filter((id) => id !== messageId);
    persistIds(ids);
  } catch {
    /* ignore */
  }
}

function hasRecordedMessageId(messageId: number): boolean {
  return parseIdList().includes(messageId);
}

/**
 * iOS: skip duplicate local Notifee when push already showed, or message is a stale replay.
 */
let iosInitialNotificationDrain: Promise<void> | null = null;

/**
 * Await once before showing any iOS local chat banner so FCM initial notification
 * (open from killed state) is read first and its message id is recorded — avoids racing
 * Sendbird onMessageReceived.
 */
export function drainIosInitialNotificationForDedup(): Promise<void> {
  if (Platform.OS !== "ios") {
    return Promise.resolve();
  }
  if (!iosInitialNotificationDrain) {
    iosInitialNotificationDrain = messaging()
      .getInitialNotification()
      .then((remoteMessage) => {
        const mid = extractSendbirdMessageIdFromRemoteMessage(remoteMessage);
        console.log("[IOS_NOTIF_SOUND_TRACE] getInitialNotification drain", {
          hasRemoteMessage: !!remoteMessage,
          sendbirdMessageId: mid,
          fcmMessageId: remoteMessage?.messageId ?? null
        });
        if (mid != null) {
          recordSendbirdMessageFromSystemPush(mid);
        }
      })
      .catch(() => {});
  }
  return iosInitialNotificationDrain;
}

type VoxoNotificationsModuleType = {
  getDeliveredSendbirdMessageIds?: () => Promise<number[]>;
};

/**
 * iOS: merge Sendbird message ids from notifications already in Notification Center
 * (e.g. system/Notifee showed a banner in background) into MMKV *before* we decide
 * to post another Notifee banner — avoids racing AppState "active" sync in NotificationManager.
 */
export async function syncIosDeliveredSendbirdIdsForDedup(): Promise<void> {
  if (Platform.OS !== "ios") {
    return;
  }
  const mod = NativeModules.VoxoNotificationsModule as
    | VoxoNotificationsModuleType
    | undefined;
  if (!mod?.getDeliveredSendbirdMessageIds) {
    return;
  }
  try {
    const ids = await mod.getDeliveredSendbirdMessageIds();
    if (!Array.isArray(ids) || ids.length === 0) {
      return;
    }
    for (const raw of ids) {
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (Number.isFinite(n) && n > 0) {
        recordSendbirdMessageFromSystemPush(n);
      }
    }
    console.log("[IOS_NOTIF_SOUND_TRACE] syncIosDeliveredSendbirdIdsForDedup", {
      count: ids.length
    });
  } catch {
    /* ignore */
  }
}

/**
 * Duplicate notification sound is prevented by skipping a second local Notifee post
 * (`shouldSkipIosDuplicateLocalBanner` / stable `sendbird-${id}`), not by muting after delivery.
 */

export function shouldSkipIosDuplicateLocalBanner(
  messageId: number,
  createdAt: number | undefined | null
): { skip: boolean; reason: "push_recorded" | "stale_replay" | null } {
  if (hasRecordedMessageId(messageId)) {
    return { skip: true, reason: "push_recorded" };
  }
  const t = typeof createdAt === "number" && createdAt > 0 ? createdAt : 0;
  if (t > 0 && Date.now() - t > IOS_STALE_MESSAGE_SKIP_MS) {
    return { skip: true, reason: "stale_replay" };
  }
  return { skip: false, reason: null };
}
