const fs = require("fs");
const path = require("path");
const { withDangerousMod, withAppDelegate } = require("@expo/config-plugins");

const NATIVE_FILE_SOURCES = [
  ["RCTVoxoNotificationsModule.m", "RCTVoxoNotificationsModule.h"],
  ["VOXODtmfSidetoneModule.m", "VOXODtmfSidetoneModule.h"],
  ["BackgroundTaskManager.m", "BackgroundTaskManager.h"],
  ["VOXOConnect/VOXOConnectBackgroundActivator.m", "VOXOConnect/VOXOConnectBackgroundActivator.h"],
  ["VOXOConnect/RCTPendingCallManager.m", "VOXOConnect/RCTPendingCallManager.h"]
].flat();

const IN_CALL_AUDIO = ["incallmanager_ringback.mp3", "incallmanager_ringtone.mp3"];
const { APP_DELEGATE_H, PUSHKIT_MM, PUSHKIT_LAUNCH } = require("./voxoPushKitAppDelegate.js");

function withVoxoCallKitVoip(config) {
  const nativeIos = path.resolve(__dirname, "../native-ios");

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const destDir = path.join(
        mod.modRequest.platformProjectRoot,
        "VOXOConnect",
        "VoxoNative"
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const rel of NATIVE_FILE_SOURCES) {
        const src = path.join(nativeIos, rel);
        const base = path.basename(rel);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(destDir, base));
        }
      }
      const appDir = path.join(mod.modRequest.platformProjectRoot, "VOXOConnect");
      fs.mkdirSync(appDir, { recursive: true });
      for (const name of IN_CALL_AUDIO) {
        const src = path.join(nativeIos, name);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(appDir, name));
        }
      }
      const { runPostPrebuildFixes } = require("../scripts/ios-native-postbuild");
      runPostPrebuildFixes({ telephony: true });
      return mod;
    }
  ]);

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const hPath = path.join(mod.modRequest.platformProjectRoot, "VOXOConnect", "AppDelegate.h");
      fs.writeFileSync(hPath, APP_DELEGATE_H);
      return mod;
    }
  ]);

  return withAppDelegate(config, (mod) => {
    let contents = mod.modResults.contents;
    const imports = [
      "#import <PushKit/PushKit.h>",
      "#import <CallKit/CallKit.h>",
      '#import "RNVoipPushNotificationManager.h"',
      '#import "RCTVoxoNotificationsModule.h"',
      '#import "RNCallKeep.h"',
      '#import "VOXOConnectBackgroundActivator.h"'
    ];
    for (const imp of imports) {
      if (!contents.includes(imp)) {
        contents = `${imp}\n${contents}`;
      }
    }
    if (!contents.includes("self.voipRegistry") && contents.includes('self.moduleName = @"main";')) {
      contents = contents.replace(
        'self.moduleName = @"main";',
        `${PUSHKIT_LAUNCH}\n  self.moduleName = @"main";`
      );
    }
    const pushKitKey =
      "- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:";
    const firstIdx = contents.indexOf(pushKitKey);
    const hasPushKit = firstIdx >= 0;
    if (!hasPushKit) {
      contents = contents.replace(/\n@end\s*$/, `${PUSHKIT_MM}\n@end`);
    } else if (contents.indexOf(pushKitKey, firstIdx + 1) >= 0) {
      const pragma = "#pragma mark - PushKit (VoIP)";
      const secondPragma = contents.indexOf(pragma, firstIdx + pragma.length);
      const endMarker = contents.lastIndexOf("\n@end");
      if (secondPragma >= 0 && endMarker >= 0) {
        contents = `${contents.slice(0, secondPragma).trimEnd()}\n\n${contents.slice(endMarker)}`;
      }
    }
    if (!contents.includes("backgroundActivator")) {
      contents = contents.replace(
        "return [super application:application didFinishLaunchingWithOptions:launchOptions];",
        `BOOL result = [super application:application didFinishLaunchingWithOptions:launchOptions];
  if (self.bridge) {
    self.backgroundActivator = [[VOXOConnectBackgroundActivator alloc] initWithBridge:self.bridge];
  }
  return result;`
      );
    }
    mod.modResults.contents = contents;
    mod.modResults.language = "objc";
    return mod;
  });
}

module.exports = { withVoxoCallKitVoip };
