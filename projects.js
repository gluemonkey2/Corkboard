// Projects: each project groups boards and PDFs. A PDF can be in many projects; a board is in one.
// Project files live in data/projects. Every PDF is in the PDF library, in a project or not.
// A board that is in no project becomes a project of its own.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function projects({ DIRS, listJson, writeAtomic }) {
  const file = (id) => path.join(DIRS.projects, `${id}.json`);
  const newId = () => crypto.randomBytes(5).toString('hex');

  // One change at a time, so two requests cannot overwrite each other's project edits.
  let queue = Promise.resolve();
  const locked = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function save(p) {
    p.updated = Date.now();
    await writeAtomic(file(p.id), JSON.stringify(p));
    return p;
  }
  async function load(id) {
    try { return JSON.parse(await fsp.readFile(file(id), 'utf8')); } catch { return null; }
  }

  // Bring the project files in line with the boards and PDFs on disk. Call inside `locked`.
  async function reconcile() {
    const projects = await listJson(DIRS.projects);
    const boards = await listJson(DIRS.boards);
    const pdfs = await listJson(DIRS.pdfs);
    const boardIds = new Set(boards.map((b) => b.id)), pdfIds = new Set(pdfs.map((p) => p.id));

    // Drop links to boards and PDFs that no longer exist.
    for (const p of projects) {
      const nb = (p.boards || []).filter((id) => boardIds.has(id));
      const np = (p.pdfs || []).filter((id) => pdfIds.has(id));
      if (nb.length !== (p.boards || []).length || np.length !== (p.pdfs || []).length) {
        Object.assign(p, { boards: nb, pdfs: np });
        await save(p);
      }
    }

    // A board in no project becomes a project of its own, with the PDFs its cards use.
    // (This is also how the boards from before projects existed got their projects.)
    const inB = new Set(projects.flatMap((p) => p.boards));
    for (const b of boards.filter((x) => !inB.has(x.id)).sort((a, c) => (a.created || 0) - (c.created || 0))) {
      const used = [...new Set((b.cards || []).map((c) => c.source?.pdfId).filter((id) => pdfIds.has(id)))];
      projects.push(await save({ id: newId(), name: b.name || 'Untitled project', created: Date.now(), boards: [b.id], pdfs: used }));
    }
    return { projects, boards, pdfs };
  }

  // Move a PDF, its record and its snippets to the trash. Call inside `locked`.
  async function trashPdf(pdfId, stamp = Date.now()) {
    const moves = [
      [path.join(DIRS.pdfs, `${pdfId}.pdf`), `pdf-${pdfId}-${stamp}.pdf`],
      [path.join(DIRS.pdfs, `${pdfId}.json`), `pdf-${pdfId}-${stamp}.json`],
      [path.join(DIRS.annotations, `${pdfId}.json`), `snippets-${pdfId}-${stamp}.json`],
      [path.join(DIRS.docs, `${pdfId}.json`), `doc-${pdfId}-${stamp}.json`], // a doc that the user wrote
    ];
    for (const [from, to] of moves) await fsp.rename(from, path.join(DIRS.trash, to)).catch(() => {});
    for (const o of await listJson(DIRS.projects)) {
      if (o.pdfs.includes(pdfId)) { o.pdfs = o.pdfs.filter((x) => x !== pdfId); await save(o); }
    }
  }

  // A rough picture of a board for the project card: card boxes and arrow lines.
  function preview(b) {
    const cards = (b.cards || []).slice(0, 400).map((c) => {
      const w = c.w || 240;
      const textH = (s, cw) => Math.ceil(((s || '').length * 7.6) / Math.max(60, w - 40)) * cw;
      let h = 60;
      if (c.type === 'note') h = 40 + textH(c.text, 22);
      else if (c.type === 'quote') h = 50 + textH(c.snipText, 22) + (c.snipNote ? 30 : 0);
      else if (c.imgW) h = 60 + ((w - 28) * c.imgH) / c.imgW + (c.snipNote ? 30 : 0);
      return { id: c.id, x: c.x, y: c.y, w, h: c.h && !c.image ? c.h : Math.max(50, h), color: c.color || null, type: c.type };
    });
    if (!cards.length) return null;
    const box = [
      Math.min(...cards.map((c) => c.x)), Math.min(...cards.map((c) => c.y)),
      Math.max(...cards.map((c) => c.x + c.w)), Math.max(...cards.map((c) => c.y + c.h)),
    ];
    const at = new Map(cards.map((c) => [c.id, c]));
    const links = (b.links || []).slice(0, 400).map((l) => [at.get(l.from), at.get(l.to)]).filter(([a, c]) => a && c)
      .map(([a, c]) => [a.x + a.w / 2, a.y + a.h / 2, c.x + c.w / 2, c.y + c.h / 2].map(Math.round));
    return { box, cards: cards.map((c) => [c.x, c.y, c.w, Math.round(c.h), c.color, c.type]), links };
  }

  async function summaries() {
    const { projects, boards, pdfs } = await locked(reconcile);
    const boardById = new Map(boards.map((b) => [b.id, b])), pdfById = new Map(pdfs.map((p) => [p.id, p]));
    const notes = new Map((await listJson(DIRS.annotations)).map((a) => [a.pdfId, (a.highlights || []).length]));
    return projects.map((p) => {
      const bs = p.boards.map((id) => boardById.get(id)).filter(Boolean).sort((a, c) => (c.updated || 0) - (a.updated || 0));
      const ps = p.pdfs.map((id) => pdfById.get(id)).filter(Boolean);
      return {
        id: p.id, name: p.name, created: p.created, kind: p.kind || 'board',
        updated: Math.max(p.updated || 0, ...bs.map((b) => b.updated || 0)),
        boards: bs.map((b) => ({ id: b.id, name: b.name, updated: b.updated || 0, cards: (b.cards || []).length })),
        pdfs: ps.map((x) => ({ id: x.id, name: x.name })),
        snippets: ps.reduce((s, x) => s + (notes.get(x.id) || 0), 0),
        cards: bs.reduce((s, b) => s + (b.cards || []).length, 0),
        preview: bs[0] ? preview(bs[0]) : null,
      };
    }).sort((a, b) => b.updated - a.updated);
  }

  // Folders and what is filed in them, as they come from the app: keep only what is well formed.
  // A folder that came from a snapshot of a folder on the disk keeps where it came from (root: the id of the
  // top folder of that snapshot, src: its path under that folder), so a later snapshot finds it again.
  function cleanFiles({ folders, filed } = {}) {
    const ok = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
    const list = (Array.isArray(folders) ? folders : []).filter((f) => f && ok(f.id)).slice(0, 5000)
      .map((f) => ({
        id: f.id, name: String(f.name || 'Folder').slice(0, 120), parent: ok(f.parent) ? f.parent : null,
        ...(ok(f.root) && typeof f.src === 'string' ? { root: f.root, src: f.src.slice(0, 1000) } : {}),
      }));
    const ids = new Set(list.map((f) => f.id));
    for (const f of list) if (f.parent && (!ids.has(f.parent) || f.parent === f.id)) f.parent = null;
    return { folders: list, filed: Object.fromEntries(Object.entries(filed && typeof filed === 'object' ? filed : {}).filter(([k, v]) => ok(k) && ids.has(v))) };
  }

  return {
    summaries,
    load,
    // The ids of the boards or PDFs in a project, or null when there is no such project.
    async members(id, key) {
      const p = await locked(async () => { await reconcile(); return load(id); });
      return p ? new Set(p[key]) : null;
    },
    // kind: 'review' for a review project (one PDF checked against existing snippets), else a board project.
    create: (name, boardId, kind) => locked(() => save({ id: newId(), name, created: Date.now(), boards: boardId ? [boardId] : [], pdfs: [], ...(kind === 'review' ? { kind } : {}) })),
    rename: (id, name) => locked(async () => { const p = await load(id); if (!p) return null; p.name = name; return save(p); }),
    // Move a project and its boards to the trash. With alsoPdfs, also the PDFs that no other project uses.
    remove: (id, { alsoPdfs = false } = {}) => locked(async () => {
      const p = await load(id);
      if (!p) return null;
      const stamp = Date.now();
      for (const b of p.boards) {
        await fsp.rename(path.join(DIRS.boards, `${b}.json`), path.join(DIRS.trash, `board-${b}-${stamp}.json`)).catch(() => {});
      }
      await fsp.rename(file(id), path.join(DIRS.trash, `project-${id}-${stamp}.json`));
      if (alsoPdfs) {
        const others = new Set((await listJson(DIRS.projects)).flatMap((o) => o.pdfs));
        for (const pdfId of p.pdfs) if (!others.has(pdfId)) await trashPdf(pdfId, stamp);
      }
      return p;
    }),
    trashPdf: (pdfId) => locked(() => trashPdf(pdfId)),
    // Every PDF with its snippet count and the projects that use it.
    async pdfLibrary() {
      const { projects, pdfs } = await locked(reconcile);
      const ann = new Map((await listJson(DIRS.annotations)).map((a) => [a.pdfId, a]));
      return pdfs.map((x) => ({
        id: x.id, name: x.name, size: x.size, added: x.added, description: x.description || '', source: x.source || null, watch: x.watch || null, rev: x.rev || 0,
        snippets: (ann.get(x.id)?.highlights || []).length, sections: (ann.get(x.id)?.sections || []).length,
        projects: projects.filter((p) => p.pdfs.includes(x.id)).map((p) => ({ id: p.id, name: p.name })),
      })).sort((a, b) => (b.added || 0) - (a.added || 0));
    },
    // Every board with its project.
    async boardLibrary() {
      const { projects, boards } = await locked(reconcile);
      return boards.map((b) => {
        const p = projects.find((x) => x.boards.includes(b.id));
        return {
          id: b.id, name: b.name, updated: b.updated || 0, cards: (b.cards || []).length, links: (b.links || []).length,
          project: p ? { id: p.id, name: p.name } : null,
        };
      }).sort((a, b) => b.updated - a.updated);
    },
    // Add (or remove) a board or PDF. A board belongs to one project only, so adding moves it.
    // The folders of a project's Files panel: folders [{ id, name, parent }] and filed { pdfId: folderId }.
    // The folders are in the project only: nothing moves on the disk, and a PDF can be filed in another way in
    // another project.
    setFiles: (id, body) => locked(async () => {
      const p = await load(id);
      if (!p) return null;
      Object.assign(p, cleanFiles(body));
      return save(p);
    }),
    cleanFiles,
    add: (id, key, member) => locked(async () => {
      const p = await load(id);
      if (!p) return null;
      if (key === 'boards') {
        for (const o of await listJson(DIRS.projects)) {
          if (o.id !== id && o.boards.includes(member)) { o.boards = o.boards.filter((b) => b !== member); await save(o); }
        }
      }
      if (!p[key].includes(member)) p[key].push(member);
      return save(p);
    }),
    drop: (id, key, member) => locked(async () => {
      const p = await load(id);
      if (!p) return null;
      p[key] = p[key].filter((x) => x !== member);
      return save(p);
    }),
  };
};
