#!/usr/bin/env node
/**
 * Optional manual sync from ios-project into vendored trees (not run on postinstall).
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getNativeIosRoot } = require("./native-ios-root");

const root = path.join(__dirname, "..");
const bareRoot = path.resolve(root, "..", "ios-project");
const bareSrc = path.join(bareRoot, "src");
const bareIos = path.join(bareRoot, "ios");
const nativeIos = getNativeIosRoot();

if (!fs.existsSync(bareSrc)) {
  console.error("[vendor-sync-bare] ios-project/src not found");
  process.exit(1);
}

execSync(`rsync -a --delete "${bareSrc}/" "${path.join(root, "src")}/"`, {
  stdio: "inherit"
});
console.log("[vendor-sync-bare] synced src/");

if (fs.existsSync(bareIos)) {
  fs.mkdirSync(nativeIos, { recursive: true });

  for (const name of [
    "BackgroundTaskManager.m",
    "BackgroundTaskManager.h",
    "RCTVoxoNotificationsModule.m",
    "RCTVoxoNotificationsModule.h",
    "VOXODtmfSidetoneModule.m",
    "VOXODtmfSidetoneModule.h",
    "incallmanager_ringback.mp3",
    "incallmanager_ringtone.mp3"
  ]) {
    const from = path.join(bareIos, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(nativeIos, name));
    }
  }

  const voxoConnectBare = path.join(bareIos, "VOXOConnect");
  const voxoConnectNative = path.join(nativeIos, "VOXOConnect");
  fs.mkdirSync(voxoConnectNative, { recursive: true });
  for (const name of [
    "VOXOConnectBackgroundActivator.m",
    "VOXOConnectBackgroundActivator.h",
    "RCTPendingCallManager.m",
    "RCTPendingCallManager.h"
  ]) {
    const from = path.join(voxoConnectBare, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(voxoConnectNative, name));
    }
  }

  execSync(
    `rsync -a --delete "${path.join(bareIos, "VoxoNotificationExtension")}/" "${path.join(nativeIos, "VoxoNotificationExtension")}/"`,
    { stdio: "inherit" }
  );
  execSync(
    `rsync -a --delete "${path.join(bareIos, "ScreenCaptureExtension")}/" "${path.join(nativeIos, "ScreenCaptureExtension")}/"`,
    { stdio: "inherit" }
  );

  const bareIcon = path.join(
    bareIos,
    "VOXOConnect",
    "Images.xcassets",
    "AppIcon.appiconset",
    "1024.png"
  );
  if (fs.existsSync(bareIcon)) {
    fs.mkdirSync(path.join(nativeIos, "branding"), { recursive: true });
    fs.copyFileSync(bareIcon, path.join(nativeIos, "branding", "app-icon-1024.png"));
  }

  console.log("[vendor-sync-bare] synced native-ios/");
}

console.log("[vendor-sync-bare] done — re-apply Expo-specific src edits if needed");
