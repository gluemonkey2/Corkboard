// Corkboard desktop app: runs the Corkboard server inside Electron and shows it in its own window.
// The packaged launcher (electron/shell) loads this file from the installed code folder,
// so an update replaces this file without a rebuild of the app.
const { app, BrowserWindow, dialog, shell, nativeTheme, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..'); // the folder with server.js
// CORKBOARD_HOME lets a test run use its own folder (and its own single-instance lock).
// The PEPE_* names are the app's old names and still work.
const env = (k) => process.env[`CORKBOARD_${k}`] || process.env[`PEPE_${k}`];
// Installed code sits in <home>/app/electron, so the home folder is found from here. That keeps an app that
// still runs from the old Pepe folder on its own data, until install.sh moves it.
const INSTALLED = path.basename(ROOT) === 'app' ? path.dirname(ROOT) : null;
const HOME = env('HOME') || INSTALLED || path.join(app.getPath('appData'), 'Corkboard');
const DATA = env('DATA') || path.join(HOME, 'data');
const PORT = Number(env('PORT')) || 4848;
const ORIGIN = `http://localhost:${PORT}`;

app.setName('Corkboard');
app.setPath('userData', path.join(HOME, 'electron')); // keep Chromium's own files apart from Corkboard's data

function info() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/info', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// The window colour before the page loads: the page background of the light or the dark theme.
const paper = () => (nativeTheme.shouldUseDarkColors ? '#17191c' : '#f6f6f4');
const WEB = { contextIsolation: true, sandbox: true, plugins: true }; // plugins: the built-in PDF viewer
// Windows and Linux: the window has its own icon, and its menu bar shows only while Alt is down.
const FRAME = { autoHideMenuBar: true, ...(process.platform === 'darwin' ? {} : { icon: path.join(__dirname, 'icon', 'icon.png') }) };

// The menu of a right-click in a text field or in a card that you write in. Electron shows no menu by itself.
// On a word that the spell check marks: its suggestions, and "add to the dictionary". Then cut, copy and paste.
// (Where the page has a menu of its own, for example on a card or in a table of a note, the page keeps it.)
function textMenu(contents, p) {
  const items = [];
  if (p.isEditable && p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 7)) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
    if (!p.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ type: 'separator' },
      { label: `Add “${p.misspelledWord}” to the dictionary`, click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
      { type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' }, { role: 'selectAll', enabled: p.editFlags.canSelectAll });
  } else if (p.selectionText && p.selectionText.trim()) items.push({ role: 'copy' });
  return items;
}
app.on('web-contents-created', (event, contents) => {
  contents.on('context-menu', (e, p) => {
    const items = textMenu(contents, p), win = BrowserWindow.fromWebContents(contents);
    if (!items.length || !win) return;
    // For a test: write the menu to a file (and choose one item) in place of the menu on the screen.
    const logFile = env('MENU_LOG');
    if (logFile) {
      fs.writeFileSync(logFile, JSON.stringify({ word: p.misspelledWord, items: items.map((i) => i.label || i.role || i.type) }));
      const pick = env('MENU_PICK');
      if (pick != null && items[+pick]?.click) items[+pick].click();
      return;
    }
    Menu.buildFromTemplate(items).popup({ window: win });
  });
});

function createWindow(route = '/') {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Corkboard', backgroundColor: paper(), webPreferences: WEB, ...FRAME,
  });
  win.loadURL(ORIGIN + route);
  // Corkboard's own pages (New window, a PDF from an export) open in app windows. Web links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN) || url.startsWith('blob:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 860, backgroundColor: paper(), webPreferences: WEB, ...FRAME } };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  return win;
}

async function start() {
  const running = await info();
  if (running && running.mode !== 'installed') {
    dialog.showErrorBox('Corkboard', `Port ${PORT} is in use by another program, so Corkboard cannot start.`);
    return app.quit();
  }
  if (!running) {
    Object.assign(process.env, { PORT: String(PORT), CORKBOARD_DATA: DATA, CORKBOARD_MODE: env('MODE') || 'installed' });
    try {
      require(path.join(ROOT, 'server.js'));
    } catch (e) {
      dialog.showErrorBox('Corkboard could not start', String(e && e.stack || e));
      return app.quit();
    }
    for (let i = 0; i < 50 && !(await info()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  createWindow('/');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return createWindow('/');
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow('/'); });
  app.whenReady().then(start);
}
