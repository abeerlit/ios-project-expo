/**
 * Runs at JS bundle load (index.js) before React/App mount — improves killed-state + Metro timing vs useEffect-only.
 */
import { Platform } from "react-native";
import {
  installRecentsEarlyCapture,
  primeIosCallKitModule
} from "./iosRecentsEarly.ts";

import { getAppDisplayName } from "shared/branding/appBrand.ts";

export function runIosCallKitEntryBootstrap(): void {
  if (Platform.OS !== "ios") {
    return;
  }
  void (async () => {
    try {
      await primeIosCallKitModule(getAppDisplayName());
      installRecentsEarlyCapture();
    } catch (e) {
      console.warn("[iosRecentsEntryBootstrap] failed:", e);
    }
  })();
}
