/**
 * App entry bootstrap (index.js): Notifee background press + native RCTVoxoNotificationsModule
 * listeners. Retries until the native module is on the bridge (bare mounts listeners from Home after React).
 */
import { NativeModules, Platform } from "react-native";
import notifee, { EventType } from "@notifee/react-native";
import { normalizeNotificationPressPayload } from "./notificationPressPayload.ts";
import { registerIosSmsNotificationDeepLinkHandler } from "./iosSmsNotificationDeepLink.ts";

let registered = false;

function hasVoxoNotificationsNativeModule(): boolean {
  const modules = NativeModules as Record<string, unknown>;
  return !!(modules.VoxoNotificationsModule ?? modules.RCTVoxoNotificationsModule);
}

function ensureNativeNotificationListenersEarly(attempt = 0): void {
  const maxAttempts = 15;
  const delayMs = 200;

  if (!hasVoxoNotificationsNativeModule()) {
    if (attempt < maxAttempts) {
      setTimeout(
        () => ensureNativeNotificationListenersEarly(attempt + 1),
        delayMs
      );
      return;
    }
    console.warn(
      "[iosNotificationPressBootstrap] VoxoNotificationsModule unavailable after retries — listeners will bind from NavigationShell / NotificationsBootstrap"
    );
    return;
  }

  void import("./NotificationManager.ts")
    .then(({ default: NotificationManager }) => {
      NotificationManager.ensureIosNativeListeners();
      console.log(
        "[iosNotificationPressBootstrap] iOS native notification listeners ensured at entry",
        { attempt }
      );
      void import("./VoxoNotificationManager.ts").then(
        ({ default: VoxoNotificationManager }) => {
          void VoxoNotificationManager.logListenerDiagnostics(
            "iosNotificationPressBootstrap"
          );
        }
      );
    })
    .catch((e) => {
      console.warn(
        "[iosNotificationPressBootstrap] ensureIosNativeListeners failed:",
        e
      );
    });
}

export function registerIosNotificationPressBootstrap(): void {
  if (registered || Platform.OS !== "ios") {
    return;
  }
  registered = true;

  registerIosSmsNotificationDeepLinkHandler();
  ensureNativeNotificationListenersEarly();

  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type !== EventType.PRESS || !detail.notification) {
      return;
    }

    const n = detail.notification;
    const notificationData = n.data || {};
    const payload = normalizeNotificationPressPayload({
      ...notificationData,
      data: notificationData,
      title: n.title,
      body: n.body
    });

    console.log("[iosNotificationPressBootstrap] Notifee background PRESS", {
      notificationId: n.id,
      channelUrl: payload.channelUrl,
      click_action: payload.click_action
    });

    const { default: NotificationManager } = await import(
      "./NotificationManager.ts"
    );
    NotificationManager.handleExternalNotificationPress(payload, true);
  });
}
