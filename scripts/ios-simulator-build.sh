#!/usr/bin/env bash
# Local iOS simulator recipe for TBBT Field. Not App Store submission.
# UNVERIFIED without Xcode + CocoaPods. This Linux environment cannot
# sign or install.
#
# `expo prebuild` rewrites the android/ios scripts in apps/native/package.json.
# This wrapper copies that tracked file aside and restores it after prebuild
# so the recipe does not leave a dirty git tree.
#
# --prebuild-only generates the Xcode project with --no-install so Linux
# can inspect Info.plist without CocoaPods. The full recipe requires
# xcodebuild and pod first, runs pod install, and builds the .xcworkspace.
# No Apple credentials. No App Store upload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/apps/native"
PREBUILD_ONLY=0
if [ "${1:-}" = "--prebuild-only" ]; then
  PREBUILD_ONLY=1
fi

if [ "$PREBUILD_ONLY" -eq 0 ]; then
  if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "xcodebuild is not available. This environment cannot sign or install an iOS build."
    echo "UNVERIFIED. Not App Store submission. No Apple credentials are committed."
    exit 2
  fi
  if ! command -v pod >/dev/null 2>&1; then
    echo "pod / CocoaPods is not available. The generated project has a CocoaPods Check Pods Manifest.lock phase and needs Pods resources."
    echo "Install CocoaPods, then re-run. Cannot build a bare .xcodeproj. UNVERIFIED."
    echo "Not App Store submission. No Apple credentials are committed."
    exit 2
  fi
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

if [ "$PREBUILD_ONLY" -eq 1 ]; then
  CI=1 EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform ios --no-install
  restore_pkg
  trap - EXIT
  echo "Prebuild finished. Tracked apps/native/package.json was restored."
  echo "Generated ios/ is gitignored. No Apple credentials were used."
  exit 0
fi

CI=1 EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform ios
restore_pkg
trap - EXIT

cd "$NATIVE/ios"
if ! command -v pod >/dev/null 2>&1; then
  echo "pod / CocoaPods disappeared after prebuild. Cannot install Pods."
  echo "UNVERIFIED. Not App Store submission."
  exit 2
fi
pod install

SCHEME="$(basename "$(find . -maxdepth 1 -name '*.xcworkspace' | head -n 1)" .xcworkspace)"
if [ -z "$SCHEME" ]; then
  echo "No generated .xcworkspace found after pod install."
  exit 1
fi
xcodebuild -workspace "${SCHEME}.xcworkspace" -scheme "$SCHEME" -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO
echo "Simulator build finished for ${SCHEME}. UNVERIFIED without an installed device/simulator run."
