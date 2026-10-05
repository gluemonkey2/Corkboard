// Corkboard — a local whiteboard for PDF snippets.
// Plain Node, no framework. Serves the app, pdf.js, and stores everything under ./data.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.CORKBOARD_DATA || process.env.PEPE_DATA || path.join(ROOT, 'data'));
const DIRS = {
  boards: path.join(DATA, 'boards'),
  pdfs: path.join(DATA, 'pdfs'),
  images: path.join(DATA, 'images'),
  annotations: path.join(DATA, 'annotations'),
  trash: path.join(DATA, 'trash'),
  projects: path.join(DATA, 'projects'),
  exports: path.join(DATA, 'exports'),
  terms: path.join(DATA, 'terms'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.icc': 'application/octet-stream',
};
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Resolve `rel` inside `base`, refusing anything that escapes it.
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serve(res, file, cache) {
  try {
    if (!file) throw new Error('bad path');
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  // On Windows, a file that another program reads at this moment (a virus scanner, a backup) can not be
  // replaced: try again for a short time.
  for (let i = 0; ; i++) {
    try { return await fsp.rename(tmp, file); } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
}

const exists = (f) => fsp.access(f).then(() => true, () => false);
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);

async function createBoard(name) {
  const board = {
    id: crypto.randomBytes(5).toString('hex'),
    name: String(name).slice(0, 200),
    cards: [], links: [], view: { x: 0, y: 0, z: 1 },
    created: Date.now(), updated: Date.now(),
  };
  await writeAtomic(path.join(DIRS.boards, `${board.id}.json`), JSON.stringify(board));
  return board;
}

async function listJson(dir) {
  const out = [];
  for (const f of await fsp.readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))); } catch { /* skip corrupt file */ }
  }
  return out;
}

const projects = require('./projects.js')({ DIRS, listJson, writeAtomic });
const capture = require('./capture.js');
const watch = require('./watch.js');

// Store a PDF in the library (and in a project). A PDF that is there already is only added to the project.
// extra: more about the PDF, for example where a web page snapshot came from.
async function storePdf(buf, name, project, extra = {}) {
  const pid = hash(buf);
  const metaFile = path.join(DIRS.pdfs, `${pid}.json`);
  if (await exists(metaFile)) {
    if (ID.test(project)) await projects.add(project, 'pdfs', pid);
    return { code: 200, meta: JSON.parse(await fsp.readFile(metaFile, 'utf8')) };
  }
  const meta = { id: pid, name: path.basename(name).slice(0, 200), size: buf.length, added: Date.now(), ...extra };
  await writeAtomic(path.join(DIRS.pdfs, `${pid}.pdf`), buf);
  await writeAtomic(metaFile, JSON.stringify(meta));
  if (ID.test(project)) await projects.add(project, 'pdfs', pid);
  return { code: 201, meta };
}
const readJsonBody = async (req) => JSON.parse((await readBody(req, 1e6)).toString() || '{}');

// The sections a place in a PDF falls under, outermost first. A section runs from its heading
// to the next heading of the same or a higher level. (Same rule as PdfView.sectionPath.)
function sectionPath(sections, page, top) {
  const stack = [];
  for (const s of sortSections(sections)) {
    const sy = s.y ?? Infinity;
    if (s.page > page || (s.page === page && sy < top - 0.5)) break;
    stack.length = Math.max(0, s.level - 1);
    stack[s.level - 1] = s;
  }
  return stack.filter(Boolean).map((s) => ({ id: s.id, title: s.title, level: s.level }));
}
const sortSections = (list) => [...(list || [])].sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));

const MODE = process.env.CORKBOARD_MODE || process.env.PEPE_MODE || 'dev';
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return null; } })();

async function handleApi(req, res, parts, query) {
  const [kind, id, sub, subId] = parts;
  // Optional ?project=ID filter for lists.
  const inProject = query.get('project');

  if (kind === 'info' && req.method === 'GET') return json(res, 200, { mode: MODE, version: VERSION, data: DATA, capture: capture.available() });

  if (kind === 'projects') {
    if (!id && req.method === 'GET') return json(res, 200, await projects.summaries());
    if (!id && req.method === 'POST') {
      const body = await readJsonBody(req);
      const board = body.noBoard ? null : await createBoard(body.boardName || 'Board 1');
      return json(res, 201, await projects.create(String(body.name || 'Untitled project').slice(0, 200), board?.id, body.kind));
    }
    if (id && ID.test(id)) {
      if (!sub && req.method === 'GET') return (await projects.load(id)) ? json(res, 200, await projects.load(id)) : json(res, 404, { error: 'no such project' });
      if (!sub && req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const p = await projects.rename(id, String(body.name || '').trim().slice(0, 200) || 'Untitled project');
        return p ? json(res, 200, p) : json(res, 404, { error: 'no such project' });
      }
      if (!sub && req.method === 'DELETE') {
        // The project and its boards go to data/trash. Its PDFs stay in the library.
        const p = await projects.remove(id, { alsoPdfs: query.get('pdfs') === 'unshared' });
        return p ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such project' });
      }
      if (sub === 'files' && req.method === 'PUT') {
        const p = await projects.setFiles(id, await readJsonBody(req));
        return p ? json(res, 200, { folders: p.folders, filed: p.filed }) : json(res, 404, { error: 'no such project' });
      }
      if ((sub === 'pdfs' || sub === 'boards') && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!ID.test(String(body.id || ''))) return json(res, 400, { error: 'bad id' });
        const p = await projects.add(id, sub, body.id);
        return p ? json(res, 200, p) : json(res, 404, { error: 'no such project' });
      }
      if ((sub === 'pdfs' || sub === 'boards') && subId && ID.test(subId) && req.method === 'DELETE') {
        const p = await projects.drop(id, sub, subId);
        return p ? json(res, 200, p) : json(res, 404, { error: 'no such project' });
      }
    }
  }

  // Libraries: every PDF and every board, with the projects they belong to.
  if (kind === 'library' && req.method === 'GET') {
    if (id === 'pdfs') return json(res, 200, await projects.pdfLibrary());
    if (id === 'boards') return json(res, 200, await projects.boardLibrary());
  }

  if (kind === 'boards') {
    if (!id && req.method === 'GET') {
      let boards = await listJson(DIRS.boards);
      if (inProject) {
        const keep = await projects.members(inProject, 'boards');
        if (!keep) return json(res, 404, { error: 'no such project' });
        boards = boards.filter((b) => keep.has(b.id));
      }
      return json(res, 200, boards
        .map((b) => ({ id: b.id, name: b.name, updated: b.updated || 0 }))
        .sort((a, b) => b.updated - a.updated));
    }
    if (!id && req.method === 'POST') {
      const body = await readJsonBody(req);
      const board = await createBoard(body.name || 'Untitled board');
      if (body.projectId && ID.test(body.projectId)) await projects.add(body.projectId, 'boards', board.id);
      return json(res, 201, board);
    }
    if (id && ID.test(id)) {
      const file = path.join(DIRS.boards, `${id}.json`);
      if (req.method === 'GET') return serve(res, file, 'no-store');
      if (req.method === 'PUT') {
        const board = JSON.parse((await readBody(req, 100e6)).toString());
        // Refuse a save made from an old copy, so a stale window cannot undo newer work.
        const base = Number(req.headers['x-base-updated']);
        if (base && !(await exists(file))) return json(res, 410, { error: 'board was deleted' });
        if (base) {
          const current = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (current.updated && current.updated !== base) return json(res, 409, { error: 'board changed elsewhere', updated: current.updated });
        }
        board.id = id;
        board.updated = Date.now();
        await writeAtomic(file, JSON.stringify(board));
        return json(res, 200, { ok: true, updated: board.updated });
      }
      if (req.method === 'DELETE') {
        // Never hard-delete: move the board to data/trash.
        await fsp.rename(file, path.join(DIRS.trash, `board-${id}-${Date.now()}.json`));
        await projects.summaries(); // drops the board from its project
        return json(res, 200, { ok: true });
      }
    }
  }

  // Change a PDF's title or description (the file itself never changes).
  if (kind === 'pdfs' && id && ID.test(id) && req.method === 'PATCH') {
    const metaFile = path.join(DIRS.pdfs, `${id}.json`);
    if (!(await exists(metaFile))) return json(res, 404, { error: 'no such PDF' });
    const body = await readJsonBody(req);
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    if (typeof body.name === 'string' && body.name.trim()) meta.name = body.name.trim().slice(0, 200);
    if (typeof body.description === 'string') meta.description = body.description.slice(0, 5000);
    // The watch on the source: its status (set by the user), a note, the address to check and what to check.
    if (body.watch && typeof body.watch === 'object') {
      const w = { ...(meta.watch || {}) }, b = body.watch;
      if (['unknown', 'current', 'superseded', 'withdrawn'].includes(b.status)) w.status = b.status;
      if (typeof b.note === 'string') w.note = b.note.slice(0, 500);
      if (typeof b.url === 'string') w.url = b.url.trim().slice(0, 2000);
      if (['status', 'page'].includes(b.mode)) w.mode = b.mode;
      meta.watch = w;
    }
    await writeAtomic(metaFile, JSON.stringify(meta));
    return json(res, 200, meta);
  }

  // Check a source: load its watch address (the desktop app does that) and look at what the page says.
  //   - the status that the page declares (current, superseded, withdrawn);
  //   - in "page" mode, which snippets of this document are no longer on the page.
  // The result is kept with the PDF. It never changes the status that the user set.
  if (kind === 'watch' && id === 'check' && sub && ID.test(sub) && req.method === 'POST') {
    const metaFile = path.join(DIRS.pdfs, `${sub}.json`);
    if (!(await exists(metaFile))) return json(res, 404, { error: 'no such PDF' });
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    const url = meta.watch?.url || (meta.source?.kind === 'web' ? meta.source.url : '');
    if (!url) return json(res, 400, { error: 'This source has no address to check.' });
    const mode = meta.watch?.mode || (meta.source?.kind === 'web' ? 'page' : 'status');
    const result = { at: Date.now(), url, mode };
    try {
      const page = await capture.pageText(url);
      const st = watch.statusFrom(page.text);
      Object.assign(result, { title: page.title, landed: page.url, declared: st.line, found: st.status, weak: st.weak });
      if (mode === 'page') {
        const annFile = path.join(DIRS.annotations, `${sub}.json`);
        const ann = (await exists(annFile)) ? JSON.parse(await fsp.readFile(annFile, 'utf8')) : { highlights: [] };
        const snips = (ann.highlights || []).filter((h) => !h.plain && h.text).map((h) => ({ id: h.id, text: h.text }));
        result.total = snips.length;
        result.missing = watch.missingSnippets(page.text, snips);
      }
      const before = meta.watch?.result;
      if (before && !before.error && (before.declared || '') !== (result.declared || '')) result.was = before.declared || '';
    } catch (e) {
      if (e.status === 501 || e.status === 400) return json(res, e.status, { error: e.message });
      result.error = e.message || String(e);
    }
    meta.watch = { ...(meta.watch || {}), checkedAt: result.at, result };
    await writeAtomic(metaFile, JSON.stringify(meta));
    return json(res, 200, meta);
  }
  if (kind === 'watch' && id === 'signin' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, capture.signIn(String(body.url || '').trim()));
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || String(e) });
    }
  }

  // Move a PDF (with its snippets) to the trash and out of every project.
  if (kind === 'pdfs' && id && ID.test(id) && req.method === 'DELETE') {
    if (!(await exists(path.join(DIRS.pdfs, `${id}.json`)))) return json(res, 404, { error: 'no such PDF' });
    await projects.trashPdf(id);
    return json(res, 200, { ok: true });
  }

  if (kind === 'pdfs' && !id) {
    if (req.method === 'GET') {
      let metas = await listJson(DIRS.pdfs);
      if (inProject) {
        const keep = await projects.members(inProject, 'pdfs');
        if (!keep) return json(res, 404, { error: 'no such project' });
        metas = metas.filter((m) => keep.has(m.id));
      }
      return json(res, 200, metas.sort((a, b) => b.added - a.added));
    }
    if (req.method === 'POST') {
      const buf = await readBody(req, 1e9);
      if (buf.subarray(0, 1024).indexOf('%PDF-') === -1) return json(res, 400, { error: 'not a PDF' });
      let name = 'document.pdf';
      try { name = decodeURIComponent(req.headers['x-filename'] || name); } catch { /* keep default */ }
      const { code, meta } = await storePdf(buf, name, String(req.headers['x-project'] || ''));
      return json(res, code, meta);
    }
  }

  // Snapshots: a web page (POST /api/capture/web {url, project}) or a file that is not a PDF
  // (POST /api/capture/file, the file as the body) becomes a PDF in the library. Desktop app only.
  if (kind === 'capture' && req.method === 'POST' && (id === 'web' || id === 'file')) {
    try {
      if (id === 'web') {
        const body = await readJsonBody(req);
        const { pdf, title } = await capture.captureUrl(String(body.url || '').trim());
        const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'Web page';
        const { code, meta } = await storePdf(pdf, `${safe}.pdf`, String(body.project || ''),
          { source: { kind: 'web', url: String(body.url).trim(), title, captured: Date.now() } });
        return json(res, code, meta);
      }
      const buf = await readBody(req, 200e6);
      let name = 'file';
      try { name = decodeURIComponent(req.headers['x-filename'] || name); } catch { /* keep default */ }
      const { pdf } = await capture.captureFile(buf, name, String(req.headers['content-type'] || ''));
      const { code, meta } = await storePdf(pdf, `${path.parse(name).name}.pdf`, String(req.headers['x-project'] || ''),
        { source: { kind: 'file', original: name, captured: Date.now() } });
      return json(res, code, meta);
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || String(e) });
    }
  }

  // Every snippet from every PDF, for the board's tray.
  if (kind === 'snippets' && !id && req.method === 'GET') {
    const allNames = new Map((await listJson(DIRS.pdfs)).map((m) => [m.id, m.name]));
    const names = new Map(allNames);
    if (inProject) {
      const keep = await projects.members(inProject, 'pdfs');
      if (!keep) return json(res, 404, { error: 'no such project' });
      for (const k of [...names.keys()]) if (!keep.has(k)) names.delete(k);
    }
    const all = await listJson(DIRS.annotations);
    // Every snippet by "pdfId:id", so a link can carry its target's text, page and PDF name.
    const index = new Map(all.flatMap((a) => (a.highlights || []).map((h) => [`${a.pdfId}:${h.id}`, h])));
    const out = [];
    for (const a of all) {
      if (!names.has(a.pdfId)) continue;
      for (const h of a.highlights || []) {
        if (h.plain) continue; // a plain highlight is not a snippet
        const top = h.rects?.[0]?.[4] ?? 0;
        const links = (h.links || []).map((l) => {
          const toPdfId = l.pdfId || a.pdfId;
          const t = l.to ? index.get(`${toPdfId}:${l.to}`) : null;
          return { ...l, toPdfId, toPdfName: allNames.get(toPdfId) || '', toText: t ? t.text || 'Area snippet' : '', toPage: t?.page || 1, missing: !!l.to && !t };
        });
        out.push({ ...h, links, pdfId: a.pdfId, pdfName: names.get(a.pdfId), section: sectionPath(a.sections, h.page, top) });
      }
    }
    return json(res, 200, out);
  }

  // Snippets in other PDFs that link into this PDF (links inside one PDF are worked out by the reader).
  if (kind === 'backlinks' && id && ID.test(id) && req.method === 'GET') {
    const names = new Map((await listJson(DIRS.pdfs)).map((m) => [m.id, m.name]));
    const out = [];
    for (const a of await listJson(DIRS.annotations)) {
      if (a.pdfId === id) continue;
      for (const h of a.highlights || []) {
        for (const l of h.links || []) {
          if (l.pdfId !== id) continue;
          out.push({ fromPdfId: a.pdfId, fromPdfName: names.get(a.pdfId) || '', from: { id: h.id, text: h.text, page: h.page, rects: h.rects }, link: l });
        }
      }
    }
    return json(res, 200, out);
  }

  // Sections of every PDF in a project (or all PDFs), for the tray's section filter.
  if (kind === 'sections' && !id && req.method === 'GET') {
    let keep = null;
    if (inProject) {
      keep = await projects.members(inProject, 'pdfs');
      if (!keep) return json(res, 404, { error: 'no such project' });
    }
    const out = {};
    for (const a of await listJson(DIRS.annotations)) {
      if (keep && !keep.has(a.pdfId)) continue;
      if (a.sections?.length) out[a.pdfId] = sortSections(a.sections);
    }
    return json(res, 200, out);
  }

  // The global folders of the Files panel: for every PDF in the library, in every project. (The folders of one
  // project are in its project file: PUT /api/projects/:id/files.)
  if (kind === 'files' && id === 'global') {
    const file = path.join(DATA, 'files.json');
    if (req.method === 'GET') {
      if (!(await exists(file))) return json(res, 200, { folders: [], filed: {} });
      return serve(res, file, 'no-store');
    }
    if (req.method === 'PUT') {
      // The app sends folders and filed. The record of the disk folders that were snapshot (links) stays.
      const before = (await exists(file)) ? JSON.parse(await fsp.readFile(file, 'utf8')) : {};
      const clean = projects.cleanFiles(await readJsonBody(req));
      clean.links = (before.links || []).filter((l) => clean.folders.some((f) => f.id === l.root));
      await writeAtomic(file, JSON.stringify(clean));
      return json(res, 200, clean);
    }
  }
  // Snapshot a folder of the disk into the global folders: every PDF in it (and in its folders) is copied into
  // the library, and the global folders get the same structure. It is a copy at this moment, not a live link: a
  // later snapshot of the same folder adds what is new. Nothing on the disk changes, and nothing is removed.
  //   {}            ask the user for the folder with the system's dialog (the desktop app only)
  //   { root: id }  snapshot again the folder that the global folder `id` came from
  // The path never comes from the page: it comes from the dialog, or from the record of an earlier snapshot.
  if (kind === 'files' && id === 'snapshot' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const file = path.join(DATA, 'files.json');
    const state = (await exists(file)) ? JSON.parse(await fsp.readFile(file, 'utf8')) : { folders: [], filed: {} };
    state.folders ||= []; state.filed ||= {}; state.links ||= [];
    let dir, rootId = null;
    if (body.root) {
      const link = state.links.find((l) => l.root === body.root);
      if (!link) return json(res, 404, { error: 'That folder did not come from a snapshot.' });
      dir = link.path; rootId = link.root;
    } else {
      if (!process.versions.electron) return json(res, 501, { error: 'A folder can be picked in the desktop app only.' });
      const { dialog, BrowserWindow } = require('electron');
      const picked = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
        title: 'Snapshot a folder into the global folders', buttonLabel: 'Snapshot', properties: ['openDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) return json(res, 200, { canceled: true });
      dir = picked.filePaths[0];
      rootId = state.links.find((l) => l.path === dir && state.folders.some((f) => f.id === l.root))?.root || null;
    }
    if (!(await exists(dir))) return json(res, 404, { error: `The folder is not there any more: ${dir}` });
    // The PDFs under the folder, each with the path of its folder ('' for the top).
    const found = [];
    let other = 0, capped = false;
    const walk = async (at, rel, depth) => {
      if (depth > 12) return;
      const entries = (await fsp.readdir(at, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(path.join(at, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
        else if (e.isFile()) {
          if (!/\.pdf$/i.test(e.name)) { other++; continue; }
          if (found.length >= 3000) { capped = true; return; }
          found.push({ file: path.join(at, e.name), name: e.name, rel });
        }
      }
    };
    await walk(dir, '', 0);
    const newId = () => crypto.randomBytes(4).toString('hex');
    if (!rootId || !state.folders.some((f) => f.id === rootId)) {
      rootId = newId();
      state.folders.push({ id: rootId, name: path.basename(dir).slice(0, 120) || 'Folder', parent: null, root: rootId, src: '' });
    }
    // The folder for a path under the top folder: the one from an earlier snapshot, or a new one.
    const folderFor = (rel) => {
      const have = state.folders.find((f) => f.root === rootId && f.src === rel);
      if (have) return have.id;
      const cut = rel.lastIndexOf('/'), parent = folderFor(cut < 0 ? '' : rel.slice(0, cut));
      const made = { id: newId(), name: rel.slice(cut + 1).slice(0, 120), parent, root: rootId, src: rel };
      state.folders.push(made);
      return made.id;
    };
    const mine = new Set(state.folders.filter((f) => f.root === rootId).map((f) => f.id));
    let added = 0, bad = 0;
    for (const f of found) {
      try {
        const st = await fsp.stat(f.file);
        if (st.size > 500e6) { bad++; continue; }
        const buf = await fsp.readFile(f.file);
        if (buf.subarray(0, 1024).indexOf('%PDF-') === -1) { bad++; continue; }
        const { code, meta } = await storePdf(buf, f.name, '', { source: { kind: 'disk', path: f.file, captured: Date.now() } });
        if (code === 201) added++;
        const folder = folderFor(f.rel);
        mine.add(folder);
        // A PDF that the user filed in a folder of his own stays there.
        if (!state.filed[meta.id] || mine.has(state.filed[meta.id])) state.filed[meta.id] = folder;
      } catch { bad++; }
    }
    state.links = [...state.links.filter((l) => l.root !== rootId), { root: rootId, path: dir, at: Date.now(), files: found.length }];
    await writeAtomic(file, JSON.stringify(state));
    return json(res, 200, { root: rootId, name: path.basename(dir), found: found.length, added, other, bad, capped });
  }

  // The dictionary: terms and their definitions. One file per project, and one for the global terms ("global").
  if (kind === 'terms' && id && ID.test(id)) {
    const file = path.join(DIRS.terms, `${id}.json`);
    if (req.method === 'GET') {
      if (!(await exists(file))) return json(res, 200, { terms: [], seen: {} });
      return serve(res, file, 'no-store');
    }
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 10e6)).toString());
      await writeAtomic(file, JSON.stringify({ terms: Array.isArray(body.terms) ? body.terms : [], seen: body.seen || {} }));
      return json(res, 200, { ok: true });
    }
  }

  // Highlights live with the PDF, not the board, so one highlight can appear on many boards.
  if (kind === 'annotations' && id && ID.test(id)) {
    const file = path.join(DIRS.annotations, `${id}.json`);
    if (req.method === 'GET') {
      if (!(await exists(file))) return json(res, 200, { pdfId: id, highlights: [] });
      return serve(res, file, 'no-store');
    }
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 50e6)).toString());
      body.pdfId = id;
      await writeAtomic(file, JSON.stringify(body));
      return json(res, 200, { ok: true });
    }
  }

  // Keep a copy of each HTML export on disk.
  if (kind === 'exports' && !id && req.method === 'POST') {
    let name = 'board.html';
    try { name = decodeURIComponent(req.headers['x-filename'] || name); } catch { /* keep default */ }
    name = path.basename(name).replace(/[^\w .()\u00C0-\uFFFF-]+/g, '-').slice(0, 150);
    if (!name.endsWith('.html')) name += '.html';
    const file = path.join(DIRS.exports, name);
    await writeAtomic(file, await readBody(req, 500e6));
    return json(res, 201, { path: file });
  }

  if (kind === 'images' && !id && req.method === 'POST') {
    const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) return json(res, 415, { error: 'unsupported image type' });
    const buf = await readBody(req, 100e6);
    const name = `${hash(buf)}.${ext}`;
    const file = path.join(DIRS.images, name);
    if (!(await exists(file))) await writeAtomic(file, buf);
    return json(res, 201, { id: name, url: `/files/images/${name}` });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p.startsWith('/api/')) {
      return await handleApi(req, res, p.split('/').filter(Boolean).slice(1), new URL(req.url, 'http://localhost').searchParams);
    }
    if (p.startsWith('/vendor/pdfjs/')) return serve(res, safeJoin(PDFJS, p.slice(14)), 'public, max-age=86400');
    if (p.startsWith('/files/pdfs/') && p.endsWith('.pdf')) return serve(res, safeJoin(DIRS.pdfs, p.slice(12)), IMMUTABLE);
    if (p.startsWith('/files/images/')) return serve(res, safeJoin(DIRS.images, p.slice(14)), IMMUTABLE);
    if (p.startsWith('/files/exports/')) return serve(res, safeJoin(DIRS.exports, p.slice(15)), 'no-cache');
    return serve(res, safeJoin(PUBLIC, p === '/' ? 'index.html' : p.slice(1)), 'no-cache');
  } catch (e) {
    console.error(e);
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`;
  console.log(`Corkboard is up: ${url}\nData folder: ${DATA}`);
  if (process.argv.includes('--open')) {
    // Open the page in the browser: each system has its own command for that.
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    require('node:child_process').spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
