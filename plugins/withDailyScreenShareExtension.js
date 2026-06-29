const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

/**
 * Copies bare ScreenCaptureExtension + patches Xcode/Podfile for Daily full-device share.
 * Safe to run on every prebuild (idempotent).
 */
function withDailyScreenShareExtension(config, options = {}) {
  return withDangerousMod(config, [
    "ios",
    async (mod) => {
      const script = path.join(
        mod.modRequest.projectRoot,
        "scripts",
        "setup-screen-capture-extension-ios.js"
      );
      process.env.APP_GROUP =
        options.appGroup ?? process.env.APP_GROUP ?? "group.co.voxo.voxo-ios";
      process.env.IOS_BUNDLE_ID =
        options.bundleId ??
        process.env.IOS_BUNDLE_ID ??
        config.ios?.bundleIdentifier ??
        "co.voxo.voxo-ios";
      require(script);
      return mod;
    }
  ]);
}

module.exports = { withDailyScreenShareExtension };
