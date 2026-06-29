# VOXO Connect — iOS Expo (prebuild)

Expo SDK 52 / React Native 0.76.9 standalone app. Vendored JavaScript in [`src/`](src/) and iOS native templates in [`native-ios/`](native-ios/). No symlink to [`ios-project`](../ios-project/) at install or build time.

## Quick start

```bash
cp .env.example .env
npm install
npm run ios:setup:clean   # prebuild + pods + all native fixes (see IOS_SETUP.md)
open ios/VOXOConnect.xcworkspace
npm run start:device      # Metro + dev client
```

**Repeatable native setup (DOOK-1276):** one command, env-driven — full guide in [IOS_SETUP.md](./IOS_SETUP.md).

| Script | Purpose |
|--------|---------|
| `npm run ios:setup:clean` | Fresh `ios/` from `.env` + plugins |
| `npm run ios:setup` | Re-apply fixes + `pod install` (existing `ios/`) |
| `npm run ios:pod-install` | Pods only |
| `vendor:sync-bare` | Optional manual pull from `ios-project` into `src/` + `native-ios/` |

Do not open `VOXOConnect.xcodeproj` alone — use **`VOXOConnect.xcworkspace`**.

## Phase flags

| Env | Phase |
|-----|-------|
| `EXPO_PUBLIC_NATIVE_TELEPHONY=0` | 0–2: UI shell without CallKit |
| `EXPO_PUBLIC_NATIVE_TELEPHONY=1` | 4+: VoIP / CallKeep / custom native modules |
| `EXPO_PUBLIC_NATIVE_NOTIFICATIONS=1` | 3+: FCM + NSE |
| `EXPO_PUBLIC_MEETINGS_NATIVE=1` | 7+: Daily meetings + full-device screen share (`npm run ios:meetings` after prebuild) |

## Plugins

- `plugins/withVoxoIos.ts` — orchestrates permissions, entitlements, Firebase, AppDelegate, NSE copy, Daily Podfile hook, optional CallKit/VoIP.

## EAS

```bash
eas build --profile development --platform ios
eas build --profile preview --platform ios
eas build --profile production --platform ios
```

**White-label:** tenant registry and EAS builds live in [`voxo-manager`](../voxo-manager/).

```bash
cd ../voxo-manager && npm ci && npm run build
voxo tenant init tenant-a
# tenant-data/tenant-a/apple.yaml + secrets.env
voxo ios release tenant-a    # build + TestFlight (automatic name/icon/bundle/ASC app)
```

`eas.json` tenant profiles are **generated** from `voxo-manager/tenants/*.yaml` — edit YAML, then `voxo sync eas`. Assets under `branding/<tenant>/` (1024×1024 PNG for icon). See [branding/README.md](./branding/README.md) and [voxo-manager/README.md](../voxo-manager/README.md).

After changing the icon, rebuild native iOS (icon is not a Metro OTA update):

```bash
npm run branding:sync
npm run prebuild:clean
npm run ios:device   # or eas build --profile development --platform ios
```

## Cutover

See [CUTOVER.md](./CUTOVER.md). Do not archive bare `ios-project` until `PARITY_CHECKLIST.md` is all **pass**.
