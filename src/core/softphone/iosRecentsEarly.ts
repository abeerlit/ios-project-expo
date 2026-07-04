/**
 * Cold-start / killed-process: CallKit Recents can fire before Softphone mounts.
 * Prime CallKeep early and capture didReceiveStartCallAction until NativeIntegration.initialize drains.
 * Native RNCallKeep also stashes continueUserActivity → NSUserDefaults (survives 4–5s Metro gap).
 */
import { NativeModules, Platform } from "react-native";
import CallKeep from "react-native-callkeep";

const MAX_QUEUE = 5;

export type PendingRecentsStart = {
  callUUID: string;
  handle: string;
  /** CallKit contact name when present (CXStartCallAction.contactIdentifier). */
  name?: string;
  /** When this start was queued — used to drop stale items on flush. */
  queuedAt?: number;
};

let globalPendingRecents: PendingRecentsStart[] = [];
let earlyRecentsListener:
  | ((ev: { callUUID?: string; handle?: string; name?: string }) => void)
  | null = null;
let iosModulePrimed = false;

/** Same shape as NativeIntegration.initialize — keeps RNCallKeep settings + CXProvider valid before JS softphone exists. */
export async function primeIosCallKitModule(appName: string): Promise<void> {
  if (Platform.OS !== "ios" || iosModulePrimed) {
    return;
  }
  iosModulePrimed = true;
  try {
    await CallKeep.setup({
      ios: {
        appName,
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
          notificationTitle: appName,
          notificationIcon: "phone_account"
        },
        imageName: "iconmask",
        selfManaged: true
      }
    });
  } catch (e) {
    iosModulePrimed = false;
    throw e;
  }
}

export function installRecentsEarlyCapture(): void {
  if (Platform.OS !== "ios" || earlyRecentsListener != null) {
    return;
  }
  earlyRecentsListener = (o: {
    callUUID?: string;
    handle?: string;
    name?: string;
  }) => {
    const raw =
      typeof o.callUUID === "string" && o.callUUID.trim().length > 0
        ? o.callUUID.trim().toLowerCase()
        : "";
    const handle = String(o.handle || "").trim();
    if (!raw || !handle) {
      return;
    }
    const name = String(o.name || "").trim();
    globalPendingRecents = globalPendingRecents.filter((x) => x.callUUID !== raw);
    globalPendingRecents.push({
      callUUID: raw,
      handle,
      queuedAt: Date.now(),
      ...(name ? { name } : {})
    });
    while (globalPendingRecents.length > MAX_QUEUE) {
      globalPendingRecents.shift();
    }
    console.warn(
      `[iosRecentsEarly] queued Recents start (softphone not ready) uuid=${raw}`
    );
  };
  CallKeep.addEventListener("didReceiveStartCallAction", earlyRecentsListener);
}

/**
 * Pull queued starts from the early listener and unregister it so NativeIntegration’s listener is sole subscriber.
 */
export function drainAndRemoveRecentsEarlyCapture(): PendingRecentsStart[] {
  const out = [...globalPendingRecents];
  globalPendingRecents = [];
  if (earlyRecentsListener != null) {
    try {
      // react-native-callkeep typings omit the listener arg; runtime accepts (type, listener).
      (CallKeep as unknown as { removeEventListener: (t: string, l: unknown) => void }).removeEventListener(
        "didReceiveStartCallAction",
        earlyRecentsListener
      );
    } catch {
      // ignore
    }
    earlyRecentsListener = null;
  }
  return out;
}

type RNCallKeepNative = {
  popPendingRecentsIntent?: () => Promise<{
    handle?: string;
    callUUID?: string;
    name?: string;
  } | null>;
};

/** Clears native UserDefaults stash written in continueUserActivity (RNCallKeep.m). */
export async function pullNativePendingRecentsIntent(): Promise<PendingRecentsStart | null> {
  if (Platform.OS !== "ios") {
    return null;
  }
  const mod = NativeModules.RNCallKeep as RNCallKeepNative | undefined;
  if (!mod?.popPendingRecentsIntent) {
    return null;
  }
  try {
    const raw = await mod.popPendingRecentsIntent();
    if (raw == null || typeof raw !== "object") {
      return null;
    }
    const handle = String((raw as { handle?: string }).handle || "").trim();
    const callUUID = String((raw as { callUUID?: string }).callUUID || "")
      .trim()
      .toLowerCase();
    const name = String((raw as { name?: string }).name || "").trim();
    if (!handle || !callUUID) {
      return null;
    }
    console.warn(
      `[iosRecentsEarly] pulled native pending Recents (NSUserDefaults) uuid=${callUUID} nameLen=${name.length}`
    );
    return { callUUID, handle, queuedAt: Date.now(), ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}
