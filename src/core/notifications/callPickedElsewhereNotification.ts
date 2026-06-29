import { Platform } from "react-native";
import notifee, { AndroidImportance } from "@notifee/react-native";

const NOTIFICATION_ID_PREFIX = "call-picked-elsewhere";
const ANDROID_CHANNEL_ID = "voxo-call-events";

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

/**
 * OS banner when the same account answered the call on another endpoint (e.g. web).
 * Safe to call from foreground, background, or locked (JS running).
 */
export async function showCallPickedElsewhereNotification(
  callUuid: string
): Promise<void> {
  const id = `${NOTIFICATION_ID_PREFIX}-${callUuid}`;
  try {
    await ensureAndroidChannel();
    await notifee.displayNotification({
      id,
      title: "Call picked up elsewhere",
      body: "This call was answered on another device.",
      data: {
        click_action: "CALL_PICKED_ELSEWHERE",
        callUuid
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
      "[callPickedElsewhereNotification] displayNotification failed:",
      e
    );
  }
}
