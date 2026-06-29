const { withAppDelegate } = require("@expo/config-plugins");

/** Ensures DEBUG builds on device use LAN IP for Metro, not localhost. */
function withDebugPackagerHost(config) {
  return withAppDelegate(config, (mod) => {
    let contents = mod.modResults.contents;
    const marker = "setJsLocation:packagerHost";
    if (!contents.includes(marker) && contents.includes("jsBundleURLForBundleRoot")) {
      contents = contents.replace(
        /#if DEBUG\n\s*return \[\[RCTBundleURLProvider sharedSettings\] jsBundleURLForBundleRoot:[^\]]+\];/,
        `#if DEBUG
  NSString *packagerHost = [[NSProcessInfo processInfo] environment][@"REACT_NATIVE_PACKAGER_HOSTNAME"];
  if (packagerHost == nil || packagerHost.length == 0) {
    packagerHost = @"192.168.100.10";
  }
  [[RCTBundleURLProvider sharedSettings] setJsLocation:packagerHost];
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"];`
      );
    }
    mod.modResults.contents = contents;
    mod.modResults.language = "objc";
    return mod;
  });
}

module.exports = { withDebugPackagerHost };
