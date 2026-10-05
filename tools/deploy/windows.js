// Corkboard on Windows: install the desktop app, and update it from the project folder.
//   node tools\deploy\windows.js install     (or double-click tools\deploy\install-windows.cmd)
//   node tools\deploy\windows.js update      (the "Update Corkboard" shortcut on the Desktop does this)
// It is the Windows form of install.sh and corkboard-update.sh. It needs Node.js, and "npm install" in the
// project folder first.
//
//   Code and data:  %APPDATA%\Corkboard          (app = the code, data = your boards and PDFs, logs)
//   The program:    %LOCALAPPDATA%\Programs\Corkboard\Corkboard.exe
//   Shortcuts:      Desktop (Corkboard, Update Corkboard) and the Start menu (Corkboard)
//
// An update tests the new code on a spare port first. If the test fails, nothing changes. Data is never touched.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
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
async function update(dev, { restart = true } = {}) {
  log(`== ${stamp()} update from ${dev}`);
  const next = path.join(APP, 'app.new'), now = path.join(APP, 'app'), prev = path.join(APP, 'app.prev');
  const fail = async (why) => {
    await fsp.rm(next, { recursive: true, force: true }).catch(() => {});
    notify('Corkboard update failed', `${why} Nothing changed. See ${LOG}`);
    return false;
  };
  if (!(await exists(path.join(dev, 'server.js')))) return fail(`The project folder ${dev} is not there.`);
  await retry(() => fsp.rm(next, { recursive: true, force: true }));
  await fsp.cp(dev, next, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });

  // The packages: the ones of the installed version when the lists are the same, else a new install.
  const samePackages = (await exists(path.join(now, 'node_modules')))
    && (await sameFile(path.join(dev, 'package.json'), path.join(now, 'package.json')))
    && (await sameFile(path.join(dev, 'package-lock.json'), path.join(now, 'package-lock.json')));
  if (samePackages) await fsp.cp(path.join(now, 'node_modules'), path.join(next, 'node_modules'), { recursive: true });
  else {
    const npm = spawnSync('npm ci --omit=dev --no-audit --no-fund', { cwd: next, shell: true, encoding: 'utf8', windowsHide: true });
    if (npm.status !== 0) { log(npm.stderr || npm.stdout || ''); return fail('npm could not install the packages.'); }
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
  const version = (await fsp.readFile(path.join(now, 'VERSION'), 'utf8')).trim();
  log(`OK ${version}`);
  if (wasRunning && restart) { startApp(); notify('Corkboard updated', `Version ${version}. Corkboard started again.`); }
  else if (restart) notify('Corkboard updated', `Version ${version}.`);
  return true;
}

// ---------- install ----------
async function install(dev) {
  if (!WIN && !env.CORKBOARD_INSTALL_HOME) throw new Error('This installer is for Windows. On macOS, run: bash tools/deploy/install.sh');
  const electron = path.join(dev, 'node_modules', 'electron', 'dist');
  // New versions of npm do not run the install script of a package, so the Electron program can be absent
  // after "npm install". The script of Electron gets it.
  const getElectron = path.join(dev, 'node_modules', 'electron', 'install.js');
  if (!(await exists(electron)) && (await exists(getElectron))) {
    log('Getting the Electron program...');
    spawnSync(process.execPath, [getElectron], { cwd: path.dirname(getElectron), stdio: 'inherit', windowsHide: true });
  }
  if (!(await exists(electron))) throw new Error('Electron is not there. Run "npm install" in the project folder, then run this install again.');
  await stopApp();
  await fsp.mkdir(path.join(APP, 'bin'), { recursive: true });
  await fsp.mkdir(path.join(APP, 'logs'), { recursive: true });
  // The update shortcut uses its own copy of this script, so a fault in the project folder can not stop an update.
  await fsp.copyFile(__filename, path.join(APP, 'bin', 'corkboard-windows.js'));
  await fsp.copyFile(path.join(dev, 'electron', 'icon', 'Corkboard.ico'), path.join(APP, 'bin', 'Corkboard.ico'));
  await fsp.writeFile(CONFIG, JSON.stringify({ dev, node: process.execPath }, null, 1));

  // First install: the installed data starts as a copy of the data of the project folder, when it has data.
  if (!(await exists(path.join(APP, 'data')))) {
    await fsp.mkdir(path.join(APP, 'data'), { recursive: true });
    for (const d of ['boards', 'pdfs', 'images', 'annotations', 'projects', 'terms', 'files.json']) {
      const from = path.join(dev, 'data', d);
      if (await exists(from)) await fsp.cp(from, path.join(APP, 'data', d), { recursive: true });
    }
  }
  if (!(await update(dev, { restart: false }))) throw new Error(`The code did not install. See ${LOG}`);

  // The program: Electron with a small launcher in it. The launcher loads the installed code, so an update
  // replaces only the code.
  await retry(() => fsp.rm(PROG, { recursive: true, force: true }));
  await fsp.mkdir(path.dirname(PROG), { recursive: true });
  await fsp.cp(electron, PROG, { recursive: true });
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
  const cmd = process.argv[2];
  const noRestart = process.argv.includes('--no-restart');
  if (cmd === 'install') return install(path.resolve(__dirname, '..', '..'));
  if (cmd === 'update') {
    // From the shortcut: the project folder is in the file that the install wrote. From the project folder: this one.
    const dev = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')).dev : path.resolve(__dirname, '..', '..');
    if (!(await update(dev, { restart: !noRestart }))) process.exitCode = 1;
    return;
  }
  console.log('Use: node tools/deploy/windows.js install | update [--no-restart] [--quiet]');
  process.exitCode = 1;
})().catch((e) => { log(`FAILED: ${e.message}`); process.exitCode = 1; });
