import { NativeModules, Platform } from "react-native";
import {
  SendbirdPushPrefsPayload,
  toSendbirdPushPrefsPayload,
  SendbirdNotificationUserPrefs
} from "features/chat/utils/sendbirdNotificationPrefs.ts";

type VoxoNotificationsNative = {
  syncChatNotificationPrefs?: (json: string) => void;
};

function getVoxoNotificationsModule(): VoxoNotificationsNative | undefined {
  return NativeModules.VoxoNotificationsModule as
    | VoxoNotificationsNative
    | undefined;
}

export function syncChatNotificationPrefsToNative(
  user: SendbirdNotificationUserPrefs | null | undefined
): void {
  const payload = toSendbirdPushPrefsPayload(user);
  if (!payload) {
    return;
  }
  syncChatNotificationPrefsPayload(payload);
}

export function syncChatNotificationPrefsPayload(
  payload: SendbirdPushPrefsPayload
): void {
  if (Platform.OS !== "ios") {
    return;
  }
  const mod = getVoxoNotificationsModule();
  if (!mod?.syncChatNotificationPrefs) {
    return;
  }
  try {
    mod.syncChatNotificationPrefs(JSON.stringify(payload));
  } catch (error) {
    console.warn(
      "[iosChatNotificationPrefsCache] syncChatNotificationPrefs failed",
      error
    );
  }
}
