#!/bin/bash
# Rebuild the app icon from electron/icon/icon.svg: icon.png (1024 px) and Corkboard.icns.
#   bash tools/icon/make-icon.sh
# The installed app picks up a new icon only when install.sh runs again.
set -euo pipefail
DEV="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$DEV/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$DEV/tools/icon/render.js" \
  "$DEV/electron/icon/icon.svg" "$TMP/icon.png" "$TMP" >/dev/null 2>&1
mkdir "$TMP/Corkboard.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/Corkboard.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$TMP/Corkboard.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/Corkboard.iconset" -o "$DEV/electron/icon/Corkboard.icns"
cp "$TMP/icon.png" "$DEV/electron/icon/icon.png"
echo "Made electron/icon/icon.png and electron/icon/Corkboard.icns"
