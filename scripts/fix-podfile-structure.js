#!/usr/bin/env node
/**
 * Repairs Podfile Ruby structure after screen-capture patch (missing VOXOConnect `end`).
 * Ensures post_install runs fix-screen-capture-extension-ios.js.
 */
const fs = require("fs");
const path = require("path");

const PODFILE = path.join(__dirname, "..", "ios", "Podfile");

const CXX_STANDARD_HOOK = `
    # RCT-Folly / React-jsi require C++17+; force c++20 on all pod targets (Pods project defaults to gnu++14).
    installer.pods_project.build_configurations.each do |config|
      config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
    end
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
      end
    end`;

const FIX_SCREEN_CAPTURE_SCRIPT = `
    fix_script = File.expand_path('../scripts/fix-screen-capture-extension-ios.js', __dir__)
    if File.exist?(fix_script)
      system('node', fix_script) || raise('fix-screen-capture-extension-ios.js failed')
    end`;

const POST_INSTALL_HOOK = `${CXX_STANDARD_HOOK}
    # Strip ExpoModulesProvider from ScreenCaptureExtension (Daily-only extension).
${FIX_SCREEN_CAPTURE_SCRIPT}`;

const POST_INTEGRATE_HOOK = `
# Expo re-adds [Expo] Configure project to ScreenCaptureExtension during integrate — run after that.
post_integrate do |_installer|
${FIX_SCREEN_CAPTURE_SCRIPT}
end
`;

/** Nested under VOXOConnect so CocoaPods can resolve the host target for the app extension. */
const NESTED_EXTENSION_BLOCK = `  # Daily ReplayKit extension — inherit! :search_paths avoids Expo pods; stripped further in post_install.
  target 'ScreenCaptureExtension' do
    inherit! :search_paths
    pod 'ReactNativeDailyJSScreenShareExtension'
  end`;

const STANDALONE_EXTENSION_BLOCK_RE =
  /\n\n# Outside VOXOConnect so use_expo_modules![\s\S]*?\ntarget 'ScreenCaptureExtension' do[\s\S]*?\nend\s*$/m;

function repairPodfile(podfile) {
  let changed = false;

  // Bug: post_install's `end` was replaced — ScreenCaptureExtension sits inside VOXOConnect (missing `end`).
  const broken = /(\n  end)\n(# Outside VOXOConnect so use_expo_modules![\s\S]*?\ntarget 'ScreenCaptureExtension' do[\s\S]*?\nend)\s*$/m;
  if (broken.test(podfile) && !podfile.includes("fix-screen-capture-extension-ios.js")) {
    podfile = podfile.replace(broken, "$1\nend\n\n$2\n");
    changed = true;
    console.log("[fix-podfile] inserted missing `end` for VOXOConnect target");
  } else if (broken.test(podfile)) {
    podfile = podfile.replace(broken, "$1\nend\n\n$2\n");
    changed = true;
    console.log("[fix-podfile] inserted missing `end` for VOXOConnect target");
  }

  // Nested ScreenCaptureExtension inside VOXOConnect (old Podfile layout)
  const nested = /\n  # VOXO Daily screen share[\s\S]*?\n  target 'ScreenCaptureExtension' do[\s\S]*?\n  end\n/m;
  if (nested.test(podfile) && podfile.includes("# Outside VOXOConnect")) {
    podfile = podfile.replace(nested, "\n");
    changed = true;
    console.log("[fix-podfile] removed nested ScreenCaptureExtension from VOXOConnect");
  }

  if (!podfile.includes("CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'")) {
    const cxxAnchor = /(react_native_post_install\([\s\S]*?\)\n)/m;
    if (cxxAnchor.test(podfile)) {
      podfile = podfile.replace(cxxAnchor, `$1${CXX_STANDARD_HOOK}\n`);
      changed = true;
      console.log("[fix-podfile] added C++20 standard hook for all pod targets");
    }
  }

  if (!podfile.includes("fix-screen-capture-extension-ios.js")) {
    const anchor = /(\n  end)\n(end\n\n# Outside VOXOConnect)/m;
    if (anchor.test(podfile)) {
      podfile = podfile.replace(
        anchor,
        `${POST_INSTALL_HOOK}\n$1\n$2`
      );
      changed = true;
      console.log("[fix-podfile] added post_install hook for ScreenCaptureExtension");
    } else if (podfile.includes("post_install do |installer|")) {
      podfile = podfile.replace(
        /(post_install do \|installer\|[\s\S]*?)(\n  end\nend\n\n# Outside VOXOConnect)/m,
        `$1${POST_INSTALL_HOOK}$2`
      );
      if (!podfile.includes("fix-screen-capture-extension-ios.js")) {
        podfile = podfile.replace(
          /(post_install do \|installer\|[\s\S]*?)(\n  end\nend\s*$)/m,
          `$1${POST_INSTALL_HOOK}$2`
        );
      }
      changed = true;
      console.log("[fix-podfile] added post_install hook for ScreenCaptureExtension");
    }
  }

  return { podfile, changed };
}

function nestScreenCaptureExtensionTarget(podfile) {
  let changed = false;

  if (STANDALONE_EXTENSION_BLOCK_RE.test(podfile)) {
    podfile = podfile.replace(STANDALONE_EXTENSION_BLOCK_RE, "\n");
    changed = true;
    console.log("[fix-podfile] removed standalone ScreenCaptureExtension target (needs host nesting)");
  }

  if (!podfile.includes("target 'ScreenCaptureExtension' do")) {
    const inserted = podfile.replace(
      /(\n  post_install do \|installer\|)/,
      `\n${NESTED_EXTENSION_BLOCK}\n$1`
    );
    if (inserted !== podfile) {
      podfile = inserted;
      changed = true;
      console.log("[fix-podfile] nested ScreenCaptureExtension under VOXOConnect");
    }
  } else if (
    podfile.includes("target 'ScreenCaptureExtension' do") &&
    !podfile.includes("inherit! :search_paths")
  ) {
    podfile = podfile.replace(
      /target 'ScreenCaptureExtension' do\n/,
      "target 'ScreenCaptureExtension' do\n    inherit! :search_paths\n"
    );
    changed = true;
    console.log("[fix-podfile] added inherit! :search_paths to ScreenCaptureExtension");
  }

  return { podfile, changed };
}

function ensurePostIntegrateHook(podfile) {
  if (podfile.includes("post_integrate do")) {
    return { podfile, changed: false };
  }
  if (!podfile.match(/\nend\s*$/)) {
    return { podfile, changed: false };
  }
  podfile = podfile.replace(/\nend\s*$/, `${POST_INTEGRATE_HOOK}\nend\n`);
  console.log("[fix-podfile] added post_integrate hook for ScreenCaptureExtension");
  return { podfile, changed: true };
}

function fixPodfile() {
  if (!fs.existsSync(PODFILE)) {
    console.warn("[fix-podfile] no Podfile");
    return false;
  }
  let podfile = fs.readFileSync(PODFILE, "utf8");
  const { podfile: repaired, changed: repairedChanged } = repairPodfile(podfile);
  podfile = repaired;
  const beforeNest = podfile;
  const nested = nestScreenCaptureExtensionTarget(podfile);
  podfile = nested.podfile;
  const postIntegrate = ensurePostIntegrateHook(podfile);
  podfile = postIntegrate.podfile;
  const changed =
    repairedChanged || nested.changed || postIntegrate.changed || podfile !== beforeNest;
  if (changed) {
    fs.writeFileSync(PODFILE, podfile);
  }
  return changed;
}

module.exports = {
  repairPodfile,
  nestScreenCaptureExtensionTarget,
  fixPodfile,
  NESTED_EXTENSION_BLOCK
};

if (require.main === module) {
  fixPodfile();
}
