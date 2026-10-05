// Render electron/icon/icon.svg to a 1024 px PNG with a hidden Electron window.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const [svgPath, outPath, scratch] = process.argv.slice(-3);
app.setPath('userData', path.join(scratch, 'render-ud'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${fs.readFileSync(svgPath, 'utf8')}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(outPath, img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
