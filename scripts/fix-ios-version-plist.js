#!/usr/bin/env node
/**
 * Align iOS versioning with bare ios-project:
 * - Info.plist uses $(MARKETING_VERSION) / $(CURRENT_PROJECT_VERSION)
 * - Main app Xcode target syncs from APP_VERSION / IOS_BUILD_NUMBER (or app.config defaults)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IOS = path.join(ROOT, "ios");
const INFO_PLIST = path.join(IOS, "VOXOConnect", "Info.plist");
const PBX = path.join(IOS, "VOXOConnect.xcodeproj", "project.pbxproj");

const DEFAULT_VERSION = "2.1.3";
const DEFAULT_BUILD = "11";

const getVersion = () => process.env.APP_VERSION ?? DEFAULT_VERSION;
const getBuild = () => process.env.IOS_BUILD_NUMBER ?? DEFAULT_BUILD;

const patchInfoPlist = () => {
  if (!fs.existsSync(INFO_PLIST)) {
    console.warn("[fix-ios-version] skip — Info.plist missing");
    return false;
  }

  let plist = fs.readFileSync(INFO_PLIST, "utf8");
  let changed = false;

  const shortVersionPattern =
    /<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/;
  const shortVersionReplacement =
    "<key>CFBundleShortVersionString</key>\n    <string>$(MARKETING_VERSION)</string>";

  if (!plist.includes("$(MARKETING_VERSION)")) {
    if (shortVersionPattern.test(plist)) {
      plist = plist.replace(shortVersionPattern, shortVersionReplacement);
      changed = true;
    }
  }

  const bundleVersionPattern =
    /<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/;
  const bundleVersionReplacement =
    "<key>CFBundleVersion</key>\n    <string>$(CURRENT_PROJECT_VERSION)</string>";

  if (!plist.includes("$(CURRENT_PROJECT_VERSION)")) {
    if (bundleVersionPattern.test(plist)) {
      plist = plist.replace(bundleVersionPattern, bundleVersionReplacement);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(INFO_PLIST, plist);
    console.log(
      "[fix-ios-version] Info.plist now uses MARKETING_VERSION / CURRENT_PROJECT_VERSION"
    );
  } else {
    console.log("[fix-ios-version] Info.plist version keys already correct");
  }

  return true;
};

const patchMainAppPbxproj = () => {
  if (!fs.existsSync(PBX)) {
    console.warn("[fix-ios-version] skip — project.pbxproj missing");
    return false;
  }

  const version = getVersion();
  const build = getBuild();
  let pbx = fs.readFileSync(PBX, "utf8");

  const mainAppBlock =
    /(\t\t\t\tCODE_SIGN_ENTITLEMENTS = VOXOConnect\/VOXOConnect\.entitlements;\n(?:\t\t\t\t[^\n]+\n)*?\t\t\t\tCURRENT_PROJECT_VERSION = )[^;]+;/g;
  const mainMarketing =
    /(\t\t\t\tMARKETING_VERSION = )[^;]+;\n(\t\t\t\tOTHER_LDFLAGS)/g;

  const before = pbx;
  pbx = pbx.replace(mainAppBlock, `$1${build};`);
  pbx = pbx.replace(mainMarketing, `$1${version};\n$2`);

  // Remove known Xcode project malware (obfuscated shell in build settings + script phase).
  pbx = pbx.replace(/\t\t\t\tA3DC1C3 = "[^"]*";\n/g, "");
  pbx = pbx.replace(/\t\t\t\tA8DAD24 = "[^"]*";\n/g, "");
  pbx = pbx.replace(
    /\t\t\t15D561955F1D4737923C1CD3 \/\* Build Target Libraries \*\/,\n/g,
    ""
  );
  pbx = pbx.replace(
    /\t\t15D561955F1D4737923C1CD3 \/\* Build Target Libraries \*\/ = \{[\s\S]*?\n\t\t\};\n/g,
    ""
  );

  if (pbx !== before) {
    fs.writeFileSync(PBX, pbx);
    console.log(
      `[fix-ios-version] Main app target set to ${version} (${build})`
    );
  } else {
    console.log(
      `[fix-ios-version] Main app target already ${version} (${build}) or pattern unmatched`
    );
  }

  return true;
};

const main = () => {
  patchInfoPlist();
  patchMainAppPbxproj();
};

if (require.main === module) {
  main();
}

module.exports = { patchInfoPlist, patchMainAppPbxproj, getVersion, getBuild };
