# iOS native setup (DOOK-1276)

One command regenerates and fixes native iOS from **`.env` + config plugins** — do not hand-edit `ios/` (change `plugins/` or `scripts/` instead).

## First time / clean machine

```bash
cd ios-project-expo
cp .env.example .env    # edit flags + bundle id as needed
npm ci
npm run ios:setup:clean # expo prebuild --clean → native fixes → pod install
open ios/VOXOConnect.xcworkspace
```

Build in Xcode (⌘B) or verify from CLI:

```bash
npm run ios:setup:verify
```

## Day-to-day

| Command | When |
|---------|------|
| `npm run ios:setup` | After pulling plugin/script changes, or odd Xcode errors |
| `npm run ios:setup:clean` | After `app.config.ts` / plugin changes, or corrupted `ios/` |
| `npm run ios:pod-install` | Only Podfile.lock drift (pods only, no prebuild) |
| `npm run start:device` | Metro + dev client (after native build exists) |

## Environment (`.env`)

| Variable | Effect |
|----------|--------|
| `EXPO_PUBLIC_NATIVE_TELEPHONY=1` | CallKit, PushKit, `VoxoNative/`, in-call audio |
| `EXPO_PUBLIC_NATIVE_NOTIFICATIONS=1` | FCM + notification service extension |
| `EXPO_PUBLIC_MEETINGS_NATIVE=1` | Daily + `ScreenCaptureExtension` |
| `IOS_BUNDLE_ID`, `APP_GROUP`, `DISPLAY_NAME` | White-label (read at prebuild) |
| `APP_ICON`, `SPLASH_IMAGE` | Branding assets |
| `GOOGLE_SERVICES_PLIST` | Firebase plist path |
| `APS_ENVIRONMENT` | `development` or `production` push entitlement |

## EAS production (App Store)

Apple requires **Xcode 26+** for App Store uploads (from April 28, 2026). Expo SDK 52 defaults to Xcode 16 on EAS unless you pin an image.

`eas.json` sets `"image": "macos-sequoia-15.6-xcode-26.2"` on all iOS profiles. After changing it, run a new production build:

```bash
cd voxo-manager
npm run voxo -- ios build voxo --skip-install --skip-editor
```

Confirm in the Expo build log under **Spin up build environment** that Xcode 26.2 is used before submitting.

EAS builds use the same variables via `eas.json` profile `env`.

## What `ios:setup` runs

1. Load `.env`
2. Optional: `expo prebuild --platform ios --clean` (`ios:setup:clean` only)
3. Copy `VoxoNative/*` from bare `ios-project` (if telephony/notifications on)
4. Register `VoxoNative` in Xcode + header search paths
5. Apply PushKit `AppDelegate` (single copy, deduped)
6. `pod install` (Podfile `post_install` fixes ScreenCaptureExtension)
7. Re-run screen-capture fix script (idempotent)

## Do not use

- **`npm run ios:telephony`** for full AppDelegate — it only re-syncs native files; AppDelegate comes from plugins + `patch-appdelegate-pushkit.js`.
- Opening `VOXOConnect.xcodeproj` without `.xcworkspace`
- Editing `ios/VOXOConnect.xcodeproj` by hand (changes lost on next `ios:setup:clean`)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Pod sandbox not in sync | `npm run ios:pod-install` |
| `Podfile` syntax error / unexpected end-of-input | `node scripts/fix-podfile-structure.js` then `npm run ios:pod-install` |
| ScreenCaptureExtension Expo errors | `node scripts/fix-screen-capture-extension-ios.js && npm run ios:pod-install` then Clean Build |
| Duplicate PushKit methods | `npm run ios:setup` (dedupes AppDelegate) |
| Missing `VOXOConnectBackgroundActivator.h` | `EXPO_PUBLIC_NATIVE_TELEPHONY=1` + `npm run ios:setup` |
