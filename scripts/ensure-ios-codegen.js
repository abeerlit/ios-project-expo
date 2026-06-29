#!/usr/bin/env node
/**
 * Regenerate RCTThirdPartyFabricComponentsProvider.* in node_modules after npm ci.
 * pod install runs this too; without it Xcode fails on React-RCTFabric header missing.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const codegenScript = path.join(
  ROOT,
  "node_modules/react-native/scripts/generate-codegen-artifacts.js"
);

if (!fs.existsSync(codegenScript)) {
  console.warn("[ios:codegen] react-native not installed — skip");
  process.exit(0);
}

const iosDir = path.join(ROOT, "ios");
const outputFlag = fs.existsSync(iosDir) ? "ios" : ".";

console.log(`[ios:codegen] generating iOS artifacts (output=${outputFlag})`);
execSync(
  `node "${codegenScript}" -p "${ROOT}" -t ios -o "${outputFlag}"`,
  { cwd: ROOT, stdio: "inherit" }
);
