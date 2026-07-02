import "./expo-shell/setupDevLogBox.ts";
import "react-native-gesture-handler";
import "react-native-get-random-values";
import { Platform } from "react-native";

const telephonyOn =
  process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "1" ||
  process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "true";

const meetingsOn =
  process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "1" ||
  process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "true";

const nativeNotificationsOn =
  process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "1" ||
  process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "true";

if (telephonyOn || meetingsOn) {
  try {
    require("./expo-shell/setupWebRTCPolyfill.ts").runSetupWebRTCPolyfill();
  } catch (e) {
    console.warn("[expo-shell] early WebRTC polyfill skipped:", e);
  }
}

// Bare ios-project/index.js: CallKit bootstrap + native VoIP flags before first PushKit.
if (telephonyOn && Platform.OS === "ios") {
  try {
    require("./src/core/softphone/iosOutboundStartupGuard.ts").markIosJsBundleLoaded();
    require("./expo-shell/iosNativeCallModule.ts").syncIosNativeCallFlags();
    require("./expo-shell/iosCallKitEntryBootstrap.ts").runIosCallKitEntryBootstrap();
  } catch (e) {
    console.warn("[expo-shell] iOS CallKit bootstrap skipped:", e);
  }
}

if (nativeNotificationsOn && Platform.OS === "ios") {
  try {
    require("./src/core/notifications/iosNotificationPressBootstrap.ts").registerIosNotificationPressBootstrap();
  } catch (e) {
    console.warn("[expo-shell] iOS notification press bootstrap skipped:", e);
  }
}

import { enableScreens } from "react-native-screens";
import { registerRootComponent } from "expo";
import Constants from "expo-constants";
import BootProbe from "./expo-shell/BootProbe.tsx";
import DeferredEntry from "./expo-shell/DeferredEntry.tsx";

enableScreens(true);

const minimalBoot =
  process.env.EXPO_PUBLIC_MINIMAL_BOOT === "1" ||
  Constants.expoConfig?.extra?.EXPO_PUBLIC_MINIMAL_BOOT === true ||
  Constants.expoConfig?.extra?.EXPO_PUBLIC_MINIMAL_BOOT === "1";

registerRootComponent(minimalBoot ? BootProbe : DeferredEntry);
