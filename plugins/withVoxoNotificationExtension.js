const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

function withVoxoNotificationExtension(config) {
  const nativeNse = path.resolve(__dirname, "../native-ios/VoxoNotificationExtension");

  return withDangerousMod(config, [
    "ios",
    async (mod) => {
      const dest = path.join(
        mod.modRequest.platformProjectRoot,
        "VoxoNotificationExtension"
      );
      if (!fs.existsSync(nativeNse)) return mod;

      process.env.APP_GROUP =
        process.env.APP_GROUP ?? "group.co.voxo.voxo-ios";
      process.env.IOS_BUNDLE_ID =
        process.env.IOS_BUNDLE_ID ??
        config.ios?.bundleIdentifier ??
        "co.voxo.voxo-ios";

      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(nativeNse)) {
        const src = path.join(nativeNse, entry);
        const out = path.join(dest, entry);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, out, { recursive: true });
        } else {
          fs.copyFileSync(src, out);
        }
      }

      const { copyExtensionSources, patchPbxproj } = require("../scripts/fix-voxo-notification-extension-ios");
      copyExtensionSources();
      patchPbxproj();
      const { repairEmbeddedExtensionsPbxproj } = require("../scripts/repair-ios-embedded-extensions");
      repairEmbeddedExtensionsPbxproj();

      return mod;
    }
  ]);
}

module.exports = { withVoxoNotificationExtension };
