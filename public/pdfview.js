// PDF reader: lazy page rendering, text + area highlights, and drag-out to the whiteboard.
import * as pdfjsLib from '/vendor/pdfjs/legacy/build/pdf.mjs';
import { api, uploadImage } from './api.js';
import { attachSelection, detachSelection, orderTextLayer } from './textselect.js';
import { findDefinitions, pageLines } from './terms.js';
import { findContents, locateContents } from './contents.js';
import { areaOf, parentOf, depthOf, excerpt, reflow, breakLikeLines, fillSnipText, plainSnipText } from './snips.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.mjs';
const DOC_OPTS = {
  cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/',
};
export const HL_COLORS = ['#ffd84d', '#86e07c', '#ff9ec7', '#7cc8ff', '#c9a6ff'];
// Reference tags (citations, "see …", document names): their own colour, and a link into or out of a PDF.
export const REF_COLOR = '#14a39a';
export const DRAG_TYPE = 'application/x-corkboard-highlight';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- words of a snippet, found on the page (for marking words on a board card) ----------
const docs = new Map();
async function pageText(pdfId, n) {
  if (!docs.has(pdfId)) docs.set(pdfId, pdfjsLib.getDocument({ url: `/files/pdfs/${pdfId}.pdf`, ...DOC_OPTS }).promise);
  const page = await (await docs.get(pdfId)).getPage(n);
  return page.getTextContent();
}
// The page boxes of outer.text.slice(start, end), as snippet rects ([page, x0, y0, x1, y1] per line), or null.
// The words are found in the outer snippet's lines. A word that occurs more than once is matched by its count.
export async function locateRange(pdfId, outer, start, end) {
  // Letters and digits only, in lower case: spaces, hyphens at line ends, punctuation and ligatures do not matter.
  const T = String(outer.text || '');
  // A selection of symbols only (* & †): match those characters instead.
  const alnum = /[\p{L}\p{N}]/u.test(T.slice(start, end));
  const key = alnum ? (ch) => ch.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : (ch) => ch.replace(/\s+/g, '');
  let cardKey = '', at = 0;
  for (let i = 0; i < T.length; i++) { if (i === start) at = cardKey.length; cardKey += key(T[i]); }
  const word = [...T.slice(start, end)].map(key).join('');
  if (!word) return null;
  // Which occurrence of the words the selection is, counted in the snippet's text.
  let k = 0;
  for (let i = cardKey.indexOf(word); i >= 0 && i < at; i = cardKey.indexOf(word, i + 1)) k++;
  const pages = [...new Set((outer.rects || []).map((r) => r[0]))];
  const tcs = new Map();
  for (const n of pages) tcs.set(n, await pageText(pdfId, n));
  // The characters of the page text with their boxes: inside the snippet's lines, or (when that finds nothing)
  // on the whole of its pages.
  const collect = (whole) => {
    const chars = [];
    const lines = whole ? pages.map((n) => [n, -1e9, -1e9, 1e9, 1e9]) : outer.rects || [];
    for (const [li, [n, x0, y0, x1, y1]] of lines.entries()) {
      const found = tcs.get(n).items.filter((it) => {
        const [a, b, c, , , f] = it.transform;
        if (!it.str || b !== 0 || c !== 0 || !(it.width > 0)) return false;
        const cy = f + (it.height || Math.hypot(c, a) || 10) * 0.35;
        return cy >= y0 - 2 && cy <= y1 + 2;
      });
      // In reading order: line by line (a raised footnote number stays on its line), then left to right.
      const rows = [];
      for (const it of found.sort((p, q) => q.transform[5] - p.transform[5])) {
        const size = it.height || 10, row = rows.find((r) => Math.abs(r.y - it.transform[5]) <= Math.max(r.size, size) * 0.5);
        if (row) row.items.push(it); else rows.push({ y: it.transform[5], size, items: [it] });
      }
      const items = rows.flatMap((r) => r.items.sort((p, q) => p.transform[4] - q.transform[4]));
      for (const it of items) {
        const e = it.transform[4], f = it.transform[5], cw = it.width / it.str.length, size = it.height || 10;
        for (let i = 0; i < it.str.length; i++) {
          const cx0 = e + i * cw, cx1 = cx0 + cw;
          // A little room at the line ends: the letter widths are estimates.
          if ((cx0 + cx1) / 2 < x0 - cw * 0.6 || (cx0 + cx1) / 2 > x1 + cw * 0.6) continue;
          const box = whole ? { li: `${n}:${Math.round(f)}`, n, x0: cx0, x1: cx1, y0: f - size * 0.25, y1: f + size * 0.85 }
            : { li, n, x0: cx0, x1: cx1, y0, y1 };
          for (const ch of key(it.str[i])) chars.push({ ch, box });
        }
      }
    }
    return chars;
  };
  let chars = collect(false);
  let flat = chars.map((c) => c.ch).join('');
  let hits = [];
  for (let i = flat.indexOf(word); i >= 0; i = flat.indexOf(word, i + 1)) hits.push(i);
  let whole = false;
  if (!hits.length) {
    chars = collect(true);
    flat = chars.map((c) => c.ch).join('');
    for (let i = flat.indexOf(word); i >= 0; i = flat.indexOf(word, i + 1)) hits.push(i);
    whole = true;
  }
  if (!hits.length) return null;
  let hit;
  if (!whole) {
    const est = (at / Math.max(1, cardKey.length)) * flat.length;
    hit = hits[k] ?? hits.reduce((b, h) => (Math.abs(h - est) < Math.abs(b - est) ? h : b), hits[0]);
  } else {
    // On the whole page: the occurrence nearest to the snippet's lines.
    const [n0, , , , top] = outer.rects[0];
    const near = (h) => { const b = chars[h].box; return (b.n === n0 ? 0 : 1e6) + Math.abs(b.y1 - top); };
    hit = hits.reduce((b, h) => (near(h) < near(b) ? h : b), hits[0]);
  }
  const lines = new Map();
  for (const c of chars.slice(hit, hit + word.length)) {
    const r = lines.get(c.box.li);
    if (r) { r[1] = Math.min(r[1], c.box.x0); r[3] = Math.max(r[3], c.box.x1); }
    else lines.set(c.box.li, [c.box.n, c.box.x0, c.box.y0, c.box.x1, c.box.y1]);
  }
  let out = [...lines.values()];
  if (whole) {
    // Found outside the snippet's own lines: fit each line into the snippet line it overlaps, so the words
    // count as part of the snippet (a highlight inside it).
    out = out.map((r) => {
      const o = (outer.rects || []).find(([m, , Y0, , Y1]) => m === r[0] && r[2] < Y1 && r[4] > Y0);
      return o ? [r[0], Math.max(r[1], o[1]), o[2], Math.min(r[3], o[3]), o[4]] : r;
    });
  }
  return out.map((r) => r.map((v, i) => (i ? Math.round(v * 100) / 100 : v)));
}
const round2 = (v) => Math.round(v * 100) / 100;
function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function button(cls, text, title) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  if (title) b.title = title;
  return b;
}
export function setDragData(ev, pdfId, h) {
  ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ pdfId, id: h.id }));
  ev.dataTransfer.setData('text/plain', h.text || '');
  ev.dataTransfer.effectAllowed = 'copy';
}

// One snippet as a list item: used by the reader sidebar and the board tray.
export function snippetItem(h, { placed, pdfName, onNote, section, depth = 0, links = [], backlinks = 0, parent = null, flag = null }) {
  const item = div(`hl-item${h.ref ? ' ref' : ''}`);
  if (depth) { item.classList.add('nested'); item.style.setProperty('--depth', Math.min(depth, 3)); }
  item.draggable = true;
  item.style.setProperty('--c', h.color);
  if (h.image) {
    const img = document.createElement('img');
    img.src = `/files/images/${h.image}`;
    img.alt = h.text || 'Area snippet';
    img.draggable = false;
    item.append(img);
  }
  if (h.text) item.append(h.image ? div('hl-quote short', plainSnipText(h.text)) : fillSnipText(div('hl-quote'), h.text));
  if (onNote) {
    const note = document.createElement('textarea');
    note.className = 'hl-item-note';
    note.placeholder = 'Add a note…';
    note.rows = 1;
    note.value = h.note || '';
    const fit = () => { if (!note.isConnected || !note.offsetParent) return; note.style.height = 'auto'; note.style.height = `${note.scrollHeight}px`; };
    note.addEventListener('input', () => { onNote(note.value.trim()); fit(); });
    requestAnimationFrame(fit);
    item.append(note);
  } else if (h.note) item.append(div('hl-item-note', h.note));
  const path = (section || h.section || []).map((x) => x.title || x);
  if (path.length) {
    const sec = div('hl-sec', path.join(' › '));
    sec.title = path.join(' › ');
    item.append(sec);
  }
  for (const f of h.footnotes || []) item.append(div('hl-foot', `${f.mark} ${f.text}`));
  if (parent) item.append(div('hl-rel', `in: ${parent}`));
  for (const l of links) item.append(div('hl-rel link', `↗ ${l.label}: ${l.text}`));
  if (backlinks) item.append(div('hl-rel back', `← ${backlinks} link${backlinks === 1 ? '' : 's'} here`));
  const meta = div('hl-meta', `${pdfName ? `${pdfName} · ` : ''}p.${h.page}`);
  if (h.ref) meta.append(div('hl-badge ref', 'reference'));
  if (placed) meta.append(div('hl-badge', 'on board'));
  // A problem with the source: it was withdrawn or superseded, or this text is no longer on its web page.
  if (flag) { const b = div('hl-badge warn', `⚠ ${flag.text}`); b.title = flag.title; meta.append(b); }
  item.append(meta);
  return item;
}

const normRect = ([ax, ay, bx, by]) => [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];

// Merge per-span rectangles into one rectangle per line.
function mergeLineRects(rects) {
  const out = [];
  for (const r of rects.sort((a, b) => a[0] - b[0] || b[4] - a[4] || a[1] - b[1])) {
    const [pg, x0, y0, x1, y1] = r;
    const h = y1 - y0;
    const line = out.find((o) => o[0] === pg && Math.abs((o[2] + o[4]) / 2 - (y0 + y1) / 2) < h * 0.5
      && x0 <= o[3] + h * 1.2 && x1 >= o[1] - h * 1.2);
    if (line) {
      line[1] = Math.min(line[1], x0); line[2] = Math.min(line[2], y0);
      line[3] = Math.max(line[3], x1); line[4] = Math.max(line[4], y1);
    } else out.push([pg, x0, y0, x1, y1]);
  }
  return out.map((r) => r.map((v, i) => (i ? round2(v) : v)));
}

export class PdfView {
  constructor(opts) {
    // scroller, pagesEl, emptyEl, listEl, menuEl, onFindOnBoard, getOnBoard, onSaved, onError, onListChange
    Object.assign(this, opts);
    this.doc = null;
    this.meta = null;
    this.pages = [];
    this.scale = 1;
    this.mode = 'text';
    this.snipAs = 'text';
    this.color = HL_COLORS[0];
    this.annots = { highlights: [], sections: [] };
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const pg = this.pages[+en.target.dataset.n - 1];
        if (pg) en.isIntersecting ? this.renderPage(pg) : this.unrenderPage(pg);
      }
    }, { root: this.scroller, rootMargin: '1200px 0px' });

    this.scroller.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
      e.preventDefault();
      this.pendingZoom = (this.pendingZoom || 1) * Math.exp(-e.deltaY * 0.01);
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => { this.setScale(this.scale * this.pendingZoom); this.pendingZoom = 1; }, 120);
    }, { passive: false });
    this.pagesEl.addEventListener('pointerup', (e) => setTimeout(() => this.afterPointerUp(e), 0));
    this.pagesEl.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.hlmenu')) this.hideMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (this.adjusting && e.key === 'Enter') { e.preventDefault(); this.run(() => this.finishAdjust()); return; }
      if (e.key !== 'Escape') return;
      this.cancelAdjust();
      this.hideMenu();
      if (this.linkFrom) {
        this.linkFrom = null;
        this.pagesEl.classList.remove('linking');
        this.onStatus?.('Link cancelled.');
      }
    });
    // Hover over a linked term: show what it links to.
    this.tipEl = div('hl-tip');
    this.tipEl.hidden = true;
    this.scroller.append(this.tipEl);
    let queued = false, last = null;
    this.pagesEl.addEventListener('mousemove', (e) => {
      last = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.hoverTip(last); });
    });
    this.pagesEl.addEventListener('mouseleave', () => { this.tipEl.hidden = true; this.onTermHover?.(null); });
  }

  // Another window (or the board) saved this PDF's snippets: take them, unless this view has changes to save.
  async reloadAnnots(pdfId) {
    if (!this.meta || this.meta.id !== pdfId || this.annotDirty) return;
    const a = await api('GET', `/api/annotations/${pdfId}`);
    if (this.meta?.id !== pdfId || this.annotDirty) return;
    this.annots = { highlights: [], sections: [], ...a };
    this.renderHighlights();
    this.renderList();
    this.renderOutline?.();
  }
  get highlights() { return this.annots.highlights; }
  get sections() { return this.annots.sections; }
  highlight(id) { return this.highlights.find((h) => h.id === id); }

  // ---------- document ----------
  async open(meta) {
    if (this.meta?.id === meta.id) return;
    const token = (this.token = Symbol());
    this.close();
    this.meta = meta;
    this.emptyEl.hidden = true;
    let doc, annots;
    try {
      [doc, annots] = await Promise.all([
        (this.task = pdfjsLib.getDocument({ url: `/files/pdfs/${meta.id}.pdf`, ...DOC_OPTS })).promise,
        api('GET', `/api/annotations/${meta.id}`),
      ]);
    } catch (e) {
      if (token !== this.token) return; // a newer open() replaced this one
      throw e;
    }
    if (token !== this.token) return;
    this.doc = doc;
    this.annots = { highlights: [], sections: [], ...annots };
    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    if (token !== this.token) return;
    this.pages = pages.map((page, i) => ({ n: i + 1, page, w1: page.getViewport({ scale: 1 }).width }));
    this.findHits = [];
    this.findIdx = -1;
    this.needsFit = this.scroller.clientWidth === 0; // opened while the reader is hidden
    this.scale = this.needsFit ? 1 : this.fitScale();
    this.layout();
    this.renderList();
    this.renderOutline();
    this.onOpened?.(meta, doc);
    this.loadLinkContext(token).catch(() => {});
    this.runningReady = this.detectRunning(token).catch(() => {});
  }

  // ---------- links to and from other PDFs ----------
  async loadLinkContext(token = this.token) {
    const id = this.meta?.id;
    if (!id) return;
    const [names, incoming] = await Promise.all([api('GET', '/api/pdfs'), api('GET', `/api/backlinks/${id}`)]);
    if (token !== this.token) return;
    this.pdfNames = new Map(names.map((x) => [x.id, x.name]));
    this.incoming = incoming;
    const others = [...new Set(this.highlights.flatMap((h) => (h.links || []).map((l) => l.pdfId)).filter((x) => x && x !== id))];
    await Promise.all(others.map((p) => this.loadForeign(p)));
    if (token !== this.token) return;
    this.renderHighlights();
    this.renderList();
  }
  async loadForeign(pdfId) {
    this.foreign ||= new Map();
    if (this.foreign.has(pdfId)) return this.foreign.get(pdfId);
    const a = await api('GET', `/api/annotations/${pdfId}`);
    this.foreign.set(pdfId, a);
    return a;
  }
  // Where a link points: { pdfId, h (the target snippet, or null), name, external, whole }.
  resolveLink(l) {
    const pdfId = l.pdfId || this.meta?.id;
    const external = pdfId !== this.meta?.id;
    const whole = !l.to;
    const h = whole ? null : external ? (this.foreign?.get(pdfId)?.highlights || []).find((x) => x.id === l.to) || null : this.highlight(l.to);
    return { pdfId, h, external, whole, name: external ? this.pdfNames?.get(pdfId) || 'another PDF' : null };
  }
  linkText(l, n = 40) {
    const r = this.resolveLink(l);
    if (r.whole) return `the whole of ${r.name || 'this PDF'}`;
    if (!r.h) return r.external ? `a snippet in ${r.name}` : '';
    return `${excerpt(r.h, n)}${r.external ? ` (${r.name})` : ''}`;
  }
  followLink(l) {
    const r = this.resolveLink(l);
    this.hideMenu();
    if (r.external || r.whole) this.onOpenLink?.(r.pdfId, l.to);
    else if (r.h) this.goToHighlight(r.h.id);
  }

  close() {
    this.flushAnnots();
    this.hideMenu();
    this.io.disconnect();
    for (const pg of this.pages) pg.task?.cancel();
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.task?.destroy(); // the loading task owns the document and its worker port
    this.task = null;
    this.doc = null;
    this.meta = null;
    this.annots = { highlights: [], sections: [] };
    this.incoming = [];
    this.emptyEl.hidden = false;
    this.renderList();
    this.renderOutline();
  }

  saveAnnots() {
    clearTimeout(this.annotTimer);
    this.annotTimer = setTimeout(() => this.flushAnnots(), 400);
    this.annotDirty = true;
  }
  flushAnnots() {
    clearTimeout(this.annotTimer);
    if (!this.annotDirty || !this.meta) return;
    this.annotDirty = false;
    const pdfId = this.meta.id;
    return api('PUT', `/api/annotations/${pdfId}`, this.annots)
      .then(() => this.onSaved?.(pdfId))
      .catch((e) => { this.annotDirty = true; this.onError?.(e); });
  }

  // ---------- layout & rendering ----------
  fitScale() {
    const widest = Math.max(...this.pages.map((p) => p.w1));
    return clamp((this.scroller.clientWidth - 36) / widest, 0.25, 5);
  }
  fit() { if (this.doc) this.setScale(this.fitScale()); }
  // Called when the reader becomes visible.
  shown() {
    if (this.needsFit && this.doc && this.scroller.clientWidth) { this.needsFit = false; this.setScale(this.fitScale()); }
    this.renderList();
  }
  setScale(s) {
    s = clamp(s, 0.25, 5);
    if (!this.doc || Math.abs(s - this.scale) < 0.001) return;
    const ratio = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight);
    this.scale = s;
    this.hideMenu();
    this.layout();
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight;
  }
  setMode(m) {
    this.mode = m;
    this.pagesEl.dataset.mode = m;
    this.hideMenu();
  }

  layout() {
    this.cancelAdjust();
    for (const pg of this.pages) if (pg.tl) detachSelection(pg.tl);
    this.io.disconnect();
    for (const pg of this.pages) pg.task?.cancel();
    this.pagesEl.replaceChildren();
    this.pagesEl.dataset.mode = this.mode;
    for (const pg of this.pages) {
      pg.vp = pg.page.getViewport({ scale: this.scale });
      pg.el = div('page');
      pg.el.dataset.n = pg.n;
      pg.el.style.width = `${pg.vp.width}px`;
      pg.el.style.height = `${pg.vp.height}px`;
      pg.el.style.setProperty('--total-scale-factor', this.scale);
      pg.canvas = document.createElement('canvas');
      pg.hl = div('hl-layer');
      pg.find = div('find-layer');
      pg.tl = div('textLayer');
      pg.terms = div('term-layer');
      pg.termHits = [];
      pg.el.append(pg.canvas, pg.hl, pg.find, pg.terms, pg.tl, div('pageno', pg.n));
      pg.rendered = 0;
      pg.textDone = false;
      pg.textReady = false;
      pg.el.addEventListener('pointerdown', (e) => {
        if (e.button === 0 && (this.mode === 'area' || e.altKey)) this.startArea(e, pg);
      });
      this.pagesEl.append(pg.el);
      this.io.observe(pg.el);
    }
    this.renderHighlights();
    this.renderFind();
  }

  // ---------- running headers and footers ----------
  // Lines near the top or bottom of the page that repeat on many pages (page numbers count as the same) are
  // running headers and footers. With skipRunning on, a selection leaves them out, so a snippet can cross a page.
  async detectRunning(token) {
    this.runningBands = new Map();
    const pages = this.pages, seen = new Map(), lines = [];
    if (pages.length < 3) return;
    for (const pg of pages) {
      const tc = (pg.tc ||= await pg.page.getTextContent());
      if (token !== this.token) return;
      const [, by0, , by1] = pg.page.view, H = by1 - by0;
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str?.trim()) continue;
        const [a, b, c, d, e, f] = it.transform;
        if (b !== 0 || c !== 0) continue;
        const rel = (f - by0) / H;
        if (rel > 0.14 && rel < 0.9) continue; // only the bottom 14% and the top 10% of the page
        const k = Math.round(f / 3);
        if (!rows.has(k)) rows.set(k, { f, size: it.height || Math.hypot(c, d) || 10, parts: [] });
        rows.get(k).parts.push([e, it.str]);
      }
      for (const [k, r] of rows) {
        const text = r.parts.sort((p, q) => p[0] - q[0]).map((p) => p[1]).join(' ').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
        const key = `${k}|${text}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(pg.n);
        lines.push({ n: pg.n, key, f: r.f, size: r.size });
      }
    }
    const need = Math.max(3, Math.ceil(pages.length * 0.4));
    for (const l of lines) {
      if (seen.get(l.key).size < need) continue;
      if (!this.runningBands.has(l.n)) this.runningBands.set(l.n, []);
      this.runningBands.get(l.n).push([l.f - l.size * 0.35, l.f + l.size * 1.05]);
    }
    for (const pg of pages) if (pg.textReady) this.markRunning(pg);
  }
  // Mark the text layer spans of a page that sit in its running header or footer.
  markRunning(pg) {
    // Found ones for this page, and the ones marked by hand (they apply on every page, at the same height).
    const bands = [...(this.runningBands?.get(pg.n) || []), ...(this.annots?.running || []).map((r) => [r.y0, r.y1])];
    if (!pg.tl) return;
    const pb = pg.el.getBoundingClientRect();
    for (const sp of pg.tl.querySelectorAll('span')) {
      if (sp.querySelector('span') || sp.classList.contains('sep')) continue;
      const r = sp.getBoundingClientRect();
      if (!r.height) continue;
      const [, y0, , y1] = this.toPdf(pg, [r.left - pb.left, r.top - pb.top, r.right - pb.left, r.bottom - pb.top]);
      const cy = (y0 + y1) / 2;
      sp.classList.toggle('running', bands.some(([a, b]) => cy >= a && cy <= b));
    }
  }
  // Mark the selected lines as a header or footer by hand: that height band is skipped on every page.
  addRunning(p) {
    const rs = p.rects.filter((r) => r[0] === p.page);
    const band = { y0: Math.min(...rs.map((r) => r[2])) - 1, y1: Math.max(...rs.map((r) => r[4])) + 1, text: p.text.slice(0, 80) };
    this.annots.running = [...(this.annots.running || []), band];
    this.saveAnnots();
    for (const pg of this.pages) if (pg.textReady) this.markRunning(pg);
    getSelection().removeAllRanges();
  }
  clearRunning() {
    delete this.annots.running;
    this.saveAnnots();
    for (const pg of this.pages) if (pg.textReady) this.markRunning(pg);
  }
  setSkipRunning(on) {
    this.skipRunning = on;
    this.pagesEl.classList.toggle('skip-running', on);
  }
  // A text node that a selection leaves out: one in a running header or footer, while skipRunning is on.
  skipped(node) { return this.skipRunning && !!node.parentElement?.closest('.running'); }

  // ---------- find text ----------
  // Find every place a text occurs (any case, any spacing, across line ends). Returns the number found,
  // or null when a newer search replaced this one. The current match is the first one at or after the view.
  async find(query) {
    const token = (this.findToken = Symbol());
    const q = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
    this.findQ = q;
    const hits = [];
    for (const pg of q ? this.pages : []) {
      // A page whose text layer is drawn gives exact boxes. Other pages are estimated from the text content,
      // and get exact boxes when their text layer is drawn (refindPage).
      if (pg.textReady) { hits.push(...this.textLayerHits(pg, q)); continue; }
      const tc = (pg.tc ||= await pg.page.getTextContent());
      if (token !== this.findToken) return null;
      const chars = [];
      const push = (ch, box) => {
        if (/\s/.test(ch)) { if (chars.length && chars[chars.length - 1].ch !== ' ') chars.push({ ch: ' ' }); }
        else chars.push({ ch: ch.toLowerCase(), box });
      };
      for (const it of tc.items) {
        if (it.str) {
          const [a, b, c, d, e, f] = it.transform, n = it.str.length;
          const flat = b === 0 && c === 0 && it.width > 0, size = it.height || Math.hypot(c, d) || Math.hypot(a, b) || 10;
          for (let i = 0; i < n; i++) push(it.str[i], flat ? [e + (i * it.width) / n, f - size * 0.22, e + ((i + 1) * it.width) / n, f + size * 0.88] : null);
        }
        if (it.hasEOL) push(' ');
      }
      const text = chars.map((x) => x.ch).join('');
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
        const rects = [];
        for (const bx of chars.slice(i, i + q.length).map((x) => x.box).filter(Boolean)) {
          const last = rects[rects.length - 1];
          if (last && Math.abs(last[2] - bx[1]) < 2 && bx[0] >= last[1] - 1) { last[3] = Math.max(last[3], bx[2]); last[4] = Math.max(last[4], bx[3]); }
          else rects.push([pg.n, ...bx]);
        }
        if (rects.length) hits.push({ page: pg.n, rects });
      }
    }
    this.findHits = hits;
    const top = this.scroller.scrollTop, at = this.pages.find((pg) => pg.el && pg.el.offsetTop + pg.el.offsetHeight > top)?.n || 1;
    this.findIdx = hits.length ? Math.max(0, hits.findIndex((h) => h.page >= at)) : -1;
    this.renderFind();
    if (this.findIdx >= 0) this.showFind();
    return hits.length;
  }
  // The matches on a page, found in its drawn text layer. Each box comes from the browser's own glyph positions.
  textLayerHits(pg, q) {
    const chars = [];
    const walker = document.createTreeWalker(pg.tl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) { if (n.tagName === 'BR' && chars.length && chars[chars.length - 1].ch !== ' ') chars.push({ ch: ' ' }); continue; }
      for (let i = 0; i < n.data.length; i++) {
        if (/\s/.test(n.data[i])) { if (chars.length && chars[chars.length - 1].ch !== ' ') chars.push({ ch: ' ', n, i }); }
        else chars.push({ ch: n.data[i].toLowerCase(), n, i });
      }
    }
    const text = chars.map((x) => x.ch).join(''), hits = [];
    const pb = pg.el.getBoundingClientRect();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
      const rects = [];
      for (const c of chars.slice(i, i + q.length)) {
        if (!c.n || /\s/.test(c.ch)) continue;
        const r = document.createRange();
        r.setStart(c.n, c.i);
        r.setEnd(c.n, c.i + 1);
        for (const cr of r.getClientRects()) {
          if (cr.width < 0.5 || cr.height < 0.5) continue;
          rects.push([pg.n, ...this.toPdf(pg, [cr.left - pb.left, cr.top - pb.top, cr.right - pb.left, cr.bottom - pb.top])]);
        }
      }
      if (rects.length) hits.push({ page: pg.n, rects: mergeLineRects(rects) });
    }
    return hits;
  }
  // ---------- dictionary terms ----------
  // match: text -> [{ start, end, term }] (see terms.js), or null for no dictionary. Each use of a term on a drawn
  // page gets a dotted line under it, and a hover shows its definition (onTermHover).
  setTermMatcher(match) {
    this.termMatch = match;
    for (const pg of this.pages) if (pg.textReady) this.renderTerms(pg);
  }
  renderTerms(pg) {
    pg.termHits = [];
    if (!pg.terms) return;
    pg.terms.replaceChildren();
    if (!this.termMatch || !pg.tl) return;
    const chars = [];
    const walker = document.createTreeWalker(pg.tl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) { if (n.tagName === 'BR' && chars.length && chars[chars.length - 1].ch !== ' ') chars.push({ ch: ' ' }); continue; }
      for (let i = 0; i < n.data.length; i++) {
        if (/\s/.test(n.data[i])) { if (chars.length && chars[chars.length - 1].ch !== ' ') chars.push({ ch: ' ', n, i }); }
        else chars.push({ ch: n.data[i], n, i });
      }
    }
    const pb = pg.el.getBoundingClientRect();
    for (const hit of this.termMatch(chars.map((x) => x.ch).join(''))) {
      const rects = [];
      for (const c of chars.slice(hit.start, hit.end)) {
        if (!c.n || c.ch === ' ') continue;
        const r = document.createRange();
        r.setStart(c.n, c.i);
        r.setEnd(c.n, c.i + 1);
        for (const cr of r.getClientRects()) {
          if (cr.width < 0.5 || cr.height < 0.5) continue;
          rects.push([pg.n, ...this.toPdf(pg, [cr.left - pb.left, cr.top - pb.top, cr.right - pb.left, cr.bottom - pb.top])]);
        }
      }
      if (!rects.length) continue;
      const merged = mergeLineRects(rects);
      pg.termHits.push({ term: hit.term, rects: merged });
      for (const [, ...r] of merged) {
        const box = div('term-hit');
        this.place(box, this.toView(pg, r));
        pg.terms.append(box);
      }
    }
  }
  // The dictionary term under a point of the window: { term, rect (in the window) }, or null.
  termAt(cx, cy) {
    for (const node of document.elementsFromPoint(cx, cy)) {
      if (!node.classList?.contains('page')) continue;
      const pg = this.pages[+node.dataset.n - 1];
      if (!pg?.termHits?.length) return null;
      const b = node.getBoundingClientRect();
      const [px, py] = pg.vp.convertToPdfPoint(cx - b.left, cy - b.top);
      for (const h of pg.termHits) {
        const r = h.rects.find(([, x0, y0, x1, y1]) => px >= x0 - 1 && px <= x1 + 1 && py >= y0 - 2 && py <= y1 + 2);
        if (!r) continue;
        const [vx0, vy0, vx1, vy1] = this.toView(pg, r.slice(1));
        return { term: h.term, rect: new DOMRect(b.left + vx0, b.top + vy0, vx1 - vx0, vy1 - vy0) };
      }
      return null;
    }
    return null;
  }
  // Look for a "Definitions" / "Terms" / "Terminology" section in this PDF: { title, page, entries } or null.
  async findDefinitions() {
    if (!this.doc) return null;
    const token = this.token;
    await this.runningReady; // headers and footers are known: leave them out of the entries
    const getLines = async (n) => {
      const pg = this.pages[n - 1];
      const tc = (pg.tc ||= await pg.page.getTextContent());
      const bands = [...(this.runningBands?.get(n) || []), ...(this.annots?.running || []).map((r) => [r.y0, r.y1])];
      return pageLines(tc, n, (y) => bands.some(([a, b]) => y >= a && y <= b), pg.page.view);
    };
    const found = await findDefinitions(this.pages.length, getLines, await this.bookmarks().catch(() => []));
    return token === this.token ? found : null;
  }

  // A page's text layer is now drawn: swap its estimated matches for exact ones.
  refindPage(pg) {
    if (!this.findHits || !this.findQ) return;
    const cur = this.findHits[this.findIdx];
    const before = this.findHits.filter((h) => h.page < pg.n), after = this.findHits.filter((h) => h.page > pg.n);
    const mine = this.textLayerHits(pg, this.findQ);
    this.findHits = [...before, ...mine, ...after];
    if (cur?.page === pg.n) {
      const k = this.findIdx - before.length;
      this.findIdx = mine.length ? before.length + Math.min(k, mine.length - 1) : Math.min(before.length, this.findHits.length - 1);
    } else if (cur && cur.page > pg.n) this.findIdx = this.findHits.indexOf(cur);
    this.renderFind();
    this.onFindChange?.();
  }
  findStep(dir) {
    const n = this.findHits?.length || 0;
    if (!n) return;
    this.findIdx = (this.findIdx + dir + n) % n;
    this.renderFind();
    this.showFind();
  }
  clearFind() {
    this.findToken = Symbol();
    this.findQ = '';
    this.findHits = [];
    this.findIdx = -1;
    this.renderFind();
  }
  renderFind() {
    for (const pg of this.pages) pg.find?.replaceChildren();
    (this.findHits || []).forEach((h, i) => {
      for (const [n, ...r] of h.rects) {
        const pg = this.pages[n - 1];
        if (!pg?.find) continue;
        const box = div(`find-hit${i === this.findIdx ? ' current' : ''}`);
        this.place(box, this.toView(pg, r));
        pg.find.append(box);
      }
    });
  }
  // Scroll so the current match sits a third of the way down the view.
  showFind() {
    const h = this.findHits?.[this.findIdx], pg = h && this.pages[h.page - 1];
    if (!pg?.el) return;
    const v = this.toView(pg, h.rects[0].slice(1));
    this.scroller.scrollTo({ top: pg.el.offsetTop + v[1] - this.scroller.clientHeight / 3, behavior: 'smooth' });
  }

  async renderPage(pg) {
    if (!pg.textDone) {
      pg.textDone = true;
      new pdfjsLib.TextLayer({ textContentSource: pg.page.streamTextContent(), container: pg.tl, viewport: pg.vp })
        .render().then(() => {
          orderTextLayer(pg.tl);
          attachSelection(pg.tl);
          this.markRunning(pg);
          pg.textReady = true;
          this.renderTerms(pg);
          if (this.findQ) this.refindPage(pg); // exact boxes from the drawn text, now that it is there
        }).catch(() => { pg.textDone = false; });
    }
    if (pg.rendered === this.scale || pg.task) return;
    const scale = this.scale, dpr = window.devicePixelRatio || 1;
    const off = document.createElement('canvas');
    off.width = Math.floor(pg.vp.width * dpr);
    off.height = Math.floor(pg.vp.height * dpr);
    pg.task = pg.page.render({ canvas: off, viewport: pg.vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
    try {
      await pg.task.promise;
      if (scale !== this.scale) return;
      pg.canvas.width = off.width;
      pg.canvas.height = off.height;
      pg.canvas.getContext('2d').drawImage(off, 0, 0);
      pg.rendered = scale;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e);
    } finally {
      pg.task = null;
    }
  }
  unrenderPage(pg) {
    pg.task?.cancel();
    if (pg.canvas) pg.canvas.width = pg.canvas.height = 0;
    pg.rendered = 0;
  }

  toView(pg, r) {
    const [ax, ay] = pg.vp.convertToViewportPoint(r[0], r[1]);
    const [bx, by] = pg.vp.convertToViewportPoint(r[2], r[3]);
    return normRect([ax, ay, bx, by]);
  }
  toPdf(pg, r) {
    const [ax, ay] = pg.vp.convertToPdfPoint(r[0], r[1]);
    const [bx, by] = pg.vp.convertToPdfPoint(r[2], r[3]);
    return normRect([ax, ay, bx, by]).map(round2);
  }
  place(node, [x0, y0, x1, y1]) {
    Object.assign(node.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  }

  renderHighlights() {
    if (!this.pages.length) return;
    const onBoard = this.getOnBoard?.(this.meta.id) || new Map();
    for (const pg of this.pages) pg.hl?.replaceChildren();
    const linkedTo = new Set([
      ...this.highlights.flatMap((x) => (x.links || []).filter((l) => !l.pdfId || l.pdfId === this.meta.id).map((l) => l.to)),
      ...(this.incoming || []).map((b) => b.link.to),
    ]);
    // Larger snippets first, so a term sits on top of its paragraph.
    for (const h of [...this.highlights].sort((a, b) => areaOf(b) - areaOf(a))) {
      let first = true;
      const nested = !!parentOf(h, this.highlights);
      const linked = (h.links || []).length > 0;
      for (const [n, ...r] of h.rects) {
        const pg = this.pages[n - 1];
        if (!pg?.hl) continue;
        const box = div(`hl hl-${h.kind}${nested ? ' nested' : ''}${linked ? ' linked' : ''}${linkedTo.has(h.id) ? ' target' : ''}${h.ref ? ' ref' : ''}`);
        box.dataset.id = h.id;
        box.style.setProperty('--c', h.color);
        const view = this.toView(pg, r);
        this.place(box, view);
        if (first && onBoard.has(h.id)) box.classList.add('onboard');
        if (first && linked) {
          // The mark is half as high as the line (6 to 12 px), so it does not cover the words next to it.
          const mark = div('hl-linkmark', '↗');
          mark.style.setProperty('--s', `${Math.round(clamp((view[3] - view[1]) * 0.5, 6, 12))}px`);
          box.append(mark);
        }
      if (h.plain) box.classList.add('plain');
        first = false;
        pg.hl.append(box);
      }
    }
    // A thin rule and a tag where each section starts.
    for (const sec of this.sections) {
      const pg = this.pages[sec.page - 1];
      if (!pg?.hl) continue;
      const top = sec.y == null ? 0 : pg.vp.convertToViewportPoint(0, sec.y)[1];
      const mark = div(`sec-mark lv${sec.level}`);
      mark.style.top = `${Math.max(0, top - 3)}px`;
      mark.append(div('sec-tag', `${'§'.repeat(sec.level)} ${sec.title}`));
      pg.hl.append(mark);
    }
  }

  // ---------- sections (an outline of the PDF, up to 3 levels) ----------
  sortedSections() {
    return [...this.sections].sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));
  }
  // The sections a place falls under, outermost first. A section runs to the next heading of the same or a higher level.
  sectionPath(page, top) {
    const stack = [];
    for (const s of this.sortedSections()) {
      const sy = s.y ?? Infinity;
      if (s.page > page || (s.page === page && sy < top - 0.5)) break;
      stack.length = Math.max(0, s.level - 1);
      stack[s.level - 1] = s;
    }
    return stack.filter(Boolean);
  }
  addSection({ title, page, y = null, level = 1 }) {
    const sec = { id: uid(), title: String(title).trim().slice(0, 200) || 'Untitled section', page, y, level: clamp(level, 1, 3) };
    this.sections.push(sec);
    this.changedSections();
    return sec;
  }
  updateSection(sec, changes) {
    Object.assign(sec, changes);
    sec.level = clamp(sec.level, 1, 3);
    this.changedSections();
  }
  deleteSection(sec) {
    this.annots.sections = this.sections.filter((x) => x !== sec);
    this.changedSections();
  }
  changedSections() {
    this.saveAnnots();
    this.renderHighlights();
    this.renderList();
    this.renderOutline();
  }
  // The page nearest the top of the reader.
  currentPage() {
    const mid = this.scroller.scrollTop + 40;
    let best = this.pages[0];
    for (const pg of this.pages) if (pg.el && pg.el.offsetTop <= mid) best = pg;
    return best?.n || 1;
  }
  goToSection(sec) {
    const pg = this.pages[sec.page - 1];
    if (!pg) return;
    const y = sec.y == null ? 0 : pg.vp.convertToViewportPoint(0, sec.y)[1];
    this.scroller.scrollTo({ top: Math.max(0, pg.el.offsetTop + y - 24), behavior: 'smooth' });
  }
  // The PDF's own bookmarks, flattened to at most 3 levels.
  async bookmarks() {
    if (!this.doc) return [];
    const outline = (await this.doc.getOutline()) || [];
    const out = [];
    const walk = async (items, level) => {
      for (const it of items) {
        let dest = it.dest;
        try {
          if (typeof dest === 'string') dest = await this.doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const page = typeof dest[0] === 'number' ? dest[0] + 1 : (await this.doc.getPageIndex(dest[0])) + 1;
            const y = dest[1]?.name === 'XYZ' && typeof dest[3] === 'number' ? dest[3] : null;
            out.push({ title: it.title, page, y, level: Math.min(level, 3) });
          }
        } catch { /* a bookmark that points nowhere */ }
        if (it.items?.length) await walk(it.items, level + 1);
      }
    };
    await walk(outline, 1);
    return out;
  }
  async importBookmarks() {
    const marks = await this.bookmarks();
    for (const m of marks) this.sections.push({ id: uid(), ...m });
    if (marks.length) this.changedSections();
    return marks.length;
  }
  // The lines of a page with the headers and footers left out.
  async linesOfPage(n) {
    const pg = this.pages[n - 1];
    const tc = (pg.tc ||= await pg.page.getTextContent());
    const bands = [...(this.runningBands?.get(n) || []), ...(this.annots?.running || []).map((r) => [r.y0, r.y1])];
    return pageLines(tc, n, (y) => bands.some(([a, b]) => y >= a && y <= b), pg.page.view);
  }
  // The contents page of this PDF, read one time for each document: { pages, entries } or null.
  contents() {
    if (!this.doc) return Promise.resolve(null);
    if (this.contentsFor !== this.token) {
      this.contentsFor = this.token;
      this.contentsFound = findContents(this.pages.length, (n) => this.linesOfPage(n)).catch(() => null);
    }
    return this.contentsFound;
  }
  // Make sections from the contents page: one for each entry, at the place where its heading starts.
  async importContents() {
    const token = this.token, toc = await this.contents();
    if (!toc || token !== this.token) return 0;
    await this.runningReady;
    const labels = await this.doc.getPageLabels().catch(() => null);
    const marks = await locateContents(toc, this.pages.length, (n) => this.linesOfPage(n), labels,
      (i, n) => { if (i % 10 === 0) this.onStatus?.(`Reading the contents: ${i} of ${n}…`); });
    if (token !== this.token) return 0;
    for (const { found, ...m } of marks) this.sections.push({ id: uid(), ...m });
    if (marks.length) this.changedSections();
    const lost = marks.filter((m) => !m.found).length;
    this.onStatus?.(`${marks.length} sections from the contents page${lost ? `. ${lost} of them start at the top of their page, because their heading was not found there` : ''}.`);
    return marks.length;
  }
  renderOutline() {
    const list = this.outlineEl;
    if (!list) return;
    this.onOutlineChange?.(this.sections.length);
    // Do not disturb a title being typed. A button that keeps the focus after a click does not count.
    if (list.contains(document.activeElement) && document.activeElement.matches('input, textarea, select, [contenteditable]')) return;
    list.replaceChildren();
    if (!this.meta) return list.append(div('hl-empty', 'Open a PDF to see its sections.'));
    const head = div('sec-head');
    const add = button('sec-add', '＋ Section at this page', 'Add a section that starts at the top of the page in view');
    add.onclick = () => this.onAskSection?.(this.currentPage());
    head.append(add);
    list.append(head);
    // Which sections are closed is kept for each PDF.
    if (this.secClosedFor !== this.meta.id) {
      this.secClosedFor = this.meta.id;
      try { this.secClosed = new Set(JSON.parse(localStorage.getItem(`corkboard.secClosed.${this.meta.id}`) || '[]')); } catch { this.secClosed = new Set(); }
    }
    if (!this.sections.length) {
      list.append(div('hl-empty', 'No sections yet. Select a heading in the PDF and pick Section or Sub-section, or add one here.'));
      this.bookmarks().then((marks) => {
        if (!marks.length || this.sections.length || !list.isConnected) return;
        const imp = button('sec-add', `Import the PDF's ${marks.length} bookmarks`, 'Make sections from the bookmarks inside the PDF');
        imp.onclick = () => this.importBookmarks();
        head.append(imp);
      }).catch(() => {});
      this.contents().then((toc) => {
        if (!toc || this.sections.length || !list.isConnected) return;
        const imp = button('sec-add', `Sections from the contents page (${toc.entries.length})`, `Make sections from the contents on page ${toc.pages.join(', ')}`);
        imp.onclick = () => { imp.disabled = true; this.importContents().catch(() => { imp.disabled = false; }); };
        head.append(imp);
      }).catch(() => {});
      return;
    }
    const counts = new Map();
    for (const h of this.highlights) {
      for (const sec of this.sectionPath(h.page, h.rects[0][4])) counts.set(sec.id, (counts.get(sec.id) || 0) + 1);
    }
    const sorted = this.sortedSections();
    // The search field, and one button that closes or opens every section.
    const search = Object.assign(document.createElement('input'), { type: 'search', className: 'sec-search', placeholder: 'Search sections…', autocomplete: 'off', spellcheck: false, value: this.secQuery || '' });
    const allBtn = button('sec-all', '', 'Close or open every section');
    const tools = div('sec-tools');
    tools.append(search, allBtn);
    list.append(tools);
    const none = div('hl-empty', 'No sections match.');
    const rows = [];
    const parents = sorted.map((sec, i) => sorted[i + 1]?.level > sec.level);
    const saveClosed = () => { try { localStorage.setItem(`corkboard.secClosed.${this.meta.id}`, JSON.stringify([...this.secClosed])); } catch { /* storage unavailable */ } };
    // Show the rows that the search and the closed sections leave. A search shows each match with its parents.
    const apply = () => {
      const q = (this.secQuery || '').trim().toLowerCase();
      const show = sorted.map(() => !q), stack = [];
      sorted.forEach((sec, i) => {
        while (stack.length && sorted[stack[stack.length - 1]].level >= sec.level) stack.pop();
        if (q) { if (sec.title.toLowerCase().includes(q)) { show[i] = true; for (const p of stack) show[p] = true; } }
        else if (stack.some((p) => this.secClosed.has(sorted[p].id))) show[i] = false;
        stack.push(i);
      });
      rows.forEach((r, i) => {
        r.row.hidden = !show[i];
        r.row.classList.toggle('dim', !!q && !sorted[i].title.toLowerCase().includes(q));
        if (r.caret) { r.caret.textContent = q || !this.secClosed.has(sorted[i].id) ? '▼' : '▶'; r.caret.disabled = !!q; }
      });
      none.hidden = show.some(Boolean);
      const anyOpen = sorted.some((sec, i) => parents[i] && !this.secClosed.has(sec.id));
      allBtn.textContent = anyOpen ? 'Close all' : 'Open all';
      allBtn.hidden = !parents.some(Boolean) || !!q;
    };
    search.oninput = () => { this.secQuery = search.value; apply(); };
    allBtn.onclick = () => {
      const anyOpen = sorted.some((sec, i) => parents[i] && !this.secClosed.has(sec.id));
      this.secClosed = new Set(anyOpen ? sorted.filter((sec, i) => parents[i]).map((sec) => sec.id) : []);
      saveClosed();
      apply();
    };
    sorted.forEach((sec, i) => {
      const row = div(`sec-row lv${sec.level}`);
      let caret = null;
      if (parents[i]) {
        caret = button('sec-caret', '▼', 'Close or open this section');
        caret.onclick = () => {
          if (this.secClosed.has(sec.id)) this.secClosed.delete(sec.id); else this.secClosed.add(sec.id);
          saveClosed();
          apply();
        };
        row.append(caret);
      } else row.append(div('sec-caret'));
      rows.push({ row, caret });
      const title = div('sec-title', sec.title);
      title.title = 'Go to this section';
      title.onclick = () => this.goToSection(sec);
      const meta = div('sec-meta', `p.${sec.page}${counts.get(sec.id) ? ` · ${counts.get(sec.id)}` : ''}`);
      meta.title = counts.get(sec.id) ? `${counts.get(sec.id)} snippets` : '';
      const acts = div('sec-acts');
      const out = button('', '⇤', 'Outdent (one level up)');
      out.disabled = sec.level === 1;
      out.onclick = () => this.updateSection(sec, { level: sec.level - 1 });
      const ind = button('', '⇥', 'Indent (one level down)');
      ind.disabled = sec.level === 3;
      ind.onclick = () => this.updateSection(sec, { level: sec.level + 1 });
      const ren = button('', '✎', 'Rename');
      ren.onclick = () => this.onRenameSection?.(sec);
      const del = button('danger', '×', 'Delete this section (snippets stay)');
      del.onclick = () => this.deleteSection(sec);
      acts.append(out, ind, ren, del);
      row.append(title, meta, acts);
      list.append(row);
    });
    list.append(none);
    apply();
  }

  // ---------- text highlights ----------
  selectionRects(range) {
    const rects = [];
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pageBoxes = this.pages.filter((p) => p.el.isConnected).map((p) => [p, p.el.getBoundingClientRect()]);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n) || !n.parentElement.closest('.textLayer') || n.parentElement.classList.contains('sep') || this.skipped(n)) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      for (const cr of r.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        const hit = pageBoxes.find(([, b]) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
        if (!hit) continue;
        const [pg, b] = hit;
        rects.push([pg.n, ...this.toPdf(pg, [cr.left - b.left, cr.top - b.top, cr.right - b.left, cr.bottom - b.top])]);
      }
    }
    return mergeLineRects(rects);
  }

  // The selected text as lines with their left edges (PDF points), so reflow can keep indents.
  // Falls back to the plain text when the lines do not hold the same words.
  async selectionLines(range, plain) {
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const lines = [];
    let cur = null, layer = null;
    const first = (n, from) => { // the first non-space character at or after offset `from`
      const i = n.data.slice(from).search(/\S/);
      return i < 0 ? -1 : from + i;
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      if (n.nodeType === 1) { if (n.tagName === 'BR') cur = null; continue; }
      const tl = n.parentElement.closest('.textLayer');
      if (!tl || this.skipped(n)) continue;
      if (tl !== layer) { layer = tl; cur = null; }
      const a = n === range.startContainer ? range.startOffset : 0;
      const b = n === range.endContainer ? range.endOffset : n.data.length;
      const str = n.data.slice(a, b);
      if (!cur) lines.push((cur = { text: '', x: null, r: null, at: null }));
      if (!n.parentElement.classList.contains('sep') && str.trim()) {
        // The right edge of this line: the end of its last visible character so far.
        const pageEl = tl.closest('.page'), pg = pageEl && this.pages[+pageEl.dataset.n - 1];
        const k = a + str.trimEnd().length;
        if (pg && k > a) {
          const r = document.createRange();
          r.setStart(n, k - 1);
          r.setEnd(n, k);
          const cr = r.getBoundingClientRect(), pb = pageEl.getBoundingClientRect();
          if (cr.width) cur.r = Math.max(cur.r ?? -Infinity, this.toPdf(pg, [cr.left - pb.left, cr.top - pb.top, cr.right - pb.left, cr.bottom - pb.top])[2]);
        }
      }
      if (cur.x == null && !n.parentElement.classList.contains('sep')) {
        const i = first(n, a);
        if (i >= 0 && i < b) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const cr = r.getBoundingClientRect();
          const pageEl = tl.closest('.page'), pg = pageEl && this.pages[+pageEl.dataset.n - 1];
          if (pg && cr.width) {
            const pb = pageEl.getBoundingClientRect();
            const r4 = this.toPdf(pg, [cr.left - pb.left, cr.top - pb.top, cr.right - pb.left, cr.bottom - pb.top]);
            cur.x = r4[0];
            cur.at = { pg, y0: r4[1], y1: r4[3] };
          }
        }
      }
      cur.text += str;
    }
    const words = (t) => t.split(/\s+/).filter(Boolean).join(' ');
    if (!lines.length || words(lines.map((l) => l.text).join(' ')) !== words(plain)) return plain;
    // The selection can start inside a line. Its first line's indent is where that line starts.
    const f = lines.find((l) => l.at);
    if (f) f.x = await this.lineStart(f.at.pg, f.x, f.at.y0, f.at.y1);
    return lines.map(({ text, x, r }) => ({ text, x, r }));
  }

  // Where the line through [y0, y1] starts, going left from x over words that are close together.
  async lineStart(pg, x, y0, y1) {
    const tc = (pg.tc ||= await pg.page.getTextContent());
    const words = [];
    for (const it of tc.items) {
      const [a, b, c, , e, f] = it.transform;
      if (!it.str?.trim() || b !== 0 || c !== 0 || !(it.width > 0)) continue;
      const size = it.height || Math.hypot(c, a) || 10, cy = f + size * 0.35;
      if (cy < y0 || cy > y1) continue;
      const lead = it.str.length - it.str.trimStart().length;
      words.push({ l: e + (lead / it.str.length) * it.width, r: e + it.width, size });
    }
    let cur = x;
    for (const w of words.sort((p, q) => q.r - p.r)) if (w.l < cur - 0.5 && w.r > cur - 1.2 * w.size) cur = w.l;
    return cur;
  }

  async afterPointerUp(e) {
    if (!this.doc || e.target.closest?.('.hlmenu') || this.adjusting || e.target.closest?.('.adjust-box')) return;
    if (this.justArea) { this.justArea = false; return; }
    const sel = getSelection();
    if ((this.mode === 'text' || this.mode === 'highlight') && sel && !sel.isCollapsed && this.pagesEl.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const rects = this.selectionRects(range);
      const text = reflow(await this.selectionLines(range, sel.toString())); // keeps list items, indents and paragraphs
      if (!rects.length || !text) return;
      // Highlight mode: colour the selection at once, with no menu. It is a plain highlight, not a snippet.
      if (this.mode === 'highlight') { await this.createHighlight({ kind: 'text', page: rects[0][0], rects, text }, this.markColor || HL_COLORS[0], { plain: true }); return; }
      const last = range.getClientRects();
      const anchor = last[last.length - 1] || range.getBoundingClientRect();
      this.showMenu({ pending: { kind: 'text', page: rects[0][0], rects, text } }, anchor);
      return;
    }
    // A plain click: open the menu for the highlight under the pointer, if any.
    const h = this.highlightAt(e.clientX, e.clientY);
    if (this.linkFrom) {
      const from = this.linkFrom;
      this.linkFrom = null;
      this.pagesEl.classList.remove('linking');
      if (h && h !== from) { this.addLink(from, h.id, this.linkLabel); this.onStatus?.(`Linked: “${excerpt(from, 30)}” ${this.linkLabel} “${excerpt(h, 30)}”`); }
      else this.onStatus?.('No link made.');
      return;
    }
    if (h) this.showMenu({ id: h.id }, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
  }

  highlightAt(cx, cy) {
    for (const node of document.elementsFromPoint(cx, cy)) {
      if (node.classList?.contains('page')) {
        const pg = this.pages[+node.dataset.n - 1];
        const b = node.getBoundingClientRect();
        const [px, py] = pg.vp.convertToPdfPoint(cx - b.left, cy - b.top);
        const hits = this.highlights.filter((h) => h.rects.some(([n, x0, y0, x1, y1]) =>
          n === pg.n && px >= x0 - 1 && px <= x1 + 1 && py >= y0 - 1 && py <= y1 + 1));
        return hits.sort((a, b) => areaOf(a) - areaOf(b))[0] || null;
      }
    }
    return null;
  }

  // ---------- area highlights ----------
  startArea(e, pg) {
    e.preventDefault();
    getSelection().removeAllRanges();
    this.hideMenu();
    const local = (ev) => {
      const r = pg.el.getBoundingClientRect();
      return [clamp(ev.clientX - r.left, 0, r.width), clamp(ev.clientY - r.top, 0, r.height)];
    };
    const [x0, y0] = local(e);
    let x1 = x0, y1 = y0;
    const sel = div('sel');
    pg.el.append(sel);
    pg.el.setPointerCapture(e.pointerId);
    const move = (ev) => { [x1, y1] = local(ev); this.place(sel, normRect([x0, y0, x1, y1])); };
    const up = () => {
      pg.el.removeEventListener('pointermove', move);
      pg.el.removeEventListener('pointerup', up);
      pg.el.removeEventListener('pointercancel', up);
      if (Math.abs(x1 - x0) < 6 || Math.abs(y1 - y0) < 6) return sel.remove();
      const rect = this.toPdf(pg, normRect([x0, y0, x1, y1]));
      const b = sel.getBoundingClientRect();
      this.justArea = true;
      this.showMenu({ pending: { kind: 'area', page: pg.n, rects: [[pg.n, ...rect]], w: Math.abs(x1 - x0) / this.scale }, selEl: sel }, b);
    };
    pg.el.addEventListener('pointermove', move);
    pg.el.addEventListener('pointerup', up);
    pg.el.addEventListener('pointercancel', up);
  }

  // The box of a selection on each of its pages, in page order, with one left and one right edge for all of them.
  // The selection leaves out the running headers and footers (when "skip" is on), so the boxes do too.
  partsOf(rects) {
    const pages = [...new Set(rects.map((r) => r[0]))].sort((a, b) => a - b);
    const boxes = pages.map((n) => this.bboxOf(rects, n));
    const x0 = Math.min(...boxes.map((b) => b[0])), x1 = Math.max(...boxes.map((b) => b[2]));
    return pages.map((n, i) => [n, x0, boxes[i][1], x1, boxes[i][3]]);
  }
  // One picture from two or more areas (a passage, a table or a figure that goes on to the next page): the
  // areas are drawn one under the other, with no space between them. parts: [[page, x0, y0, x1, y1], …].
  async captureParts(parts) {
    const width = Math.max(...parts.map((p) => p[3] - p[1])), height = parts.reduce((sum, p) => sum + (p[4] - p[2]), 0);
    const s = Math.min(clamp(1600 / width, 2, 6), 16000 / height);
    const tiles = [], texts = [];
    for (const [n, x0, y0, x1, y1] of parts) {
      const pg = this.pages[n - 1];
      const vp = pg.page.getViewport({ scale: s });
      const [vx0, vy0, vx1, vy1] = normRect([...vp.convertToViewportPoint(x0, y0), ...vp.convertToViewportPoint(x1, y1)]);
      const tile = document.createElement('canvas');
      tile.width = Math.ceil(vx1 - vx0);
      tile.height = Math.ceil(vy1 - vy0);
      await pg.page.render({ canvas: tile, viewport: vp, transform: [1, 0, 0, 1, -vx0, -vy0] }).promise;
      tiles.push(tile);
      texts.push(await this.extractText(pg, [x0, y0, x1, y1]));
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...tiles.map((t) => t.width));
    canvas.height = tiles.reduce((sum, t) => sum + t.height, 0);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let y = 0;
    for (const t of tiles) { ctx.drawImage(t, 0, y); y += t.height; }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return { blob, imgW: canvas.width, imgH: canvas.height, text: texts.filter(Boolean).join('\n') };
  }
  // Render just the region at high resolution, and pull the text inside it.
  async captureArea(pg, rect) {
    const [x0, y0, x1, y1] = rect;
    const s = clamp(1600 / (x1 - x0), 2, 6);
    const vp = pg.page.getViewport({ scale: s });
    const [vx0, vy0, vx1, vy1] = normRect([...vp.convertToViewportPoint(x0, y0), ...vp.convertToViewportPoint(x1, y1)]);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vx1 - vx0);
    canvas.height = Math.ceil(vy1 - vy0);
    await pg.page.render({ canvas, viewport: vp, transform: [1, 0, 0, 1, -vx0, -vy0] }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return { blob, imgW: canvas.width, imgH: canvas.height, text: await this.extractText(pg, rect) };
  }

  async extractText(pg, rect) {
    return reflow(await this.extractLines(pg, rect));
  }
  // The text inside a box, as lines with their left edges: [{ text, x }].
  async extractLines(pg, [x0, y0, x1, y1]) {
    const tc = (pg.tc ||= await pg.page.getTextContent());
    const lines = [];
    let cur = null;
    const put = (str, x, eol, r) => {
      if (!cur) lines.push((cur = { text: '', x: null, r: null }));
      if (cur.x == null && str.trim()) cur.x = x;
      if (str.trim()) cur.r = Math.max(cur.r ?? -Infinity, r);
      cur.text += str;
      if (eol) cur = null;
      else cur.text += ' ';
    };
    for (const it of tc.items) {
      if (!it.str) { if (it.hasEOL && cur?.text.trim()) cur = null; continue; }
      const [a, b, c, , e, f] = it.transform;
      const cy = f + (it.height || Math.hypot(c, a) || 10) * 0.35;
      if (b === 0 && c === 0 && it.width > 0) {
        if (cy < y0 || cy > y1) continue;
        const s0 = Math.max(e, x0), s1 = Math.min(e + it.width, x1);
        if (s1 - s0 <= 0) continue;
        const n = it.str.length;
        const i0 = Math.round(((s0 - e) / it.width) * n), str = it.str.slice(i0, Math.round(((s1 - e) / it.width) * n));
        const lead = str.length - str.trimStart().length; // leading spaces move the line's left edge
        const tail = str.length - str.trimEnd().length;
        put(str, e + ((i0 + lead) / n) * it.width, it.hasEOL || s1 < e + it.width - 1, e + ((i0 + str.length - tail) / n) * it.width);
      } else {
        const cx = e + (it.width || 0) / 2;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) put(it.str, e, it.hasEOL, e + (it.width || 0));
      }
    }
    return lines.filter((l) => l.text.trim());
  }

  // ---------- create / change / delete ----------
  async createHighlight(p, color, extra = {}) {
    const h = { id: uid(), kind: p.kind, page: p.page, rects: p.rects, text: p.text || '', color, created: Date.now(), ...extra };
    if (p.kind === 'area') {
      const pg = this.pages[p.page - 1];
      const cap = p.rects.length > 1 ? await this.captureParts(p.rects) : await this.captureArea(pg, p.rects[0].slice(1));
      const img = await uploadImage(cap.blob);
      Object.assign(h, { image: img.id, imgW: cap.imgW, imgH: cap.imgH, text: cap.text, w: Math.round(clamp(p.w, 180, 460)) });
    }
    this.highlights.push(h);
    this.color = color;
    getSelection().removeAllRanges();
    this.changedHighlights();
    if (h.kind === 'text' && !h.plain) this.attachFootnotes(h).catch(() => {});
    return h;
  }
  // ---------- footnotes ----------
  // A snippet that holds a footnote mark (a small raised number, or * † ‡ §) carries the footnote's text with it.
  // rects: where the snippet's text is (a picture snippet keeps its text's lines apart). quiet: no save yet.
  async attachFootnotes(h, { rects = h.rects, quiet = false } = {}) {
    const notes = await this.footnotesFor({ ...h, kind: 'text', rects });
    if (JSON.stringify(notes) === JSON.stringify(h.footnotes || [])) return false;
    if (notes.length) h.footnotes = notes; else delete h.footnotes;
    if (!quiet) this.changedHighlights();
    return true;
  }
  async footnotesFor(h) {
    const out = [];
    for (const n of [...new Set(h.rects.map((r) => r[0]))]) {
      const pg = this.pages[n - 1];
      if (!pg) continue;
      const tc = (pg.tc ||= await pg.page.getTextContent());
      const items = tc.items.filter((it) => it.str?.trim() && it.transform[1] === 0 && it.transform[2] === 0).map((it) => {
        const [, , , d, e, f] = it.transform, size = it.height || Math.abs(d) || 10;
        return { s: it.str, x: e, y: f, size, w: it.width || 0, cy: f + size * 0.35 };
      });
      const inSnip = (it) => h.rects.some(([m, x0, y0, x1, y1]) => m === n && it.x + it.w / 2 >= x0 - 1 && it.x + it.w / 2 <= x1 + 1 && it.cy >= y0 - 3 && it.cy <= y1 + 3);
      const mine = items.filter(inSnip);
      if (!mine.length) continue;
      const sizes = mine.map((i) => i.size).sort((a, b) => a - b), body = sizes[Math.floor(sizes.length / 2)];
      const marks = [...new Set(mine.filter((i) => i.size <= body * 0.8 && /^\s*(\d{1,3}|[*†‡§]+)\s*$/.test(i.s)).map((i) => i.s.trim()))];
      if (!marks.length) continue;
      // The footnote area: smaller print in the lower part of the page, outside the snippet and its running footer.
      const [, by0, , by1] = pg.page.view, H = by1 - by0, bands = this.runningBands?.get(n) || [];
      const small = items.filter((i) => (i.y - by0) / H < 0.45 && i.size <= body * 1.02 && !inSnip(i)
        && !bands.some(([a, b]) => i.cy >= a && i.cy <= b));
      // Lines: items whose baselines are close (a raised mark sits a little above its line's text).
      const rowsList = [];
      for (const i of [...small].sort((a, b) => b.y - a.y)) {
        const r = rowsList.find((row) => Math.abs(row[0].y - i.y) <= Math.max(row[0].size, i.size) * 0.45);
        if (r) r.push(i); else rowsList.push([i]);
      }
      const lines = rowsList.map((r) => r.sort((a, b) => a.x - b.x)).sort((a, b) => b[0].y - a[0].y)
        .map((r) => ({ y: r[0].y, size: Math.max(...r.map((i) => i.size)), first: r[0].s.trim(), text: r.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim() }));
      const startsNote = (L) => /^(\d{1,3}|[*†‡§]+)(\s|$)/.test(L.text) || /^(\d{1,3}|[*†‡§]+)$/.test(L.first);
      for (const mk of marks) {
        // The lowest line that starts with the mark: footnotes sit under the text.
        const match = (L) => L.first === mk || L.text.startsWith(`${mk} `) || (L.text.startsWith(mk) && /^[A-Z“"(]/.test(L.text.slice(mk.length)));
        let i = -1;
        lines.forEach((L, k) => { if (match(L)) i = k; });
        if (i < 0) continue;
        let text = lines[i].text.slice(lines[i].text.indexOf(mk) + mk.length).trim();
        for (let j = i + 1; j < lines.length; j++) {
          if (startsNote(lines[j]) || lines[j - 1].y - lines[j].y > lines[j].size * 2.2) break;
          text += ` ${lines[j].text}`;
        }
        if (text) out.push({ mark: mk, text: text.replace(/\s+/g, ' ').trim() });
      }
    }
    return out;
  }
  // The box around a snippet's lines on one page (PDF points), with a little room.
  bboxOf(rects, page, pad = 3) {
    const rs = rects.filter((r) => r[0] === page);
    return [Math.min(...rs.map((r) => r[1])) - pad, Math.min(...rs.map((r) => r[2])) - pad,
      Math.max(...rs.map((r) => r[3])) + pad, Math.max(...rs.map((r) => r[4])) + pad].map(round2);
  }
  // A selection snipped as a picture: an area snippet of the selection's box that keeps the selected text.
  // A selection that crosses a page gives one picture: its part on each page, one under the other.
  async createPictureSnippet(p, color) {
    const parts = this.partsOf(p.rects);
    const h = await this.createHighlight({ kind: 'area', page: parts[0][0], rects: parts, w: (parts[0][3] - parts[0][1]) * 1.1 }, color);
    if (p.text) { h.text = p.text; h.keepText = true; this.changedHighlights(); }
    if (p.text) { h.textRects = p.rects; await this.attachFootnotes(h, { rects: p.rects }).catch(() => {}); }
    return h;
  }
  async addPicture(h) {
    const pg = this.pages[h.page - 1];
    const box = h.picRect ? h.picRect.slice(1) : this.bboxOf(h.rects, h.page);
    // A snippet that crosses a page: its picture has the part on each page.
    const parts = h.picRect ? [] : this.partsOf(h.rects);
    const cap = parts.length > 1 ? await this.captureParts(parts) : await this.captureArea(pg, box);
    if (parts.length > 1) h.picParts = parts; else delete h.picParts;
    const img = await uploadImage(cap.blob);
    Object.assign(h, { image: img.id, imgW: cap.imgW, imgH: cap.imgH, w: Math.round(clamp((box[2] - box[0]) * 1.1, 180, 460)) });
    this.changedHighlights();
  }
  // Rebuild a snippet's text from the page, line by line, keeping lists and paragraphs.
  // all: a bulk refresh. It changes an area snippet only when its words stay the same.
  async refreshText(h, { all = false } = {}) {
    if (h.kind === 'area' && h.keepText) return false;
    let raw = '';
    if (h.kind === 'area') {
      const [n, ...r] = h.rects[0];
      raw = await this.extractText(this.pages[n - 1], r);
    } else {
      // Read each line from the page only to learn where lines start. The saved words stay as they are.
      const lines = [];
      for (const [n, x0, y0, x1, y1] of h.rects) {
        const pg = this.pages[n - 1];
        if (pg) lines.push(...(await this.extractLines(pg, [x0 - 1, y0 - 1, x1 + 1, y1 + 1])));
      }
      // The snippet can start inside a line. Its first line's indent is where that line starts.
      const [n, x0, y0, , y1] = h.rects[0];
      if (lines.length && this.pages[n - 1]) lines[0].x = await this.lineStart(this.pages[n - 1], lines[0].x ?? x0, y0, y1);
      raw = breakLikeLines(h.text, lines);
    }
    const text = reflow(raw);
    if (!text || text === h.text) return false;
    const flat = (t) => t.replace(/\s+/g, ' ').trim();
    if (all && h.kind === 'area' && flat(text) !== flat(h.text)) return false;
    h.text = text;
    return true;
  }
  async refreshAllText() {
    let changed = 0;
    for (const h of this.highlights) {
      const a = await this.refreshText(h, { all: true });
      // Footnotes too: text snippets, and picture snippets that keep their text's lines.
      const b = h.kind === 'text' || h.textRects ? await this.attachFootnotes(h, { rects: h.textRects || h.rects, quiet: true }) : false;
      if (a || b) changed++;
    }
    if (changed) this.changedHighlights();
    return changed;
  }
  removePicture(h) {
    for (const k of ['image', 'imgW', 'imgH', 'w', 'picRect', 'picParts']) delete h[k];
    this.changedHighlights();
  }
  // ---------- adjust a picture's box on the page ----------
  // The areas that a snippet's picture shows: [[page, x0, y0, x1, y1], …]. One area, or one for each joined area.
  pictureParts(h) {
    if (h.kind === 'area') return h.rects.map((r) => [...r]);
    if (Array.isArray(h.picParts) && h.picParts.length > 1) return h.picParts.map((r) => [...r]);
    if (h.picParts) return this.partsOf(h.rects);
    return [h.picRect ? [...h.picRect] : [h.page, ...this.bboxOf(h.rects, h.page)]];
  }
  // One box with handles for each area of the picture. Each box changes by itself. Done snips them all.
  startAdjust(h) {
    this.cancelAdjust();
    this.hideMenu();
    const parts = this.pictureParts(h).filter(([n]) => this.pages[n - 1]?.el);
    if (!parts.length) return;
    const many = parts.length > 1;
    const starts = h.kind === 'area' ? parts : (many ? this.partsOf(h.rects) : [[parts[0][0], ...this.bboxOf(h.rects, parts[0][0])]]);
    const items = [];
    this.adjusting = { h, items };
    for (const [page, ...rect] of parts) {
      const pg = this.pages[page - 1];
      const box = div(`adjust-box${many ? ' multi' : ''}`);
      for (const k of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) box.append(div(`adj-h adj-${k}`));
      const bar = div('adjust-bar');
      const done = button('primary', 'Done', many ? 'Snip all the areas again (Enter)' : 'Snip the new area (Enter)');
      const reset = button('', 'Reset', h.kind === 'area' ? 'Back to the box you started with' : 'Back to the box around the text');
      const cancel = button('', 'Cancel', 'Change nothing (Esc)');
      bar.append(cancel, reset);
      const it = { pg, box, v: this.toView(pg, rect) };
      const st = starts.find((x) => x[0] === page && (h.kind !== 'area' || x === parts[items.length])) || [page, ...rect];
      const start = this.toView(pg, st.slice(1));
      if (many) {
        const drop = button('', 'Remove area', 'Take this area out of the picture');
        drop.onclick = () => {
          box.remove();
          items.splice(items.indexOf(it), 1);
          if (items.length === 1) items[0].box.classList.remove('multi');
        };
        bar.append(drop);
      }
      bar.append(done);
      box.append(bar);
      pg.el.append(box);
      const place = () => this.place(box, it.v);
      place();
      items.push(it);
      box.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.adjust-bar')) return;
        e.preventDefault();
        e.stopPropagation();
        const handle = [...e.target.classList].find((c) => c.startsWith('adj-') && c !== 'adj-h')?.slice(4) || 'move';
        const [sx, sy] = [e.clientX, e.clientY], v0 = [...it.v];
        const W = pg.vp.width, H = pg.vp.height, MIN = 12;
        box.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          let [x0, y0, x1, y1] = v0;
          if (handle === 'move') {
            const w = x1 - x0, hh = y1 - y0;
            x0 = clamp(x0 + dx, 0, W - w); y0 = clamp(y0 + dy, 0, H - hh); x1 = x0 + w; y1 = y0 + hh;
          } else {
            if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN);
            if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + MIN, W);
            if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN);
            if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + MIN, H);
          }
          it.v = [x0, y0, x1, y1];
          place();
        };
        const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); };
        box.addEventListener('pointermove', move);
        box.addEventListener('pointerup', up);
      });
      done.onclick = () => this.run(() => this.finishAdjust());
      reset.onclick = () => { it.v = [...start]; place(); };
      cancel.onclick = () => this.cancelAdjust();
    }
    this.onStatus?.(many
      ? `This picture has ${parts.length} areas. Each one has its own box: drag its handles or the box. Enter or Done snips them all.`
      : 'Drag the handles or the box. Enter or Done snips the new area.');
  }
  cancelAdjust() {
    if (!this.adjusting) return;
    for (const it of this.adjusting.items) it.box.remove();
    this.adjusting = null;
  }
  async finishAdjust() {
    const a = this.adjusting;
    if (!a) return;
    const { h, items } = a;
    if (!items.length) return this.cancelAdjust();
    // In reading order: by page, then from the top of the page.
    const parts = items.map((it) => [it.pg.n, ...this.toPdf(it.pg, it.v)]).sort((p, q) => p[0] - q[0] || q[4] - p[4]);
    const cap = parts.length > 1 ? await this.captureParts(parts) : await this.captureArea(this.pages[parts[0][0] - 1], parts[0].slice(1));
    const img = await uploadImage(cap.blob);
    const width = Math.max(...parts.map((p) => p[3] - p[1]));
    Object.assign(h, { image: img.id, imgW: cap.imgW, imgH: cap.imgH, w: Math.round(clamp(width * 1.1, 180, 460)) });
    if (h.kind === 'area') {
      h.rects = parts;
      h.page = parts[0][0];
      if (!h.keepText) h.text = cap.text;
    } else if (parts.length > 1) {
      h.picParts = parts;
      delete h.picRect;
    } else {
      h.picRect = parts[0];
      delete h.picParts;
    }
    this.cancelAdjust();
    this.changedHighlights();
    this.onStatus?.('Picture updated');
  }
  setColor(h, color) {
    h.color = color;
    this.color = color;
    this.changedHighlights();
  }
  setNote(h, note) {
    h.note = note;
    this.saveAnnots();
  }
  deleteHighlight(h) {
    this.annots.highlights = this.highlights.filter((x) => x !== h);
    for (const x of this.highlights) if (x.links?.some((l) => l.to === h.id)) x.links = x.links.filter((l) => l.to !== h.id);
    this.changedHighlights();
  }
  hoverTip(e) {
    if (e.buttons || !this.doc || getSelection()?.toString()) { this.tipEl.hidden = true; this.onTermHover?.(null); return; }
    const t = this.termAt(e.clientX, e.clientY);
    this.onTermHover?.(t?.term || null, t?.rect);
    const h = this.highlightAt(e.clientX, e.clientY);
    const targets = (h?.links || []).map((l) => [l, this.resolveLink(l)]).filter(([, r]) => r.h || r.whole);
    if (!targets.length) { this.tipEl.hidden = true; return; }
    this.tipEl.replaceChildren(...targets.map(([l, r]) => {
      const row = div('hl-tip-row');
      row.append(div('hl-tip-label', `↗ ${l.label}${r.external ? ` · ${r.name}` : ''}`),
        div('hl-tip-text', r.whole ? `The whole document: ${r.name}` : excerpt(r.h, 280)));
      return row;
    }));
    this.tipEl.hidden = false;
    const sb = this.scroller.getBoundingClientRect();
    const x = clamp(e.clientX - sb.left + this.scroller.scrollLeft + 14, 4, this.scroller.scrollWidth - this.tipEl.offsetWidth - 4);
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${e.clientY - sb.top + this.scroller.scrollTop + 18}px`;
  }

  // ---------- links between snippets (a term to its definition) ----------
  addLink(h, toId, label = 'defined by', pdfId = null) {
    const other = pdfId && pdfId !== this.meta.id ? pdfId : undefined;
    h.links = (h.links || []).filter((l) => !(l.to === toId && (l.pdfId || undefined) === other));
    h.links.push({ id: uid(), to: toId, label, ...(other ? { pdfId: other } : {}) });
    this.changedHighlights();
    if (other) this.loadForeign(other).then(() => { this.renderHighlights(); this.renderList(); }).catch(() => {});
  }
  removeLink(h, linkId) {
    h.links = (h.links || []).filter((l) => l.id !== linkId);
    this.changedHighlights();
  }
  startLinkPick(h, label) {
    this.linkFrom = h;
    this.linkLabel = label;
    this.pagesEl.classList.add('linking');
    this.hideMenu();
    this.onStatus?.('Click the snippet to link to. Esc cancels.');
  }
  backlinks(h) { return this.highlights.filter((x) => (x.links || []).some((l) => l.to === h.id && (!l.pdfId || l.pdfId === this.meta.id))); }
  goToHighlight(id) {
    const h = this.highlight(id);
    if (h) this.goTo(h.page, h.rects);
  }
  changedHighlights() {
    this.saveAnnots();
    this.renderHighlights();
    this.renderList();
  }

  // ---------- popup menu ----------
  // New selection: pick a colour to make the snippet. Existing snippet: colour, note, delete.
  showMenu(target, anchor) {
    this.hideMenu();
    this.menuTarget = target;
    this.menuAnchor = anchor;
    const m = this.menuEl;
    m.replaceChildren();
    const h = target.id && this.highlight(target.id);
    if (h?.plain) return this.plainMenu(h, target, anchor);
    const onBoard = h && this.getOnBoard?.(this.meta.id).get(h.id);

    const row = div('hl-row');
    if (!h && target.pending.kind === 'text') {
      // Snip the selection as text (default) or as a picture of the page.
      const mode = div('hl-mode');
      for (const [val, label, tip] of [['text', 'Text', 'Snip the selected text'], ['picture', '📷 Picture', 'Snip a picture of the selected area (the text is kept for search and links)']]) {
        const b = button(`hl-mode-btn${this.snipAs === val ? ' on' : ''}`, label, tip);
        b.onclick = () => { this.snipAs = val; this.showMenu(target, anchor); };
        mode.append(b);
      }
      row.append(mode);
    }
    const swatches = div('hl-swatches');
    for (const c of HL_COLORS) {
      const s = button(`hl-swatch${(h ? h.color : null) === c ? ' active' : ''}`, '', h ? 'Change colour' : 'Make a snippet in this colour');
      s.style.setProperty('--c', c);
      s.onclick = () => this.run(async () => {
        if (h) return this.setColor(h, c);
        const nh = target.pending.kind === 'text' && this.snipAs === 'picture'
          ? await this.createPictureSnippet(target.pending, c)
          : await this.createHighlight(target.pending, c);
        this.showMenu({ id: nh.id, focusNote: true }, anchor);
      });
      swatches.append(s);
    }
    row.append(swatches);
    if (!h) {
      // A reference tag: snip in the reference colour, then choose what it links to.
      const ref = button('hl-action hl-ref-btn', '🔖 Reference', 'Tag the selection as a reference, then link it into another PDF, a snippet or a whole document');
      ref.style.setProperty('--c', REF_COLOR);
      ref.onclick = () => this.run(async () => {
        const nh = await this.createHighlight(target.pending, REF_COLOR, { ref: true });
        this.hideMenu();
        this.onPickLink?.(nh);
      });
      row.append(ref, div('hl-hint', 'Pick a colour to snip, or tag a reference'));
      if (target.pending.kind === 'text') {
        const skip = button('hl-action', 'Skip as header/footer', 'Leave text at this height out of selections on every page (a page header or footer)');
        skip.onclick = () => { this.addRunning(target.pending); this.hideMenu(); this.onStatus?.('Marked as a header or footer. Selections skip it on every page.'); };
        row.append(skip);
        if (this.onDefineTerm) {
          const def = button('hl-action', '📖 Define term', 'Add the selection to the dictionary: as a term, or as the definition of a term');
          def.onclick = () => { const p = target.pending; this.hideMenu(); getSelection().removeAllRanges(); this.onDefineTerm(p); };
          row.append(def);
        }
      }
    }
    if (!h && target.pending.kind === 'text') {
      // The selected text can also become a section heading.
      const heads = div('hl-row hl-heads');
      heads.append(div('hl-hint', 'Or make it a heading:'));
      const p = target.pending, top = Math.max(...p.rects.filter((r) => r[0] === p.page).map((r) => r[4]));
      for (const [level, label] of [[1, 'Section'], [2, 'Sub-section'], [3, 'Level 3']]) {
        const b = button('hl-action', label, `Start a level ${level} section here, titled with the selected text`);
        b.onclick = () => {
          this.addSection({ title: p.text, page: p.page, y: round2(top + 2), level });
          getSelection().removeAllRanges();
          this.hideMenu();
        };
        heads.append(b);
      }
      m.append(row, heads);
    }
    // A snippet's actions get a row of their own, under the colours. The row wraps when it is full.
    const acts = div('hl-row hl-acts');
    if (h && onBoard) {
      const find = button('hl-action', 'Find on board');
      find.onclick = () => { this.hideMenu(); this.onFindOnBoard(onBoard); };
      acts.append(find);
    }
    if (h && h.image) {
      const adj = button('hl-action', '⤢ Adjust picture', 'Change the area the picture shows. A picture of joined areas gets a box for each area');
      adj.onclick = () => this.startAdjust(h);
      acts.append(adj);
    }
    if (h && !(h.kind === 'area' && h.keepText)) {
      const re = button('hl-action', '↻ Refresh text', 'Read this snippet’s text again from the page, keeping lists and paragraphs');
      re.onclick = () => this.run(async () => {
        const t = await this.refreshText(h);
        const f = h.kind === 'text' || h.textRects ? await this.attachFootnotes(h, { rects: h.textRects || h.rects, quiet: true }) : false;
        const changed = t || f;
        if (changed) this.changedHighlights();
        this.onStatus?.(changed ? 'Text refreshed' : 'The text is already up to date');
        this.showMenu({ id: h.id }, anchor);
      });
      acts.append(re);
    }
    if (h && h.kind === 'text') {
      const pic = button('hl-action', h.image ? 'Remove picture' : '📷 Add picture',
        h.image ? 'Show this snippet as text again' : 'Add a picture of this snippet’s area, for figures, symbols or layout');
      pic.onclick = () => this.run(async () => {
        if (h.image) this.removePicture(h); else await this.addPicture(h);
        this.showMenu({ id: h.id }, anchor);
      });
      acts.append(pic);
    }
    if (h) {
      const del = button('hl-action danger', 'Delete', 'Delete this snippet (cards already on a board stay)');
      del.onclick = () => { this.deleteHighlight(h); this.hideMenu(); };
      acts.append(del);
    }
    if (!m.contains(row)) m.append(row);
    if (acts.childElementCount) m.append(acts);

    if (h) {
      // Layers: the snippet this one sits in.
      const parent = parentOf(h, this.highlights);
      const rel = div('hl-rels');
      if (parent) {
        const up = button('hl-rel-btn', `In: ${excerpt(parent, 44)}`, 'Open the snippet this one sits in');
        up.onclick = () => this.showMenu({ id: parent.id }, anchor);
        rel.append(up);
      }
      // Links out (to definitions) and links in.
      for (const l of h.links || []) {
        const text = this.linkText(l, 40);
        if (!text) continue;
        const r = div('hl-link-row');
        const go = button(`hl-rel-btn${l.pdfId ? ' ext' : ''}`, `↗ ${l.label}: ${text}`, l.pdfId ? 'Open the other PDF at the linked snippet' : 'Go to the linked snippet');
        go.onclick = () => this.followLink(l);
        const x = button('hl-x', '×', 'Remove this link');
        x.onclick = () => { this.removeLink(h, l.id); this.showMenu({ id: h.id }, anchor); };
        r.append(go, x);
        rel.append(r);
      }
      for (const b of this.backlinks(h)) {
        const lab = (b.links.find((l) => l.to === h.id) || {}).label || 'linked';
        const back = button('hl-rel-btn back', `← “${excerpt(b, 36)}” ${lab} this`, 'Go to the snippet that links here');
        back.onclick = () => { this.hideMenu(); this.goToHighlight(b.id); };
        rel.append(back);
      }
      for (const b of (this.incoming || []).filter((x) => x.link.to === h.id)) {
        const back = button('hl-rel-btn back ext', `← “${excerpt(b.from, 30)}” (${b.fromPdfName}) ${b.link.label} this`, 'Open the other PDF at the snippet that links here');
        back.onclick = () => { this.hideMenu(); this.onOpenLink?.(b.fromPdfId, b.from.id); };
        rel.append(back);
      }
      const tag = button('hl-action hl-ref-btn', h.ref ? 'Not a reference' : '🔖 Reference', h.ref ? 'Make this an ordinary snippet again' : 'Tag this snippet as a reference (its own colour)');
      tag.style.setProperty('--c', REF_COLOR);
      tag.onclick = () => {
        if (h.ref) { delete h.ref; h.color = h.prevColor || HL_COLORS[0]; delete h.prevColor; }
        else { h.ref = true; h.prevColor = h.color; h.color = REF_COLOR; }
        this.changedHighlights();
        this.showMenu({ id: h.id }, anchor);
      };
      rel.append(tag);
      const link = button('hl-action', '↗ Link to…', 'Link this snippet to another one, for example a term to its definition');
      link.onclick = () => { this.hideMenu(); this.onPickLink?.(h); };
      rel.append(link);
      m.append(rel);

      const note = document.createElement('textarea');
      note.className = 'hl-note';
      note.placeholder = 'Note on this snippet… (Enter to save, Shift+Enter for a new line)';
      note.value = h.note || '';
      note.rows = 2;
      note.addEventListener('input', () => this.setNote(h, note.value.trim()));
      note.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.hideMenu(); }
        if (e.key === 'Escape') this.hideMenu();
      });
      m.append(note);
      if (target.focusNote) setTimeout(() => note.focus(), 0);
    }

    this.placeMenu(target, anchor);
  }
  placeMenu(target, anchor) {
    const m = this.menuEl;
    m.hidden = false;
    const sb = this.scroller.getBoundingClientRect();
    const left = clamp(anchor.left - sb.left + this.scroller.scrollLeft, 4, this.scroller.scrollWidth - m.offsetWidth - 4);
    // Below the anchor, else above it when there is room there. The menu always starts inside the view.
    let top = anchor.bottom - sb.top + this.scroller.scrollTop + 8;
    const fitsBelow = anchor.bottom + m.offsetHeight + 12 <= sb.bottom, fitsAbove = anchor.top - m.offsetHeight - 12 >= sb.top;
    if (!fitsBelow && fitsAbove) top = anchor.top - sb.top + this.scroller.scrollTop - m.offsetHeight - 8;
    top = clamp(top, this.scroller.scrollTop + 4, Math.max(this.scroller.scrollTop + 4, this.scroller.scrollTop + sb.height - m.offsetHeight - 4));
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    if (target.selEl) target.selEl.classList.add('pending');
  }
  // A plain highlight (Highlight mode): only its colour. It can become a snippet, or go.
  plainMenu(h, target, anchor) {
    const m = this.menuEl;
    const row = div('hl-row');
    const sw = div('hl-swatches');
    for (const c of HL_COLORS) {
      const b = button(`hl-swatch${h.color === c ? ' active' : ''}`, '', 'Change colour');
      b.style.setProperty('--c', c);
      b.onclick = () => { h.color = c; this.markColor = c; this.onMarkColor?.(c); this.changedHighlights(); this.showMenu({ id: h.id }, anchor); };
      sw.append(b);
    }
    row.append(sw, div('hl-hint', 'Highlight'));
    const acts = div('hl-row hl-acts');
    const snip = button('hl-action', 'Make it a snippet', 'Turn this highlight into a snippet (it can go on a board and take links)');
    snip.onclick = () => { delete h.plain; this.changedHighlights(); this.showMenu({ id: h.id, focusNote: true }, anchor); };
    const del = button('hl-action danger', 'Delete', 'Remove this highlight');
    del.onclick = () => { this.deleteHighlight(h); this.hideMenu(); };
    acts.append(snip, del);
    m.append(row, acts);
    this.placeMenu(target, anchor);
  }
  hideMenu() {
    if (this.menuEl.hidden) return;
    this.menuEl.hidden = true;
    this.menuTarget?.selEl?.remove();
    this.menuTarget = null;
    this.renderList();
  }
  async run(fn) {
    this.menuEl.classList.add('busy');
    try { await fn(); } catch (e) { this.onError?.(e); } finally { this.menuEl.classList.remove('busy'); }
  }

  // ---------- snippet list (sidebar) ----------
  renderList() {
    const list = this.listEl;
    // Do not disturb a note being typed. A button that keeps the focus after a click does not count.
    if (list.contains(document.activeElement) && document.activeElement.matches('input, textarea, select, [contenteditable]')) return;
    list.replaceChildren();
    const snips = this.highlights.filter((h) => !h.plain); // plain highlights are not snippets
    this.onListChange?.(snips.length);
    if (!this.meta) return list.append(div('hl-empty', 'Open a PDF to see its snippets.'));
    if (!snips.length) {
      return list.append(div('hl-empty', 'No snippets yet. Select text, or switch to Area and drag a box.'));
    }
    const onBoard = this.getOnBoard?.(this.meta.id) || new Map();
    for (const h of [...snips].sort((a, b) => a.page - b.page || b.rects[0][4] - a.rects[0][4])) {
      const parent = parentOf(h, snips);
      list.append(snippetItem(h, {
        placed: onBoard.has(h.id), pdfName: null, onNote: (v) => this.setNote(h, v), section: this.sectionPath(h.page, h.rects[0][4]),
        depth: depthOf(h, this.highlights), parent: parent ? excerpt(parent, 40) : null,
        links: (h.links || []).map((l) => ({ label: l.label, text: this.linkText(l, 40) })).filter((l) => l.text),
        backlinks: this.backlinks(h).length + (this.incoming || []).filter((x) => x.link.to === h.id).length,
        flag: this.flagOf?.(h) || null,
      }));
      const item = list.lastChild;
      item.addEventListener('dragstart', (ev) => setDragData(ev, this.meta.id, h));
      item.addEventListener('click', (ev) => { if (!ev.target.closest('textarea')) this.goTo(h.page, h.rects); });
    }
  }

  goTo(page, rects) {
    const pg = this.pages[page - 1];
    if (!pg) return;
    let top = pg.el.offsetTop - 12;
    const list = rects ? (Array.isArray(rects[0]) ? rects : [[page, ...rects]]) : [];
    let firstTop = null;
    for (const [n, ...r] of list) {
      const p = this.pages[n - 1];
      if (!p) continue;
      const fl = div('flashbox');
      const v = this.toView(p, r);
      this.place(fl, v);
      p.hl.append(fl);
      setTimeout(() => fl.remove(), 2000);
      if (firstTop === null && n === page) firstTop = v[1];
    }
    if (firstTop !== null) top += firstTop - this.scroller.clientHeight / 3;
    this.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}
