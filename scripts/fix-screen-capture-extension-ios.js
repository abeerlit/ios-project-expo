#!/usr/bin/env node
/**
 * ScreenCaptureExtension must NOT link Expo/React Native — only Daily's broadcast framework.
 * Run after pod install (also invoked from Podfile post_install).
 */
const fs = require("fs");
const path = require("path");

const IOS = path.resolve(__dirname, "../ios");
const PBX = path.join(IOS, "VOXOConnect.xcodeproj/project.pbxproj");
const XCCONFIG = path.join(IOS, "ScreenCaptureExtension/ScreenCaptureExtension.xcconfig");
// Xcode IDs are 24 chars (0-9, A-Z) — not strict hex (custom SCE*/VNE* prefixes use S, etc.).
const PBX_ID = "[0-9A-Z]{24}";

const MINIMAL_XCCONFIG = `// Daily ReplayKit extension only — do not include Pods-ScreenCaptureExtension xcconfig (pulls RN/Expo).
// PODS_PODFILE_DIR_PATH + PODS_ROOT are required for [CP] Check Pods Manifest.lock in Xcode.
FRAMEWORK_SEARCH_PATHS = $(inherited) "$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates/ReactNativeDailyJSScreenShareExtension" "$(PODS_XCFRAMEWORKS_BUILD_DIR)/ReactNativeDailyJSScreenShareExtension"
HEADER_SEARCH_PATHS = $(inherited)
LD_RUNPATH_SEARCH_PATHS = $(inherited) @executable_path/Frameworks @executable_path/../../Frameworks @loader_path/Frameworks
OTHER_LDFLAGS = $(inherited) -framework ReplayKit -framework ReactNativeDailyJSScreenShareExtension
OTHER_SWIFT_FLAGS = $(inherited)
PODS_PODFILE_DIR_PATH = \${SRCROOT}
PODS_ROOT = \${SRCROOT}/Pods
PODS_XCFRAMEWORKS_BUILD_DIR = $(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates
PODS_CONFIGURATION_BUILD_DIR = \${PODS_BUILD_DIR}/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)
PODS_BUILD_DIR = \${BUILD_DIR}
`;

function writeMinimalXcconfig() {
  fs.mkdirSync(path.dirname(XCCONFIG), { recursive: true });
  fs.writeFileSync(XCCONFIG, MINIMAL_XCCONFIG);
  console.log("[fix-screen-capture] wrote ScreenCaptureExtension.xcconfig");
}

function discoverScreenCapturePodsDirs() {
  const supportRoot = path.join(IOS, "Pods/Target Support Files");
  if (!fs.existsSync(supportRoot)) return [];
  return fs
    .readdirSync(supportRoot)
    .filter((name) => name.startsWith("Pods-") && name.includes("ScreenCapture"))
    .map((name) => path.join(supportRoot, name));
}

const STRIPPED_PODS_XCCONFIG = `// Stripped by fix-screen-capture-extension-ios.js — extension links Daily only.
FRAMEWORK_SEARCH_PATHS = $(inherited) "$(PODS_XCFRAMEWORKS_BUILD_DIR)/ReactNativeDailyJSScreenShareExtension"
LD_RUNPATH_SEARCH_PATHS = $(inherited) @executable_path/Frameworks @executable_path/../../Frameworks
OTHER_LDFLAGS = $(inherited) -framework ReplayKit -framework ReactNativeDailyJSScreenShareExtension
OTHER_SWIFT_FLAGS = $(inherited)
PODS_BUILD_DIR = \${BUILD_DIR}
PODS_CONFIGURATION_BUILD_DIR = \${PODS_BUILD_DIR}/$(CONFIGURATION)$(EFFECTIVE_PLATFORM_NAME)
PODS_ROOT = \${SRCROOT}/Pods
PODS_XCFRAMEWORKS_BUILD_DIR = $(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates
`;

function patchPodsXcconfig() {
  const dirs = discoverScreenCapturePodsDirs();
  if (dirs.length === 0) {
    console.log("[fix-screen-capture] no Pods-*ScreenCapture* xcconfig dirs — skip");
    return;
  }
  for (const dir of dirs) {
    for (const name of ["debug", "release"]) {
      const podXc = path.join(dir, `${path.basename(dir)}.${name}.xcconfig`);
      if (!fs.existsSync(podXc)) continue;
      fs.writeFileSync(podXc, STRIPPED_PODS_XCCONFIG);
    }
    console.log("[fix-screen-capture] patched", path.basename(dir), "*.xcconfig");
  }
}

function patchExpoConfigureScriptsNoOp() {
  for (const dir of discoverScreenCapturePodsDirs()) {
    const script = path.join(dir, "expo-configure-project.sh");
    if (!fs.existsSync(script)) continue;
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bash
# Disabled by fix-screen-capture-extension-ios.js — Daily ReplayKit extension only.
exit 0
`
    );
    console.log("[fix-screen-capture] no-op expo-configure-project.sh in", path.basename(dir));
  }
}

const STUB_EXPO_MODULES_PROVIDER = `// Daily ReplayKit extension — Expo modules disabled (fix-screen-capture-extension-ios.js).
// This file must not import ExpoModulesCore; the extension links Daily only.
import Foundation
`;

function writeStubExpoModulesProvider() {
  for (const dir of discoverScreenCapturePodsDirs()) {
    const provider = path.join(dir, "ExpoModulesProvider.swift");
    fs.writeFileSync(provider, STUB_EXPO_MODULES_PROVIDER);
    console.log("[fix-screen-capture] stub ExpoModulesProvider.swift in", path.basename(dir));
  }
}

function removeExtensionExpoConfigureShellPhases(pbx) {
  const phaseRe =
    /\t\t([0-9A-Z]{24}) \/\* \[Expo\] Configure project \*\/ = \{isa = PBXShellScriptBuildPhase;[\s\S]*?\n\t\t\};\n/g;
  return pbx.replace(phaseRe, (block) =>
    /Pods-ScreenCaptureExtension\/expo-configure-project|ScreenCaptureExtension\/expo-configure/.test(
      block
    )
      ? ""
      : block
  );
}

function removeExtensionExpoModulesProviderRefs(pbx) {
  const refRe =
    /\t\t([0-9A-Z]{24}) \/\* ExpoModulesProvider\.swift \*\/ = \{isa = PBXFileReference;[\s\S]*?Pods-ScreenCaptureExtension\/ExpoModulesProvider\.swift[\s\S]*?\};\n/g;
  let refIds = [];
  pbx = pbx.replace(refRe, (_m, id) => {
    refIds.push(id);
    return "";
  });
  for (const id of refIds) {
    pbx = pbx.replace(
      new RegExp(
        `\\t\\t[0-9A-Z]{24} \\/\\* ExpoModulesProvider\\.swift in Sources \\*\\/ = \\{isa = PBXBuildFile; fileRef = ${id} \\/\\* ExpoModulesProvider\\.swift \\*\\/; \\};\\n`,
        "g"
      ),
      ""
    );
    pbx = pbx.replace(
      new RegExp(
        `\\n\\t\\t\\t\\t[0-9A-Z]{24} \\/\\* ExpoModulesProvider\\.swift in Sources \\*\\/,\\n`,
        "g"
      ),
      (line) => (line.includes(`${id} /*`) ? "\n" : line)
    );
  }
  return pbx;
}

function patchPbxprojBlock(pbx, blockRe, mutator) {
  const m = pbx.match(blockRe);
  if (!m) return pbx;
  return pbx.replace(blockRe, mutator(m[0]));
}

const XCCONFIG_ID = "SCE0E0171A68108700A75B9A";
const EXT_DEBUG_ID = "SCE0E0041A68108700A75B9A";
const EXT_RELEASE_ID = "SCE0E0051A68108700A75B9A";
const EXT_TARGET_ID = "SCE0E0011A68108700A75B9A";
const EXT_DAILY_CP_ID = "SCE0E0181A68108700A75B9A";
const EXT_GROUP_ID = "SCE0E00A1A68108700A75B9A";
const EXT_SAMPLE_REF = "SCE0E00B1A68108700A75B9A";
const EXT_SAMPLE_BUILD = "SCE0E00C1A68108700A75B9A";
const EXT_REPLAY_REF = "SCE0E00D1A68108700A75B9A";
const EXT_REPLAY_BUILD = "SCE0E00E1A68108700A75B9A";

function ensureScreenCaptureFileRefs(pbx) {
  let changed = false;

  if (!pbx.includes(`${EXT_SAMPLE_REF} /* SampleHandler.swift */`)) {
    const refs = `\t\t${EXT_SAMPLE_REF} /* SampleHandler.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SampleHandler.swift; sourceTree = "<group>"; };
\t\t${EXT_REPLAY_REF} /* ReplayKit.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = ReplayKit.framework; path = System/Library/Frameworks/ReplayKit.framework; sourceTree = SDKROOT; };
`;
    pbx = pbx.replace("/* End PBXFileReference section */", `${refs}/* End PBXFileReference section */`);
    changed = true;
  }

  if (!pbx.includes(`${EXT_SAMPLE_BUILD} /* SampleHandler.swift in Sources */`)) {
    const builds = `\t\t${EXT_SAMPLE_BUILD} /* SampleHandler.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${EXT_SAMPLE_REF} /* SampleHandler.swift */; };
\t\t${EXT_REPLAY_BUILD} /* ReplayKit.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${EXT_REPLAY_REF} /* ReplayKit.framework */; };
`;
    pbx = pbx.replace("/* End PBXBuildFile section */", `${builds}/* End PBXBuildFile section */`);
    changed = true;
  }

  if (!pbx.includes(`${EXT_GROUP_ID} /* ScreenCaptureExtension */ = {\n\t\t\tisa = PBXGroup`)) {
    const group = `\t\t${EXT_GROUP_ID} /* ScreenCaptureExtension */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */,
\t\t\t\t${EXT_SAMPLE_REF} /* SampleHandler.swift */,
\t\t\t);
\t\t\tpath = ScreenCaptureExtension;
\t\t\tsourceTree = "<group>";
\t\t};
`;
    pbx = pbx.replace("/* End PBXGroup section */", `${group}/* End PBXGroup section */`);
    if (!pbx.includes(`${EXT_GROUP_ID} /* ScreenCaptureExtension */,\n`)) {
      pbx = pbx.replace(
        /(83CBB9F61A601CBA00E9B192 = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \()\n/,
        `$1\n\t\t\t\t${EXT_GROUP_ID} /* ScreenCaptureExtension */,\n`
      );
    }
    changed = true;
  }

  const sourcesRe = /SCE0E0061A68108700A75B9A \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/;
  if (sourcesRe.test(pbx) && !pbx.includes(`${EXT_SAMPLE_BUILD} /* SampleHandler.swift in Sources */`)) {
    pbx = pbx.replace(
      sourcesRe,
      (block) =>
        block.replace(
          /files = \(\n/,
          `files = (\n\t\t\t\t${EXT_SAMPLE_BUILD} /* SampleHandler.swift in Sources */,\n`
        )
    );
    changed = true;
  }

  const fwRe = /SCE0E0071A68108700A75B9A \/\* Frameworks \*\/ = \{[\s\S]*?\n\t\t\};/;
  if (fwRe.test(pbx) && !pbx.includes(`${EXT_REPLAY_BUILD} /* ReplayKit.framework in Frameworks */`)) {
    pbx = pbx.replace(
      fwRe,
      (block) =>
        block.replace(
          /files = \(\n/,
          `files = (\n\t\t\t\t${EXT_REPLAY_BUILD} /* ReplayKit.framework in Frameworks */,\n`
        )
    );
    changed = true;
  }

  if (changed) {
    console.log("[fix-screen-capture] restored ScreenCaptureExtension source file refs");
  }
  return { pbx, changed };
}

function ensureScreenCaptureNativeTarget(pbx) {
  if (
    pbx.includes(
      `${EXT_TARGET_ID} /* ScreenCaptureExtension */ = {\n\t\t\tisa = PBXNativeTarget`
    )
  ) {
    return pbx;
  }

  const cpCheck = pbx.includes("13B916D39D44DF383059EFA9 /* [CP] Check Pods Manifest.lock */")
    ? "\t\t\t\t13B916D39D44DF383059EFA9 /* [CP] Check Pods Manifest.lock */,\n"
    : "";
  const dailyCp = pbx.includes(EXT_DAILY_CP_ID)
    ? `\t\t\t\t${EXT_DAILY_CP_ID} /* [CP] Copy Daily xcframework */,\n`
    : "";

  const nativeTarget = `\t\t${EXT_TARGET_ID} /* ScreenCaptureExtension */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = SCE0E0031A68108700A75B9A /* Build configuration list for PBXNativeTarget "ScreenCaptureExtension" */;
\t\t\tbuildPhases = (
${cpCheck}${dailyCp}\t\t\t\tSCE0E0061A68108700A75B9A /* Sources */,
\t\t\t\tSCE0E0071A68108700A75B9A /* Frameworks */,
\t\t\t\tSCE0E0081A68108700A75B9A /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ScreenCaptureExtension;
\t\t\tproductName = ScreenCaptureExtension;
\t\t\tproductReference = SCE0E0021A68108700A75B9A /* ScreenCaptureExtension.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t};
`;

  pbx = pbx.replace("/* End PBXNativeTarget section */", `${nativeTarget}/* End PBXNativeTarget section */`);
  console.log("[fix-screen-capture] restored ScreenCaptureExtension PBXNativeTarget");
  return pbx;
}

function ensureScreenCaptureInProjectTargets(pbx) {
  if (pbx.includes(`${EXT_TARGET_ID} /* ScreenCaptureExtension */,`)) {
    return pbx;
  }
  if (
    !pbx.includes(
      `${EXT_TARGET_ID} /* ScreenCaptureExtension */ = {\n\t\t\tisa = PBXNativeTarget`
    )
  ) {
    return pbx;
  }
  const next = pbx.replace(
    /(targets = \([\s\S]*?13B07F861A680F5B00A75B9A \/\* VOXOConnect \*\/,\n)/,
    `$1\t\t\t\t${EXT_TARGET_ID} /* ScreenCaptureExtension */,\n`
  );
  if (next !== pbx) {
    console.log("[fix-screen-capture] added ScreenCaptureExtension to project targets");
  }
  return next;
}

function ensureExtensionXcconfigInPbxproj(pbx) {
  let changed = false;

  if (!pbx.includes(`${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */`)) {
    const fileRef = `\t\t${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = ScreenCaptureExtension.xcconfig; sourceTree = "<group>"; };
`;
    pbx = pbx.replace(
      "/* End PBXFileReference section */",
      `${fileRef}/* End PBXFileReference section */`
    );
    if (pbx.includes("SCE0E00A1A68108700A75B9A /* ScreenCaptureExtension */")) {
      pbx = pbx.replace(
        /(SCE0E00A1A68108700A75B9A \/\* ScreenCaptureExtension \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \()\n/,
        `$1\n\t\t\t\t${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */,`
      );
    }
    changed = true;
  }

  for (const [configId, label] of [
    [EXT_DEBUG_ID, "Debug"],
    [EXT_RELEASE_ID, "Release"]
  ]) {
    const hasRef = new RegExp(
      `${configId} \\/\\* ${label} \\*\\/ = \\{[\\s\\S]*?baseConfigurationReference = ${XCCONFIG_ID}`
    ).test(pbx);
    if (hasRef) continue;

    const configRe = new RegExp(
      `(${configId} \\/\\* ${label} \\*\\/ = \\{\\n\\t\\t\\tisa = XCBuildConfiguration;\\n)(\\t\\t\\tbaseConfigurationReference = [^;]+;\\n)?`
    );
    if (!configRe.test(pbx)) continue;
    pbx = pbx.replace(
      configRe,
      `$1\t\t\tbaseConfigurationReference = ${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */;\n`
    );
    changed = true;
  }

  return { pbx, changed };
}

function patchPbxproj() {
  if (!fs.existsSync(PBX)) return;
  let pbx = fs.readFileSync(PBX, "utf8");
  let changed = false;

  const restored = ensureScreenCaptureNativeTarget(pbx);
  if (restored !== pbx) {
    pbx = restored;
    changed = true;
  }
  const inProject = ensureScreenCaptureInProjectTargets(pbx);
  if (inProject !== pbx) {
    pbx = inProject;
    changed = true;
  }

  // 1) Extension Sources: only SampleHandler.swift (drop ExpoModulesProvider.swift)
  const sourcesRe =
    /SCE0E0061A68108700A75B9A \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/;
  if (sourcesRe.test(pbx)) {
    const next = patchPbxprojBlock(pbx, sourcesRe, (block) => {
      const cleaned = block.replace(
        new RegExp(
          `\\n\\t\\t\\t\\t${PBX_ID} \\/\\* ExpoModulesProvider\\.swift in Sources \\*\\/,`,
          "g"
        ),
        ""
      );
      return cleaned !== block ? cleaned : block;
    });
    if (next !== pbx) {
      pbx = next;
      changed = true;
    }
  }

  // 2) Remove PBXFileReference / PBXBuildFile for extension ExpoModulesProvider (any Pods-*ScreenCapture* path)
  const extProviderRefRe = new RegExp(
    `\\t\\t(${PBX_ID}) \\/\\* ExpoModulesProvider\\.swift \\*\\/ = \\{isa = PBXFileReference;[\\s\\S]*?Pods-[^"]*ScreenCapture[^"]*\\/ExpoModulesProvider\\.swift[\\s\\S]*?\\};\\n`,
    "g"
  );
  if (extProviderRefRe.test(pbx)) {
    const refIds = [];
    pbx = pbx.replace(extProviderRefRe, (m, id) => {
      refIds.push(id);
      return "";
    });
    for (const id of refIds) {
      pbx = pbx.replace(
        new RegExp(
          `\\t\\t${PBX_ID} \\/\\* ExpoModulesProvider\\.swift in Sources \\*\\/ = \\{isa = PBXBuildFile; fileRef = ${id} \\/\\* ExpoModulesProvider\\.swift \\*\\/; \\};\\n`,
          "g"
        ),
        ""
      );
      pbx = pbx.replace(
        new RegExp(`\\t\\t\\t\\t${id} \\/\\* ExpoModulesProvider\\.swift \\*\\/,\\n`, "g"),
        ""
      );
    }
    changed = true;
  }

  // 3) Frameworks: ReplayKit + Daily only (no Pods_ScreenCaptureExtension.framework)
  const fwRe =
    /SCE0E0071A68108700A75B9A \/\* Frameworks \*\/ = \{[\s\S]*?\n\t\t\};/;
  if (fwRe.test(pbx)) {
    const next = patchPbxprojBlock(pbx, fwRe, (block) => {
      const cleaned = block.replace(
        new RegExp(
          `\\n\\t\\t\\t\\t${PBX_ID} \\/\\* Pods_ScreenCaptureExtension\\.framework in Frameworks \\*\\/,`,
          "g"
        ),
        ""
      );
      return cleaned !== block ? cleaned : block;
    });
    if (next !== pbx) {
      pbx = next;
      changed = true;
    }
  }
  const podsFwBuildRemoved = pbx.replace(
    new RegExp(
      `\\t\\t${PBX_ID} \\/\\* Pods_ScreenCaptureExtension\\.framework in Frameworks \\*\\/ = \\{isa = PBXBuildFile; fileRef = ${PBX_ID} \\/\\* Pods_ScreenCaptureExtension\\.framework \\*\\/; \\};\\n`,
      "g"
    ),
    ""
  );
  if (podsFwBuildRemoved !== pbx) {
    pbx = podsFwBuildRemoved;
    changed = true;
  }

  // 4) Remove [Expo] Configure project from extension buildPhases + delete extension shell phase
  const extTargetRe =
    /SCE0E0011A68108700A75B9A \/\* ScreenCaptureExtension \*\/ = \{[\s\S]*?\n\t\t\};/;
  if (extTargetRe.test(pbx)) {
    const next = patchPbxprojBlock(pbx, extTargetRe, (block) =>
      block.replace(
        new RegExp(
          `\\n\\t\\t\\t\\t${PBX_ID} \\/\\* \\[Expo\\] Configure project \\*\\/,`,
          "g"
        ),
        ""
      )
    );
    if (next !== pbx) {
      pbx = next;
      changed = true;
    }
  }
  const expoShellRemoved = removeExtensionExpoConfigureShellPhases(pbx);
  if (expoShellRemoved !== pbx) {
    pbx = expoShellRemoved;
    changed = true;
  }

  const providerRemoved = removeExtensionExpoModulesProviderRefs(pbx);
  if (providerRemoved !== pbx) {
    pbx = providerRemoved;
    changed = true;
  }

  // 5) Remove ExpoModulesProviders subgroup for ScreenCaptureExtension (not the source folder group)
  pbx = pbx.replace(
    new RegExp(
      `\\t\\t${PBX_ID} \\/\\* ScreenCaptureExtension \\*\\/ = \\{\\n\\t\\t\\tisa = PBXGroup;\\n\\t\\t\\tchildren = \\([\\s\\S]*?\\n\\t\\t\\t\\);\\n\\t\\t\\tname = ScreenCaptureExtension;\\n\\t\\t\\tsourceTree = "<group>";\\n\\t\\t\\};\\n`,
      "g"
    ),
    ""
  );
  pbx = pbx.replace(
    /(\t\tD7E4C46ADA2E9064B798F356 \/\* ExpoModulesProviders \*\/ = \{[\s\S]*?children = \([\s\S]*?)(\n\t\t\t\t[A-Z0-9]{24} \/\* ExpoModulesProvider\.swift \*\/,\n)/g,
    (full, pre, providerLine) => {
      const id = providerLine.match(/([A-Z0-9]{24})/)?.[1];
      if (!id) return full;
      const isMainApp = new RegExp(
        `${id} \\/\\* ExpoModulesProvider\\.swift \\*\\/ = \\{isa = PBXFileReference;[\\s\\S]*?Pods-VOXOConnect\\/ExpoModulesProvider\\.swift"`
      ).test(pbx);
      return isMainApp ? full : pre;
    }
  );

  const fileRefs = ensureScreenCaptureFileRefs(pbx);
  pbx = fileRefs.pbx;
  if (fileRefs.changed) changed = true;

  const pathFixed = pbx.replace(
    /path = ScreenCaptureExtension\/ScreenCaptureExtension\.xcconfig; sourceTree = "<group>"; \};/,
    'path = ScreenCaptureExtension.xcconfig; sourceTree = "<group>"; };'
  );
  if (pathFixed !== pbx) {
    pbx = pathFixed;
    changed = true;
  }

  // 6) Wire ScreenCaptureExtension.xcconfig (sets PODS_ROOT for [CP] Check Pods Manifest.lock)
  const xcconfigResult = ensureExtensionXcconfigInPbxproj(pbx);
  pbx = xcconfigResult.pbx;
  if (xcconfigResult.changed) changed = true;

  // Legacy: swap Pods xcconfig refs when present from an older pbxproj layout
  if (
    pbx.includes("Pods-ScreenCaptureExtension.debug.xcconfig") &&
    pbx.includes(`baseConfigurationReference = SCE0E0151A68108700A75B9A`)
  ) {
    pbx = pbx.replace(
      /baseConfigurationReference = SCE0E0151A68108700A75B9A \/\* Pods-ScreenCaptureExtension\.debug\.xcconfig \*\/;/g,
      `baseConfigurationReference = ${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */;`
    );
    pbx = pbx.replace(
      /baseConfigurationReference = SCE0E0161A68108700A75B9A \/\* Pods-ScreenCaptureExtension\.release\.xcconfig \*\/;/g,
      `baseConfigurationReference = ${XCCONFIG_ID} /* ScreenCaptureExtension.xcconfig */;`
    );
    changed = true;
  }

  // 7) [CP] Copy Daily xcframework build phase
  if (!pbx.includes("SCE0E0181A68108700A75B9A")) {
    const embedDaily =
      '\t\tSCE0E0181A68108700A75B9A /* [CP] Copy Daily xcframework */ = {isa = PBXShellScriptBuildPhase; buildActionMask = 2147483647; files = (); inputFileListPaths = (); inputPaths = ("${PROJECT_DIR}/Pods/Target Support Files/ReactNativeDailyJSScreenShareExtension/ReactNativeDailyJSScreenShareExtension-xcframeworks.sh",); name = "[CP] Copy Daily xcframework"; outputFileListPaths = (); outputPaths = ("${BUILD_DIR}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}/XCFrameworkIntermediates/ReactNativeDailyJSScreenShareExtension/ReactNativeDailyJSScreenShareExtension.framework/ReactNativeDailyJSScreenShareExtension",); runOnlyForDeploymentPostprocessing = 0; shellPath = /bin/sh; shellScript = "export PODS_ROOT=\\"${PROJECT_DIR}/Pods\\"\\nexport PODS_XCFRAMEWORKS_BUILD_DIR=\\"${BUILD_DIR}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}/XCFrameworkIntermediates\\"\\n\\"${PROJECT_DIR}/Pods/Target Support Files/ReactNativeDailyJSScreenShareExtension/ReactNativeDailyJSScreenShareExtension-xcframeworks.sh\\"\\n"; showEnvVarsInLog = 0; };\n';
    pbx = pbx.replace(
      "/* End PBXShellScriptBuildPhase section */",
      `${embedDaily}/* End PBXShellScriptBuildPhase section */`
    );
    pbx = pbx.replace(
      /(SCE0E0011A68108700A75B9A \/\* ScreenCaptureExtension \*\/ = \{[\s\S]*?buildPhases = \()\n/,
      "$1\n\t\t\t\tSCE0E0181A68108700A75B9A /* [CP] Copy Daily xcframework */,\n"
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(PBX, pbx);
    console.log("[fix-screen-capture] stripped Expo/RN from ScreenCaptureExtension target");
  } else {
    console.log("[fix-screen-capture] pbxproj already clean for ScreenCaptureExtension");
  }
}

writeMinimalXcconfig();
patchPodsXcconfig();
patchExpoConfigureScriptsNoOp();
writeStubExpoModulesProvider();
patchPbxproj();
