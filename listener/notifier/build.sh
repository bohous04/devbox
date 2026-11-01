#!/bin/bash
# Build + install "Devbox Notifier.app" — an ad-hoc-signed UNUserNotificationCenter
# helper whose bundle icon is the devbox amber >_ PNG.
set -euo pipefail

ICON_SRC="${1:?usage: build.sh <icon.png> [install-dir]}"
INSTALL_DIR="${2:-$HOME/Applications}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
APP="$WORK/Devbox Notifier.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SRC_DIR/Info.plist" "$APP/Contents/Info.plist"

# PNG -> icns (iconutil only accepts canonical iconset names)
ICONSET="$WORK/devbox.iconset"
mkdir -p "$ICONSET"
sips -z 16 16   "$ICON_SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32   "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
cp "$ICONSET/icon_16x16@2x.png" "$ICONSET/icon_32x32.png"
sips -z 64 64   "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128 "$ICON_SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
cp "$ICONSET/icon_128x128@2x.png" "$ICONSET/icon_256x256.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/devbox.icns"

swiftc -O "$SRC_DIR/main.swift" -o "$APP/Contents/MacOS/devbox-notify"

# Ad-hoc sign LAST — any later edit to the bundle invalidates the seal and
# usernoted will silently refuse to register the app.
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"

mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/Devbox Notifier.app"
ditto "$APP" "$INSTALL_DIR/Devbox Notifier.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$INSTALL_DIR/Devbox Notifier.app"
rm -rf "$WORK"
echo "installed: $INSTALL_DIR/Devbox Notifier.app"
