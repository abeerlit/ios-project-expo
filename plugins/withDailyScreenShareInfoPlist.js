const { withInfoPlist } = require("@expo/config-plugins");

/** Daily ReplayKit: app group + broadcast extension bundle id for full-device screen share. */
function withDailyScreenShareInfoPlist(config, options = {}) {
  const appGroup = options.appGroup ?? "group.co.voxo.voxo-ios";
  const bundleId =
    options.bundleId ??
    process.env.IOS_BUNDLE_ID ??
    config.ios?.bundleIdentifier ??
    "co.voxo.voxo-ios";
  const extensionId = `${bundleId}.ScreenCaptureExtension`;

  return withInfoPlist(config, (mod) => {
    mod.modResults.RTCAppGroupIdentifier = appGroup;
    mod.modResults.DailyScreenCaptureExtensionBundleIdentifier = extensionId;
    return mod;
  });
}

module.exports = { withDailyScreenShareInfoPlist };
