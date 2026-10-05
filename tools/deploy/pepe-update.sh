#!/bin/bash
# Copy the current code from the dev folder into the installed Pepe, then restart the app.
# The new code is tested on a spare port first. If the test fails, nothing changes.
# Data is never touched.   Options: --no-restart
APP="@APP@"
DEV="@DEV@"
TEST_PORT=4849
BUNDLE=com.local.pepe
export PATH="@NODE_DIR@:/usr/bin:/bin:/usr/sbin:/sbin"
LOG="$APP/logs/update.log"
mkdir -p "$APP/logs"

notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
fail() { echo "FAILED: $1"; rm -rf "$APP/app.new"; notify "Pepe update failed" "$1 Nothing changed. See $LOG"; exit 1; }

exec >> "$LOG" 2>&1
echo "== $(date '+%Y-%m-%d %H:%M:%S') update from $DEV"

rm -rf "$APP/app.new"
rsync -a --exclude 'data/' --exclude 'node_modules/' --exclude 'dist/' --exclude '.claude/' --exclude '.DS_Store' \
  "$DEV/" "$APP/app.new/" || fail "Could not copy the code from $DEV."

if [ -d "$APP/app/node_modules" ] && cmp -s "$DEV/package.json" "$APP/app/package.json" \
   && cmp -s "$DEV/package-lock.json" "$APP/app/package-lock.json"; then
  cp -R "$APP/app/node_modules" "$APP/app.new/"
else
  (cd "$APP/app.new" && npm ci --omit=dev --no-audit --no-fund) || fail "npm could not install the packages."
fi
node --check "$APP/app.new/server.js" && node --check "$APP/app.new/electron/main.js" || fail "The code has a syntax error."
date '+%Y-%m-%d %H:%M' > "$APP/app.new/VERSION"

# Test run on a spare port, with the real data folder (the server writes nothing at start).
PORT=$TEST_PORT PEPE_DATA="$APP/data" PEPE_MODE=installed node "$APP/app.new/server.js" &
TEST_PID=$!
ok=""
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "http://localhost:$TEST_PORT/api/info" && curl -sf -o /dev/null "http://localhost:$TEST_PORT/app.js"; then ok=1; break; fi
  sleep 0.1
done
kill "$TEST_PID" 2>/dev/null; wait "$TEST_PID" 2>/dev/null
[ -n "$ok" ] || fail "The new version did not start in the test run."

rm -rf "$APP/app.prev"
[ -d "$APP/app" ] && mv "$APP/app" "$APP/app.prev"
mv "$APP/app.new" "$APP/app"
echo "OK $(cat "$APP/app/VERSION")"

if [ "${1:-}" != "--no-restart" ] && pgrep -f "Pepe.app/Contents/MacOS/Pepe" >/dev/null; then
  osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1
  for _ in $(seq 1 100); do pgrep -f "Pepe.app/Contents/MacOS/Pepe" >/dev/null || break; sleep 0.1; done
  open -b "$BUNDLE"
  notify "Pepe updated" "Version $(cat "$APP/app/VERSION"). Pepe restarted."
else
  notify "Pepe updated" "Version $(cat "$APP/app/VERSION")."
fi
