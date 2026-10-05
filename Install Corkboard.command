#!/bin/bash
# macOS: double-click this file in the Finder to install Corkboard as a desktop app, with a shortcut on the
# Desktop. It gets the packages when they are not there, then runs tools/deploy/install.sh. It needs Node.js.
cd "$(dirname "$0")" || exit 1
finish() { echo; read -n 1 -s -r -p "Press a key to close this window."; echo; exit "$1"; }

# A window that the Finder starts can have a short PATH: add the usual places of Node.js.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Get it from https://nodejs.org (the LTS version), then open this file again."
  finish 1
fi

if [ ! -d node_modules/electron/dist ]; then
  echo "Getting the packages that Corkboard needs. This can take some minutes..."
  npm install || { echo "npm could not get the packages. Make sure that this computer has a connection to the internet."; finish 1; }
fi

if bash tools/deploy/install.sh; then
  echo
  echo "Corkboard is installed. The Desktop has two shortcuts: Corkboard, and Update Corkboard."
  finish 0
fi
echo "The install failed. The text above gives the cause."
finish 1
