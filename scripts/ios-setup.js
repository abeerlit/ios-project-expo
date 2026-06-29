#!/usr/bin/env node
/**
 * DOOK-1276 — Single entry for repeatable iOS native setup.
 *
 * Usage:
 *   npm run ios:setup              # post-prebuild fixes + pod install (ios/ must exist)
 *   npm run ios:setup:clean        # expo prebuild --clean + fixes + pod install
 *   npm run ios:setup -- --verify  # also xcodebuild (simulator, no signing)
 *
 * Env: .env (see .env.example) — EXPO_PUBLIC_NATIVE_TELEPHONY, IOS_BUNDLE_ID, etc.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IOS = path.join(ROOT, "ios");
const WORKSPACE = path.join(IOS, "VOXOConnect.xcworkspace");

const { loadEnv, isTruthy } = require("./load-env");
const { runPostPrebuildFixes } = require("./ios-native-postbuild");

function run(cmd, opts = {}) {
  console.log(`\n[ios:setup] ▶ ${cmd}\n`);
  execSync(cmd, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
    ...opts
  });
}

function step(label, fn) {
  console.log(`\n[ios:setup] —— ${label} ——\n`);
  fn();
}

function main() {
  const args = new Set(process.argv.slice(2));
  const prebuildClean = args.has("--prebuild-clean") || args.has("--clean");
  const prebuild = prebuildClean || args.has("--prebuild");
  const podsOnly = args.has("--pods-only");
  const verify = args.has("--verify");

  loadEnv();

  const telephony =
    isTruthy("EXPO_PUBLIC_NATIVE_TELEPHONY") ||
    isTruthy("EXPO_PUBLIC_NATIVE_NOTIFICATIONS");

  console.log("[ios:setup] env loaded from .env");
  console.log(`[ios:setup] EXPO_PUBLIC_NATIVE_TELEPHONY=${process.env.EXPO_PUBLIC_NATIVE_TELEPHONY ?? "(unset)"}`);
  console.log(`[ios:setup] telephony native fixes: ${telephony ? "yes" : "no"}`);

  if (prebuild) {
    step("expo prebuild (ios)", () => {
      const cleanFlag = prebuildClean ? " --clean" : "";
      run(`npx expo prebuild --platform ios${cleanFlag}`);
    });
  } else if (!podsOnly && !fs.existsSync(IOS)) {
    console.error("[ios:setup] ios/ missing — run: npm run ios:setup:clean");
    process.exit(1);
  }

  if (!podsOnly) {
    step("native post-prebuild fixes", () => {
      if (!runPostPrebuildFixes({ telephony })) {
        process.exit(1);
      }
    });

    step("Podfile structure (ScreenCaptureExtension target)", () => {
      const fixPod = path.join(__dirname, "fix-podfile-structure.js");
      if (fs.existsSync(fixPod)) {
        run(`node "${fixPod}"`);
      }
    });

    step("screen capture extension (pre-pod pbxproj)", () => {
      const fix = path.join(__dirname, "fix-screen-capture-extension-ios.js");
      if (fs.existsSync(fix)) {
        run(`node "${fix}"`);
      }
    });

    step("repair embedded extension pbxproj", () => {
      const repair = path.join(__dirname, "repair-ios-embedded-extensions.js");
      if (fs.existsSync(repair)) {
        run(`node "${repair}"`);
      }
    });

    step("VoxoNotificationExtension (NSE) embed verify", () => {
      const nseFix = path.join(__dirname, "fix-voxo-notification-extension-ios.js");
      const repair = path.join(__dirname, "repair-ios-embedded-extensions.js");
      if (fs.existsSync(nseFix)) {
        run(`node "${nseFix}"`);
      }
      if (fs.existsSync(repair)) {
        run(`node "${repair}"`);
      }
    });
  }

  step("react-native codegen (Fabric provider)", () => {
    run("node scripts/ensure-ios-codegen.js");
  });

  step("pod install", () => {
    if (!fs.existsSync(path.join(IOS, "Podfile"))) {
      console.error("[ios:setup] Podfile missing — run prebuild first");
      process.exit(1);
    }
    run("cd ios && pod install");
  });

  step("screen capture extension (post-pod)", () => {
    const fix = path.join(__dirname, "fix-screen-capture-extension-ios.js");
    if (fs.existsSync(fix)) {
      run(`node "${fix}"`);
    }
    const repair = path.join(__dirname, "repair-ios-embedded-extensions.js");
    if (fs.existsSync(repair)) {
      run(`node "${repair}"`);
    }
    const nseFix = path.join(__dirname, "fix-voxo-notification-extension-ios.js");
    if (fs.existsSync(nseFix)) {
      run(`node "${nseFix}"`);
    }
    if (fs.existsSync(repair)) {
      run(`node "${repair}"`);
    }
    // Re-sync Pods manifest check inputs after pbxproj edits.
    run("cd ios && pod install");
  });

  if (verify) {
    step("xcodebuild verify (simulator)", () => {
      if (!fs.existsSync(WORKSPACE)) {
        console.error("[ios:setup] workspace missing");
        process.exit(1);
      }
      run(
        'xcodebuild -workspace ios/VOXOConnect.xcworkspace -scheme VOXOConnect -configuration Debug -sdk iphonesimulator -destination "generic/platform=iOS Simulator" build CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY='
      );
    });
  }

  console.log("\n[ios:setup] ✓ Done");
  console.log("[ios:setup] Open: open ios/VOXOConnect.xcworkspace");
  console.log("[ios:setup] Metro:   npm run start:device");
  if (!verify) {
    console.log("[ios:setup] CI-style verify: npm run ios:setup -- --verify");
  }
}

main();
