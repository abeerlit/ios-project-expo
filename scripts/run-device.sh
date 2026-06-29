#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE_UDID="${DEVICE_UDID:-00008110-0012319C14EA201E}"
BUNDLE_ID="${IOS_BUNDLE_ID:-co.voxo.voxo-ios}"

echo "==> Start Metro (background) if not running"
if ! lsof -i :8081 >/dev/null 2>&1; then
  npx expo start --dev-client --port 8081 &
  METRO_PID=$!
  sleep 6
else
  METRO_PID=""
  echo "Metro already on :8081"
fi

echo "==> Build & install on device ${DEVICE_UDID}"
npx expo run:ios --device "$DEVICE_UDID" 2>&1 | tee /tmp/voxo-ios-run.log

if [[ -n "${METRO_PID}" ]]; then
  kill "$METRO_PID" 2>/dev/null || true
fi
