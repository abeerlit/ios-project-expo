#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

@interface BackgroundTaskManager : NSObject

+ (instancetype)sharedInstance;
+ (instancetype)sharedTasks; // Alias for sharedInstance
- (void)startBackgroundTask;
- (void)endBackgroundTask;
- (NSUInteger)beginTaskWithCompletionHandler:(void (^)(NSUInteger taskKey, BOOL forced))completionHandler;
- (void)endTaskWithKey:(NSUInteger)taskKey;
- (void)registerForVoIPNotifications;
- (void)handleVoIPNotification:(NSDictionary *)payload;

@end

