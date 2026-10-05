#!/bin/bash
# Install Corkboard as a desktop app (Electron) with its own data, plus Desktop shortcuts.
#   bash tools/deploy/install.sh
# Run it again to rebuild the app and the shortcuts. It never overwrites existing data.
#
# Corkboard used to be called Pepe. The first run after the rename copies the data of the old Pepe app
# into the Corkboard folder, keeps the old Pepe folder as a backup, and removes the old Pepe app and shortcuts.
set -euo pipefail
DEV="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$HOME/Library/Application Support/Corkboard"
OLD="$HOME/Library/Application Support/Pepe"
APPS="$HOME/Applications"
DESKTOP="$HOME/Desktop"
BUNDLE=com.local.corkboard
OLD_BUNDLE=com.local.pepe
NODE="$(command -v node)" || { echo "node is not on PATH"; exit 1; }
NODE_DIR="$(dirname "$NODE")"
ARCH="$(uname -m)"
EVER="$(node -p "require('$DEV/node_modules/electron/package.json').version")"

# Stop the app (new and old name) and any server that an older, browser-based install left running.
osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1 || true
osascript -e "tell application id \"$OLD_BUNDLE\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 50); do pgrep -f "(Corkboard|Pepe).app/Contents/MacOS" >/dev/null || break; sleep 0.1; done
for pid in $(lsof -ti tcp:4848 -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done

mkdir -p "$APP/bin" "$APP/logs" "$APPS"
sed -e "s|@APP@|$APP|g" -e "s|@DEV@|$DEV|g" -e "s|@NODE_DIR@|$NODE_DIR|g" \
  "$DEV/tools/deploy/corkboard-update.sh" > "$APP/bin/corkboard-update.sh"
chmod +x "$APP/bin/corkboard-update.sh"

MOVED="$APP/.moved-from-pepe" # written when the move from Pepe has finished
if [ -d "$OLD/data" ] && [ ! -e "$MOVED" ]; then
  # Renamed from Pepe: copy the old app's data and its window settings. The old folder stays as a backup.
  # A run that stopped before the end left a copy that may be older than Pepe's data now: set it aside and copy again.
  if [ -d "$APP/data" ]; then
    mv "$APP/data" "$APP/data.unfinished-$(date +%Y%m%d-%H%M%S)"
    rm -rf "$APP/electron"
  fi
  cp -R "$OLD/data" "$APP/data"
  [ -d "$OLD/electron" ] && cp -R "$OLD/electron" "$APP/electron"
  echo "Copied your Pepe data into $APP/data. The old folder $OLD is kept as a backup."
elif [ ! -d "$APP/data" ]; then
  # First install: start the installed data as a copy of the dev data (trash and exports left out).
  mkdir -p "$APP/data"
  for d in boards pdfs images annotations projects; do
    [ -d "$DEV/data/$d" ] && cp -R "$DEV/data/$d" "$APP/data/"
  done
  echo "Copied dev data into $APP/data"
fi

# Code: the same path an update takes.
"$APP/bin/corkboard-update.sh" --no-restart || { tail -n 5 "$APP/logs/update.log"; exit 1; }

# The app itself: a small launcher that loads the installed code.
# Electron itself comes from a local zip, so no download is needed: the packager's cached zip, else one made
# from the Electron in node_modules. (A download needs the network and can fail with "fetch failed".)
rm -rf "$APP/build"
ZIPDIR="$APP/build/zip"
ZIP="electron-v$EVER-darwin-$ARCH.zip"
mkdir -p "$ZIPDIR"
CACHED="$(find "$HOME/Library/Caches/electron" -name "$ZIP" 2>/dev/null | head -n 1 || true)"
if [ -n "$CACHED" ]; then
  cp "$CACHED" "$ZIPDIR/$ZIP"
else
  (cd "$DEV/node_modules/electron/dist" && zip -qry "$ZIPDIR/$ZIP" .)
fi
(cd "$DEV" && npx --no-install @electron/packager electron/shell Corkboard --platform=darwin --arch="$ARCH" \
  --electron-version="$EVER" --electron-zip-dir="$ZIPDIR" --icon=electron/icon/Corkboard.icns --app-bundle-id="$BUNDLE" \
  --out="$APP/build" --overwrite --quiet)
rm -rf "$APPS/Corkboard.app"
mv "$APP/build/Corkboard-darwin-$ARCH/Corkboard.app" "$APPS/Corkboard.app"
rm -rf "$APP/build"

# The old Pepe app and its shortcuts go. (Its data folder stays, see above.)
rm -rf "$APPS/Pepe.app" "$DESKTOP/Pepe.app" "$DESKTOP/Update Pepe.app"

# Desktop: a link to the app, and the update shortcut.
rm -rf "$DESKTOP/Corkboard.app"
ln -s "$APPS/Corkboard.app" "$DESKTOP/Corkboard.app"
q() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
rm -rf "$DESKTOP/Update Corkboard.app"
osacompile -o "$DESKTOP/Update Corkboard.app" -e "do shell script \"'$(q "$APP")/bin/corkboard-update.sh'\""
cp "$DEV/electron/icon/Corkboard.icns" "$DESKTOP/Update Corkboard.app/Contents/Resources/applet.icns"
touch "$DESKTOP/Update Corkboard.app"

# The move from Pepe is done: later runs keep the Corkboard data as it is.
if [ -d "$OLD" ]; then touch "$MOVED"; fi

tail -n 2 "$APP/logs/update.log"
echo "Installed: $APPS/Corkboard.app (data in $APP/data)"
