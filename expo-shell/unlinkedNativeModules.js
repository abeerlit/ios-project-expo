const path = require("path");

function envOn(name) {
  const v = process.env[name];
  return v === "1" || v === "true";
}

/** Linked in the Expo dev client when chat is enabled; do not Metro-stub. */
const CHAT_LINKED_NATIVE_MODULES = new Set([
  "react-native-image-picker",
  "react-native-document-picker",
  "react-native-image-crop-picker",
  "react-native-blob-util",
  "react-native-fs",
  "react-native-video",
  "react-native-image-modal",
  "@react-native-camera-roll/camera-roll"
]);

/** Metro/Babel stubs for RN packages not linked in the Expo dev client binary. */
const UNLINKED_NATIVE_MODULES = {
  "react-native-document-picker": "document-picker.stub.ts",
  "react-native-image-crop-picker": "image-crop-picker.stub.ts",
  "react-native-image-picker": "image-picker.stub.ts",
  "react-native-blob-util": "blob-util.stub.ts",
  "react-native-fs": "fs.stub.ts",
  "react-native-video": "video.stub.tsx",
  "react-native-image-modal": "image-modal.stub.tsx",
  "@react-native-camera-roll/camera-roll": "camera-roll.stub.ts",
  "react-native-push-notification": "push-notification.stub.ts"
};

function getUnlinkedStubPath(moduleName) {
  const file = UNLINKED_NATIVE_MODULES[moduleName];
  if (!file) return null;
  return path.join(__dirname, "stubs", file);
}

function shouldStubUnlinkedModule(moduleName) {
  if (envOn("EXPO_PUBLIC_CHAT_NATIVE") && CHAT_LINKED_NATIVE_MODULES.has(moduleName)) {
    return false;
  }
  return true;
}

function applyUnlinkedNativeAliases(aliases) {
  for (const moduleName of Object.keys(UNLINKED_NATIVE_MODULES)) {
    if (!shouldStubUnlinkedModule(moduleName)) continue;
    const stubPath = getUnlinkedStubPath(moduleName);
    if (stubPath) aliases[moduleName] = stubPath;
  }
}

function resolveUnlinkedNativeStub(moduleName) {
  if (!shouldStubUnlinkedModule(moduleName)) return null;
  return getUnlinkedStubPath(moduleName);
}

module.exports = {
  UNLINKED_NATIVE_MODULES,
  CHAT_LINKED_NATIVE_MODULES,
  shouldStubUnlinkedModule,
  applyUnlinkedNativeAliases,
  resolveUnlinkedNativeStub
};
