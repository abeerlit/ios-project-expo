#import "VOXODtmfSidetoneModule.h"
#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>
#import <WebRTC/RTCAudioSession.h>
#import <math.h>
#import <string.h>

/**
 * Gain for sin(row)+sin(col) before Hann. Soft-clip limits rare peaks when both sines align.
 * Tune with kVoxoDtmfSidetoneMixerVolume on earpiece vs speaker.
 */
static const float kVoxoDtmfSidetoneDualToneGain = 0.38f;

/** AVAudioMixerNode outputVolume on iOS is 0.0–1.0. */
static const float kVoxoDtmfSidetoneMixerVolume = 1.0f;

/** Linear through |x|<=t, then eases toward ±1. */
static inline float VoxoDtmfSidetoneSoftClip(float x) {
  const float t = 0.92f;
  float ax = fabsf(x);
  if (ax <= t) {
    return x;
  }
  float sgn = (x >= 0.f) ? 1.f : -1.f;
  float over = ax - t;
  return sgn * (t + (1.f - t) * tanhf(over * 5.f));
}

/** ITU-T Q.23 — dual-tone frequencies for local sidetone only. */
static BOOL VoxoDtmfFreqsForCharacter(unichar c, double *rowHz, double *colHz) {
  switch (c) {
    case '1':
      *rowHz = 697;
      *colHz = 1209;
      return YES;
    case '2':
      *rowHz = 697;
      *colHz = 1336;
      return YES;
    case '3':
      *rowHz = 697;
      *colHz = 1477;
      return YES;
    case '4':
      *rowHz = 770;
      *colHz = 1209;
      return YES;
    case '5':
      *rowHz = 770;
      *colHz = 1336;
      return YES;
    case '6':
      *rowHz = 770;
      *colHz = 1477;
      return YES;
    case '7':
      *rowHz = 852;
      *colHz = 1209;
      return YES;
    case '8':
      *rowHz = 852;
      *colHz = 1336;
      return YES;
    case '9':
      *rowHz = 852;
      *colHz = 1477;
      return YES;
    case '0':
      *rowHz = 941;
      *colHz = 1336;
      return YES;
    case '*':
      *rowHz = 941;
      *colHz = 1209;
      return YES;
    case '#':
      *rowHz = 941;
      *colHz = 1477;
      return YES;
    case 'A':
    case 'a':
      *rowHz = 697;
      *colHz = 1633;
      return YES;
    case 'B':
    case 'b':
      *rowHz = 770;
      *colHz = 1633;
      return YES;
    case 'C':
    case 'c':
      *rowHz = 852;
      *colHz = 1633;
      return YES;
    case 'D':
    case 'd':
      *rowHz = 941;
      *colHz = 1633;
      return YES;
    default:
      return NO;
  }
}

@interface VOXODtmfSidetoneModule () {
  struct {
    double phaseRow;
    double phaseCol;
    double rowHz;
    double colHz;
    int64_t sampleIndex;
    int64_t totalSamples;
    double sampleRate;
  } _gen;
}
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, strong) AVAudioSourceNode *sourceNode;
@end

@implementation VOXODtmfSidetoneModule

RCT_EXPORT_MODULE(VOXODtmfSidetone);

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)stopEngineIfNeeded {
  if (self.engine.isRunning) {
    [self.engine stop];
  }
  self.engine = nil;
  self.sourceNode = nil;
}

- (void)playSidetoneForDigit:(NSString *)digitStr {
  if (digitStr.length == 0) {
    return;
  }
  unichar c = [digitStr characterAtIndex:0];
  double rowHz = 697;
  double colHz = 1336;
  if (!VoxoDtmfFreqsForCharacter(c, &rowHz, &colHz)) {
    return;
  }

  AVAudioSession *avs = [AVAudioSession sharedInstance];
  double sr = avs.sampleRate;
  if (sr < 8000.0 || sr > 192000.0) {
    sr = 48000.0;
  }

  const double durationSec = 0.12;
  memset(&_gen, 0, sizeof(_gen));
  _gen.rowHz = rowHz;
  _gen.colHz = colHz;
  _gen.sampleRate = sr;
  _gen.phaseRow = 0.0;
  _gen.phaseCol = 0.0;
  _gen.sampleIndex = 0;
  _gen.totalSamples = (int64_t)llround(durationSec * sr);

  [self stopEngineIfNeeded];

  AVAudioEngine *engine = [[AVAudioEngine alloc] init];
  self.engine = engine;

  AVAudioFormat *format =
      [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sr channels:1];
  if (!format) {
    RCTLogWarn(@"[VOXODtmfSidetone] failed to create AVAudioFormat");
    return;
  }

  __weak typeof(self) weakSelf = self;
  AVAudioSourceNode *src = [[AVAudioSourceNode alloc]
      initWithFormat:format
         renderBlock:^OSStatus(BOOL *_Nonnull isSilence,
                               const AudioTimeStamp *_Nonnull timestamp,
                               AVAudioFrameCount frameCount,
                               AudioBufferList *_Nonnull outputData) {
         typeof(self) strongSelf = weakSelf;
         if (!strongSelf) {
           return noErr;
         }
         float *out = (float *)outputData->mBuffers[0].mData;
         if (!out) {
           return noErr;
         }

         double srUse = strongSelf->_gen.sampleRate > 0 ? strongSelf->_gen.sampleRate : 48000.0;
         double row = strongSelf->_gen.rowHz;
         double col = strongSelf->_gen.colHz;
         const double twoPi = 2.0 * M_PI;
         int64_t total = strongSelf->_gen.totalSamples;

         for (AVAudioFrameCount i = 0; i < frameCount; i++) {
           int64_t idx = strongSelf->_gen.sampleIndex;
           if (idx >= total || total < 1) {
             out[i] = 0.f;
             continue;
           }

           float t = (float)idx / (float)(total > 1 ? total - 1 : 1);
           float hann = 0.5f * (1.f - cosf((float)M_PI * 2.f * t));
           float sample = (float)((sin(strongSelf->_gen.phaseRow) +
                                   sin(strongSelf->_gen.phaseCol)) *
                                  (double)kVoxoDtmfSidetoneDualToneGain * (double)hann);
           out[i] = VoxoDtmfSidetoneSoftClip(sample);

           strongSelf->_gen.phaseRow += twoPi * row / srUse;
           strongSelf->_gen.phaseCol += twoPi * col / srUse;
           strongSelf->_gen.sampleIndex++;
         }

         if (strongSelf->_gen.sampleIndex >= total) {
           *isSilence = YES;
         }
         return noErr;
       }];

  self.sourceNode = src;
  AVAudioMixerNode *sidetoneMixer = [[AVAudioMixerNode alloc] init];
  sidetoneMixer.outputVolume = kVoxoDtmfSidetoneMixerVolume;

  [engine attachNode:src];
  [engine attachNode:sidetoneMixer];
  [engine connect:src to:sidetoneMixer format:format];
  [engine connect:sidetoneMixer to:engine.mainMixerNode format:format];

  NSError *err = nil;
  RTCAudioSession *rtc = [RTCAudioSession sharedInstance];
  [rtc lockForConfiguration];
  BOOL ok = [engine startAndReturnError:&err];
  [rtc unlockForConfiguration];

  if (!ok || err) {
    RCTLogWarn(@"[VOXODtmfSidetone] engine start failed: %@", err);
    [self stopEngineIfNeeded];
    return;
  }

  double delaySec = durationSec + 0.05;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delaySec * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        [self stopEngineIfNeeded];
      });
}

RCT_EXPORT_METHOD(playSidetone:(NSString *)digit) {
  NSString *safe =
      (digit.length > 0) ? [digit substringToIndex:1] : @"";
  dispatch_async(dispatch_get_main_queue(), ^{
    [self playSidetoneForDigit:safe];
  });
}

@end
