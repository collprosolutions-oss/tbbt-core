#!/usr/bin/env bash
# Local debug APK for TBBT Field. Not Play distribution.
# Requires Android SDK + JDK. Fails clearly when they are missing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/apps/native"

if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ]; then
  echo "ANDROID_HOME / ANDROID_SDK_ROOT is unset. This environment cannot assemble an APK."
  echo "Install the Android SDK command-line tools, then re-run:"
  echo "  cd apps/native && npm run android:debug-apk"
  exit 2
fi

cd "$NATIVE"
npm run android:debug-apk
echo "Debug APK: $NATIVE/android/app/build/outputs/apk/debug/app-debug.apk"
