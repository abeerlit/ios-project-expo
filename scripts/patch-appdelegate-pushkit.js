#!/usr/bin/env node
/**
 * Ensures AppDelegate implements PKPushRegistryDelegate (fixes VoIP crash on launch).
 */
const fs = require("fs");
const path = require("path");
const {
  APP_DELEGATE_H,
  PUSHKIT_MM,
  PUSHKIT_LAUNCH,
  CONTINUE_USER_ACTIVITY_MM,
  LAUNCH_PENDING_NOTIFICATION_MM,
  DID_RECEIVE_REMOTE_NOTIFICATION_MM
} = require("../plugins/voxoPushKitAppDelegate.js");

const IOS = path.join(__dirname, "..", "ios", "VOXOConnect");
const H = path.join(IOS, "AppDelegate.h");
const MM = path.join(IOS, "AppDelegate.mm");

/** Remove a second copy of PushKit delegate methods (patch + ios:telephony can both add them). */
function dedupePushKitMethods(mm) {
  const key =
    "- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:";
  const first = mm.indexOf(key);
  const second = mm.indexOf(key, first + 1);
  if (second < 0) return mm;
  const pragma = "#pragma mark - PushKit (VoIP)";
  const secondPragma = mm.indexOf(pragma, first + pragma.length);
  const endMarker = mm.lastIndexOf("\n@end");
  if (secondPragma < 0 || endMarker < 0) return mm;
  return `${mm.slice(0, secondPragma).trimEnd()}\n\n${mm.slice(endMarker)}`;
}

/** Replace Expo default continueUserActivity (Linking only) with RNCallKeep + Linking (Recents redial). */
function patchContinueUserActivity(mm) {
  if (mm.includes("[RNCallKeep application:application\n                         continueUserActivity:userActivity")) {
    return mm;
  }
  if (mm.includes("[RNCallKeep application:application continueUserActivity:userActivity")) {
    return mm;
  }

  const methodStart = mm.search(
    /- \(BOOL\)application:\(UIApplication \*\)application\s*\n?continueUserActivity:/
  );
  if (methodStart < 0) {
    const openUrlIdx = mm.indexOf("// Linking API");
    const insertAt = openUrlIdx >= 0 ? openUrlIdx : mm.lastIndexOf("\n@end");
    if (insertAt < 0) return mm;
    return `${mm.slice(0, insertAt).trimEnd()}\n${CONTINUE_USER_ACTIVITY_MM}\n${mm.slice(insertAt)}`;
  }

  let depth = 0;
  let i = methodStart;
  let started = false;
  for (; i < mm.length; i++) {
    const ch = mm[i];
    if (ch === "{") {
      depth++;
      started = true;
    } else if (ch === "}") {
      depth--;
      if (started && depth === 0) {
        i++;
        break;
      }
    }
  }

  return `${mm.slice(0, methodStart).trimEnd()}\n${CONTINUE_USER_ACTIVITY_MM.trim()}\n${mm.slice(i).trimStart()}`;
}

/** Stash launchOptions remote notification for killed-state tap → chat navigation. */
function patchLaunchPendingNotification(mm) {
  if (mm.includes("[RCTVoxoNotificationsModule setPendingPayload:launchNotification]")) {
    return mm;
  }
  if (mm.includes("Cold start from remote notification")) {
    return mm;
  }

  const anchor = "self.initialProps = @{};";
  if (mm.includes(anchor)) {
    return mm.replace(
      anchor,
      `${anchor}\n${LAUNCH_PENDING_NOTIFICATION_MM.trim()}`
    );
  }

  const superLaunch =
    "BOOL result = [super application:application didFinishLaunchingWithOptions:launchOptions];";
  if (mm.includes(superLaunch)) {
    return mm.replace(
      superLaunch,
      `${LAUNCH_PENDING_NOTIFICATION_MM.trim()}\n\n  ${superLaunch}`
    );
  }

  return mm;
}

/** Replace Expo stub didReceiveRemoteNotification (forwards to super) with SMS silent-push handler. */
function patchDidReceiveRemoteNotification(mm) {
  if (mm.includes("[notifModule emitConversationUpdatedForReferenceId:referenceId]")) {
    return mm;
  }
  if (mm.includes("emitConversationUpdatedForReferenceId:referenceId")) {
    return mm;
  }

  const methodRe =
    /- \(void\)application:\(UIApplication \*\)application didReceiveRemoteNotification:\(NSDictionary \*\)userInfo fetchCompletionHandler:\(void \(\^\)\(UIBackgroundFetchResult\)\)completionHandler\s*\{[\s\S]*?\n\}/;
  if (methodRe.test(mm)) {
    return mm.replace(methodRe, DID_RECEIVE_REMOTE_NOTIFICATION_MM.trim());
  }

  const pushKitPragma = mm.indexOf("#pragma mark - PushKit (VoIP)");
  const insertAt = pushKitPragma >= 0 ? pushKitPragma : mm.lastIndexOf("\n@end");
  if (insertAt < 0) return mm;
  return `${mm.slice(0, insertAt).trimEnd()}\n${DID_RECEIVE_REMOTE_NOTIFICATION_MM}\n${mm.slice(insertAt)}`;
}

/** Replace PushKit block when missing killed-state stale CallKit end (VoxoEndStaleIncomingCall). */
function upgradePushKitBlock(mm) {
  if (mm.includes("VoxoEndStaleIncomingCall")) {
    return mm;
  }
  const re =
    /#pragma mark - PushKit \(VoIP\)[\s\S]*?(?=\n#pragma mark|\n\/\*\*|\n- \(void\)application|\n@end)/;
  if (re.test(mm)) {
    return mm.replace(re, `${PUSHKIT_MM.trim()}\n\n`);
  }
  if (!mm.includes("pushRegistry:didUpdatePushCredentials")) {
    return mm.replace(/\n@end\s*$/, `${PUSHKIT_MM.trim()}\n\n@end`);
  }
  return mm;
}

function ensureCallKitImport(mm) {
  if (mm.includes("#import <CallKit/CallKit.h>")) {
    return mm;
  }
  if (mm.includes("#import <PushKit/PushKit.h>")) {
    return mm.replace(
      "#import <PushKit/PushKit.h>",
      "#import <PushKit/PushKit.h>\n#import <CallKit/CallKit.h>"
    );
  }
  return `#import <CallKit/CallKit.h>\n${mm}`;
}

function patch() {
  if (!fs.existsSync(MM)) {
    console.warn("[patch-appdelegate-pushkit] no AppDelegate.mm — run expo prebuild first");
    return;
  }

  fs.writeFileSync(H, APP_DELEGATE_H);

  let mm = fs.readFileSync(MM, "utf8");
  mm = dedupePushKitMethods(mm);
  mm = upgradePushKitBlock(mm);
  mm = ensureCallKitImport(mm);

  if (!mm.includes("VoxoEndStaleIncomingCall") && !mm.includes("pushRegistry:didUpdatePushCredentials")) {
    mm = mm.replace(/\n@end\s*$/, `${PUSHKIT_MM}\n@end`);
  }
  if (!mm.includes("self.voipRegistry") && mm.includes('self.moduleName = @"main";')) {
    mm = mm.replace(
      'self.moduleName = @"main";',
      `${PUSHKIT_LAUNCH}\n  self.moduleName = @"main";`
    );
  }
  if (!mm.includes("backgroundActivator")) {
    mm = mm.replace(
      "return [super application:application didFinishLaunchingWithOptions:launchOptions];",
      `BOOL result = [super application:application didFinishLaunchingWithOptions:launchOptions];
  if (self.bridge) {
    self.backgroundActivator = [[VOXOConnectBackgroundActivator alloc] initWithBridge:self.bridge];
  }
  return result;`
    );
  }
  mm = patchContinueUserActivity(mm);
  mm = patchLaunchPendingNotification(mm);
  mm = patchDidReceiveRemoteNotification(mm);
  if (!mm.includes("#import <React/RCTBridge.h>")) {
    mm = mm.replace(
      '#import <React/RCTLinkingManager.h>',
      '#import <React/RCTBridge.h>\n#import <React/RCTLinkingManager.h>'
    );
  }
  mm = dedupePushKitMethods(mm);
  fs.writeFileSync(MM, mm);
  console.log("[patch-appdelegate-pushkit] AppDelegate.h/.mm updated");
}

module.exports = {
  dedupePushKitMethods,
  patchContinueUserActivity,
  patchLaunchPendingNotification,
  patchDidReceiveRemoteNotification,
  patch
};

if (require.main === module) {
  patch();
}
