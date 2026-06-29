/**
 * Foreground SMS banner taps use native system UI (not Notifee). iOS delivers the tap via
 * RCTVoxoNotificationsModule → Linking URL `{bundleId}://text/{reference_id}` so navigation
 * works even when NativeEventEmitter hasListeners=0.
 */
import { Linking, Platform } from "react-native";
import { normalizeNotificationPressPayload } from "./notificationPressPayload.ts";

let registered = false;
let lastHandledKey = "";
let lastHandledAt = 0;

const DEDUPE_MS = 1500;

function smsDeepLinkReferenceId(url: string): string | null {
  const match = url.match(/:\/\/text\/([^/?#]+)/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function handleSmsDeepLink(url: string | null, source: string): void {
  if (!url) {
    return;
  }
  const referenceId = smsDeepLinkReferenceId(url);
  if (!referenceId) {
    return;
  }

  const dedupeKey = `text:${referenceId}`;
  const now = Date.now();
  if (dedupeKey === lastHandledKey && now - lastHandledAt < DEDUPE_MS) {
    return;
  }
  lastHandledKey = dedupeKey;
  lastHandledAt = now;

  const payload = normalizeNotificationPressPayload({
    click_action: "TEXT-RECEIVED",
    reference_id: referenceId,
    referenceId,
    conversationId: referenceId,
    data: {
      click_action: "TEXT-RECEIVED",
      reference_id: referenceId,
      conversationId: referenceId
    }
  });

  console.log("[iosSmsNotificationDeepLink] SMS tap via Linking", {
    source,
    referenceId,
    url
  });

  void import("./NotificationManager.ts")
    .then(({ default: NotificationManager }) => {
      NotificationManager.handleExternalNotificationPress(payload, false);
    })
    .catch((e) => {
      console.warn("[iosSmsNotificationDeepLink] handleExternalNotificationPress failed:", e);
    });
}

export function registerIosSmsNotificationDeepLinkHandler(): void {
  if (registered || Platform.OS !== "ios") {
    return;
  }
  registered = true;

  void Linking.getInitialURL().then((url) =>
    handleSmsDeepLink(url, "initial")
  );
  Linking.addEventListener("url", ({ url }) =>
    handleSmsDeepLink(url, "runtime")
  );
}
