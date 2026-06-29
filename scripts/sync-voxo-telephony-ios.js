#!/usr/bin/env node
/**
 * Re-sync VoxoNative sources from bare ios-project (does NOT replace AppDelegate — use plugins + patch-appdelegate-pushkit).
 * Prefer: npm run ios:setup
 */
const { loadEnv } = require("./load-env");
const { runPostPrebuildFixes } = require("./ios-native-postbuild");

loadEnv();
runPostPrebuildFixes({ telephony: true });
console.log("[sync-voxo-telephony] done — prefer: npm run ios:setup (includes pod install)");
