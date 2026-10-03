#!/usr/bin/env bash
# Local iOS simulator recipe for TBBT Field. Not App Store submission.
# UNVERIFIED without Xcode. This Linux environment cannot sign or install.
#
# `expo prebuild` rewrites the android/ios scripts in apps/native/package.json.
# This wrapper copies that tracked file aside and restores it after prebuild
# so the recipe does not leave a dirty git tree.
#
# --prebuild-only generates the Xcode project with --no-install (no CocoaPods,
# no Apple credentials). A later xcodebuild still needs a Mac + Xcode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/apps/native"
PREBUILD_ONLY=0
if [ "${1:-}" = "--prebuild-only" ]; then
  PREBUILD_ONLY=1
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

CI=1 EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform ios --no-install
restore_pkg
trap - EXIT

if [ "$PREBUILD_ONLY" -eq 1 ]; then
  echo "Prebuild finished. Tracked apps/native/package.json was restored."
  echo "Generated ios/ is gitignored. No Apple credentials were used."
  exit 0
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is not available. This environment cannot sign or install an iOS build."
  echo "The generated ios/ project can be inspected, but no simulator/device install ran."
  echo "UNVERIFIED. Not App Store submission. No Apple credentials are committed."
  exit 2
fi

cd "$NATIVE/ios"
SCHEME="$(basename "$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1)" .xcodeproj)"
if [ -z "$SCHEME" ]; then
  echo "No generated .xcodeproj found after prebuild."
  exit 1
fi
xcodebuild -project "${SCHEME}.xcodeproj" -scheme "$SCHEME" -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO
echo "Simulator build finished for ${SCHEME}. UNVERIFIED without an installed device/simulator run."
