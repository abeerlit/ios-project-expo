#!/usr/bin/env node
/**
 * Copy VOXO custom native sources + in-call audio from native-ios/ into ios/VOXOConnect.
 */
const fs = require("fs");
const path = require("path");
const { getNativeIosRoot } = require("./native-ios-root");

const ROOT = path.resolve(__dirname, "..");
const NATIVE_IOS = getNativeIosRoot();
const VOXO_NATIVE = path.join(ROOT, "ios", "VOXOConnect", "VoxoNative");
const VOXO_APP = path.join(ROOT, "ios", "VOXOConnect");

const IN_CALL_AUDIO = ["incallmanager_ringback.mp3", "incallmanager_ringtone.mp3"];

const NATIVE_SOURCES = [
  { src: "RCTVoxoNotificationsModule.m", srcDirs: [NATIVE_IOS] },
  { src: "RCTVoxoNotificationsModule.h", srcDirs: [NATIVE_IOS] },
  { src: "VOXODtmfSidetoneModule.m", srcDirs: [NATIVE_IOS] },
  { src: "VOXODtmfSidetoneModule.h", srcDirs: [NATIVE_IOS] },
  { src: "BackgroundTaskManager.m", srcDirs: [NATIVE_IOS] },
  { src: "BackgroundTaskManager.h", srcDirs: [NATIVE_IOS] },
  {
    src: "VOXOConnectBackgroundActivator.m",
    srcDirs: [path.join(NATIVE_IOS, "VOXOConnect")]
  },
  {
    src: "VOXOConnectBackgroundActivator.h",
    srcDirs: [path.join(NATIVE_IOS, "VOXOConnect")]
  },
  { src: "RCTPendingCallManager.m", srcDirs: [path.join(NATIVE_IOS, "VOXOConnect")] },
  { src: "RCTPendingCallManager.h", srcDirs: [path.join(NATIVE_IOS, "VOXOConnect")] }
];

function copyNativeFiles() {
  fs.mkdirSync(VOXO_NATIVE, { recursive: true });
  for (const { src, srcDirs } of NATIVE_SOURCES) {
    let from = null;
    for (const dir of srcDirs) {
      const candidate = path.join(dir, src);
      if (fs.existsSync(candidate)) {
        from = candidate;
        break;
      }
    }
    if (!from) {
      console.warn(`[copy-voxo-native] missing source: ${src}`);
      continue;
    }
    fs.copyFileSync(from, path.join(VOXO_NATIVE, path.basename(src)));
  }
}

function copyInCallAudioAssets() {
  fs.mkdirSync(VOXO_APP, { recursive: true });
  for (const name of IN_CALL_AUDIO) {
    const from = path.join(NATIVE_IOS, name);
    const to = path.join(VOXO_APP, name);
    if (!fs.existsSync(from)) {
      console.warn(`[copy-voxo-native] missing audio: ${from}`);
      continue;
    }
    fs.copyFileSync(from, to);
  }
}

function copyAll() {
  copyNativeFiles();
  copyInCallAudioAssets();
  console.log("[copy-voxo-native] VoxoNative + in-call audio synced from native-ios/");
}

module.exports = { copyAll, copyNativeFiles, copyInCallAudioAssets, NATIVE_SOURCES, IN_CALL_AUDIO };

if (require.main === module) {
  copyAll();
}
