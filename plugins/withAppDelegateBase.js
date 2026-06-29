const { withAppDelegate, withInfoPlist } = require("@expo/config-plugins");

// Keep in sync with src/features/authentication/config/google-signin-config.ts
const GOOGLE_URL_SCHEME =
  "com.googleusercontent.apps.381032391922-hg2uocpbhgh2hr8kimv4ue5ta41n7isn";

function withAppDelegateBase(config) {
  config = withInfoPlist(config, (mod) => {
    const existing = mod.modResults.CFBundleURLTypes ?? [];
    mod.modResults.CFBundleURLTypes = [
      ...existing,
      {
        CFBundleTypeRole: "Editor",
        CFBundleURLSchemes: [GOOGLE_URL_SCHEME]
      }
    ];
    return mod;
  });

  return withAppDelegate(config, (mod) => {
    let contents = mod.modResults.contents;
    if (!contents.includes("#import <Firebase.h>")) {
      contents = `#import <Firebase.h>\n#import <GoogleSignIn/GoogleSignIn.h>\n${contents}`;
    }
    if (!contents.includes("GoogleService-Info")) {
      contents = contents.replace(
        "didFinishLaunchingWithOptions:(NSDictionary *)launchOptions\n{",
        `didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  if ([[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"]) {
    [FIRApp configure];
  } else {
    NSLog(@"[VOXO] GoogleService-Info.plist missing — skipping [FIRApp configure]");
  }`
      );
      // Remove duplicate bare [FIRApp configure] if present from prior prebuild
      contents = contents.replace(/\n  \[FIRApp configure\];\n/g, "\n");
    }
    mod.modResults.contents = contents;
    mod.modResults.language = "objc";
    return mod;
  });
}

module.exports = { withAppDelegateBase };
