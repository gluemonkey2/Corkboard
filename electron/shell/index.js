// Corkboard launcher. The real code lives in ~/Library/Application Support/Corkboard/app,
// so "Update Corkboard" can replace it without a rebuild of this app. On Windows that folder is
// %APPDATA%\Corkboard\app.
const { app, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const main = process.env.CORKBOARD_MAIN || process.env.PEPE_MAIN || path.join(app.getPath('appData'), 'Corkboard', 'app', 'electron', 'main.js');
if (fs.existsSync(main)) {
  require(main);
} else {
  app.whenReady().then(() => {
    const installer = process.platform === 'win32' ? 'tools\\deploy\\install-windows.cmd' : 'tools/deploy/install.sh';
    dialog.showErrorBox('Corkboard is not installed', `${main} is missing. Run ${installer} in the Corkboard project folder.`);
    app.quit();
  });
}
