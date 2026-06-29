/**
 * Phase-0 shell: keep telephony/chat/meeting native modules out of the iOS build
 * until EXPO_PUBLIC_* flags are enabled and plugins are wired.
 */
const path = require("path");
const fs = require("fs");

/** Load .env without stdout noise (dotenv v17 prints and breaks `pod install` JSON). */
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const telephony =
  process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "1" ||
  process.env.EXPO_PUBLIC_NATIVE_TELEPHONY === "true";

const notifications =
  process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "1" ||
  process.env.EXPO_PUBLIC_NATIVE_NOTIFICATIONS === "true" ||
  telephony;

const meetings =
  process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "1" ||
  process.env.EXPO_PUBLIC_MEETINGS_NATIVE === "true" ||
  telephony;

const chat =
  process.env.EXPO_PUBLIC_CHAT_NATIVE === "1" ||
  process.env.EXPO_PUBLIC_CHAT_NATIVE === "true";

function off() {
  return { platforms: { ios: null, android: null } };
}

const deps = {};

if (!telephony) {
  Object.assign(deps, {
    "react-native-callkeep": off(),
    "react-native-voip-push-notification": off(),
    "react-native-incall-manager": off(),
    "react-native-background-timer": off()
  });
}

if (!notifications) {
  Object.assign(deps, {
    "@react-native-firebase/messaging": off(),
    "@notifee/react-native": off(),
    "@react-native-community/push-notification-ios": off()
  });
}

if (!meetings) {
  Object.assign(deps, {
    "@daily-co/react-native-daily-js": off(),
    "@daily-co/react-native-webrtc": off()
  });
}

if (!chat) {
  Object.assign(deps, {
    "@giphy/react-native-sdk": off(),
    "@10play/tentap-editor": off()
  });
}

// Sentry native init has caused startup issues on Expo dev builds — use JS-only for now.
deps["@sentry/react-native"] = off();

module.exports = { dependencies: deps };
