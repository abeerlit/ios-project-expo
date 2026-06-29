#import "RCTVoxoNotificationsModule.h"
#import <React/RCTLog.h>
#import "RNCallKeep.h"
#import <UIKit/UIKit.h>
#import <os/log.h>

#if __has_include(<React/RCTLinkingManager.h>)
#import <React/RCTLinkingManager.h>
#define VOXO_HAS_RCT_LINKING 1
#endif

#if __has_include(<Sentry/SentrySDK.h>)
#import <Sentry/SentrySDK.h>
#endif

@implementation RCTVoxoNotificationsModule

RCT_EXPORT_MODULE();

/// Expo dev boot can create multiple module instances: JS listeners attach to instance A while
/// `-init` may have set UNUserNotificationCenter.delegate to instance B. Keep listener state global
/// and bind the notification delegate in `startObserving` (when JS actually subscribes).
static BOOL gVoxoHasRNListeners = NO;
static __weak RCTVoxoNotificationsModule *gVoxoListenerModule = nil;

static BOOL VoxoHasRNListeners(void)
{
  return gVoxoHasRNListeners && gVoxoListenerModule != nil;
}

static RCTVoxoNotificationsModule *VoxoListenerModule(void)
{
  return gVoxoListenerModule;
}

static void VoxoLogModuleInstances(NSString *tag)
{
  id<UNUserNotificationCenterDelegate> delegate =
      [UNUserNotificationCenter currentNotificationCenter].delegate;
  NSLog(@"🔔 [RCTVoxoNotificationsModule] %@ listener=%p delegate=%p hasListeners=%d",
        tag,
        VoxoListenerModule(),
        delegate,
        VoxoHasRNListeners());
}

static void VoxoSendEventNamed(NSString *eventName, id body)
{
  RCTVoxoNotificationsModule *emitter = VoxoListenerModule();
  if (!VoxoHasRNListeners() || emitter == nil) {
    return;
  }
  [emitter sendEventWithName:eventName body:body];
}

static NSString * const kUseVoxoMobileCallApproachKey = @"UseVoxoMobileCallApproach";
static NSString * const kEnableMobileCallNotificationsKey = @"EnableMobileCallNotifications";
static NSString * const kVoxoAppGroupId = @"group.co.voxo.voxo-ios";
static NSString * const kVoxoSmsNotificationCacheKey = @"voxo_sms_notification_cache";
static NSString * const kVoxoChatNotificationPrefsKey = @"voxo_chat_notification_prefs";

RCT_EXPORT_METHOD(syncChatNotificationPrefs:(NSString *)json)
{
  if (!json.length) {
    return;
  }
  NSUserDefaults *suite = [[NSUserDefaults alloc] initWithSuiteName:kVoxoAppGroupId];
  if (!suite) {
    NSLog(@"📱 [RCTVoxoNotificationsModule] syncChatNotificationPrefs: App Group suite unavailable");
    return;
  }
  [suite setObject:json forKey:kVoxoChatNotificationPrefsKey];
  [suite synchronize];
  NSLog(@"📱 [RCTVoxoNotificationsModule] syncChatNotificationPrefs: saved %lu bytes to App Group",
        (unsigned long)json.length);
}

RCT_EXPORT_METHOD(syncSmsNotificationContactCache:(NSString *)json)
{
  if (!json.length) {
    return;
  }
  NSUserDefaults *suite = [[NSUserDefaults alloc] initWithSuiteName:kVoxoAppGroupId];
  if (!suite) {
    NSLog(@"📱 [RCTVoxoNotificationsModule] syncSmsNotificationContactCache: App Group suite unavailable");
    if (notification_log) {
      os_log(notification_log, "[IOS-SMS-CACHE] sync FAILED — App Group unavailable");
    }
    return;
  }
  [suite setObject:json forKey:kVoxoSmsNotificationCacheKey];
  [suite synchronize];
  NSLog(@"📱 [RCTVoxoNotificationsModule] syncSmsNotificationContactCache: saved %lu bytes to App Group",
        (unsigned long)json.length);
  if (notification_log) {
    os_log(notification_log, "[IOS-SMS-CACHE] sync OK bytes=%lu", (unsigned long)json.length);
    NSString *lastNse = [suite stringForKey:@"voxo_sms_nse_last_resolve"];
    if (lastNse.length > 0) {
      os_log(notification_log, "[IOS-SMS-CACHE] NSE last resolve: %{public}@", lastNse);
    }
  }
}

RCT_EXPORT_METHOD(setUseVoxoMobileCallApproach:(BOOL)value) {
  [[NSUserDefaults standardUserDefaults] setBool:value forKey:kUseVoxoMobileCallApproachKey];
  [[NSUserDefaults standardUserDefaults] synchronize];
  NSLog(@"📞 [RCTVoxoNotificationsModule] setUseVoxoMobileCallApproach=%d", value);
}

+ (BOOL)useVoxoMobileCallApproach {
  return [[NSUserDefaults standardUserDefaults] boolForKey:kUseVoxoMobileCallApproachKey];
}

RCT_EXPORT_METHOD(setEnableMobileCallNotifications:(BOOL)enabled) {
  [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:kEnableMobileCallNotificationsKey];
  [[NSUserDefaults standardUserDefaults] synchronize];
  NSLog(@"📞 [RCTVoxoNotificationsModule] setEnableMobileCallNotifications=%d", enabled);
}

+ (BOOL)enableMobileCallNotifications {
  NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
  if ([ud objectForKey:kEnableMobileCallNotificationsKey] == nil) {
    return YES;
  }
  return [ud boolForKey:kEnableMobileCallNotificationsKey];
}

RCT_EXPORT_METHOD(viewingConversation: (NSString *)conversationId)
{
  NSLog(@"conversation id: %@", conversationId);
  viewingConversationId = conversationId;
}

RCT_EXPORT_METHOD(flushPendingNotificationEvents:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [self flushPendingNotificationEvents];
    resolve(@(YES));
  });
}

RCT_EXPORT_METHOD(getListenerDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UNUserNotificationCenterDelegate> delegate =
        [UNUserNotificationCenter currentNotificationCenter].delegate;
    RCTVoxoNotificationsModule *listener = VoxoListenerModule();
    resolve(@{
      @"hasListeners": @(VoxoHasRNListeners()),
      @"hasPendingPayload": @(pendingPayload != nil),
      @"hasPendingRemoteNotifee": @(pendingRemoteNotifeeUserInfo != nil),
      @"hasPendingConversationUpdated": @(pendingConversationUpdatedBody != nil),
      @"pendingConversationId": pendingConversationUpdatedBody[@"conversationId"] ?: [NSNull null],
      @"listenerModulePtr": listener ? [NSString stringWithFormat:@"%p", listener] : [NSNull null],
      @"delegateModulePtr": delegate ? [NSString stringWithFormat:@"%p", delegate] : [NSNull null],
      @"callerModulePtr": [NSString stringWithFormat:@"%p", self],
      @"listenerMatchesDelegate": @((listener != nil) && (delegate == listener)),
    });
  });
}

RCT_EXPORT_METHOD(handleIncomingVoipCall: (NSDictionary *)payload)
{
  NSLog(@"Handling incoming VoIP call: %@", payload);
  // Set the payload for the React Native side to handle
  [RCTVoxoNotificationsModule setPendingPayload:payload];
}

- (void)handleVoIPCallNotification:(NSNotification *)notification
{
  NSDictionary *payload = notification.userInfo;
  NSLog(@"Received VoIP call notification: %@", payload);
  
  // Set the payload for the React Native side
  [RCTVoxoNotificationsModule setPendingPayload:payload];
  
  if (VoxoHasRNListeners()) {
    VoxoSendEventNamed(@"onVoIPCallReceived", payload);
  }
}

+ (BOOL)requiresMainQueueSetup
{
    return YES;
}

static NSDictionary *pendingPayload = nil;
static NSDictionary *pendingRemoteNotifeeUserInfo = nil;
static NSDictionary *pendingConversationUpdatedBody = nil;
static os_log_t notification_log = NULL;
static NSString *lastNotificationTapDedupeKey = nil;
static NSTimeInterval lastNotificationTapDedupeAt = 0;

static NSString *VoxoNotificationTapDedupeKey(NSDictionary *payload) {
  if (![payload isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  id messageId = payload[@"messageId"] ?: payload[@"message_id"];
  NSDictionary *data = payload[@"data"];
  if (messageId == nil && [data isKindOfClass:[NSDictionary class]]) {
    messageId = data[@"messageId"] ?: data[@"message_id"];
  }
  NSDictionary *notifee = payload[@"__notifee_notification"];
  if (messageId == nil && [notifee isKindOfClass:[NSDictionary class]]) {
    NSDictionary *nd = notifee[@"data"];
    if ([nd isKindOfClass:[NSDictionary class]]) {
      messageId = nd[@"messageId"] ?: nd[@"message_id"];
    }
    if (messageId == nil) {
      messageId = notifee[@"id"];
    }
  }
  if (messageId == nil) {
    id sendbird = payload[@"sendbird"];
    if ([sendbird isKindOfClass:[NSDictionary class]]) {
      messageId = sendbird[@"message_id"] ?: sendbird[@"messageId"];
    }
  }
  if (messageId == nil) {
    return nil;
  }
  return [NSString stringWithFormat:@"%@", messageId];
}

static BOOL VoxoShouldSkipDuplicateNotificationTap(NSDictionary *payload) {
  NSString *key = VoxoNotificationTapDedupeKey(payload);
  if (key.length == 0) {
    return NO;
  }
  NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
  if (lastNotificationTapDedupeKey != nil &&
      [lastNotificationTapDedupeKey isEqualToString:key] &&
      (now - lastNotificationTapDedupeAt) < 1.0) {
    NSLog(@"🔔 [RCTVoxoNotificationsModule] Skipping duplicate notification tap for messageId=%@", key);
    return YES;
  }
  lastNotificationTapDedupeKey = [key copy];
  lastNotificationTapDedupeAt = now;
  return NO;
}

static void VoxoNativeSentryFlow(NSString *stage, NSDictionary *data) {
#if __has_include(<Sentry/SentrySDK.h>)
  NSString *payload = @"";
  if (data) {
    NSError *jsonError = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:data options:0 error:&jsonError];
    if (jsonData && !jsonError) {
      payload = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding] ?: @"";
    }
  }
  [SentrySDK captureMessage:[NSString stringWithFormat:@"VOXO_IOS_NATIVE_NOTIFICATIONS %@ %@", stage ?: @"", payload]];
#endif
}

/// FCM often nests `sendbird` under `data` or sends it as a JSON string — root-only lookup misses it.
static NSDictionary *VoxoSendbirdDictFromUserInfo(NSDictionary *userInfo) {
  id sb = userInfo[@"sendbird"];
  NSDictionary *data = userInfo[@"data"];
  if (!sb && [data isKindOfClass:[NSDictionary class]]) {
    sb = data[@"sendbird"];
  }
  if ([sb isKindOfClass:[NSDictionary class]]) {
    return (NSDictionary *)sb;
  }
  if ([sb isKindOfClass:[NSString class]]) {
    NSData *d = [(NSString *)sb dataUsingEncoding:NSUTF8StringEncoding];
    if (!d) {
      return nil;
    }
    NSError *err = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:d options:0 error:&err];
    if ([parsed isKindOfClass:[NSDictionary class]]) {
      return (NSDictionary *)parsed;
    }
  }
  return nil;
}

/// Remote pushes only (not VoIP/calls). Used to sync delivered-notification dedup with JS.
static BOOL VoxoUserInfoIsSendbirdChatPush(NSDictionary *userInfo) {
  if (userInfo[@"callUuid"] || userInfo[@"callUUID"] || userInfo[@"uuid"]) {
    return NO;
  }
  NSString *vm = userInfo[@"vm_payload_type"];
  if (vm.length > 0) {
    return NO;
  }
  NSDictionary *data = userInfo[@"data"];
  if ([data isKindOfClass:[NSDictionary class]]) {
    if (data[@"callUuid"] || data[@"callUUID"] || data[@"uuid"]) {
      return NO;
    }
    NSString *dvm = data[@"vm_payload_type"];
    if (dvm.length > 0) {
      return NO;
    }
  }
  NSString *click = userInfo[@"click_action"];
  if (!click.length && [data isKindOfClass:[NSDictionary class]]) {
    click = data[@"click_action"];
  }
  if ([click isEqualToString:@"TEXT-RECEIVED"]) {
    return NO;
  }
  if ([click isEqualToString:@"SENDBIRD-RECEIVED"]) {
    return YES;
  }
  return VoxoSendbirdDictFromUserInfo(userInfo) != nil;
}

static BOOL VoxoIgnorePushFromUserInfo(NSDictionary *userInfo) {
  if (!userInfo) {
    return NO;
  }
  NSDictionary *data = userInfo[@"data"];
  id val = userInfo[@"ignorePush"];
  if (val == nil && [data isKindOfClass:[NSDictionary class]]) {
    val = data[@"ignorePush"];
  }
  if ([val isKindOfClass:[NSNumber class]]) {
    return [(NSNumber *)val boolValue];
  }
  if ([val isKindOfClass:[NSString class]]) {
    NSString *s = [(NSString *)val lowercaseString];
    return [s isEqualToString:@"true"] || [s isEqualToString:@"1"];
  }
  return NO;
}

static BOOL VoxoHasApsAlertFromUserInfo(NSDictionary *userInfo) {
  NSDictionary *aps = userInfo[@"aps"];
  if (![aps isKindOfClass:[NSDictionary class]]) {
    return NO;
  }
  id alert = aps[@"alert"];
  if ([alert isKindOfClass:[NSDictionary class]]) {
    NSDictionary *alertDict = (NSDictionary *)alert;
    NSString *body = alertDict[@"body"];
    NSString *title = alertDict[@"title"];
    return (body.length > 0 || title.length > 0);
  }
  if ([alert isKindOfClass:[NSString class]]) {
    return [(NSString *)alert length] > 0;
  }
  return NO;
}

static NSString *VoxoStringFromPayloadId(id val) {
  if ([val isKindOfClass:[NSString class]]) {
    return (NSString *)val;
  }
  if ([val isKindOfClass:[NSNumber class]]) {
    return [(NSNumber *)val stringValue];
  }
  return nil;
}

static NSDictionary *VoxoConversationUpdatedBodyFromUserInfo(NSDictionary *userInfo) {
  if (![userInfo isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSDictionary *data = [userInfo[@"data"] isKindOfClass:[NSDictionary class]]
      ? userInfo[@"data"]
      : nil;

  NSString *referenceId = VoxoStringFromPayloadId(userInfo[@"reference_id"]);
  if (!referenceId.length) {
    referenceId = VoxoStringFromPayloadId(data[@"reference_id"]);
  }
  if (!referenceId.length) {
    return nil;
  }

  NSString *text = VoxoStringFromPayloadId(userInfo[@"text"]);
  if (!text.length) {
    text = VoxoStringFromPayloadId(data[@"text"]);
  }
  NSDictionary *aps = userInfo[@"aps"];
  if (!text.length && [aps isKindOfClass:[NSDictionary class]]) {
    id alert = aps[@"alert"];
    if ([alert isKindOfClass:[NSDictionary class]]) {
      text = VoxoStringFromPayloadId(((NSDictionary *)alert)[@"body"]);
    } else if ([alert isKindOfClass:[NSString class]]) {
      text = (NSString *)alert;
    }
  }

  NSString *from = VoxoStringFromPayloadId(userInfo[@"from"]);
  if (!from.length) {
    from = VoxoStringFromPayloadId(data[@"from"]);
  }
  NSString *peerName = VoxoStringFromPayloadId(userInfo[@"peerName"]);
  if (!peerName.length) {
    peerName = VoxoStringFromPayloadId(data[@"peerName"]);
  }

  NSMutableDictionary *body = [@{
    @"conversationId": referenceId,
    @"click_action": @"TEXT-RECEIVED",
  } mutableCopy];
  if (text.length) {
    body[@"text"] = text;
  }
  if (from.length) {
    body[@"from"] = from;
  }
  if (peerName.length) {
    body[@"peerName"] = peerName;
  }
  return body;
}

static void VoxoPresentNativeBanner(void (^completionHandler)(UNNotificationPresentationOptions)) {
  if (@available(iOS 14.0, *)) {
    completionHandler(
      UNNotificationPresentationOptionBanner |
      UNNotificationPresentationOptionList |
      UNNotificationPresentationOptionBadge |
      UNNotificationPresentationOptionSound
    );
  } else {
    completionHandler(
      UNNotificationPresentationOptionAlert |
      UNNotificationPresentationOptionBadge |
      UNNotificationPresentationOptionSound
    );
  }
}

/// Foreground SMS tap → JS via Linking (works when NativeEventEmitter hasListeners=0).
static BOOL VoxoOpenForegroundSmsDeepLink(NSDictionary *payload) {
#ifdef VOXO_HAS_RCT_LINKING
  if ([UIApplication sharedApplication].applicationState != UIApplicationStateActive) {
    return NO;
  }
  NSDictionary *data = payload[@"data"];
  if (![data isKindOfClass:[NSDictionary class]]) {
    data = nil;
  }
  NSString *click = payload[@"click_action"];
  if (click.length == 0 && data) {
    click = data[@"click_action"];
  }
  if (![click isEqualToString:@"TEXT-RECEIVED"]) {
    return NO;
  }
  id ref = payload[@"reference_id"];
  if (!ref && data) {
    ref = data[@"reference_id"];
  }
  if ([ref isKindOfClass:[NSNumber class]]) {
    ref = [(NSNumber *)ref stringValue];
  }
  if (![ref isKindOfClass:[NSString class]] || [(NSString *)ref length] == 0) {
    return NO;
  }
  NSString *scheme = [[NSBundle mainBundle] bundleIdentifier];
  if (scheme.length == 0) {
    scheme = @"co.voxo.voxo-ios";
  }
  NSString *urlStr = [NSString stringWithFormat:@"%@://text/%@", scheme, ref];
  NSURL *url = [NSURL URLWithString:urlStr];
  if (!url) {
    return NO;
  }
  NSLog(@"📱 [RCTVoxoNotificationsModule] Foreground SMS tap → Linking %@", urlStr);
  dispatch_async(dispatch_get_main_queue(), ^{
    [RCTLinkingManager application:[UIApplication sharedApplication] openURL:url options:@{}];
  });
  return YES;
#else
  return NO;
#endif
}

/// Parse Sendbird chat message id from APNs userInfo (mirrors JS extractSendbirdMessageIdFromRemoteMessage).
static NSNumber *VoxoSendbirdMessageIdFromUserInfo(NSDictionary *userInfo) {
  if (!userInfo) {
    return nil;
  }
  NSDictionary *sb = VoxoSendbirdDictFromUserInfo(userInfo);
  id mid = sb[@"message_id"] ?: sb[@"messageId"];
  NSDictionary *data = userInfo[@"data"];
  if (mid == nil && [data isKindOfClass:[NSDictionary class]]) {
    id dsb = data[@"sendbird"];
    if ([dsb isKindOfClass:[NSDictionary class]]) {
      mid = ((NSDictionary *)dsb)[@"message_id"] ?: ((NSDictionary *)dsb)[@"messageId"];
    }
    if (mid == nil) {
      mid = data[@"messageId"] ?: data[@"message_id"];
    }
  }
  if (mid == nil) {
    mid = userInfo[@"messageId"] ?: userInfo[@"message_id"];
  }
  if ([mid isKindOfClass:[NSNumber class]]) {
    double v = [(NSNumber *)mid doubleValue];
    return (v > 0) ? @((long long)v) : nil;
  }
  if ([mid isKindOfClass:[NSString class]]) {
    long long n = [(NSString *)mid longLongValue];
    return (n > 0) ? @(n) : nil;
  }
  return nil;
}

/// Delivered notifications still in Notification Center (e.g. user saw system banner in background
/// then opened app from icon). JS records these ids so Sendbird does not post a second Notifee banner.
RCT_EXPORT_METHOD(getDeliveredSendbirdMessageIds:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> * _Nonnull notifications) {
    NSMutableArray *out = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    for (UNNotification *n in notifications) {
      NSDictionary *userInfo = n.request.content.userInfo;
      if (!VoxoUserInfoIsSendbirdChatPush(userInfo)) {
        continue;
      }
      NSNumber *mid = VoxoSendbirdMessageIdFromUserInfo(userInfo);
      if (mid == nil) {
        continue;
      }
      NSString *key = [mid stringValue];
      if ([seen containsObject:key]) {
        continue;
      }
      [seen addObject:key];
      [out addObject:mid];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(out);
    });
  }];
}

/// Respect Notifee `ios.foregroundPresentationOptions.sound` (JS sets false for chat to avoid double chime).
static BOOL VoxoNotifeeForegroundSoundEnabled(NSDictionary *userInfo) {
  NSDictionary *notifeePayload = userInfo[@"__notifee_notification"];
  if (![notifeePayload isKindOfClass:[NSDictionary class]]) {
    return YES;
  }
  NSDictionary *ios = notifeePayload[@"ios"];
  if (![ios isKindOfClass:[NSDictionary class]]) {
    return YES;
  }
  NSDictionary *fpo = ios[@"foregroundPresentationOptions"];
  if (![fpo isKindOfClass:[NSDictionary class]]) {
    return YES;
  }
  id snd = fpo[@"sound"];
  if (snd == nil) {
    return YES;
  }
  return [snd boolValue];
}

/// JSON-serialize userInfo for the RN bridge (drops non-JSON types).
static NSDictionary *VoxoSerializeUserInfoForRN(NSDictionary *userInfo) {
  if (!userInfo || ![userInfo isKindOfClass:[NSDictionary class]]) {
    return @{};
  }
  NSError *err = nil;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:userInfo options:0 error:&err];
  if (jsonData) {
    id obj = [NSJSONSerialization JSONObjectWithData:jsonData options:NSJSONReadingMutableContainers error:nil];
    if ([obj isKindOfClass:[NSDictionary class]]) {
      return (NSDictionary *)obj;
    }
  }
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  for (NSString *key in userInfo) {
    id val = userInfo[key];
    if ([val isKindOfClass:[NSString class]] || [val isKindOfClass:[NSNumber class]]) {
      out[key] = val;
    } else if ([val isKindOfClass:[NSDictionary class]]) {
      NSDictionary *nested = VoxoSerializeUserInfoForRN((NSDictionary *)val);
      if (nested.count > 0) {
        out[key] = nested;
      }
    } else if ([val isKindOfClass:[NSArray class]]) {
      NSMutableArray *arr = [NSMutableArray array];
      for (id item in (NSArray *)val) {
        if ([item isKindOfClass:[NSString class]] || [item isKindOfClass:[NSNumber class]]) {
          [arr addObject:item];
        } else if ([item isKindOfClass:[NSDictionary class]]) {
          [arr addObject:VoxoSerializeUserInfoForRN((NSDictionary *)item)];
        }
      }
      out[key] = arr;
    }
  }
  return out;
}

NSString *viewingConversationId = nil;

- (instancetype)init
{
  self = [super init];

  // Initialize os_log for Console.app visibility (only once)
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    if (notification_log == NULL) {
      notification_log = os_log_create("com.voxo.connect", "Notifications");
    }
  });

  // UNUserNotificationCenter delegate is set in -startObserving when JS listeners attach,
  // so willPresent and the listener module are always the same instance.

  // Listen for VoIP call notifications from BackgroundTaskManager
  [[NSNotificationCenter defaultCenter] addObserver:self
                                           selector:@selector(handleVoIPCallNotification:)
                                               name:@"VoIPCallReceived"
                                             object:nil];

  return self;
}

+ (void)setPendingPayload:(NSDictionary *)payload {
  pendingPayload = payload;
}

+ (RCTVoxoNotificationsModule *)listenerModuleIfReady {
  return VoxoListenerModule();
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    NSDictionary *userInfo = notification.request.content.userInfo;
    NSDictionary *data = userInfo[@"data"];
    NSDictionary *payload = userInfo[@"payload"];
    if (![payload isKindOfClass:[NSDictionary class]]) {
      payload = nil;
    }
    NSString *clickAction = data[@"click_action"] ?: payload[@"click_action"] ?: userInfo[@"click_action"];
    NSDictionary *sendbirdData = VoxoSendbirdDictFromUserInfo(userInfo);
    
    // ✅ FIX: Check if this is a Notifee notification (from our JavaScript code)
    BOOL isNotifeeNotification = (userInfo[@"__notifee_notification"] != nil);
    
    NSLog(@"🔔 [RCTVoxoNotificationsModule] willPresentNotification called");
    NSLog(@"payload %@", userInfo);
    NSLog(@"clickAction: %@", clickAction);
    NSLog(@"isNotifeeNotification: %d", isNotifeeNotification);
  NSLog(@"📦 [RCTVoxoNotificationsModule] root keys: %@", [userInfo allKeys]);
  NSLog(@"📦 [RCTVoxoNotificationsModule] data keys: %@", [data allKeys]);
  
  // Debug SMS payload shape for GIF/media classification.
  id mediaUrlsRoot = userInfo[@"mediaUrls"] ?: userInfo[@"media_urls"];
  id mediaUrlsData = data[@"mediaUrls"] ?: data[@"media_urls"];
  id bodyRoot = userInfo[@"body"];
  id bodyData = data[@"body"] ?: data[@"message"] ?: data[@"text"];
  NSDictionary *aps = userInfo[@"aps"];
  id alertObj =
      [aps isKindOfClass:[NSDictionary class]] ? aps[@"alert"] : nil;
  NSString *apsBody = nil;
  if ([alertObj isKindOfClass:[NSDictionary class]]) {
    id bodyVal = ((NSDictionary *)alertObj)[@"body"];
    if ([bodyVal isKindOfClass:[NSString class]]) {
      apsBody = (NSString *)bodyVal;
    }
  } else if ([alertObj isKindOfClass:[NSString class]]) {
    apsBody = (NSString *)alertObj;
  }
  
  NSLog(@"🧪 [RCTVoxoNotificationsModule] SMS debug mediaUrlsRoot=%@ mediaUrlsData=%@",
        mediaUrlsRoot, mediaUrlsData);
  NSLog(@"🧪 [RCTVoxoNotificationsModule] SMS debug apsBody=%@ bodyRoot=%@ bodyData=%@",
        apsBody, bodyRoot, bodyData);
  NSLog(@"🧪 [RCTVoxoNotificationsModule] SMS debug click_action=%@ reference_id=%@",
        clickAction, userInfo[@"reference_id"] ?: data[@"reference_id"]);
    
    // Check if this is a CALL notification (don't suppress these)
    BOOL isCallNotification = (userInfo[@"callUuid"] != nil ||
                               userInfo[@"uuid"] != nil ||
                               data[@"callUuid"] != nil ||
                               data[@"uuid"] != nil ||
                               userInfo[@"vm_payload_type"] != nil ||
                               data[@"vm_payload_type"] != nil);
    
    // Check if this is a MESSAGE notification (Sendbird or SMS)
    BOOL isMessageNotification = (sendbirdData != nil ||
                                   [clickAction isEqualToString:@"SENDBIRD-RECEIVED"] ||
                                   [clickAction isEqualToString:@"TEXT-RECEIVED"]);
    
    // Check app state
    UIApplicationState appState = [UIApplication sharedApplication].applicationState;
    BOOL isForeground = (appState == UIApplicationStateActive);
    
    NSLog(@"🔔 [RCTVoxoNotificationsModule] App state: %ld, isForeground: %d, isCallNotification: %d, isMessageNotification: %d, isNotifeeNotification: %d", (long)appState, isForeground, isCallNotification, isMessageNotification, isNotifeeNotification);
    VoxoNativeSentryFlow(@"notification willPresent evaluated", @{
      @"isForeground": @(isForeground),
      @"isCallNotification": @(isCallNotification),
      @"clickAction": clickAction ?: @""
    });
    
    // CALL-EVENT-MISSED: Call ended remotely (caller hung up, timeout, etc). Dismiss CallKit and clean up.
    // Works for foreground, background, and locked screen — native runs before app can be suspended.
    NSString *clickActionStr = clickAction ?: userInfo[@"click_action"] ?: data[@"click_action"];
    BOOL isMissedCallEnded = [clickActionStr isEqualToString:@"CALL-EVENT-MISSED"] ||
                             [clickActionStr isEqualToString:@"MISSED-CALL"] ||
                             [clickActionStr isEqualToString:@"MISSED-CALL-RECEIVED"] ||
                             (userInfo[@"callCancelReason"] != nil && (userInfo[@"callUUID"] != nil || userInfo[@"callUuid"] != nil));
    if (isMissedCallEnded) {
      NSString *callUUID = userInfo[@"callUUID"] ?: userInfo[@"callUuid"] ?: data[@"callUUID"] ?: data[@"callUuid"];
      if ([callUUID isKindOfClass:[NSNumber class]]) {
        callUUID = [(NSNumber *)callUUID stringValue];
      }
      if (callUUID.length > 0) {
        NSLog(@"📞 [RCTVoxoNotificationsModule] CALL-EVENT-MISSED for callUUID=%@ — dismissing CallKit", callUUID);
        VoxoNativeSentryFlow(@"CALL-EVENT-MISSED dismiss CallKit", @{ @"callUUID": callUUID });
        [RNCallKeep endCallWithUUID:callUUID reason:2]; // 2 = REMOTE_ENDED
        if (VoxoHasRNListeners()) {
          VoxoSendEventNamed(@"onCallEndedRemotely", @{ @"callUUID": callUUID });
          NSLog(@"📞 [RCTVoxoNotificationsModule] Emitted onCallEndedRemotely for %@", callUUID);
        }
      }
    }
    
    // Handle TEXT-RECEIVED notifications (foreground + background — parity with bare ios-project)
    if ([clickAction isEqualToString: @"TEXT-RECEIVED"]) {
      NSDictionary *conversationBody = VoxoConversationUpdatedBodyFromUserInfo(userInfo);
      NSLog(@"referenceId: %@", conversationBody[@"conversationId"]);
      [self sendOrQueueConversationUpdated:conversationBody];
    }
    
    // IMPORTANT: Always allow CALL notifications to display (CallKit handles these)
    if (isCallNotification) {
      NSLog(@"📞 [RCTVoxoNotificationsModule] Call notification - allowing display (CallKit will handle)");
      NSLog(@"🔔🔔🔔 [RCTVoxoNotificationsModule] ✅ NATIVE iOS WILL DISPLAY CALL NOTIFICATION");
      if (@available(iOS 14.0, *)) {
        completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionBadge | UNNotificationPresentationOptionSound);
      } else {
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionBadge | UNNotificationPresentationOptionSound);
      }
      return;
    }

    // Notifee-created local notifications: keep native foreground presentation (already requested by JS)
    if (isNotifeeNotification) {
      NSLog(@"✅ [RCTVoxoNotificationsModule] Notifee notification - allowing display (from our JS code)");
      BOOL notifeeSound = VoxoNotifeeForegroundSoundEnabled(userInfo);
      if (@available(iOS 14.0, *)) {
        UNNotificationPresentationOptions opts =
            UNNotificationPresentationOptionBanner |
            UNNotificationPresentationOptionList |
            UNNotificationPresentationOptionBadge;
        if (notifeeSound) {
          opts |= UNNotificationPresentationOptionSound;
        }
        completionHandler(opts);
      } else {
        UNNotificationPresentationOptions opts =
            UNNotificationPresentationOptionAlert |
            UNNotificationPresentationOptionBadge;
        if (notifeeSound) {
          opts |= UNNotificationPresentationOptionSound;
        }
        completionHandler(opts);
      }
      return;
    }

    // Remote APNs (Sendbird, SMS, etc.): do not present natively — forward to RN so Notifee shows banner + sound.
    BOOL bodyLooksHtml = (apsBody.length > 0 &&
      ([apsBody rangeOfString:@"<" options:NSLiteralSearch].location != NSNotFound ||
       [apsBody rangeOfString:@"&nbsp;" options:NSLiteralSearch].location != NSNotFound));
    NSLog(@"[SENDBIRD_HTML_TRACE] willPresent path=FORWARD_TO_NOTIFEE appState=%ld isForeground=%d isMessageNotification=%d sendbird=%d bodyLooksHtml=%d apsBodyPreview=%@",
          (long)appState,
          isForeground,
          isMessageNotification,
          sendbirdData != nil,
          bodyLooksHtml,
          apsBody.length > 180 ? [[apsBody substringToIndex:180] stringByAppendingString:@"…"] : (apsBody ?: @"(nil)"));
    NSLog(@"🔔 [RCTVoxoNotificationsModule] Remote push — suppressing native UI; forwarding to Notifee via RN");
    completionHandler(UNNotificationPresentationOptionNone);

    NSDictionary *safe = VoxoSerializeUserInfoForRN(userInfo);
    NSDictionary *body = @{ @"userInfo": safe ?: @{} };
    if (VoxoHasRNListeners()) {
      VoxoSendEventNamed(@"onRemoteNotificationForNotifee", body);
      NSLog(@"🔔 [RCTVoxoNotificationsModule] Emitted onRemoteNotificationForNotifee to listener=%p",
            VoxoListenerModule());
    } else {
      pendingRemoteNotifeeUserInfo = body;
      VoxoLogModuleInstances(@"No RN listeners — queued onRemoteNotificationForNotifee");
      [self schedulePendingNotificationFlushRetries];
    }
}

- (void)flushPendingNotificationEvents {
  if (!VoxoHasRNListeners()) {
    VoxoLogModuleInstances(@"flushPendingNotificationEvents skipped");
    return;
  }

  if (pendingPayload != nil) {
    NSDictionary *payloadToEmit = pendingPayload;
    pendingPayload = nil;
    NSLog(@"🔔 [RCTVoxoNotificationsModule] flushPendingNotificationEvents emitting onNotificationPressed");
    VoxoSendEventNamed(@"onNotificationPressed", payloadToEmit);
  }

  if (pendingRemoteNotifeeUserInfo != nil) {
    NSDictionary *notifeePayload = pendingRemoteNotifeeUserInfo;
    pendingRemoteNotifeeUserInfo = nil;
    NSLog(@"🔔 [RCTVoxoNotificationsModule] flushPendingNotificationEvents emitting onRemoteNotificationForNotifee");
    VoxoSendEventNamed(@"onRemoteNotificationForNotifee", notifeePayload);
  }

  if (pendingConversationUpdatedBody != nil) {
    NSDictionary *conversationBody = pendingConversationUpdatedBody;
    pendingConversationUpdatedBody = nil;
    NSLog(@"🔔 [RCTVoxoNotificationsModule] flushPendingNotificationEvents emitting onConversationUpdated for %@",
          conversationBody[@"conversationId"]);
    VoxoSendEventNamed(@"onConversationUpdated", conversationBody);
  }
}

- (void)schedulePendingNotificationFlushRetries {
  for (NSNumber *delayMs in @[@300, @800, @1500, @2500]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)([delayMs doubleValue] * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      if (pendingPayload == nil &&
          pendingRemoteNotifeeUserInfo == nil &&
          pendingConversationUpdatedBody == nil) {
        return;
      }
      RCTVoxoNotificationsModule *listener = VoxoListenerModule();
      if (listener) {
        [listener flushPendingNotificationEvents];
      } else {
        [self flushPendingNotificationEvents];
      }
    });
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completionHandler {
  UNNotification *notification = [response notification];
  UNNotificationRequest *request = [notification request];
  UNNotificationContent *content = [request content];
  NSDictionary *payload = [content userInfo];

  if (VoxoShouldSkipDuplicateNotificationTap(payload)) {
    completionHandler();
    return;
  }

  NSString *logMessage = [NSString stringWithFormat:@"🔔 [RCTVoxoNotificationsModule] didReceiveNotificationResponse called"];
  os_log(notification_log, "%{public}@", logMessage);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] didReceiveNotificationResponse called");
  
  logMessage = [NSString stringWithFormat:@"🔔 [RCTVoxoNotificationsModule] Payload: %@", payload];
  os_log(notification_log, "%{public}@", logMessage);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] Payload: %@", payload);
  
  VoxoLogModuleInstances(@"didReceiveNotificationResponse");
  
  logMessage = [NSString stringWithFormat:@"🔔 [RCTVoxoNotificationsModule] pendingPayload before: %@", pendingPayload ?: @"nil"];
  os_log(notification_log, "%{public}@", logMessage);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] pendingPayload before: %@", pendingPayload);

  // CALL-EVENT-MISSED on tap (e.g. app was killed/background when push arrived): dismiss CallKit + notify JS
  NSDictionary *respData = payload[@"data"];
  NSString *respClickAction = payload[@"click_action"] ?: respData[@"click_action"];
  BOOL isMissedCallTap = [respClickAction isEqualToString:@"CALL-EVENT-MISSED"] ||
                        [respClickAction isEqualToString:@"MISSED-CALL"] ||
                        [respClickAction isEqualToString:@"MISSED-CALL-RECEIVED"] ||
                        (payload[@"callCancelReason"] != nil && (payload[@"callUUID"] != nil || payload[@"callUuid"] != nil));
  if (isMissedCallTap) {
    NSString *callUUID = payload[@"callUUID"] ?: payload[@"callUuid"] ?: respData[@"callUUID"] ?: respData[@"callUuid"];
    if ([callUUID isKindOfClass:[NSNumber class]]) {
      callUUID = [(NSNumber *)callUUID stringValue];
    }
    if (callUUID.length > 0) {
      NSLog(@"📞 [RCTVoxoNotificationsModule] didReceiveResponse CALL-EVENT-MISSED for %@ — dismissing CallKit", callUUID);
      VoxoNativeSentryFlow(@"tap CALL-EVENT-MISSED dismiss CallKit", @{ @"callUUID": callUUID ?: @"" });
      [RNCallKeep endCallWithUUID:callUUID reason:2];
      if (VoxoHasRNListeners()) {
        VoxoSendEventNamed(@"onCallEndedRemotely", @{ @"callUUID": callUUID });
      }
    }
  }

  [self sendEvent:payload];
  
  logMessage = [NSString stringWithFormat:@"🔔 [RCTVoxoNotificationsModule] pendingPayload after: %@", pendingPayload ?: @"nil"];
  os_log(notification_log, "%{public}@", logMessage);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] pendingPayload after: %@", pendingPayload);
  
  VoxoLogModuleInstances(@"didReceiveNotificationResponse after sendEvent");
  
  completionHandler();
}

- (void)startObserving {
  gVoxoHasRNListeners = YES;
  gVoxoListenerModule = self;
  [[UNUserNotificationCenter currentNotificationCenter] setDelegate:self];
  NSLog(@"🔔 [RCTVoxoNotificationsModule] ✅ startObserving — listener=%p is now UNUserNotificationCenter delegate",
        self);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] pending queues: tap=%@ notifee=%@ conversation=%@",
        pendingPayload ? @"yes" : @"no",
        pendingRemoteNotifeeUserInfo ? @"yes" : @"no",
        pendingConversationUpdatedBody ? @"yes" : @"no");
  if (pendingConversationUpdatedBody[@"conversationId"]) {
    NSLog(@"🔔 [RCTVoxoNotificationsModule] pending conversationId=%@",
          pendingConversationUpdatedBody[@"conversationId"]);
  }

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [self flushPendingNotificationEvents];
    [self schedulePendingNotificationFlushRetries];
  });
}

// Will be called when this module's last listener is removed, or on dealloc.
- (void)stopObserving {
  if (gVoxoListenerModule == self) {
    gVoxoHasRNListeners = NO;
    gVoxoListenerModule = nil;
    NSLog(@"⚠️ [RCTVoxoNotificationsModule] stopObserving — listener=%p cleared; pushes will queue until re-attach",
          self);
    NSLog(@"🔔 [RCTVoxoNotificationsModule] pending queues after stop: tap=%@ notifee=%@ conversation=%@",
          pendingPayload ? @"yes" : @"no",
          pendingRemoteNotifeeUserInfo ? @"yes" : @"no",
          pendingConversationUpdatedBody ? @"yes" : @"no");
  } else {
    NSLog(@"⚠️ [RCTVoxoNotificationsModule] stopObserving on non-listener instance=%p (active listener=%p)",
          self,
          VoxoListenerModule());
  }
}

- (void)sendEvent:(NSDictionary *) payload {
  NSString *logMessage = [NSString stringWithFormat:@"🔔 [RCTVoxoNotificationsModule] sendEvent called with payload: %@", payload];
  os_log(notification_log, "%{public}@", logMessage);
  NSLog(@"🔔 [RCTVoxoNotificationsModule] sendEvent called with payload: %@", payload);
  
  VoxoLogModuleInstances(@"sendEvent onNotificationPressed");
  
  if (VoxoHasRNListeners()) {
    logMessage = @"🔔 [RCTVoxoNotificationsModule] Sending event to React Native: onNotificationPressed";
    os_log(notification_log, "%{public}@", logMessage);
    NSLog(@"🔔 [RCTVoxoNotificationsModule] Sending event to React Native: onNotificationPressed");
    VoxoSendEventNamed(@"onNotificationPressed", payload);
  }
  else {
    logMessage = @"🔔 [RCTVoxoNotificationsModule] No listeners yet, storing in pendingPayload";
    os_log(notification_log, "%{public}@", logMessage);
    NSLog(@"🔔 [RCTVoxoNotificationsModule] No listeners yet, storing in pendingPayload");
    pendingPayload = payload;
    [self schedulePendingNotificationFlushRetries];
  }
}

- (void)sendOrQueueConversationUpdated:(NSDictionary *)body {
  if (![body isKindOfClass:[NSDictionary class]] || body[@"conversationId"] == nil) {
    return;
  }
  if (VoxoHasRNListeners()) {
    VoxoSendEventNamed(@"onConversationUpdated", body);
    NSLog(@"📱 [RCTVoxoNotificationsModule] Sent onConversationUpdated for conversationId: %@ listener=%p",
          body[@"conversationId"],
          VoxoListenerModule());
  } else {
    pendingConversationUpdatedBody = [body copy];
    VoxoLogModuleInstances([NSString stringWithFormat:@"No RN listeners — queued onConversationUpdated for %@",
                            body[@"conversationId"]]);
    [self schedulePendingNotificationFlushRetries];
  }
}

- (void)emitConversationUpdatedForReferenceId:(NSString *)referenceId {
  if (!referenceId || referenceId.length == 0) return;
  [self sendOrQueueConversationUpdated:@{
    @"conversationId": referenceId,
    @"click_action": @"TEXT-RECEIVED"
  }];
}

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onNotificationPressed", @"onConversationUpdated", @"onVoIPCallReceived", @"onSMSNotificationReceived", @"onCallEndedRemotely", @"onRemoteNotificationForNotifee"];
}

- (void)dealloc {
  if (gVoxoListenerModule == self) {
    gVoxoHasRNListeners = NO;
    gVoxoListenerModule = nil;
  }
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end

