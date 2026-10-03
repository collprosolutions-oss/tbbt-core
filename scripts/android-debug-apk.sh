#!/usr/bin/env bash
# Local debug-shell recipe for TBBT Field. Not Play distribution.
# UNVERIFIED without an Android SDK and a device/emulator.
#
# `expo prebuild` rewrites the android/ios scripts in apps/native/package.json.
# This wrapper copies that tracked file aside and restores it after prebuild
# so the recipe does not leave a dirty git tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/apps/native"
PREBUILD_ONLY=0
if [ "${1:-}" = "--prebuild-only" ]; then
  PREBUILD_ONLY=1
fi

if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ]; then
  echo "ANDROID_HOME / ANDROID_SDK_ROOT is unset. This environment cannot assemble an APK."
  echo "Install the Android SDK command-line tools, then re-run:"
  echo "  bash scripts/android-debug-apk.sh"
  echo "The resulting assembleDebug APK is a debug native shell and still needs Metro"
  echo "unless you separately export and embed a JS bundle. It is UNVERIFIED here."
  exit 2
fi

cd "$NATIVE"
PKG="$NATIVE/package.json"
PKG_BAK="$(mktemp)"
cp "$PKG" "$PKG_BAK"
restore_pkg() {
  cp "$PKG_BAK" "$PKG"
  rm -f "$PKG_BAK"
}
trap restore_pkg EXIT

npx expo prebuild --platform android
restore_pkg
trap - EXIT

if [ "$PREBUILD_ONLY" -eq 1 ]; then
  echo "Prebuild finished. Tracked apps/native/package.json was restored."
  exit 0
fi

cd "$NATIVE/android"
./gradlew assembleDebug
echo "Debug APK: $NATIVE/android/app/build/outputs/apk/debug/app-debug.apk"
echo "This debug shell still needs Metro unless a JS bundle was embedded. UNVERIFIED without a device."
