/**
 * Idempotent native fixes after expo prebuild (and before/after pod install).
 */
const path = require("path");
const { isTruthy } = require("./load-env");
const { copyAll } = require("./copy-voxo-native-ios");
const { ensurePbxprojVoxoNative } = require("./ensure-voxo-native-pbx");
const { patch: patchAppDelegatePushKit } = require("./patch-appdelegate-pushkit");
const { ensurePbxprojInCallAudio } = require("./ensure-incall-audio-pbx");

const IOS_DIR = path.join(__dirname, "..", "ios");
const PBX = path.join(IOS_DIR, "VOXOConnect.xcodeproj", "project.pbxproj");

function runPostPrebuildFixes(options = {}) {
  const telephony =
    options.telephony ??
    (isTruthy("EXPO_PUBLIC_NATIVE_TELEPHONY") || isTruthy("EXPO_PUBLIC_NATIVE_NOTIFICATIONS"));

  if (!require("fs").existsSync(PBX)) {
    console.warn("[ios-native-postbuild] skip — no ios/VOXOConnect.xcodeproj (run prebuild first)");
    return false;
  }

  if (telephony) {
    copyAll();
    ensurePbxprojInCallAudio();
    ensurePbxprojVoxoNative();
    patchAppDelegatePushKit();
    const { copyExtensionSources, patchPbxproj } = require("./fix-voxo-notification-extension-ios");
    copyExtensionSources();
    patchPbxproj();
  }

  const { fixPodfile } = require("./fix-podfile-structure");
  fixPodfile();

  const { repairEmbeddedExtensionsPbxproj } = require("./repair-ios-embedded-extensions");
  repairEmbeddedExtensionsPbxproj();

  const { patchInfoPlist, patchMainAppPbxproj } = require("./fix-ios-version-plist");
  patchInfoPlist();
  patchMainAppPbxproj();

  return true;
}

module.exports = { runPostPrebuildFixes };
