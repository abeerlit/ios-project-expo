/** PushKit delegate stubs for EXAppDelegateWrapper — RNVoipPush sets registry.delegate to AppDelegate. */

const APP_DELEGATE_H = `#import <RCTAppDelegate.h>
#import <UIKit/UIKit.h>
#import <Expo/Expo.h>
#import <PushKit/PushKit.h>
#import "RNAppAuthAuthorizationFlowManager.h"

@class VOXOConnectBackgroundActivator;

@interface AppDelegate : EXAppDelegateWrapper <
    PKPushRegistryDelegate,
    NSNetServiceBrowserDelegate,
    RNAppAuthAuthorizationFlowManager>

@property(nonatomic, weak) id<RNAppAuthAuthorizationFlowManagerDelegate> authorizationFlowManagerDelegate;
@property(nonatomic, strong) PKPushRegistry *voipRegistry;
@property(nonatomic, strong) VOXOConnectBackgroundActivator *backgroundActivator;
@property(nonatomic, strong) NSNetServiceBrowser *localNetworkPermissionBrowser;

@end
`;

const PUSHKIT_MM = `
#pragma mark - PushKit (VoIP)

static const long long kVoxoVoipPushMaxAgeMs = 20000;

static void VoxoEndStaleIncomingCall(NSString *uuidString, int attempt, void (^completion)(void)) {
  NSLog(@"📞 [VoIP] VoxoEndStaleIncomingCall uuid=%@ attempt=%d", uuidString, attempt);

  [RNCallKeep endCallWithUUID:uuidString reason:3];

  NSUUID *callUUID = [[NSUUID alloc] initWithUUIDString:uuidString];
  if (callUUID == nil) {
    NSLog(@"📞 [VoIP] VoxoEndStaleIncomingCall invalid uuid=%@", uuidString);
    if (completion) {
      completion();
    }
    return;
  }

  CXCallController *callController = [[CXCallController alloc] init];
  CXEndCallAction *endAction = [[CXEndCallAction alloc] initWithCallUUID:callUUID];
  CXTransaction *transaction = [[CXTransaction alloc] initWithAction:endAction];
  [callController requestTransaction:transaction completion:^(NSError * _Nullable error) {
    if (error) {
      NSLog(@"📞 [VoIP] CXEndCallAction failed uuid=%@ attempt=%d err=%@",
            uuidString, attempt, error.localizedDescription);
      if (attempt < 4) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_MSEC)),
                       dispatch_get_main_queue(), ^{
          VoxoEndStaleIncomingCall(uuidString, attempt + 1, completion);
        });
        return;
      }
    } else {
      NSLog(@"📞 [VoIP] CXEndCallAction succeeded uuid=%@ attempt=%d", uuidString, attempt);
    }
    if (completion) {
      completion();
    }
  }];
}

- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type {
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type {
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion {
  NSString *uuid = payload.dictionaryPayload[@"callUuid"];
  NSString *callerName = payload.dictionaryPayload[@"callerName"];
  if (![callerName isKindOfClass:[NSString class]] || callerName.length == 0) {
    callerName = @"Unknown";
  }
  NSString *handle = payload.dictionaryPayload[@"callerNumber"];
  NSString *callerIp = payload.dictionaryPayload[@"ip"] ?: payload.dictionaryPayload[@"callerIp"];

  id sentAtRaw = payload.dictionaryPayload[@"sentAt"];
  long long sentAtMs = 0;
  if ([sentAtRaw isKindOfClass:[NSNumber class]]) {
    sentAtMs = [(NSNumber *)sentAtRaw longLongValue];
  } else if ([sentAtRaw isKindOfClass:[NSString class]]) {
    sentAtMs = [(NSString *)sentAtRaw longLongValue];
  }
  long long nowMs = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
  long long ageMs = (sentAtMs > 0) ? (nowMs - sentAtMs) : 0;
  BOOL isStale = (sentAtMs > 0) && (ageMs > kVoxoVoipPushMaxAgeMs);

  UIApplicationState appState = [[UIApplication sharedApplication] applicationState];
  NSString *appStateStr = (appState == UIApplicationStateActive) ? @"ACTIVE" :
      (appState == UIApplicationStateBackground) ? @"BACKGROUND" : @"INACTIVE";

  if (uuid && callerIp) {
    NSMutableDictionary *pendingCalls = [[[NSUserDefaults standardUserDefaults] objectForKey:@"pendingVoipCalls"] mutableCopy];
    if (!pendingCalls) pendingCalls = [NSMutableDictionary dictionary];
    pendingCalls[uuid] = @{
      @"callUuid": uuid,
      @"callerName": payload.dictionaryPayload[@"callerName"] ?: @"Unknown",
      @"callerNumber": handle ?: @"Unknown",
      @"callerIp": callerIp,
      @"sentAt": sentAtMs > 0 ? @(sentAtMs) : @(nowMs),
      @"receivedAt": @(nowMs),
      @"timestamp": @([[NSDate date] timeIntervalSince1970]),
      @"staleDeclined": isStale ? @YES : @NO
    };
    [[NSUserDefaults standardUserDefaults] setObject:pendingCalls forKey:@"pendingVoipCalls"];
    [[NSUserDefaults standardUserDefaults] synchronize];
  }

  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];

  if (isStale && uuid) {
    NSLog(@"📞 [VoIP] STALE push appState=%@ ageMs=%lld uuid=%@ sentAt=%lld", appStateStr, ageMs, uuid, sentAtMs);
    [RNCallKeep reportNewIncomingCall:uuid
                               handle:handle
                           handleType:@"number"
                             hasVideo:NO
                  localizedCallerName:callerName
                      supportsHolding:NO
                         supportsDTMF:YES
                     supportsGrouping:NO
                   supportsUngrouping:NO
                          fromPushKit:YES
                              payload:payload.dictionaryPayload
                withCompletionHandler:^{
      NSLog(@"📞 [VoIP] STALE push — reportNewIncomingCall done, ending CallKit uuid=%@", uuid);
      VoxoEndStaleIncomingCall(uuid, 0, ^{
        if (completion) {
          completion();
        }
      });
    }];
    return;
  }

  BOOL allowBgCallUi = [RCTVoxoNotificationsModule enableMobileCallNotifications];
  if (!allowBgCallUi && appState != UIApplicationStateActive) {
    if (completion) completion();
    return;
  }

  BOOL useVoxoMobileApproach = [RCTVoxoNotificationsModule useVoxoMobileCallApproach];
  if (appState == UIApplicationStateActive && !useVoxoMobileApproach) {
    if (completion) completion();
    return;
  }

  [RNCallKeep reportNewIncomingCall:uuid
                             handle:handle
                         handleType:@"number"
                           hasVideo:NO
                localizedCallerName:callerName
                    supportsHolding:NO
                       supportsDTMF:YES
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:payload.dictionaryPayload
              withCompletionHandler:completion];
}
`;

const PUSHKIT_LAUNCH = `
  dispatch_queue_t mainQueue = dispatch_get_main_queue();
  self.voipRegistry = [[PKPushRegistry alloc] initWithQueue:mainQueue];
  self.voipRegistry.delegate = self;
  self.voipRegistry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
`;

/** Silent SMS push (content-available) → refresh badge/unread via RCTVoxoNotificationsModule (parity with bare ios-project). */
const DID_RECEIVE_REMOTE_NOTIFICATION_MM = `
// Handle silent/background push (content-available: 1) so JS can refresh badge/unread for SMS
- (void)application:(UIApplication *)application didReceiveRemoteNotification:(NSDictionary *)userInfo fetchCompletionHandler:(void (^)(UIBackgroundFetchResult))completionHandler {
  NSDictionary *payload = userInfo[@"payload"];
  if (![payload isKindOfClass:[NSDictionary class]]) {
    payload = userInfo;
  }

  NSString *bgStateStr = (application.applicationState == UIApplicationStateActive) ? @"ACTIVE" :
                         (application.applicationState == UIApplicationStateBackground) ? @"BACKGROUND" : @"INACTIVE";
  NSLog(@"📩 [AppDelegate] didReceiveRemoteNotification state=%@ userInfo=%@", bgStateStr, userInfo);
  if (payload != userInfo) {
    NSLog(@"📩 [AppDelegate] didReceiveRemoteNotification nested payload=%@", payload);
  }

  NSString *clickAction = payload[@"click_action"] ?: userInfo[@"click_action"];
  if (![clickAction isEqualToString:@"TEXT-RECEIVED"]) {
    if (completionHandler) completionHandler(UIBackgroundFetchResultNoData);
    return;
  }

  id refIdVal = payload[@"reference_id"] ?: userInfo[@"reference_id"];
  NSString *referenceId = nil;
  if ([refIdVal isKindOfClass:[NSString class]]) {
    referenceId = (NSString *)refIdVal;
  } else if ([refIdVal isKindOfClass:[NSNumber class]]) {
    referenceId = [(NSNumber *)refIdVal stringValue];
  }
  if (!referenceId.length) {
    if (completionHandler) completionHandler(UIBackgroundFetchResultNoData);
    return;
  }

  __weak __typeof__(self) weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    __strong __typeof__(weakSelf) strongSelf = weakSelf;
    RCTBridge *bridge = strongSelf ? strongSelf.bridge : nil;
    if (!bridge) {
      if (completionHandler) completionHandler(UIBackgroundFetchResultFailed);
      return;
    }
    RCTVoxoNotificationsModule *notifModule = [RCTVoxoNotificationsModule listenerModuleIfReady];
    if (!notifModule) {
      notifModule = [bridge moduleForClass:[RCTVoxoNotificationsModule class]];
    }
    if (notifModule) {
      [notifModule emitConversationUpdatedForReferenceId:referenceId];
      NSLog(@"📩 [AppDelegate] silent TEXT-RECEIVED → emitConversationUpdatedForReferenceId=%@ module=%p",
            referenceId, notifModule);
    }
    if (completionHandler) completionHandler(UIBackgroundFetchResultNewData);
  });
}
`;

/** Cold start from notification tap (killed state) — stash before JS mounts (parity with bare ios-project). */
const LAUNCH_PENDING_NOTIFICATION_MM = `
  NSDictionary *launchNotification = [launchOptions objectForKey:UIApplicationLaunchOptionsRemoteNotificationKey];
  if (launchNotification) {
    NSLog(@"[VOXO][AppDelegate] Cold start from remote notification — setPendingPayload");
    [RCTVoxoNotificationsModule setPendingPayload:launchNotification];
  }
`;

/** Phone → Recents / Siri redial: forward NSUserActivity to RNCallKeep (parity with bare ios-project). */
const CONTINUE_USER_ACTIVITY_MM = `
// CallKit Recents + Universal Links
- (BOOL)application:(UIApplication *)application
continueUserActivity:(NSUserActivity *)userActivity
 restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler
{
  NSString *appStateStr = (application.applicationState == UIApplicationStateActive) ? @"ACTIVE" :
      (application.applicationState == UIApplicationStateBackground) ? @"BACKGROUND" : @"INACTIVE";
  NSLog(@"[VOXO_CK][AppDelegate] continueUserActivity ENTRY type=%@ title=%@ appState=%@ webURL=%@",
        userActivity.activityType ?: @"(nil)",
        userActivity.title ?: @"(nil)",
        appStateStr,
        userActivity.webpageURL.absoluteString ?: @"(nil)");

  BOOL callKeepOk = [RNCallKeep application:application
                         continueUserActivity:userActivity
                           restorationHandler:restorationHandler];
  NSLog(@"[VOXO_CK][AppDelegate] RNCallKeep continueUserActivity → %@", callKeepOk ? @"YES" : @"NO");
  if (!callKeepOk) {
    NSLog(@"[VOXO_RECENTS_CK][AppDelegate] RNCallKeep returned NO — filter Console for VOXO_RECENTS_CK + ABANDON in RNCallKeep.m");
  }

  BOOL linkingOk = [RCTLinkingManager application:application
                             continueUserActivity:userActivity
                               restorationHandler:restorationHandler];
  NSLog(@"[VOXO_CK][AppDelegate] RCTLinkingManager continueUserActivity → %@", linkingOk ? @"YES" : @"NO");

  BOOL handled = callKeepOk || linkingOk;
  if (!handled) {
    NSLog(@"[VOXO_CK][AppDelegate] continueUserActivity UNHANDLED — app may stay backgrounded or call won't start "
          @"(check [VOXO_CK] continueUserActivity ABANDON in RNCallKeep)");
  }
  return handled;
}
`;

module.exports = {
  APP_DELEGATE_H,
  PUSHKIT_MM,
  PUSHKIT_LAUNCH,
  CONTINUE_USER_ACTIVITY_MM,
  LAUNCH_PENDING_NOTIFICATION_MM,
  DID_RECEIVE_REMOTE_NOTIFICATION_MM
};
