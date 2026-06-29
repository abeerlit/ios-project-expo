#import <Foundation/Foundation.h>
#import "VOXOConnectBackgroundActivator.h"
#import "BackgroundTaskManager.h"
#import <React/RCTTiming.h>

@implementation VOXOConnectBackgroundActivator
NSTimer *rctTimerUpdater;
NSTimer *rctTimerCancellor;
NSUInteger activeBackgroundTask;
BOOL isFirstCall = YES;

- (instancetype)init
{
    self = [self initWithBridge:nil];
    return self;
}

- (instancetype)initWithBridge:(RCTBridge*)bridge
{
    self = [super init];
    if (self) {
      self.bridge = bridge;

      CXCallObserver *callObserver = [[CXCallObserver alloc] init];
      [callObserver setDelegate:self queue:nil];
      self.callObserver = callObserver;
      
      NSLog(@"🟣 [VOXOConnectBackgroundActivator] Initialized with bridge: %@", bridge);
    }
    return self;
}

- (void)callObserver:(CXCallObserver *)callObserver callChanged:(CXCall *)call {
  NSLog(@"🟣 [VOXOConnectBackgroundActivator] Call state changed: %@", call);
  BackgroundTaskManager *bgTasks = [BackgroundTaskManager sharedTasks];

  BOOL hasCall = [self.callObserver calls].count > 0;
  NSLog(@"🟣 [VOXOConnectBackgroundActivator] Has active calls: %d", hasCall);
  
  if (hasCall) {
    if (isFirstCall) {
      NSLog(@"🟣 [VOXOConnectBackgroundActivator] First active call detected");

      isFirstCall = NO;
      if (activeBackgroundTask) {
        NSLog(@"🟣 [VOXOConnectBackgroundActivator] Background task running. Cancelling timers and background task");
        [bgTasks endTaskWithKey:activeBackgroundTask];
      }
    }

    if (rctTimerUpdater == nil)
    {
      NSLog(@"🟣 [VOXOConnectBackgroundActivator] Started RCT Update Timer to keep React Native bridge alive");

      rctTimerUpdater = [NSTimer scheduledTimerWithTimeInterval:0.5f target:self selector:@selector(doDidUpdate:) userInfo:nil repeats:YES];
    }
  }
  else {
    NSLog(@"🟣 [VOXOConnectBackgroundActivator] No more active calls");

    isFirstCall = YES;

    // End any previous task from a rapid callObserver oscillation (otherwise UIKit tasks pile up and iOS kills the app).
    if (activeBackgroundTask != 0) {
      NSLog(@"🟣 [VOXOConnectBackgroundActivator] Ending prior background task key=%lu before starting cooldown task", (unsigned long)activeBackgroundTask);
      [bgTasks endTaskWithKey:activeBackgroundTask];
      activeBackgroundTask = 0;
    }

    //Request a background processing task, which if forcibly terminated, will terminate the timers.
    activeBackgroundTask = [bgTasks beginTaskWithCompletionHandler:^(NSUInteger taskKey, BOOL forced) {
      NSLog(@"🟣 [VOXOConnectBackgroundActivator] Background Processing completed %lu, active is: %lu forced: %i", taskKey, activeBackgroundTask, forced);
      [self invalidateTimers];
      activeBackgroundTask = 0;
    }];

    NSLog(@"🟣 [VOXOConnectBackgroundActivator] Background Processing started, active is: %lu", activeBackgroundTask);

    NSLog(@"🟣 [VOXOConnectBackgroundActivator] Scheduling RCT Timers to end in 15 seconds.");
    rctTimerCancellor = [NSTimer scheduledTimerWithTimeInterval:15.0f target:self selector:@selector(doInvalidateTimers:) userInfo:nil repeats:NO];
  }
}

- (void)invalidateTimers
{
  NSLog(@"🟣 [VOXOConnectBackgroundActivator] invalidateTimers called");

  if (rctTimerUpdater != nil) {
    [rctTimerUpdater invalidate];
    rctTimerUpdater = nil;
    NSLog(@"🟣 [VOXOConnectBackgroundActivator] invalidated timerUpdater");
  }
  if (rctTimerCancellor != nil) {
    [rctTimerCancellor invalidate];
    rctTimerCancellor = nil;
    NSLog(@"🟣 [VOXOConnectBackgroundActivator] invalidated timerCancellor");
  }
}

- (void)doInvalidateTimers:(NSTimer *)timer
{
  NSLog(@"🟣 [VOXOConnectBackgroundActivator] RCT Timer update is being ended by regular 15 second schedule.");

  BackgroundTaskManager *bgTasks = [BackgroundTaskManager sharedTasks];
  [bgTasks endTaskWithKey:activeBackgroundTask];
}

- (void)doDidUpdate:(NSTimer *)timer
{
  RCTTiming *timing = [self.bridge moduleForClass:[RCTTiming class]];
  if (timing != nil)
  {
    [timing didUpdateFrame:nil];
  }
  else {
    NSLog(@"🟣 [VOXOConnectBackgroundActivator] didUpdate with no react native module present");
  }
}

@end
