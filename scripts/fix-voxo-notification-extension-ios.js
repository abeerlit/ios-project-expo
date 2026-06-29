#!/usr/bin/env node
/**
 * Sync VoxoNotificationExtension (SMS NSE) from native-ios/ and ensure App Group entitlements.
 * Run from ios:setup post-prebuild (after copy-voxo-native-ios).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BARE_EXT = path.join(ROOT, "native-ios", "VoxoNotificationExtension");
const IOS = path.join(ROOT, "ios");
const EXT_DIR = path.join(IOS, "VoxoNotificationExtension");
const PBX = path.join(IOS, "VOXOConnect.xcodeproj", "project.pbxproj");

const APP_GROUP = process.env.APP_GROUP || "group.co.voxo.voxo-ios";
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || "co.voxo.voxo-ios";
const EXT_BUNDLE_ID = `${BUNDLE_ID}.VoxoNotificationExtension`;
const DEVELOPMENT_TEAM = "FLD7A54T23";

const IDS = {
  product: "VNE0E0021A68108700A75B9A",
  notifRef: "VNE0E00B1A68108700A75B9A",
  notifBuild: "VNE0E00C1A68108700A75B9A",
  cacheRef: "VNE0E00D1A68108700A75B9A",
  cacheBuild: "VNE0E00E1A68108700A75B9A",
  chatPrefsRef: "VNE0E00F1A68108700A75B9A",
  chatPrefsBuild: "VNE0E0101A68108700A75B9A",
  embedBuild: "VNE0E0121A68108700A75B9A",
  target: "VNE0E0011A68108700A75B9A",
  bcl: "VNE0E0031A68108700A75B9A",
  debug: "VNE0E0041A68108700A75B9A",
  release: "VNE0E0051A68108700A75B9A",
  sources: "VNE0E0061A68108700A75B9A",
  frameworks: "VNE0E0071A68108700A75B9A",
  resources: "VNE0E0081A68108700A75B9A",
  group: "VNE0E00A1A68108700A75B9A",
  embedPhase: "VNE0E0111A68108700A75B9A",
  proxy: "VNE0E0131A68108700A75B9A",
  dependency: "VNE0E0141A68108700A75B9A"
};

function copyExtensionSources() {
  if (!fs.existsSync(BARE_EXT)) {
    throw new Error(`Missing bare extension: ${BARE_EXT}`);
  }
  fs.mkdirSync(EXT_DIR, { recursive: true });
  for (const name of fs.readdirSync(BARE_EXT)) {
    const src = path.join(BARE_EXT, name);
    const dest = path.join(EXT_DIR, name);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
  const entPath = path.join(EXT_DIR, "VoxoNotificationExtension.entitlements");
  if (!fs.existsSync(entPath)) {
    fs.writeFileSync(
      entPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${APP_GROUP}</string>
\t</array>
</dict>
</plist>
`
    );
  }
  console.log("[voxo-nse] copied VoxoNotificationExtension/");
}

function patchEntitlementsInPbx(pbx) {
  const entLine = `CODE_SIGN_ENTITLEMENTS = VoxoNotificationExtension/VoxoNotificationExtension.entitlements;`;
  if (pbx.includes("VoxoNotificationExtension") && !pbx.includes(entLine)) {
    return pbx.replace(
      /(\/\* VoxoNotificationExtension \*\/ = \{[\s\S]*?buildSettings = \{[\s\S]*?)(CODE_SIGN_STYLE = Automatic;)/g,
      `$1${entLine}\n\t\t\t\t$2`
    );
  }
  return pbx;
}

function patchChatPrefsCacheInPbx(pbx) {
  if (pbx.includes("ChatNotificationPrefsCache.swift")) {
    return pbx;
  }
  pbx = pbx.replace(
    "/* Begin PBXBuildFile section */",
    `/* Begin PBXBuildFile section */
\t\t${IDS.chatPrefsBuild} /* ChatNotificationPrefsCache.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */; };`
  );
  pbx = pbx.replace(
    "/* Begin PBXFileReference section */",
    `/* Begin PBXFileReference section */
\t\t${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ChatNotificationPrefsCache.swift; sourceTree = "<group>"; };`
  );
  pbx = pbx.replace(
    `${IDS.cacheRef} /* SmsNotificationCache.swift */,`,
    `${IDS.cacheRef} /* SmsNotificationCache.swift */,
\t\t\t\t${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */,`
  );
  pbx = pbx.replace(
    `${IDS.cacheBuild} /* SmsNotificationCache.swift in Sources */,`,
    `${IDS.cacheBuild} /* SmsNotificationCache.swift in Sources */,
\t\t\t\t${IDS.chatPrefsBuild} /* ChatNotificationPrefsCache.swift in Sources */,`
  );
  console.log("[voxo-nse] added ChatNotificationPrefsCache.swift to project.pbxproj");
  return pbx;
}

function patchPbxproj() {
  if (!fs.existsSync(PBX)) {
    console.warn("[voxo-nse] no project.pbxproj — skip Xcode patch");
    return;
  }
  let pbx = fs.readFileSync(PBX, "utf8");
  if (pbx.includes("VNE0E0011A68108700A75B9A /* VoxoNotificationExtension */")) {
    pbx = patchEntitlementsInPbx(pbx);
    pbx = patchChatPrefsCacheInPbx(pbx);
    fs.writeFileSync(PBX, pbx);
    console.log("[voxo-nse] VoxoNotificationExtension target present — ensuring embed + entitlements");
    const { repairEmbeddedExtensionsPbxproj } = require("./repair-ios-embedded-extensions");
    repairEmbeddedExtensionsPbxproj();
    return;
  }

  const buildFiles = `\t\t${IDS.embedBuild} /* VoxoNotificationExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${IDS.product} /* VoxoNotificationExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
\t\t${IDS.notifBuild} /* NotificationService.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.notifRef} /* NotificationService.swift */; };
\t\t${IDS.cacheBuild} /* SmsNotificationCache.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.cacheRef} /* SmsNotificationCache.swift */; };
\t\t${IDS.chatPrefsBuild} /* ChatNotificationPrefsCache.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */; };
`;

  const fileRefs = `\t\t${IDS.product} /* VoxoNotificationExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = VoxoNotificationExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${IDS.notifRef} /* NotificationService.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = NotificationService.swift; sourceTree = "<group>"; };
\t\t${IDS.cacheRef} /* SmsNotificationCache.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SmsNotificationCache.swift; sourceTree = "<group>"; };
\t\t${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ChatNotificationPrefsCache.swift; sourceTree = "<group>"; };
`;

  const containerProxy = `\t\t${IDS.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 83CBB9F71A601CBA00E9B192 /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${IDS.target};
\t\t\tremoteInfo = VoxoNotificationExtension;
\t\t};
`;

  const copyPhase = `\t\t${IDS.embedPhase} /* Embed Foundation Extensions */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t${IDS.embedBuild} /* VoxoNotificationExtension.appex in Embed Foundation Extensions */,
\t\t\t);
\t\t\tname = "Embed Foundation Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const frameworksExt = `\t\t${IDS.frameworks} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const group = `\t\t${IDS.group} /* VoxoNotificationExtension */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${IDS.notifRef} /* NotificationService.swift */,
\t\t\t\t${IDS.cacheRef} /* SmsNotificationCache.swift */,
\t\t\t\t${IDS.chatPrefsRef} /* ChatNotificationPrefsCache.swift */,
\t\t\t);
\t\t\tpath = VoxoNotificationExtension;
\t\t\tsourceTree = "<group>";
\t\t};
`;

  const nativeTarget = `\t\t${IDS.target} /* VoxoNotificationExtension */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${IDS.bcl} /* Build configuration list for PBXNativeTarget "VoxoNotificationExtension" */;
\t\t\tbuildPhases = (
\t\t\t\t${IDS.sources} /* Sources */,
\t\t\t\t${IDS.frameworks} /* Frameworks */,
\t\t\t\t${IDS.resources} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = VoxoNotificationExtension;
\t\t\tproductName = VoxoNotificationExtension;
\t\t\tproductReference = ${IDS.product} /* VoxoNotificationExtension.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t};
`;

  const resources = `\t\t${IDS.resources} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const sources = `\t\t${IDS.sources} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${IDS.notifBuild} /* NotificationService.swift in Sources */,
\t\t\t\t${IDS.cacheBuild} /* SmsNotificationCache.swift in Sources */,
\t\t\t\t${IDS.chatPrefsBuild} /* ChatNotificationPrefsCache.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const targetDep = `\t\t${IDS.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${IDS.target} /* VoxoNotificationExtension */;
\t\t\ttargetProxy = ${IDS.proxy} /* PBXContainerItemProxy */;
\t\t};
`;

  const entLine = `CODE_SIGN_ENTITLEMENTS = VoxoNotificationExtension/VoxoNotificationExtension.entitlements;`;
  const extDebug = `\t\t${IDS.debug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\t${entLine}
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = ${DEVELOPMENT_TEAM};
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_FILE = VoxoNotificationExtension/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = VoxoNotificationExtension;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.1;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t\t"@executable_path/../../Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${EXT_BUNDLE_ID}";
\t\t\t\tPRODUCT_NAME = "\$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
`;

  const extRelease = `\t\t${IDS.release} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\t${entLine}
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = ${DEVELOPMENT_TEAM};
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_FILE = VoxoNotificationExtension/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = VoxoNotificationExtension;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.1;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t\t"@executable_path/../../Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${EXT_BUNDLE_ID}";
\t\t\t\tPRODUCT_NAME = "\$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Release;
\t\t};
`;

  const extBcl = `\t\t${IDS.bcl} /* Build configuration list for PBXNativeTarget "VoxoNotificationExtension" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${IDS.debug} /* Debug */,
\t\t\t\t${IDS.release} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
`;

  pbx = pbx.replace("/* End PBXBuildFile section */", `${buildFiles}/* End PBXBuildFile section */`);
  pbx = pbx.replace("/* End PBXFileReference section */", `${fileRefs}/* End PBXFileReference section */`);

  if (pbx.includes("PBXContainerItemProxy section")) {
    pbx = pbx.replace("/* End PBXContainerItemProxy section */", `${containerProxy}/* End PBXContainerItemProxy section */`);
  } else {
    pbx = pbx.replace(
      "/* Begin PBXCopyFilesBuildPhase section */",
      `/* Begin PBXContainerItemProxy section */\n${containerProxy}/* End PBXContainerItemProxy section */\n\n/* Begin PBXCopyFilesBuildPhase section */`
    );
  }

  if (pbx.includes("Embed Foundation Extensions")) {
    pbx = pbx.replace(
      /files = \(\n(\s+SCE0E0121A68108700A75B9A \/\* ScreenCaptureExtension\.appex in Embed Foundation Extensions \*\/,\n)/,
      `files = (\n$1\t\t\t\t${IDS.embedBuild} /* VoxoNotificationExtension.appex in Embed Foundation Extensions */,\n`
    );
  } else if (pbx.includes("PBXCopyFilesBuildPhase section")) {
    pbx = pbx.replace("/* End PBXCopyFilesBuildPhase section */", `${copyPhase}/* End PBXCopyFilesBuildPhase section */`);
  } else {
    pbx = pbx.replace(
      "/* Begin PBXFrameworksBuildPhase section */",
      `/* Begin PBXCopyFilesBuildPhase section */\n${copyPhase}/* End PBXCopyFilesBuildPhase section */\n\n/* Begin PBXFrameworksBuildPhase section */`
    );
  }

  pbx = pbx.replace("/* End PBXFrameworksBuildPhase section */", `${frameworksExt}/* End PBXFrameworksBuildPhase section */`);
  pbx = pbx.replace(
    /83CBB9F61A601CBA00E9B192 = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t13B07FAE1A68108700A75B9A \/\* VOXOConnect \*\/,/,
    `83CBB9F61A601CBA00E9B192 = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t13B07FAE1A68108700A75B9A /* VOXOConnect */,\n\t\t\t\t${IDS.group} /* VoxoNotificationExtension */,`
  );
  pbx = pbx.replace(
    /83CBBA001A601CBA00E9B192 \/\* Products \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t13B07F961A680F5B00A75B9A \/\* VOXOConnect\.app \*\/,/,
    `83CBBA001A601CBA00E9B192 /* Products */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t13B07F961A680F5B00A75B9A /* VOXOConnect.app */,\n\t\t\t\t${IDS.product} /* VoxoNotificationExtension.appex */,`
  );
  pbx = pbx.replace("/* End PBXGroup section */", `${group}/* End PBXGroup section */`);

  if (!pbx.includes('name = "Embed Foundation Extensions"')) {
    pbx = pbx.replace(
      /13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/ = \{\n\t\t\tisa = PBXNativeTarget;[\s\S]*?buildPhases = \(\n/,
      (m) => `${m}\t\t\t\t${IDS.embedPhase} /* Embed Foundation Extensions */,\n`
    );
  }

  if (!pbx.includes(`${IDS.dependency} /* PBXTargetDependency */`)) {
    pbx = pbx.replace(
      /(13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/ = \{[\s\S]*?dependencies = \(\n)([\s\S]*?)(\t+\);\n\t+name = VOXOConnect;)/,
      (block, pre, depsInner, post) => {
        const line = `\t\t\t\t${IDS.dependency} /* PBXTargetDependency */,\n`;
        const nextDeps =
          depsInner.trim().length > 0 ? `${depsInner}${line}` : line;
        return `${pre}${nextDeps}${post}`;
      }
    );
  }

  pbx = pbx.replace("/* End PBXNativeTarget section */", `${nativeTarget}/* End PBXNativeTarget section */`);
  pbx = pbx.replace(
    /targets = \(\n\t\t\t\t13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/,/,
    `targets = (\n\t\t\t\t13B07F861A680F5B00A75B9A /* VOXOConnect */,\n\t\t\t\t${IDS.target} /* VoxoNotificationExtension */,`
  );
  if (!pbx.includes(`${IDS.target} = {`)) {
    pbx = pbx.replace(
      /TargetAttributes = \{\n\t\t\t\t\t13B07F861A680F5B00A75B9A = \{/,
      `TargetAttributes = {\n\t\t\t\t\t${IDS.target} = {\n\t\t\t\t\t\tDevelopmentTeam = ${DEVELOPMENT_TEAM};\n\t\t\t\t\t};\n\t\t\t\t\t13B07F861A680F5B00A75B9A = {`
    );
  }

  pbx = pbx.replace("/* End PBXResourcesBuildPhase section */", `${resources}/* End PBXResourcesBuildPhase section */`);
  pbx = pbx.replace("/* End PBXSourcesBuildPhase section */", `${sources}/* End PBXSourcesBuildPhase section */`);

  if (!pbx.includes("PBXTargetDependency section")) {
    pbx = pbx.replace(
      "/* Begin XCBuildConfiguration section */",
      `/* Begin PBXTargetDependency section */\n${targetDep}/* End PBXTargetDependency section */\n\n/* Begin XCBuildConfiguration section */`
    );
  } else {
    pbx = pbx.replace("/* End PBXTargetDependency section */", `${targetDep}/* End PBXTargetDependency section */`);
  }

  pbx = pbx.replace("/* End XCBuildConfiguration section */", `${extDebug}${extRelease}/* End XCBuildConfiguration section */`);
  pbx = pbx.replace("/* End XCConfigurationList section */", `${extBcl}/* End XCConfigurationList section */`);

  fs.writeFileSync(PBX, pbx);
  console.log("[voxo-nse] patched VOXOConnect.xcodeproj for VoxoNotificationExtension");
  const { repairEmbeddedExtensionsPbxproj } = require("./repair-ios-embedded-extensions");
  repairEmbeddedExtensionsPbxproj();
}

function main() {
  copyExtensionSources();
  patchPbxproj();
}

if (require.main === module) {
  main();
}

module.exports = { copyExtensionSources, patchPbxproj };
