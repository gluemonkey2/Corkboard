// Corkboard on Windows: install the desktop app, and update it.
//   node tools\deploy\windows.js install     (or double-click "Install Corkboard.cmd")
//   node tools\deploy\windows.js update      (the "Update Corkboard" shortcut on the Desktop does this)
// It is the Windows form of install.sh and corkboard-update.sh. It needs Node.js only: no npm and no git.
// The script also works alone, with no project folder: then the install gets the code from GitHub.
//
//   Code and data:  %APPDATA%\Corkboard          (app = the code, data = your boards and PDFs, logs)
//   The program:    %LOCALAPPDATA%\Programs\Corkboard\Corkboard.exe
//   Shortcuts:      Desktop (Corkboard, Update Corkboard) and the Start menu (Corkboard)
//
// An update gets the newest code from GitHub (no git is necessary), tests it on a spare port, and then replaces
// the installed code. If the download or the test fails, nothing changes. Data is never touched.
//   update --local    use the code of the project folder, not GitHub (for a computer where you change the code)
//   update --github   use GitHub (the default after an install)
// The choice is kept for the next updates.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const env = process.env;
// The folders. The CORKBOARD_INSTALL_* names let a test use its own folders.
const APP = env.CORKBOARD_INSTALL_HOME || path.join(env.APPDATA || '', 'Corkboard');
const PROG = env.CORKBOARD_INSTALL_PROGRAM || path.join(env.LOCALAPPDATA || '', 'Programs', 'Corkboard');
const TEST_PORT = Number(env.CORKBOARD_TEST_PORT) || 4849;
const EXE = path.join(PROG, 'Corkboard.exe');
const CONFIG = path.join(APP, 'bin', 'config.json');
const LOG = path.join(APP, 'logs', 'update.log');
const SKIP = new Set(['data', 'node_modules', 'dist', '.claude', '.git', '.DS_Store']);
const REPO = 'gluemonkey2/Corkboard', BRANCH = 'main'; // where the updates come from (config.json can name another)

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
const exists = (p) => fsp.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(line) {
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${line}\n`); } catch { /* no log */ }
}
// Windows keeps a file or a folder busy for a moment after a program stops: try again for a short time.
async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}
const sameFile = async (a, b) => (await exists(a)) && (await exists(b)) && (await fsp.readFile(a)).equals(await fsp.readFile(b));
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
async function writeConfig(change) {
  const next = { ...readConfig(), ...change };
  await fsp.mkdir(path.dirname(CONFIG), { recursive: true });
  await fsp.writeFile(CONFIG, JSON.stringify(next, null, 1));
  return next;
}

// ---------- Windows only: PowerShell, the running app, shortcuts ----------
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`; // a PowerShell string
function powershell(script) {
  if (!WIN) return { status: 0, stdout: '' };
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
}
function notify(title, text) {
  log(`${title}: ${text}`);
  if (!WIN || process.argv.includes('--quiet')) return;
  powershell(`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${quote(text)}, ${quote(title)}) | Out-Null`);
}
function running() {
  if (!WIN) return false;
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Corkboard.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /Corkboard\.exe/i.test(r.stdout || '');
}
// Ask the app to close, and wait. After 8 seconds, stop it.
async function stopApp() {
  if (!running()) return false;
  spawnSync('taskkill', ['/IM', 'Corkboard.exe'], { windowsHide: true });
  for (let i = 0; i < 32 && running(); i++) await sleep(250);
  if (running()) { spawnSync('taskkill', ['/IM', 'Corkboard.exe', '/F'], { windowsHide: true }); await sleep(500); }
  return true;
}
function startApp() {
  if (WIN && fs.existsSync(EXE)) spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
}
function shortcut(file, target, args, icon, style = 1) {
  const r = powershell([
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + quote(file) + ')',
    '$s.TargetPath = ' + quote(target),
    '$s.Arguments = ' + quote(args),
    '$s.WorkingDirectory = ' + quote(path.dirname(target)),
    '$s.IconLocation = ' + quote(icon),
    '$s.WindowStyle = ' + style, // 1: a normal window, 7: minimised
    '$s.Save()',
  ].join('; '));
  if (r.status !== 0) throw new Error(`Could not make the shortcut ${file}. ${r.stderr || ''}`);
}
const folder = (name) => (powershell(`[Environment]::GetFolderPath(${quote(name)})`).stdout || '').trim();

// ---------- the newest code from GitHub ----------
// GitHub gives the files of a branch as one .tar.gz file. No git and no account are necessary for a public
// repository.
function httpsGet(url, hops = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'corkboard-update' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).href, hops - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The server answered ${res.statusCode}.`)); }
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
  });
}
// The download: Node first. On an office network, Node can be stopped by a proxy or by a certificate that only
// Windows knows. Then curl does it (Windows 10 and 11 have curl, and it uses the Windows settings).
async function download(url) {
  if (!env.CORKBOARD_FORCE_CURL) {
    try { return await httpsGet(url); } catch (e) { log(`Node could not get the code (${e.message}). Now with curl...`); }
  }
  const file = path.join(os.tmpdir(), `corkboard-${process.pid}.tar.gz`);
  const r = spawnSync(WIN ? 'curl.exe' : 'curl', ['-fsSL', '--max-time', '120', '-o', file, url], { encoding: 'utf8', windowsHide: true });
  try {
    if (r.status !== 0) throw new Error(`The download failed. ${(r.stderr || '').trim()}`);
    return await fsp.readFile(file);
  } finally { await fsp.rm(file, { force: true }).catch(() => {}); }
}
// A large download, to a file: Node first, then curl (see download()).
function httpsToFile(url, file, hops = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'corkboard-update' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpsToFile(new URL(res.headers.location, url).href, file, hops - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The server answered ${res.statusCode}.`)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
  });
}
async function downloadTo(url, file) {
  if (!env.CORKBOARD_FORCE_CURL) {
    try { return await httpsToFile(url, file); } catch (e) { log(`Node could not get the file (${e.message}). Now with curl...`); }
  }
  const r = spawnSync(WIN ? 'curl.exe' : 'curl', ['-fsSL', '--max-time', '900', '-o', file, url], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`The download failed. ${(r.stderr || '').trim()}`);
}
const hashFile = (file, kind) => new Promise((resolve, reject) => {
  const h = crypto.createHash(kind);
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h)).on('error', reject);
});

// ---------- packages and the Electron program, with no npm ----------
// The npm program of this Node.js, when it has one. (The "npm" command is not on the PATH of every computer.)
function npmCli() {
  const dir = path.dirname(process.execPath);
  return [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) => fs.existsSync(f)) || null;
}
// Install the packages that the app needs when it runs (not the ones for development) into dir/node_modules.
// With npm when this Node.js has it. Else each package comes from the address in package-lock.json, and its
// checksum from that file is checked.
async function installPackages(dir) {
  const cli = env.CORKBOARD_NO_NPM ? null : npmCli();
  if (cli) {
    const r = spawnSync(process.execPath, [cli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return;
    log(`npm did not install the packages. ${(r.stderr || r.stdout || '').trim().slice(0, 400)} Now with a direct download...`);
  }
  const lock = JSON.parse(await fsp.readFile(path.join(dir, 'package-lock.json'), 'utf8'));
  for (const [key, p] of Object.entries(lock.packages || {})) {
    if (!key.startsWith('node_modules/') || p.dev || p.optional || p.devOptional || !p.resolved) continue;
    const gz = await download(p.resolved);
    const [kind, want] = String(p.integrity || '').split('-');
    if (!want || crypto.createHash(kind).update(gz).digest('base64') !== want) throw new Error(`The package ${key.slice(13)} did not pass its check.`);
    await untar(gz, path.join(dir, ...key.split('/')));
    log(`Package ${key.slice(13)} ${p.version}: from ${new URL(p.resolved).host}`);
  }
}
// Put the Electron program into the folder `to`. From the project folder when "npm install" put it there. Else
// from the Electron page on GitHub: the version of package-lock.json, checked with the checksum list of Electron.
async function getProgram(dev, to) {
  const local = path.join(dev, 'node_modules', 'electron', 'dist');
  await retry(() => fsp.rm(to, { recursive: true, force: true }));
  await fsp.mkdir(to, { recursive: true });
  if (!env.CORKBOARD_FORCE_DOWNLOAD && (await exists(local))) return fsp.cp(local, to, { recursive: true });
  const lock = JSON.parse(await fsp.readFile(path.join(dev, 'package-lock.json'), 'utf8'));
  const version = lock.packages?.['node_modules/electron']?.version;
  if (!version) throw new Error('The version of Electron is not in package-lock.json.');
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`, base = `https://github.com/electron/electron/releases/download/v${version}`;
  const zip = path.join(os.tmpdir(), `corkboard-${process.pid}-${name}`);
  try {
    log(`Getting the Electron program (${name}, about 120 MB)...`);
    await downloadTo(`${base}/${name}`, zip);
    const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
    const want = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find((x) => x[1] === name)?.[0];
    if (!want || (await hashFile(zip, 'sha256')).digest('hex') !== want) throw new Error('The Electron program did not pass its check.');
    // Windows 10 and 11, macOS and Linux have a tar that reads .zip files. Windows has PowerShell as a second method.
    let r = spawnSync(WIN ? 'tar.exe' : 'tar', ['-xf', zip, '-C', to], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 && WIN) r = powershell(`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(to)} -Force`);
    if (r.status !== 0) throw new Error(`The Electron program could not be unpacked. ${(r.stderr || '').trim().slice(0, 300)}`);
  } finally { await fsp.rm(zip, { force: true }).catch(() => {}); }
}

// Write the files of a .tar.gz into a folder. The first folder of each path (Corkboard-main/) is left out.
async function untar(gz, dest) {
  const buf = zlib.gunzipSync(gz), root = path.resolve(dest);
  let off = 0, longName = null, files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    off += 512;
    if (!h[0]) break; // the end: empty blocks
    const text = (start, len) => { const z = h.indexOf(0, start); return h.toString('utf8', start, z < 0 || z > start + len ? start + len : z); };
    const size = parseInt(text(124, 12).trim() || '0', 8) || 0;
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    // A name longer than 100 letters comes in a block of its own before the file.
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); if (m) longName = m[1]; continue; }
    if (type === 'g') continue; // a note for the whole archive
    const prefix = h.toString('ascii', 257, 262) === 'ustar' ? text(345, 155) : '';
    const name = longName || (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longName = null;
    const rel = name.split('/').slice(1).filter(Boolean);
    if (!rel.length || rel.includes('..')) continue;
    const out = path.resolve(root, ...rel);
    if (!out.startsWith(root + path.sep)) continue; // never outside the folder
    if (type === '5') { await fsp.mkdir(out, { recursive: true }); continue; }
    if (type !== '0') continue; // links and other special entries: the project has none
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, data);
    if (!WIN && (parseInt(text(100, 8).trim() || '0', 8) & 0o111)) await fsp.chmod(out, 0o755);
    files++;
  }
  return files;
}
// Get the code of the branch into a new temporary folder. Returns { dir, mark }: mark changes when the code changes.
async function fromGitHub(repo, branch) {
  const gz = await download(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'corkboard-update-'));
  const files = await untar(gz, dir);
  if (!files || !(await exists(path.join(dir, 'server.js')))) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('The download from GitHub was not complete.');
  }
  return { dir, mark: crypto.createHash('sha256').update(gz).digest('hex').slice(0, 16) };
}

// ---------- update: the same steps on every system ----------
function testRun(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
      env: { ...env, PORT: String(TEST_PORT), CORKBOARD_DATA: path.join(APP, 'data'), CORKBOARD_MODE: 'installed' }, stdio: 'ignore', windowsHide: true,
    });
    const get = (p) => new Promise((res) => {
      const req = http.get({ host: '127.0.0.1', port: TEST_PORT, path: p, timeout: 1000 }, (r) => { r.resume(); res(r.statusCode === 200); });
      req.on('error', () => res(false));
      req.on('timeout', () => { req.destroy(); res(false); });
    });
    let done = false;
    const end = (ok) => { if (done) return; done = true; child.kill(); resolve(ok); };
    child.on('exit', () => end(false));
    (async () => {
      for (let i = 0; i < 60 && !done; i++) {
        if ((await get('/api/info')) && (await get('/app.js'))) return end(true);
        await sleep(150);
      }
      end(false);
    })();
  });
}
// source: 'github' gets the newest code from GitHub. 'folder' uses the project folder `dev`.
async function update(dev, { restart = true, source = 'folder', force = false } = {}) {
  const config = readConfig();
  const next = path.join(APP, 'app.new'), now = path.join(APP, 'app'), prev = path.join(APP, 'app.prev');
  let temp = null, mark = null;
  const tidy = async () => { if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}); };
  const fail = async (why) => {
    await fsp.rm(next, { recursive: true, force: true }).catch(() => {});
    await tidy();
    notify('Corkboard update failed', `${why} Nothing changed. See ${LOG}`);
    return false;
  };
  if (source === 'github') {
    const repo = config.repo || REPO, branch = config.branch || BRANCH;
    log(`== ${stamp()} update from GitHub (${repo}, ${branch})`);
    try { ({ dir: temp, mark } = await fromGitHub(repo, branch)); } catch (e) {
      return fail(`Corkboard could not get the new code from GitHub. ${e.message} Make sure that this computer has a connection to the internet.`);
    }
    dev = temp;
    if (!force && mark === config.mark && (await exists(now))) {
      await tidy();
      log('No change on GitHub.');
      if (restart) notify('Corkboard', 'Corkboard is the newest version already.');
      return true;
    }
  } else log(`== ${stamp()} update from ${dev}`);

  if (!(await exists(path.join(dev, 'server.js')))) return fail(`The project folder ${dev} is not there.`);
  await retry(() => fsp.rm(next, { recursive: true, force: true }));
  await fsp.cp(dev, next, { recursive: true, filter: (src) => src === dev || !SKIP.has(path.basename(src)) });

  // The packages: the ones of the installed version when the lists are the same, else a new install.
  const samePackages = (await exists(path.join(now, 'node_modules')))
    && (await sameFile(path.join(dev, 'package.json'), path.join(now, 'package.json')))
    && (await sameFile(path.join(dev, 'package-lock.json'), path.join(now, 'package-lock.json')));
  if (samePackages) await fsp.cp(path.join(now, 'node_modules'), path.join(next, 'node_modules'), { recursive: true });
  else {
    try { await installPackages(next); } catch (e) { return fail(`The packages did not install. ${e.message}`); }
  }
  for (const f of ['server.js', path.join('electron', 'main.js')]) {
    if (spawnSync(process.execPath, ['--check', path.join(next, f)], { windowsHide: true }).status !== 0) return fail('The code has a syntax error.');
  }
  await fsp.writeFile(path.join(next, 'VERSION'), `${stamp()}\n`);
  await fsp.mkdir(path.join(APP, 'data'), { recursive: true });
  if (!(await testRun(next))) return fail('The new version did not start in the test run.');

  // Windows can not replace the folder of a program that runs: stop the app, replace the code, start the app.
  const wasRunning = await stopApp();
  await retry(() => fsp.rm(prev, { recursive: true, force: true }));
  if (await exists(now)) await retry(() => fsp.rename(now, prev));
  await retry(() => fsp.rename(next, now));
  await tidy();
  // The update shortcut uses the copy of this script in the bin folder: the new code brings its new version.
  const self = path.join(now, 'tools', 'deploy', 'windows.js');
  if (await exists(self)) await fsp.copyFile(self, path.join(APP, 'bin', 'corkboard-windows.js')).catch(() => {});
  await writeConfig({ source, mark }); // mark: which code of GitHub is installed (none after an update from a folder)
  const version = (await fsp.readFile(path.join(now, 'VERSION'), 'utf8')).trim();
  log(`OK ${version}`);
  // The program (Electron) is not a part of an update. A new version of it needs the installer.
  let note = '';
  try {
    const want = JSON.parse(await fsp.readFile(path.join(now, 'package.json'), 'utf8')).devDependencies?.electron;
    if (config.electron && want && want !== config.electron) note = ' This version asks for a newer program part: run "Install Corkboard.cmd" one time.';
  } catch { /* no note */ }
  if (wasRunning && restart) { startApp(); notify('Corkboard updated', `Version ${version}. Corkboard started again.${note}`); }
  else if (restart) notify('Corkboard updated', `Version ${version}.${note}`);
  return true;
}

// ---------- install ----------
async function install(dev, { source = 'github' } = {}) {
  if (!WIN && !env.CORKBOARD_INSTALL_HOME) throw new Error('This installer is for Windows. On macOS, run: bash tools/deploy/install.sh');
  // This script alone, with no project folder around it: the code comes from GitHub.
  let temp = null;
  if (!(await exists(path.join(dev, 'server.js')))) {
    log(`Getting the code from GitHub (${REPO})...`);
    ({ dir: temp } = await fromGitHub(REPO, BRANCH));
    dev = temp;
  }
  try { await installFrom(dev, source, !!temp); } finally { if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}); }
}
async function installFrom(dev, source, fetched) {
  await stopApp();
  await fsp.mkdir(path.join(APP, 'bin'), { recursive: true });
  await fsp.mkdir(path.join(APP, 'logs'), { recursive: true });
  // The update shortcut uses its own copy of this script, so a fault in the project folder can not stop an update.
  await fsp.copyFile(path.join(dev, 'tools', 'deploy', 'windows.js'), path.join(APP, 'bin', 'corkboard-windows.js'));
  await fsp.copyFile(path.join(dev, 'electron', 'icon', 'Corkboard.ico'), path.join(APP, 'bin', 'Corkboard.ico'));
  let wantElectron = null;
  try { wantElectron = JSON.parse(await fsp.readFile(path.join(dev, 'package.json'), 'utf8')).devDependencies?.electron || null; } catch { /* not known */ }
  // dev: the project folder, for "update --local". Code that came from GitHub for this install has none.
  await writeConfig({ dev: fetched ? null : dev, node: process.execPath, source, electron: wantElectron });

  // First install: the installed data starts as a copy of the data of the project folder, when it has data.
  if (!(await exists(path.join(APP, 'data')))) {
    await fsp.mkdir(path.join(APP, 'data'), { recursive: true });
    for (const d of ['boards', 'pdfs', 'images', 'annotations', 'projects', 'terms', 'docs', 'files.json']) {
      const from = path.join(dev, 'data', d);
      if (await exists(from)) await fsp.cp(from, path.join(APP, 'data', d), { recursive: true });
    }
  }
  // The code of the first install is the code of this folder. The updates after it follow `source`.
  if (!(await update(dev, { restart: false, source: 'folder' }))) throw new Error(`The code did not install. See ${LOG}`);
  await writeConfig({ source });

  // The program: Electron with a small launcher in it. The launcher loads the installed code, so an update
  // replaces only the code.
  await getProgram(dev, PROG);
  if (await exists(path.join(PROG, 'electron.exe'))) await retry(() => fsp.rename(path.join(PROG, 'electron.exe'), EXE));
  await fsp.rm(path.join(PROG, 'resources', 'default_app.asar'), { force: true });
  await fsp.cp(path.join(dev, 'electron', 'shell'), path.join(PROG, 'resources', 'app'), { recursive: true });

  if (WIN) {
    const icon = path.join(APP, 'bin', 'Corkboard.ico'), desktop = folder('Desktop'), programs = folder('Programs');
    shortcut(path.join(desktop, 'Corkboard.lnk'), EXE, '', icon);
    shortcut(path.join(programs, 'Corkboard.lnk'), EXE, '', icon);
    shortcut(path.join(desktop, 'Update Corkboard.lnk'), process.execPath, `"${path.join(APP, 'bin', 'corkboard-windows.js')}" update`, icon, 7);
  }
  log(`Installed: ${EXE} (data in ${path.join(APP, 'data')})`);
}

(async () => {
  const cmd = process.argv[2], has = (flag) => process.argv.includes(flag);
  const project = path.resolve(__dirname, '..', '..');
  if (cmd === 'install') return install(project, { source: has('--local') ? 'folder' : 'github' });
  if (cmd === 'update') {
    const config = readConfig();
    // Where the code comes from: what the command says, else what the last update used, else GitHub.
    const source = has('--local') ? 'folder' : has('--github') ? 'github' : config.source || 'github';
    const dev = config.dev || project;
    if (!(await update(dev, { restart: !has('--no-restart'), source, force: has('--force') }))) process.exitCode = 1;
    return;
  }
  console.log('Use: node tools/deploy/windows.js install [--local] | update [--github | --local] [--force] [--no-restart] [--quiet]');
  process.exitCode = 1;
})().catch((e) => { log(`FAILED: ${e.message}`); process.exitCode = 1; });
