#!/usr/bin/env node
/**
 * Copies default VOXO AppIcon into branding/ + assets/.
 * Manual only: npm run branding:sync
 */
const fs = require("fs");
const path = require("path");
const { getNativeIosRoot } = require("./native-ios-root");

const root = path.resolve(__dirname, "..");
const iconSources = [
  path.join(getNativeIosRoot(), "branding", "app-icon-1024.png"),
  path.join(root, "branding", "voxo", "icon.png")
];

const defaultBrandDir = path.join(root, "branding", "voxo");
const assetTargets = [
  path.join(root, "assets", "icon.png"),
  path.join(root, "assets", "splash-icon.png"),
  path.join(root, "assets", "adaptive-icon.png")
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function ensureTenantPlaceholder(tenantId) {
  const dir = path.join(root, "branding", tenantId);
  const icon = path.join(dir, "icon.png");
  const splash = path.join(dir, "splash.png");
  const voxoIcon = path.join(defaultBrandDir, "icon.png");
  const voxoSplash = path.join(defaultBrandDir, "splash.png");
  if (!fs.existsSync(icon) && fs.existsSync(voxoIcon)) {
    copyFile(voxoIcon, icon);
    console.log(`[sync-branding] placeholder ${tenantId}/icon.png (replace for white label)`);
  }
  if (!fs.existsSync(splash) && fs.existsSync(voxoSplash)) {
    copyFile(voxoSplash, splash);
  }
}

const sourceIcon = iconSources.find((p) => fs.existsSync(p));
if (!sourceIcon) {
  console.warn("[sync-branding] No icon source found (native-ios/branding or branding/voxo/)");
  process.exit(0);
}

copyFile(sourceIcon, path.join(defaultBrandDir, "icon.png"));
copyFile(sourceIcon, path.join(defaultBrandDir, "splash.png"));

for (const dest of assetTargets) {
  copyFile(sourceIcon, dest);
}

ensureTenantPlaceholder("tenant-a");
ensureTenantPlaceholder("tenant-b");

console.log("[sync-branding] VOXO icon synced from", path.relative(root, sourceIcon));
