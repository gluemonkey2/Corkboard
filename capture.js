// Turn a web page, or a file that is not a PDF (an image, HTML, text, Markdown), into a PDF snapshot.
// It needs the desktop app: a hidden Electron window loads the page and prints it to PDF. Under plain Node
// (npm start in a browser) capture is not available.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const electron = process.versions.electron ? require('electron') : null;
const available = () => !!(electron && electron.BrowserWindow && electron.app?.isReady());

// One web session for snapshots, source checks and sign-in windows. It is kept between runs, so a site that
// the user signed in to (in a sign-in window) stays signed in for later checks and snapshots.
const PARTITION = 'persist:corkboard-web';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Load a URL in a hidden window, let it settle, and print it. Returns { pdf (Buffer), title }.
async function print(url, { timeout = 45000 } = {}) {
  const { BrowserWindow, session } = electron;
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { session: session.fromPartition(PARTITION), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // A captured page cannot open more windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([
      win.loadURL(url),
      wait(timeout).then(() => { throw new Error('The page took too long to load.'); }),
    ]);
    // Give scripts and late images a moment. Scroll to the end once, so pictures that load on scroll come in.
    await wait(1200);
    await win.webContents.executeJavaScript('window.scrollTo(0, document.body ? document.body.scrollHeight : 0); 1').catch(() => {});
    await wait(800);
    await win.webContents.executeJavaScript('window.scrollTo(0, 0); 1').catch(() => {});
    await wait(300);
    const title = win.webContents.getTitle();
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    return { pdf: Buffer.from(pdf), title };
  } finally {
    win.destroy();
  }
}

// A web page, by its address.
async function captureUrl(url) {
  if (!available()) throw Object.assign(new Error('Web pages can be added in the desktop app only.'), { status: 501 });
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('That is not a web address.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https addresses can be captured.'), { status: 400 });
  const { pdf, title } = await print(u.href);
  return { pdf, title: title && title !== u.href ? title : u.hostname };
}

// A file: an image, an HTML page, or text / Markdown. It is laid out on A4 pages and printed.
async function captureFile(buf, name, type) {
  if (!available()) throw Object.assign(new Error('Files other than PDFs can be added in the desktop app only.'), { status: 501 });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'corkboard-capture-'));
  try {
    const ext = path.extname(name).toLowerCase();
    let page;
    if (/^image\//.test(type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      const img = path.join(dir, `image${ext || '.png'}`);
      await fsp.writeFile(img, buf);
      page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(name)}</title>
        <style>body{margin:0}img{display:block;max-width:100%;margin:0 auto}</style><img src="${pathToFileURL(img).href}">`;
    } else if (type === 'text/html' || ['.html', '.htm'].includes(ext)) {
      page = buf.toString('utf8');
    } else if (/^text\//.test(type) || ['.txt', '.md', '.markdown', '.csv', '.log'].includes(ext)) {
      page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(name)}</title>
        <style>body{font:12pt/1.45 -apple-system,Helvetica,Arial,sans-serif;margin:0}pre{white-space:pre-wrap;word-wrap:break-word;font:inherit}</style>
        <pre>${escapeHtml(buf.toString('utf8'))}</pre>`;
    } else {
      throw Object.assign(new Error(`${name}: this kind of file cannot be added. Use a PDF, an image, HTML, text or Markdown.`), { status: 415 });
    }
    const file = path.join(dir, 'page.html');
    await fsp.writeFile(file, page);
    const { pdf } = await print(pathToFileURL(file).href);
    return { pdf, title: name };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The text of a web page as a reader sees it (for the source checks). Returns { text, title, url }.
async function pageText(url, { timeout = 45000 } = {}) {
  if (!available()) throw Object.assign(new Error('Sources can be checked in the desktop app only.'), { status: 501 });
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('That is not a web address.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https addresses can be checked.'), { status: 400 });
  const { BrowserWindow, session } = electron;
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { session: session.fromPartition(PARTITION), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([
      win.loadURL(u.href),
      wait(timeout).then(() => { throw new Error('The page took too long to load.'); }),
    ]);
    await wait(1500); // scripts that fill the page
    const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    return { text: String(text || ''), title: win.webContents.getTitle(), url: win.webContents.getURL() };
  } finally {
    win.destroy();
  }
}

// A window where the user signs in to a site by hand. It uses the same web session as the checks and the
// snapshots. Corkboard does not read or keep what the user types: the site's cookies stay in that session.
function signIn(url) {
  if (!available()) throw Object.assign(new Error('Sign-in windows work in the desktop app only.'), { status: 501 });
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('That is not a web address.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https addresses can be opened.'), { status: 400 });
  const { BrowserWindow, session } = electron;
  const prefs = { session: session.fromPartition(PARTITION), sandbox: true, contextIsolation: true, nodeIntegration: false };
  const win = new BrowserWindow({ width: 1100, height: 820, title: 'Sign in — close this window when you are done', webPreferences: prefs });
  // A sign-in can open a second window (single sign-on): it gets the same session.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 700, webPreferences: prefs } }));
  win.loadURL(u.href).catch(() => {});
  return { ok: true };
}

module.exports = { available, captureUrl, captureFile, pageText, signIn };
