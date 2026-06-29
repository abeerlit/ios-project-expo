#import "RCTPendingCallManager.h"

@implementation RCTPendingCallManager

RCT_EXPORT_MODULE(PendingCallManager);

// Get pending VoIP call data stored by AppDelegate
RCT_EXPORT_METHOD(getPendingCalls:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *pendingCalls = [[NSUserDefaults standardUserDefaults] objectForKey:@"pendingVoipCalls"];
  
  if (pendingCalls && [pendingCalls count] > 0) {
    NSLog(@"🟢 [PendingCallManager] Found %lu pending VoIP calls", (unsigned long)[pendingCalls count]);
    resolve(pendingCalls);
  } else {
    NSLog(@"🟢 [PendingCallManager] No pending VoIP calls found");
    resolve(@{});
  }
}

// Clear a specific pending call after it's been processed
RCT_EXPORT_METHOD(clearPendingCall:(NSString *)callUuid
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableDictionary *pendingCalls = [[[NSUserDefaults standardUserDefaults] objectForKey:@"pendingVoipCalls"] mutableCopy];
  
  if (pendingCalls && pendingCalls[callUuid]) {
    [pendingCalls removeObjectForKey:callUuid];
    [[NSUserDefaults standardUserDefaults] setObject:pendingCalls forKey:@"pendingVoipCalls"];
    [[NSUserDefaults standardUserDefaults] synchronize];
    NSLog(@"🟢 [PendingCallManager] Cleared pending call: %@", callUuid);
    resolve(@YES);
  } else {
    NSLog(@"🟢 [PendingCallManager] No pending call found for UUID: %@", callUuid);
    resolve(@NO);
  }
}

// Clear all pending calls
RCT_EXPORT_METHOD(clearAllPendingCalls:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"pendingVoipCalls"];
  [[NSUserDefaults standardUserDefaults] synchronize];
  NSLog(@"🟢 [PendingCallManager] Cleared all pending calls");
  resolve(@YES);
}

@end
