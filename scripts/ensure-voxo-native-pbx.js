#!/usr/bin/env node
/**
 * Registers ios/VOXOConnect/VoxoNative/*.m in VOXOConnect target and header search paths.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PBX = path.join(ROOT, "ios", "VOXOConnect.xcodeproj", "project.pbxproj");
const VOXO_NATIVE_DIR = path.join(ROOT, "ios", "VOXOConnect", "VoxoNative");

const MARKER = "A7VN80011A68108700A75B9A /* VoxoNative */";

const NATIVE_SOURCES = [
  "RCTVoxoNotificationsModule.m",
  "VOXODtmfSidetoneModule.m",
  "BackgroundTaskManager.m",
  "VOXOConnectBackgroundActivator.m",
  "RCTPendingCallManager.m"
];

const PBX_IDS = {
  group: "A7VN80011A68108700A75B9A",
  RCTVoxoNotificationsModule: {
    h: "A7VN80121A68108700A75B9A",
    m: "A7VN80111A68108700A75B9A",
    build: "A7VN80211A68108700A75B9A"
  },
  VOXODtmfSidetoneModule: {
    h: "A7VN80321A68108700A75B9A",
    m: "A7VN80311A68108700A75B9A",
    build: "A7VN80411A68108700A75B9A"
  },
  BackgroundTaskManager: {
    h: "A7VN80521A68108700A75B9A",
    m: "A7VN80511A68108700A75B9A",
    build: "A7VN80611A68108700A75B9A"
  },
  VOXOConnectBackgroundActivator: {
    h: "A7VN80721A68108700A75B9A",
    m: "A7VN80711A68108700A75B9A",
    build: "A7VN80811A68108700A75B9A"
  },
  RCTPendingCallManager: {
    h: "A7VN80921A68108700A75B9A",
    m: "A7VN80911A68108700A75B9A",
    build: "A7VN80A11A68108700A75B9A"
  }
};

const HEADER_SEARCH = 'HEADER_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"$(SRCROOT)/VOXOConnect/VoxoNative",\n\t\t\t\t);';

function fileRef(id, name) {
  return `\t\t${id} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = ${name.endsWith(".h") ? "sourcecode.c.h" : "sourcecode.c.objc"}; name = ${name}; path = ${name}; sourceTree = "<group>"; };\n`;
}

function buildFile(id, name, fileId) {
  return `\t\t${id} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${name} */; };\n`;
}

function ensureHeaderSearchPaths(pbx) {
  const targets = [
    ["13B07F941A680F5B00A75B9A", "Debug"],
    ["13B07F951A680F5B00A75B9A", "Release"]
  ];
  for (const [configId, label] of targets) {
    const blockStart = pbx.indexOf(`${configId} /* ${label} */`);
    if (blockStart < 0) continue;
    const settingsKey = "buildSettings = {";
    const settingsStart = pbx.indexOf(settingsKey, blockStart);
    if (settingsStart < 0 || settingsStart > blockStart + 800) continue;
    const window = pbx.slice(settingsStart, settingsStart + 500);
    if (window.includes("VOXOConnect/VoxoNative")) continue;
    const insertAt = settingsStart + settingsKey.length;
    pbx = `${pbx.slice(0, insertAt)}\n\t\t\t\t${HEADER_SEARCH}\n${pbx.slice(insertAt)}`;
  }
  return pbx;
}

function ensurePbxprojVoxoNative() {
  if (!fs.existsSync(PBX)) {
    console.warn("[ensure-voxo-native-pbx] no project.pbxproj — run expo prebuild first");
    return false;
  }

  let pbx = fs.readFileSync(PBX, "utf8");
  if (pbx.includes(MARKER)) {
    pbx = pbx.replace(
      /path = VOXOConnect\/VoxoNative\/([^;]+); sourceTree = "<group>";/g,
      "path = $1; sourceTree = \"<group>\";"
    );
    pbx = pbx.replace(
      /path = VOXOConnect\/VoxoNative;\n\t\t\tsourceTree = "<group>";/,
      "path = VOXOConnect/VoxoNative;\n\t\t\tsourceTree = SOURCE_ROOT;"
    );
    pbx = ensureHeaderSearchPaths(pbx);
    fs.writeFileSync(PBX, pbx);
    console.log("[ensure-voxo-native-pbx] VoxoNative already registered (paths/header refreshed)");
    return true;
  }

  const present = NATIVE_SOURCES.filter((name) =>
    fs.existsSync(path.join(VOXO_NATIVE_DIR, name))
  );
  if (present.length === 0) {
    console.warn("[ensure-voxo-native-pbx] no VoxoNative sources — run sync-voxo-telephony-ios.js or prebuild");
    return false;
  }

  let buildFiles = "";
  let fileRefs = "";
  const groupChildren = [];
  const sourceEntries = [];

  for (const mName of NATIVE_SOURCES) {
    const base = mName.replace(/\.m$/, "");
    const ids = PBX_IDS[base];
    if (!ids || !fs.existsSync(path.join(VOXO_NATIVE_DIR, mName))) continue;
    const hName = `${base}.h`;
    buildFiles += buildFile(ids.build, mName, ids.m);
    fileRefs += fileRef(ids.m, mName);
    fileRefs += fileRef(ids.h, hName);
    groupChildren.push(`\t\t\t\t${ids.h} /* ${hName} */,`, `\t\t\t\t${ids.m} /* ${mName} */,`);
    sourceEntries.push(`\t\t\t\t${ids.build} /* ${mName} in Sources */,`);
  }

  const groupBlock = `\t\t${PBX_IDS.group} /* VoxoNative */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n${groupChildren.join("\n")}\n\t\t\t);\n\t\t\tname = VoxoNative;\n\t\t\tpath = VOXOConnect/VoxoNative;\n\t\t\tsourceTree = SOURCE_ROOT;\n\t\t};\n`;

  pbx = pbx.replace("/* End PBXBuildFile section */", `${buildFiles}/* End PBXBuildFile section */`);
  pbx = pbx.replace("/* End PBXFileReference section */", `${fileRefs}/* End PBXFileReference section */`);
  pbx = pbx.replace("/* End PBXGroup section */", `${groupBlock}/* End PBXGroup section */`);
  pbx = pbx.replace(
    /(13B07FAE1A68108700A75B9A \/\* VOXOConnect \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \()\n/,
    `$1\n\t\t\t\t${PBX_IDS.group} /* VoxoNative */,`
  );
  pbx = pbx.replace(
    /(13B07F871A680F5B00A75B9A \/\* Sources \*\/ = \{\n\t\t\tisa = PBXSourcesBuildPhase;[\s\S]*?files = \()\n/,
    `$1\n${sourceEntries.join("\n")}`
  );
  pbx = ensureHeaderSearchPaths(pbx);

  fs.writeFileSync(PBX, pbx);
  console.log("[ensure-voxo-native-pbx] registered VoxoNative in VOXOConnect target");
  return true;
}

if (require.main === module) {
  ensurePbxprojVoxoNative();
}

module.exports = { ensurePbxprojVoxoNative };
