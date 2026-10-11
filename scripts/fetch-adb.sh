#!/usr/bin/env bash
# Fetches Google's official platform-tools and installs `adb` as a Tauri sidecar
# (src-tauri/binaries/adb-{aarch64,x86_64,universal}-apple-darwin). Run once before `npm run tauri build`.
set -euo pipefail
cd "$(dirname "$0")/.."
URL=https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/pt.zip"
unzip -q "$TMP/pt.zip" -d "$TMP"
mkdir -p src-tauri/binaries
for arch in arm64:aarch64 x86_64:x86_64; do
  lipo -thin "${arch%%:*}" "$TMP/platform-tools/adb" -output "src-tauri/binaries/adb-${arch##*:}-apple-darwin"
done
# the universal sidecar is Google's original fat binary
cp "$TMP/platform-tools/adb" src-tauri/binaries/adb-universal-apple-darwin
for f in src-tauri/binaries/adb-*-apple-darwin; do
  chmod 755 "$f"
  codesign --force --sign - "$f"        # thinning/copying can invalidate signatures; arm64 requires one
done
cp "$TMP/platform-tools/NOTICE.txt" src-tauri/binaries/adb-NOTICE.txt
echo "installed:"; shasum -a 256 src-tauri/binaries/adb-*-apple-darwin; lipo -archs src-tauri/binaries/adb-universal-apple-darwin
