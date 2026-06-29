#import "BackgroundTaskManager.h"
#import <PushKit/PushKit.h>
#import <CallKit/CallKit.h>
#import <Foundation/Foundation.h>

// Forward declaration to avoid circular import
@class RCTVoxoNotificationsModule;

@interface BackgroundTaskManager () <PKPushRegistryDelegate>

@property (nonatomic, strong) PKPushRegistry *pushRegistry;
@property (nonatomic, assign) UIBackgroundTaskIdentifier backgroundTaskId;
@property (nonatomic, strong) CXProvider *callProvider;
@property (nonatomic, strong) CXCallController *callController;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, void (^)(NSUInteger taskKey, BOOL forced)> *taskCompletionHandlers;
@property (nonatomic, assign) NSUInteger nextTaskKey;
/** Maps beginTaskWithCompletionHandler keys → UIBackgroundTaskIdentifier (boxed). Required so endTaskWithKey actually ends the UIKit task (otherwise OS kills the app ~30s). */
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSNumber *> *taskIdByKey;

@end

@implementation BackgroundTaskManager

+ (instancetype)sharedInstance {
    static BackgroundTaskManager *sharedInstance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        sharedInstance = [[BackgroundTaskManager alloc] init];
    });
    return sharedInstance;
}

+ (instancetype)sharedTasks {
    return [self sharedInstance];
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _backgroundTaskId = UIBackgroundTaskInvalid;
        _taskCompletionHandlers = [NSMutableDictionary dictionary];
        _taskIdByKey = [NSMutableDictionary dictionary];
        _nextTaskKey = 1;
        // Do NOT create a second CXProvider here — RNCallKeep owns CallKit for VoIP.
        // Lazy-init callProvider only if legacy handleVoIPNotification path reports an incoming call.
        // VoIP push is handled by AppDelegate + RNVoipPushNotificationManager only.
        // Duplicate PKPushRegistry here caused conflicts when app was background/killed.
        // [self registerForVoIPNotifications];
    }
    return self;
}

- (void)ensureLegacyCallKitProviderIfNeeded {
    if (self.callProvider != nil) {
        return;
    }
    NSString *localizedName = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleDisplayName"];
    if (localizedName == nil || localizedName.length == 0) {
        localizedName = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleName"];
    }
    if (localizedName == nil || localizedName.length == 0) {
        localizedName = @"App";
    }
    CXProviderConfiguration *configuration = [[CXProviderConfiguration alloc] initWithLocalizedName:localizedName];
    configuration.supportsVideo = NO;
    configuration.maximumCallGroups = 3;
    configuration.maximumCallsPerCallGroup = 1;
    configuration.supportedHandleTypes = [NSSet setWithObjects:@(CXHandleTypePhoneNumber), @(CXHandleTypeGeneric), nil];
    self.callProvider = [[CXProvider alloc] initWithConfiguration:configuration];
    self.callController = [[CXCallController alloc] init];
    NSLog(@"[BackgroundTaskManager] Lazy CallKit CXProvider created (legacy incoming path only)");
}

- (void)setupCallKit {
    [self ensureLegacyCallKitProviderIfNeeded];
}

- (void)registerForVoIPNotifications {
    // Check if VoIP entitlement is available
    NSString *entitlementsPath = [[NSBundle mainBundle] pathForResource:@"VOXO Connect" ofType:@"entitlements"];
    if (entitlementsPath) {
        NSDictionary *entitlements = [NSDictionary dictionaryWithContentsOfFile:entitlementsPath];
        NSArray *voipServices = entitlements[@"com.apple.developer.voip-services"];
        
        if (!voipServices) {
            NSLog(@"VoIP services entitlement not found. VoIP push notifications will not be available.");
            NSLog(@"To enable VoIP push notifications, update your provisioning profile with VoIP capability.");
            return;
        }
    }
    
    @try {
        self.pushRegistry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
        self.pushRegistry.delegate = self;
        self.pushRegistry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
        
        NSLog(@"Registered for VoIP push notifications");
    } @catch (NSException *exception) {
        NSLog(@"Failed to register for VoIP push notifications: %@", exception.reason);
        NSLog(@"This is likely due to missing VoIP entitlement in provisioning profile");
    }
}

- (void)startBackgroundTask {
    if (self.backgroundTaskId != UIBackgroundTaskInvalid) {
        return; // Already running
    }
    
    self.backgroundTaskId = [[UIApplication sharedApplication] beginBackgroundTaskWithExpirationHandler:^{
        [self endBackgroundTask];
    }];
    
    NSLog(@"Started background task with ID: %lu", (unsigned long)self.backgroundTaskId);
}

- (void)endBackgroundTask {
    if (self.backgroundTaskId != UIBackgroundTaskInvalid) {
        [[UIApplication sharedApplication] endBackgroundTask:self.backgroundTaskId];
        self.backgroundTaskId = UIBackgroundTaskInvalid;
        NSLog(@"Ended background task");
    }
}

- (NSUInteger)beginTaskWithCompletionHandler:(void (^)(NSUInteger taskKey, BOOL forced))completionHandler {
    NSUInteger taskKey = self.nextTaskKey++;

    __weak typeof(self) weakSelf = self;
    UIBackgroundTaskIdentifier taskId = [[UIApplication sharedApplication] beginBackgroundTaskWithExpirationHandler:^{
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (!strongSelf) return;
        NSLog(@"Background task %lu expired (forced termination)", (unsigned long)taskKey);

        void (^handler)(NSUInteger, BOOL) = strongSelf.taskCompletionHandlers[@(taskKey)];
        if (handler) {
            handler(taskKey, YES);
            [strongSelf.taskCompletionHandlers removeObjectForKey:@(taskKey)];
        }
        [strongSelf.taskIdByKey removeObjectForKey:@(taskKey)];
        [[UIApplication sharedApplication] endBackgroundTask:taskId];
    }];

    NSLog(@"Started background task with key: %lu, ID: %lu", (unsigned long)taskKey, (unsigned long)taskId);

    if (completionHandler) {
        self.taskCompletionHandlers[@(taskKey)] = completionHandler;
    }
    self.taskIdByKey[@(taskKey)] = @(taskId);

    return taskKey;
}

- (void)endTaskWithKey:(NSUInteger)taskKey {
    NSLog(@"Ending background task with key: %lu", (unsigned long)taskKey);

    NSNumber *boxedId = self.taskIdByKey[@(taskKey)];
    if (boxedId != nil) {
        UIBackgroundTaskIdentifier btid = (UIBackgroundTaskIdentifier)[boxedId unsignedLongValue];
        if (btid != UIBackgroundTaskInvalid) {
            [[UIApplication sharedApplication] endBackgroundTask:btid];
        }
        [self.taskIdByKey removeObjectForKey:@(taskKey)];
    }

    void (^handler)(NSUInteger, BOOL) = self.taskCompletionHandlers[@(taskKey)];
    if (handler) {
        handler(taskKey, NO);
        [self.taskCompletionHandlers removeObjectForKey:@(taskKey)];
    }
}

- (void)handleVoIPNotification:(NSDictionary *)payload {
    NSLog(@"Handling VoIP notification: %@", payload);
    
    // Start background task to handle the call
    [self startBackgroundTask];
    
    // Extract call information
    NSString *callUUID = payload[@"callUuid"] ?: payload[@"uuid"] ?: [[NSUUID UUID] UUIDString];
    NSString *callerName = payload[@"callerName"] ?: payload[@"displayName"] ?: @"Unknown Caller";
    NSString *callerNumber = payload[@"callerNumber"] ?: payload[@"handle"] ?: @"Unknown Number";
    
    // Report incoming call to CallKit
    [self reportIncomingCallWithUUID:callUUID callerName:callerName callerNumber:callerNumber];
    
    // Store the payload for the React Native module to pick up
    // Note: We avoid direct import to prevent circular dependencies
    [[NSNotificationCenter defaultCenter] postNotificationName:@"VoIPCallReceived" 
                                                        object:nil 
                                                      userInfo:payload];
}

- (void)reportIncomingCallWithUUID:(NSString *)callUUID callerName:(NSString *)callerName callerNumber:(NSString *)callerNumber {
    [self ensureLegacyCallKitProviderIfNeeded];
    NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:callUUID];
    if (!uuid) {
        uuid = [NSUUID UUID];
        NSLog(@"Invalid UUID provided, generating new one: %@", uuid.UUIDString);
    }
    
    CXHandle *handle = [[CXHandle alloc] initWithType:CXHandleTypePhoneNumber value:callerNumber];
    CXCallUpdate *callUpdate = [[CXCallUpdate alloc] init];
    callUpdate.remoteHandle = handle;
    callUpdate.localizedCallerName = callerName;
    callUpdate.hasVideo = NO;
    callUpdate.supportsHolding = NO;
    callUpdate.supportsGrouping = NO;
    callUpdate.supportsUngrouping = NO;
    callUpdate.supportsDTMF = YES;
    
    [self.callProvider reportNewIncomingCallWithUUID:uuid update:callUpdate completion:^(NSError * _Nullable error) {
        if (error) {
            NSLog(@"Failed to report incoming call: %@", error.localizedDescription);
        } else {
            NSLog(@"Successfully reported incoming call with UUID: %@", uuid.UUIDString);
        }
        
        // End background task after reporting call
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self endBackgroundTask];
        });
    }];
}

#pragma mark - PKPushRegistryDelegate

- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)pushCredentials forType:(PKPushType)type {
    if (type == PKPushTypeVoIP) {
        NSString *token = [self stringFromDeviceToken:pushCredentials.token];
        NSLog(@"VoIP push token updated: %@", token);
        
        // Store token for later use or send to server
        [[NSUserDefaults standardUserDefaults] setObject:token forKey:@"VoIPPushToken"];
        [[NSUserDefaults standardUserDefaults] synchronize];
    }
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion {
    if (type == PKPushTypeVoIP) {
        NSLog(@"Received VoIP push notification: %@", payload.dictionaryPayload);
        
        // Handle the VoIP notification
        [self handleVoIPNotification:payload.dictionaryPayload];
        
        // Call completion handler
        if (completion) {
            completion();
        }
    }
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type {
    if (type == PKPushTypeVoIP) {
        NSLog(@"VoIP push token invalidated");
        [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"VoIPPushToken"];
        [[NSUserDefaults standardUserDefaults] synchronize];
    }
}

#pragma mark - Helper Methods

- (NSString *)stringFromDeviceToken:(NSData *)deviceToken {
    const char *data = [deviceToken bytes];
    NSMutableString *token = [NSMutableString string];
    
    for (NSUInteger i = 0; i < [deviceToken length]; i++) {
        [token appendFormat:@"%02.2hhX", data[i]];
    }
    
    return [token copy];
}

@end
