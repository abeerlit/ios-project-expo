const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

/** Center splash logo at ~35% screen width instead of full-bleed (1024px assets look huge otherwise). */
const SPLASH_CONSTRAINTS = `                            <constraint firstItem="EXPO-SplashScreen" firstAttribute="centerX" secondItem="EXPO-ContainerView" secondAttribute="centerX" id="voxo-splash-centerX"/>
                            <constraint firstItem="EXPO-SplashScreen" firstAttribute="centerY" secondItem="EXPO-ContainerView" secondAttribute="centerY" id="voxo-splash-centerY"/>
                            <constraint firstItem="EXPO-SplashScreen" firstAttribute="width" secondItem="EXPO-ContainerView" secondAttribute="width" multiplier="0.35" id="voxo-splash-width"/>
                            <constraint firstItem="EXPO-SplashScreen" firstAttribute="height" secondItem="EXPO-SplashScreen" secondAttribute="width" multiplier="1" id="voxo-splash-aspect"/>`;

function withVoxoSplash(config) {
  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const storyboard = path.join(
        mod.modRequest.platformProjectRoot,
        "VOXOConnect",
        "SplashScreen.storyboard"
      );
      if (!fs.existsSync(storyboard)) return mod;

      let xml = fs.readFileSync(storyboard, "utf8");
      if (xml.includes("voxo-splash-centerX")) return mod;

      xml = xml.replace(
        /<constraints>[\s\S]*?<\/constraints>/,
        `<constraints>\n${SPLASH_CONSTRAINTS}\n                        </constraints>`
      );
      fs.writeFileSync(storyboard, xml);
      return mod;
    }
  ]);

  return config;
}

module.exports = { withVoxoSplash };
