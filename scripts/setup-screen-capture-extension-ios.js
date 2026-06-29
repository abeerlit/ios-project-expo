#!/usr/bin/env node
/**
 * Daily ReplayKit broadcast extension (full-device screen share) for ios-project-expo.
 * Copies native-ios ScreenCaptureExtension, patches Xcode + main Info.plist, Podfile.
 * Run: node scripts/setup-screen-capture-extension-ios.js && cd ios && pod install
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BARE_EXT = path.join(ROOT, "native-ios", "ScreenCaptureExtension");
const IOS = path.join(ROOT, "ios");
const EXT_DIR = path.join(IOS, "ScreenCaptureExtension");
const PBX = path.join(IOS, "VOXOConnect.xcodeproj", "project.pbxproj");
const MAIN_PLIST = path.join(IOS, "VOXOConnect", "Info.plist");
const PODFILE = path.join(IOS, "Podfile");

const APP_GROUP =
  process.env.APP_GROUP || "group.co.voxo.voxo-ios";
const BUNDLE_ID =
  process.env.IOS_BUNDLE_ID || "co.voxo.voxo-ios";
const EXT_BUNDLE_ID = `${BUNDLE_ID}.ScreenCaptureExtension`;
const DEVELOPMENT_TEAM = "FLD7A54T23";

const IDS = {
  product: "SCE0E0021A68108700A75B9A",
  sampleRef: "SCE0E00B1A68108700A75B9A",
  sampleBuild: "SCE0E00C1A68108700A75B9A",
  replayRef: "SCE0E00D1A68108700A75B9A",
  replayBuild: "SCE0E00E1A68108700A75B9A",
  podsFwRef: "SCE0E00F1A68108700A75B9A",
  podsFwBuild: "SCE0E0101A68108700A75B9A",
  embedBuild: "SCE0E0121A68108700A75B9A",
  target: "SCE0E0011A68108700A75B9A",
  bcl: "SCE0E0031A68108700A75B9A",
  debug: "SCE0E0041A68108700A75B9A",
  release: "SCE0E0051A68108700A75B9A",
  sources: "SCE0E0061A68108700A75B9A",
  frameworks: "SCE0E0071A68108700A75B9A",
  resources: "SCE0E0081A68108700A75B9A",
  cpCheck: "SCE0E0091A68108700A75B9A",
  group: "SCE0E00A1A68108700A75B9A",
  embedPhase: "SCE0E0111A68108700A75B9A",
  proxy: "SCE0E0131A68108700A75B9A",
  dependency: "SCE0E0141A68108700A75B9A",
  podsDebugXc: "SCE0E0151A68108700A75B9A",
  podsReleaseXc: "SCE0E0161A68108700A75B9A"
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
  const handler = path.join(EXT_DIR, "SampleHandler.swift");
  let swift = fs.readFileSync(handler, "utf8");
  if (!swift.includes(APP_GROUP)) {
    swift = swift.replace(
      /super\.init\(appGroupIdentifier:\s*"[^"]+"\)/,
      `super.init(appGroupIdentifier: "${APP_GROUP}")`
    );
    fs.writeFileSync(handler, swift);
  }
  console.log("[screen-capture] copied ScreenCaptureExtension/");
}

function patchMainInfoPlist() {
  let plist = fs.readFileSync(MAIN_PLIST, "utf8");
  if (!plist.includes("RTCAppGroupIdentifier")) {
    const insert = `    <key>RTCAppGroupIdentifier</key>\n    <string>${APP_GROUP}</string>\n    <key>DailyScreenCaptureExtensionBundleIdentifier</key>\n    <string>${EXT_BUNDLE_ID}</string>\n`;
    plist = plist.replace(
      /<key>UIBackgroundModes<\/key>/,
      `${insert}    <key>UIBackgroundModes</key>`
    );
    fs.writeFileSync(MAIN_PLIST, plist);
    console.log("[screen-capture] added Daily keys to VOXOConnect/Info.plist");
  }
}

function patchPodfile() {
  const { fixPodfile } = require("./fix-podfile-structure");
  if (fixPodfile()) {
    console.log("[screen-capture] Podfile structure updated");
  }
}

function patchPbxproj() {
  if (!fs.existsSync(PBX)) {
    console.warn("[screen-capture] no project.pbxproj — skip Xcode patch");
    return;
  }
  let pbx = fs.readFileSync(PBX, "utf8");
  if (
    pbx.includes(`${IDS.target} /* ScreenCaptureExtension */ = {\n\t\t\tisa = PBXNativeTarget`) &&
    pbx.includes(`${IDS.sampleRef} /* SampleHandler.swift */`)
  ) {
    patchMainInfoPlist();
    if (!pbx.includes("PBXContainerItemProxy section")) {
      const containerProxy = `\t\t${IDS.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 83CBB9F71A601CBA00E9B192 /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${IDS.target};
\t\t\tremoteInfo = ScreenCaptureExtension;
\t\t};
`;
      pbx = pbx.replace(
        "/* Begin PBXTargetDependency section */",
        `/* Begin PBXContainerItemProxy section */\n${containerProxy}/* End PBXContainerItemProxy section */\n\n/* Begin PBXTargetDependency section */`
      );
      pbx = pbx.replace(
        /SCE0E0141A68108700A75B9A \/\* PBXTargetDependency \*\/ = \{[\s\S]*?target = SCE0E0011A68108700A75B9A \/\* ScreenCaptureExtension \*\/;\n\t\t\};/,
        `\t\t${IDS.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${IDS.target} /* ScreenCaptureExtension */;
\t\t\ttargetProxy = ${IDS.proxy} /* PBXContainerItemProxy */;
\t\t};`
      );
      fs.writeFileSync(PBX, pbx);
      console.log("[screen-capture] added missing PBXContainerItemProxy");
    }
    console.log("[screen-capture] ScreenCaptureExtension already in project.pbxproj");
    const { repairEmbeddedExtensionsPbxproj } = require("./repair-ios-embedded-extensions");
    repairEmbeddedExtensionsPbxproj();
    return;
  }

  const buildFiles = `\t\t${IDS.embedBuild} /* ScreenCaptureExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${IDS.product} /* ScreenCaptureExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
\t\t${IDS.sampleBuild} /* SampleHandler.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.sampleRef} /* SampleHandler.swift */; };
\t\t${IDS.replayBuild} /* ReplayKit.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${IDS.replayRef} /* ReplayKit.framework */; };
\t\t${IDS.podsFwBuild} /* Pods_ScreenCaptureExtension.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${IDS.podsFwRef} /* Pods_ScreenCaptureExtension.framework */; };
`;

  const fileRefs = `\t\t${IDS.product} /* ScreenCaptureExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ScreenCaptureExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${IDS.sampleRef} /* SampleHandler.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SampleHandler.swift; sourceTree = "<group>"; };
\t\t${IDS.replayRef} /* ReplayKit.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = ReplayKit.framework; path = System/Library/Frameworks/ReplayKit.framework; sourceTree = SDKROOT; };
\t\t${IDS.podsFwRef} /* Pods_ScreenCaptureExtension.framework */ = {isa = PBXFileReference; explicitFileType = wrapper.framework; includeInIndex = 0; path = Pods_ScreenCaptureExtension.framework; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${IDS.podsDebugXc} /* Pods-ScreenCaptureExtension.debug.xcconfig */ = {isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = text.xcconfig; name = "Pods-ScreenCaptureExtension.debug.xcconfig"; path = "Target Support Files/Pods-ScreenCaptureExtension/Pods-ScreenCaptureExtension.debug.xcconfig"; sourceTree = "<group>"; };
\t\t${IDS.podsReleaseXc} /* Pods-ScreenCaptureExtension.release.xcconfig */ = {isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = text.xcconfig; name = "Pods-ScreenCaptureExtension.release.xcconfig"; path = "Target Support Files/Pods-ScreenCaptureExtension/Pods-ScreenCaptureExtension.release.xcconfig"; sourceTree = "<group>"; };
`;

  const containerProxy = `\t\t${IDS.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 83CBB9F71A601CBA00E9B192 /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${IDS.target};
\t\t\tremoteInfo = ScreenCaptureExtension;
\t\t};
`;

  const copyPhase = `\t\t${IDS.embedPhase} /* Embed Foundation Extensions */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t${IDS.embedBuild} /* ScreenCaptureExtension.appex in Embed Foundation Extensions */,
\t\t\t);
\t\t\tname = "Embed Foundation Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const frameworksExt = `\t\t${IDS.frameworks} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${IDS.replayBuild} /* ReplayKit.framework in Frameworks */,
\t\t\t\t${IDS.podsFwBuild} /* Pods_ScreenCaptureExtension.framework in Frameworks */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const group = `\t\t${IDS.group} /* ScreenCaptureExtension */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${IDS.sampleRef} /* SampleHandler.swift */,
\t\t\t);
\t\t\tpath = ScreenCaptureExtension;
\t\t\tsourceTree = "<group>";
\t\t};
`;

  const nativeTarget = `\t\t${IDS.target} /* ScreenCaptureExtension */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${IDS.bcl} /* Build configuration list for PBXNativeTarget "ScreenCaptureExtension" */;
\t\t\tbuildPhases = (
\t\t\t\t${IDS.sources} /* Sources */,
\t\t\t\t${IDS.frameworks} /* Frameworks */,
\t\t\t\t${IDS.resources} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ScreenCaptureExtension;
\t\t\tproductName = ScreenCaptureExtension;
\t\t\tproductReference = ${IDS.product} /* ScreenCaptureExtension.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t};
`;

  // [CP] Check Pods Manifest.lock is added by `pod install` — do not inject here (runs before Pods exist).

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
\t\t\t\t${IDS.sampleBuild} /* SampleHandler.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`;

  const targetDep = `\t\t${IDS.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${IDS.target} /* ScreenCaptureExtension */;
\t\t\ttargetProxy = ${IDS.proxy} /* PBXContainerItemProxy */;
\t\t};
`;

  const extDebug = `\t\t${IDS.debug} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbaseConfigurationReference = ${IDS.podsDebugXc} /* Pods-ScreenCaptureExtension.debug.xcconfig */;
\t\t\tbuildSettings = {
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ScreenCaptureExtension/ScreenCaptureExtension.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = ${DEVELOPMENT_TEAM};
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_FILE = ScreenCaptureExtension/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = ScreenCaptureExtension;
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
\t\t\tbaseConfigurationReference = ${IDS.podsReleaseXc} /* Pods-ScreenCaptureExtension.release.xcconfig */;
\t\t\tbuildSettings = {
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ScreenCaptureExtension/ScreenCaptureExtension.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = ${DEVELOPMENT_TEAM};
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_FILE = ScreenCaptureExtension/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = ScreenCaptureExtension;
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

  const extBcl = `\t\t${IDS.bcl} /* Build configuration list for PBXNativeTarget "ScreenCaptureExtension" */ = {
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
  pbx = pbx.replace(
    "/* End PBXContainerItemProxy section */",
    `${containerProxy}/* End PBXContainerItemProxy section */`
  );
  if (!pbx.includes("PBXContainerItemProxy section")) {
    pbx = pbx.replace(
      "/* Begin PBXCopyFilesBuildPhase section */",
      `/* Begin PBXContainerItemProxy section */\n${containerProxy}/* End PBXContainerItemProxy section */\n\n/* Begin PBXCopyFilesBuildPhase section */`
    );
  }
  if (!pbx.includes("PBXCopyFilesBuildPhase section")) {
    pbx = pbx.replace(
      "/* Begin PBXFrameworksBuildPhase section */",
      `/* Begin PBXCopyFilesBuildPhase section */\n${copyPhase}/* End PBXCopyFilesBuildPhase section */\n\n/* Begin PBXFrameworksBuildPhase section */`
    );
  } else {
    pbx = pbx.replace(
      "/* End PBXCopyFilesBuildPhase section */",
      `${copyPhase}/* End PBXCopyFilesBuildPhase section */`
    );
  }
  pbx = pbx.replace("/* End PBXFrameworksBuildPhase section */", `${frameworksExt}/* End PBXFrameworksBuildPhase section */`);
  pbx = pbx.replace(
    /83CBB9F61A601CBA00E9B192 = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t13B07FAE1A68108700A75B9A \/\* VOXOConnect \*\/,/,
    `83CBB9F61A601CBA00E9B192 = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t13B07FAE1A68108700A75B9A /* VOXOConnect */,\n\t\t\t\t${IDS.group} /* ScreenCaptureExtension */,`
  );
  pbx = pbx.replace(
    /83CBBA001A601CBA00E9B192 \/\* Products \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t13B07F961A680F5B00A75B9A \/\* VOXOConnect.app \*\/,/,
    `83CBBA001A601CBA00E9B192 /* Products */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t13B07F961A680F5B00A75B9A /* VOXOConnect.app */,\n\t\t\t\t${IDS.product} /* ScreenCaptureExtension.appex */,`
  );
  pbx = pbx.replace(
    /2D16E6871FA4F8E400B85C8A \/\* Frameworks \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\tED297162215061F000B7C4FE \/\* JavaScriptCore.framework \*\/,/,
    `2D16E6871FA4F8E400B85C8A /* Frameworks */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${IDS.replayRef} /* ReplayKit.framework */,\n\t\t\t\t${IDS.podsFwRef} /* Pods_ScreenCaptureExtension.framework */,\n\t\t\t\tED297162215061F000B7C4FE /* JavaScriptCore.framework */,`
  );
  pbx = pbx.replace(
    /D65327D7A22EEC0BE12398D9 \/\* Pods \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t6C2E3173556A471DD304B334/,
    `D65327D7A22EEC0BE12398D9 /* Pods */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${IDS.podsDebugXc} /* Pods-ScreenCaptureExtension.debug.xcconfig */,\n\t\t\t\t${IDS.podsReleaseXc} /* Pods-ScreenCaptureExtension.release.xcconfig */,\n\t\t\t\t6C2E3173556A471DD304B334`
  );
  pbx = pbx.replace("/* End PBXGroup section */", `${group}/* End PBXGroup section */`);
  pbx = pbx.replace(
    /13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/ = \{\n\t\t\tisa = PBXNativeTarget;[\s\S]*?buildPhases = \(\n\t\t\t\t08A4A3CD/,
    (m) =>
      m.replace(
        "buildPhases = (\n\t\t\t\t08A4A3CD",
        `buildPhases = (\n\t\t\t\t${IDS.embedPhase} /* Embed Foundation Extensions */,\n\t\t\t\t08A4A3CD`
      )
  );
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
    `targets = (\n\t\t\t\t13B07F861A680F5B00A75B9A /* VOXOConnect */,\n\t\t\t\t${IDS.target} /* ScreenCaptureExtension */,`
  );
  pbx = pbx.replace(
    /TargetAttributes = \{\n\t\t\t\t\t13B07F861A680F5B00A75B9A = \{/,
    `TargetAttributes = {\n\t\t\t\t\t${IDS.target} = {\n\t\t\t\t\t\tDevelopmentTeam = ${DEVELOPMENT_TEAM};\n\t\t\t\t\t};\n\t\t\t\t\t13B07F861A680F5B00A75B9A = {`
  );
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
  console.log("[screen-capture] patched VOXOConnect.xcodeproj for ScreenCaptureExtension");
  const { repairEmbeddedExtensionsPbxproj } = require("./repair-ios-embedded-extensions");
  repairEmbeddedExtensionsPbxproj();
}

copyExtensionSources();
patchPodfile();
patchPbxproj();
patchMainInfoPlist();
try {
  require("./fix-screen-capture-extension-ios.js");
} catch (e) {
  console.warn("[screen-capture] fix script skipped:", e.message);
}

console.log(
  "[screen-capture] done — run: cd ios && pod install, then rebuild in Xcode"
);
