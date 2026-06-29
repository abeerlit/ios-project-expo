#import <Foundation/Foundation.h>
#import <CallKit/CXCallObserver.h>
#import <CallKit/CXCall.h>
#import <React/RCTBridge.h>

@interface VOXOConnectBackgroundActivator: NSObject<CXCallObserverDelegate>
@property (nonatomic, strong) CXCallObserver *callObserver;
@property (strong) RCTBridge *bridge;

- (instancetype)init;
- (instancetype)initWithBridge:(RCTBridge*)bridge;

@end
