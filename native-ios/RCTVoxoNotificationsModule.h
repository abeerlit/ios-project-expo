#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <UserNotifications/UserNotifications.h>

@interface RCTVoxoNotificationsModule: RCTEventEmitter <RCTBridgeModule, UNUserNotificationCenterDelegate>
- (void)sendEvent:(NSDictionary *)payload;
+ (void)setPendingPayload:(NSDictionary *)payload;
+ (BOOL)useVoxoMobileCallApproach;
/// Mirrors JS user.enableMobileCallNotifications (1 = on). When off, AppDelegate suppresses CallKit for background/killed only.
+ (BOOL)enableMobileCallNotifications;
- (void)handleIncomingVoipCall:(NSDictionary *)payload;
/// Call from AppDelegate when a silent push (content-available) is received for SMS, so JS can refresh badge/unread.
- (void)emitConversationUpdatedForReferenceId:(NSString *)referenceId;
/// Bridge-attached module that currently owns RN listeners (may differ from delegate during Expo boot).
+ (RCTVoxoNotificationsModule * _Nullable)listenerModuleIfReady;
/// Replay notification tap / APNs payloads queued while JS had no RN listeners.
- (void)flushPendingNotificationEvents;
@end
