// The whiteboard: cards, arrows, ink on image cards, pan/zoom, undo, focus and gravity.
import { Gravity } from './gravity.js';
import { fillSnipText, plainSnipText, locateSubs, inside } from './snips.js';
import { laneLayout, groupKey } from './layout.js';
import { createEditor, renderDoc, docToText, fromMarkdown, toggleTask, isEmptyDoc } from '/vendor/docedit/docedit.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const uid = () => crypto.randomUUID().slice(0, 8);
const ZONE_COLORS = ['#7cc8ff', '#86e07c', '#ffb347', '#c9a6ff', '#ff9ec7', '#ffd84d', '#9aa5b1'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const jitter = (n) => (Math.random() * 2 - 1) * n;

export const PALETTES = {
  marker: ['#ffe14d', '#8cff7a', '#ff8ad8', '#7fd8ff', '#ffb347'],
  pen: ['#d62828', '#1d3557', '#111111', '#2a9d4b', '#7b2cbf'],
  note: ['#d9d9d6', '#ffd84d', '#86e07c', '#ff9ec7', '#7cc8ff'],
  link: ['#8a8f98', '#e0573a', '#2f7de1', '#2a9d4b', '#111111', '#9b5de5', '#f4a261', '#14a39a'],
};
// In the dark theme, the near-black inks and arrows would not show on the dark board: draw them light.
// The stored colour does not change. Ink on a picture keeps its colour (a picture stays white).
const DARK_SWAP = { '#111111': '#e6e7e9', '#1f2328': '#e6e7e9', '#1d3557': '#8fb0e0', '#7b2cbf': '#b98be8' };
const shown = (c) => (c && document.documentElement.dataset.theme === 'dark' && DARK_SWAP[c.toLowerCase()]) || c;
const INK_WIDTH = { marker: 16, pen: 3 }; // CSS px on screen when drawn
const SIDES = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

function el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}
// "3. Requirements › I. WD emissions" from a snippet's section path.
const sectionLabel = (h) => (h.section || []).map((x) => x.title || x).join(' › ');
// A snippet's links, as a card keeps them: where each one points and what it says there.
const cardLinks = (h) => (h.links || []).filter((l) => !l.missing).map((l) => ({
  to: l.to || null, toPdfId: l.toPdfId || l.pdfId || h.pdfId, toPdfName: l.toPdfName || '', toText: l.toText || '', label: l.label || 'linked',
}));
// ---------- note cards: light formatting ----------
// "# " heading, "## " smaller heading, "- " list item, "1. " numbered item, "[ ] " / "[x] " task, "> " quote.
// Inside a line: **bold**, *italic*, `code`, and web links. The note keeps the plain text. This only draws it.
function inlineNote(into, s) {
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let at = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > at) into.append(s.slice(at, m.index));
    const t = m[0];
    let node;
    if (t.startsWith('**')) { node = document.createElement('strong'); node.textContent = t.slice(2, -2); }
    else if (t.startsWith('`')) { node = document.createElement('code'); node.textContent = t.slice(1, -1); }
    else if (t.startsWith('http')) { node = document.createElement('a'); node.href = t; node.target = '_blank'; node.rel = 'noopener'; node.textContent = t; }
    else { node = document.createElement('em'); node.textContent = t.slice(1, -1); }
    into.append(node);
    at = m.index + t.length;
  }
  if (at < s.length) into.append(s.slice(at));
}
// A note card that was edited with the document editor keeps a document (c.doc). An older note keeps plain
// text with marks (c.text) until its first edit.
function drawNote(el, c) {
  if (c.doc) return renderDoc(el, c.doc);
  el.classList.remove('de-doc');
  renderNote(el, c.text || '');
}
function renderNote(el, text) {
  el.replaceChildren();
  if (!text) return;
  String(text).split('\n').forEach((line, i) => {
    const row = document.createElement('div');
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { row.className = `nh nh${m[1].length}`; inlineNote(row, m[2]); }
    else if ((m = /^\s*\[( |x|X)\]\s?(.*)$/.exec(line))) {
      row.className = `ntask${m[1] === ' ' ? '' : ' done'}`;
      const box = document.createElement('span');
      box.className = 'ncheck';
      box.dataset.line = i;
      box.title = 'Done / not done';
      row.append(box);
      inlineNote(row, m[2]);
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { row.className = 'nli'; inlineNote(row, m[1]); }
    else if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) { row.className = 'nli nol'; row.dataset.n = `${m[1]}.`; inlineNote(row, m[2]); }
    else if ((m = /^>\s?(.*)$/.exec(line))) { row.className = 'nquote'; inlineNote(row, m[1]); }
    else { row.className = line.trim() ? 'np' : 'np empty'; inlineNote(row, line); }
    el.append(row);
  });
}
// A snippet's footnotes as a card keeps them: one "mark text" line each.
const footText = (h) => (h.footnotes || []).map((f) => `${f.mark} ${f.text}`).join('\n');
// A card's links: its snippet's own links, then the links of the snippets inside it (with sub: that snippet).
const allLinks = (c) => [...(c.snipLinks || []), ...(c.snipSubs || []).flatMap((s) => (s.links || []).map((l) => ({ ...l, sub: s.id, subText: s.text })))];
const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
// ---------- arrows around cards ----------
// Does the segment p→q cross the box r ({ x0, y0, x1, y1 })? (Liang–Barsky clipping.)
function crosses(p, q, r) {
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - r.x0], [dx, r.x1 - p.x], [-dy, p.y - r.y0], [dy, r.y1 - p.y]]) {
    if (pp === 0) { if (qq < 0) return null; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return t0 <= t1 ? { x: p.x + dx * (t0 + t1) / 2, y: p.y + dy * (t0 + t1) / 2 } : null;
}
const within = (pt, r) => pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1;
const dist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
// Waypoints from the first to the last point that go around the boxes, or null when nothing is in the way.
// For each crossing, the shortest way past the box (over, under, left, right, or a corner) is added.
function detour(pts, boxes) {
  let changed = false;
  for (let guard = 0; guard < 10; guard++) {
    let hit = null;
    for (let i = 0; i < pts.length - 1 && !hit; i++) {
      for (const r of boxes) { const m = crosses(pts[i], pts[i + 1], r); if (m) { hit = { i, r, m }; break; } }
    }
    if (!hit) break;
    const { i, r, m } = hit, p = pts[i], q = pts[i + 1], P = 18;
    const cands = [
      { x: m.x, y: r.y0 - P }, { x: m.x, y: r.y1 + P }, { x: r.x0 - P, y: m.y }, { x: r.x1 + P, y: m.y },
      { x: r.x0 - P, y: r.y0 - P }, { x: r.x1 + P, y: r.y0 - P }, { x: r.x0 - P, y: r.y1 + P }, { x: r.x1 + P, y: r.y1 + P },
    ].filter((w) => !boxes.some((o) => within(w, o)));
    const clear = (w) => !crosses(p, w, r) && !crosses(w, q, r);
    const best = (cands.filter(clear).length ? cands.filter(clear) : cands).sort((u, v) => dist(p, u) + dist(u, q) - dist(p, v) - dist(v, q))[0];
    if (!best) break;
    pts = [...pts.slice(0, i + 1), best, ...pts.slice(i + 1)];
    changed = true;
  }
  return changed ? pts : null;
}
// A smooth curve through the points (Catmull–Rom), with its middle (by length) for the label.
function smoothPath(pts, trunk) {
  const P = (p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`;
  let d = `M${P(pts[0])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    // A trunk's shared run stays straight.
    if (trunk && p1 === trunk.t1 && p2 === trunk.t2) { d += `L${P(p2)}`; continue; }
    // Centripetal Catmull–Rom: it does not overshoot or loop where the points are unevenly spaced.
    const d1 = Math.sqrt(dist(p0, p1)), d2 = Math.sqrt(dist(p1, p2)) || 1e-6, d3 = Math.sqrt(dist(p2, p3));
    const c1 = d1 < 1e-6 ? p1 : {
      x: (d1 * d1 * p2.x - d2 * d2 * p0.x + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.x) / (3 * d1 * (d1 + d2)),
      y: (d1 * d1 * p2.y - d2 * d2 * p0.y + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.y) / (3 * d1 * (d1 + d2)),
    };
    const c2 = d3 < 1e-6 ? p2 : {
      x: (d3 * d3 * p1.x - d2 * d2 * p3.x + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.x) / (3 * d3 * (d3 + d2)),
      y: (d3 * d3 * p1.y - d2 * d2 * p3.y + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.y) / (3 * d3 * (d3 + d2)),
    };
    d += `C${P(c1)} ${P(c2)} ${P(p2)}`;
  }
  const lens = pts.slice(1).map((p, i) => dist(pts[i], p));
  let half = lens.reduce((x, y) => x + y, 0) / 2, mid = pts[0];
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) { const t = lens[i] ? half / lens[i] : 0; mid = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; break; }
    half -= lens[i];
  }
  const out = { d, mid };
  if (trunk) {
    out.mid = { x: (trunk.t1.x + trunk.t2.x) / 2, y: (trunk.t1.y + trunk.t2.y) / 2 };
    out.split = { x: (trunk.t2.x + pts[pts.length - 1].x) / 2, y: (trunk.t2.y + pts[pts.length - 1].y) / 2 };
  }
  return out;
}
// The point halfway along a polyline.
function polyMid(pts) {
  const lens = pts.slice(1).map((p, i) => dist(pts[i], p));
  let half = lens.reduce((x, y) => x + y, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) { const t = lens[i] ? half / lens[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; }
    half -= lens[i];
  }
  return pts[0];
}
// A circuit route (straight runs, 90° turns) from a to b that goes around the boxes. The start leaves by side sa,
// the end enters by side sb. bus: a fixed position for the middle run (shared by the arrows of a trunk).
// Returns { pts, score }: the score counts box crossings first, then length and turns.
function orthoRoute(a, sa, b, sb, boxes, bus = null) {
  const H = sa === 'e' || sa === 'w';
  const T = H ? (p) => ({ x: p.x, y: p.y }) : (p) => ({ x: p.y, y: p.x }); // work as if the start leaves sideways
  const TB = H ? (r) => r : (r) => ({ x0: r.y0, y0: r.x0, x1: r.y1, y1: r.x1 });
  const A = T(a), B = T(b), na = T({ x: SIDES[sa][0], y: SIDES[sa][1] }), nb = T({ x: SIDES[sb][0], y: SIDES[sb][1] });
  const S = 18, P = 16, pa = { x: A.x + na.x * S, y: A.y + na.y * S }, pb = { x: B.x + nb.x * S, y: B.y + nb.y * S };
  const R = 500, near = boxes.map(TB).filter((r) => r.x1 > Math.min(pa.x, pb.x) - R && r.x0 < Math.max(pa.x, pb.x) + R
    && r.y1 > Math.min(pa.y, pb.y) - R && r.y0 < Math.max(pa.y, pb.y) + R);
  const X = bus != null ? [bus] : [(pa.x + pb.x) / 2, pa.x, pb.x, ...near.flatMap((r) => [r.x0 - P, r.x1 + P])];
  const Y = bus != null ? [] : [(pa.y + pb.y) / 2, pa.y, pb.y, ...near.flatMap((r) => [r.y0 - P, r.y1 + P])];
  const cands = [...X.map((x) => [pa, { x, y: pa.y }, { x, y: pb.y }, pb]), ...Y.map((y) => [pa, { x: pa.x, y }, { x: pb.x, y }, pb])];
  if (bus == null) {
    // Two runs out and one across: for a box that blocks the straight ways.
    for (const y of Y) for (const x of [pa.x, ...near.flatMap((r) => [r.x0 - P, r.x1 + P])].slice(0, 12)) {
      cands.push([pa, { x, y: pa.y }, { x, y }, { x: pb.x, y }, pb]);
    }
  }
  let best = null;
  for (const c of cands) {
    let hits = 0, len = 0, turns = 0;
    for (let i = 0; i < c.length - 1; i++) {
      len += Math.abs(c[i + 1].x - c[i].x) + Math.abs(c[i + 1].y - c[i].y);
      for (const r of near) if (crosses(c[i], c[i + 1], r)) hits++;
    }
    for (let i = 1; i < c.length - 1; i++) {
      const u = Math.sign(c[i].x - c[i - 1].x) || 0, v = Math.sign(c[i + 1].x - c[i].x) || 0;
      if (u !== v) turns++;
    }
    const score = hits * 100000 + len + turns * 40;
    if (!best || score < best.score) best = { c, score };
  }
  const back = H ? (p) => p : (p) => ({ x: p.y, y: p.x });
  let pts = [a, ...best.c.map(back), b];
  // Drop repeated points and points that do not turn.
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.5);
  pts = pts.filter((p, i) => i === 0 || i === pts.length - 1
    || !((Math.abs(pts[i - 1].x - p.x) < 0.5 && Math.abs(p.x - pts[i + 1].x) < 0.5) || (Math.abs(pts[i - 1].y - p.y) < 0.5 && Math.abs(p.y - pts[i + 1].y) < 0.5)));
  return { pts, score: best.score };
}
// Line styles for connections. dash: the stroke pattern. under: extra strokes drawn with the line, as
// [width factor, colour (null = the line's colour), opacity, dash pattern, line cap]. main: false hides the
// line itself (its arrowheads stay), for styles made only of those strokes.
const LINK_STYLES = {
  solid: { label: 'Solid' },
  dashed: { label: 'Dashed', dash: (w) => `${w * 4} ${w * 2.5}` },
  dotted: { label: 'Dotted', dash: (w) => `0.1 ${w * 3}` },
  dashdot: { label: 'Dash-dot', dash: (w) => `${w * 5} ${w * 2} ${w * 0.1} ${w * 2}` },
  double: { label: 'Double', main: false, under: [[3, null, 1], [1.2, 'var(--bg, #f6f6f4)', 1]] },
  // Two rails with cross ties, like a railway track.
  track: { label: 'Track', main: false, under: [[3.4, null, 1], [1.6, 'var(--bg, #f6f6f4)', 1], [5.2, null, 1, (w) => `${w * 0.7} ${w * 3.2}`, 'butt']] },
  glow: { label: 'Glow', under: [[5, null, 0.22]] },
};
const linkStyle = (l) => (l.style === 'stitched' ? 'track' : l.style && LINK_STYLES[l.style] ? l.style : l.dash ? 'dashed' : 'solid');
const LINK_WIDTHS = { thin: 1.25, normal: 2, bold: 3.5 };
const pathD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
const markerId = (color) => `ah-${color.replace(/[^a-z0-9]/gi, '')}`;

function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Board {
  constructor(opts) {
    Object.assign(this, opts); // pane, world, cardsEl, svg, labelsEl, hint, callbacks
    this.inkSvg = svgEl('svg', { id: 'boardInk' }); // pen and marker strokes drawn on the board itself
    this.world.append(this.inkSvg);
    this.data = null;
    this.tool = 'move';
    this.colors = { marker: PALETTES.marker[0], pen: PALETTES.pen[0], note: PALETTES.note[0], link: PALETTES.link[0] };
    this.sel = null;
    this.els = new Map();
    this.history = [];
    this.future = [];
    this.query = '';
    this.iso = null;        // { root, depth }: show only cards within `depth` links of `root`
    this.isoSet = null;     // Map card id -> link distance, while focus is on
    this.lastCard = null;   // the last card selected, for travel along links
    this.dragging = null;   // id of the card under the pointer, held still by gravity
    this.gravity = new Gravity(this);
    this.ro = new ResizeObserver(() => this.scheduleLinks());
    this.bindEvents();
  }

  // ---------- data ----------
  load(data) {
    data.cards ||= [];
    data.links ||= [];
    data.view ||= { x: 0, y: 0, z: 1 };
    data.groups ||= [];
    this.setGravity(false);
    this.data = data;
    this.history = [];
    this.future = [];
    this.sel = null;
    this.iso = null;
    this.lastCard = null;
    this.onIso?.(null);
    this.renderAll();
    this.applyView();
  }
  card(id) { return this.data.cards.find((c) => c.id === id); }
  link(id) { return this.data.links.find((l) => l.id === id); }
  maxZ() { return this.data.cards.reduce((m, c) => Math.max(m, c.z || 0), 0); }
  // Highlight id → card id, for every card on this board that came from the given PDF.
  highlightCards(pdfId) {
    const m = new Map();
    for (const c of this.data?.cards || []) if (c.source?.pdfId === pdfId && c.source.hl) m.set(c.source.hl, c.id);
    return m;
  }

  snapshotData() { return JSON.stringify({ cards: this.data.cards, links: this.data.links, style: this.data.style || {}, groups: this.data.groups || [], ink: this.data.ink || [] }); }
  snapshot() {
    this.history.push(this.snapshotData());
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }
  restore(from, to) {
    const s = from.pop();
    if (!s) return;
    this.setGravity(false);
    to.push(this.snapshotData());
    Object.assign(this.data, JSON.parse(s));
    this.renderAll();
    this.changed('structure');
  }
  undo() { this.restore(this.history, this.future); }
  redo() { this.restore(this.future, this.history); }
  changed(kind = 'data') { this.onChange?.(kind); }

  // ---------- view ----------
  applyView() {
    const { x, y, z } = this.data.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.pane.style.backgroundPosition = `${x}px ${y}px`;
    this.pane.style.backgroundSize = `${24 * z}px ${24 * z}px`;
    if (this.bar && !this.bar.hidden) this.placeLinkBar();
    this.placeNoteBar();
  }
  toWorld(cx, cy) {
    const r = this.pane.getBoundingClientRect();
    const { x, y, z } = this.data.view;
    return { x: (cx - r.left - x) / z, y: (cy - r.top - y) / z };
  }
  viewCenter() {
    const r = this.pane.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  zoomAt(cx, cy, factor) {
    const v = this.data.view;
    const r = this.pane.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const nz = clamp(v.z * factor, 0.1, 4);
    v.x = px - ((px - v.x) * nz) / v.z;
    v.y = py - ((py - v.y) * nz) / v.z;
    v.z = nz;
    this.applyView();
    this.changed('view');
  }
  // Move the view so (wx, wy) is in the middle, gliding there over `ms`.
  centerOn(wx, wy, z = this.data.view.z, ms = 350) {
    const r = this.pane.getBoundingClientRect();
    const v = this.data.view, from = { ...v }, to = { z, x: r.width / 2 - wx * z, y: r.height / 2 - wy * z };
    cancelAnimationFrame(this.viewAnim);
    if (!ms) { Object.assign(v, to); this.applyView(); return this.changed('view'); }
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      // Interpolate zoom, then place the target point in the middle at that zoom.
      v.z = from.z + (to.z - from.z) * e;
      const cx = ((r.width / 2 - from.x) / from.z) * (1 - e) + wx * e;
      const cy = ((r.height / 2 - from.y) / from.z) * (1 - e) + wy * e;
      v.x = r.width / 2 - cx * v.z;
      v.y = r.height / 2 - cy * v.z;
      this.applyView();
      if (t < 1) this.viewAnim = requestAnimationFrame(tick);
      else this.changed('view');
    };
    this.viewAnim = requestAnimationFrame(tick);
  }
  // The cards that the board shows: not outside the focus, and not in a branch of a choice that is not shown.
  visibleCards() { return this.data.cards.filter((c) => (!this.isoSet || this.isoSet.has(c.id)) && !this.offSet?.has(c.id)); }
  // An arrow shows when its two cards show.
  shownLinks() { return this.offSet?.size ? this.data.links.filter((l) => !this.offSet.has(l.from) && !this.offSet.has(l.to)) : this.data.links; }
  fit(cards = this.visibleCards()) {
    if (!cards.length) return this.centerOn(0, 0, 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cards) {
      const r = this.rectOf(c.id);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    const r = this.pane.getBoundingClientRect();
    const z = clamp(Math.min(r.width / (x1 - x0 + 120), r.height / (y1 - y0 + 120)), 0.1, 1.5);
    this.centerOn((x0 + x1) / 2, (y0 + y1) / 2, z);
  }
  focusCard(id) {
    this.reveal(id);
    const r = this.rectOf(id);
    if (!r) return;
    if (this.isoSet && !this.isoSet.has(id)) this.isolate(this.iso.depth, id, false);
    this.centerOn(r.x + r.w / 2, r.y + r.h / 2, Math.max(this.data.view.z, 0.8));
    this.select({ kind: 'card', id });
    this.flash(this.els.get(id));
  }

  // ---------- travel along a link ----------
  // Go to the end of the link that is not the card you came from.
  travel(linkId) {
    const l = this.link(linkId);
    if (!l) return;
    const centre = (id) => { const r = this.rectOf(id); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
    let from = this.lastCard;
    if (from !== l.from && from !== l.to) {
      // No card on this link was selected: leave from the end nearer the middle of the view.
      const v = this.viewCenter(), a = centre(l.from), b = centre(l.to);
      from = Math.hypot(a.x - v.x, a.y - v.y) <= Math.hypot(b.x - v.x, b.y - v.y) ? l.from : l.to;
    }
    const to = from === l.from ? l.to : l.from, p = centre(to);
    if (this.iso) this.isolate(this.iso.depth, to, false);
    this.centerOn(p.x, p.y, Math.max(this.data.view.z, 0.6), 450);
    this.select({ kind: 'card', id: to });
    this.flash(this.els.get(to));
  }

  // ---------- focus: isolate a card and its neighbours ----------
  // Breadth-first walk over links in both directions. Returns card id -> distance.
  reach(root, depth) {
    const adj = new Map();
    for (const l of this.data.links) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      if (!adj.has(l.to)) adj.set(l.to, []);
      adj.get(l.from).push(l.to);
      adj.get(l.to).push(l.from);
    }
    const dist = new Map([[root, 0]]);
    let frontier = [root];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next = [];
      for (const id of frontier) for (const n of adj.get(id) || []) if (!dist.has(n)) { dist.set(n, d); next.push(n); }
      frontier = next;
    }
    return dist;
  }
  // depth 0 clears focus. Returns false when there is no card to focus on.
  isolate(depth, root = this.sel?.kind === 'card' ? this.sel.id : this.lastCard, fit = true) {
    if (!depth) {
      this.iso = null;
      this.applyFilter();
      this.onIso?.(null);
      this.gravity.wake();
      return true;
    }
    if (!root || !this.card(root)) return false;
    this.iso = { root, depth };
    this.applyFilter();
    this.onIso?.(this.iso);
    if (fit) this.fit();
    this.gravity.wake();
    return true;
  }

  // ---------- structured layout ----------
  structure() {
    const cards = this.visibleCards();
    if (cards.length < 2) return false;
    this.setGravity(false);
    // Document order key: PDF, then page, then top of the snippet on the page.
    const pdfIndex = new Map();
    const doc = (c) => {
      const src = c.source;
      if (!src) return null;
      if (!pdfIndex.has(src.pdfId)) pdfIndex.set(src.pdfId, pdfIndex.size);
      const topPt = src.rects?.[0]?.[4] ?? src.rect?.[3] ?? 0;
      return pdfIndex.get(src.pdfId) * 1e7 + src.page * 1e4 + (1e4 - topPt);
    };
    const nodes = cards.map((c) => ({
      id: c.id, x: c.x, y: c.y, w: c.w, h: this.els.get(c.id)?.offsetHeight || 120,
      group: groupKey(c), header: c.laneHeader, doc: doc(c),
    }));
    const pos = laneLayout(nodes, this.data.links);
    this.snapshot(); // one undo step returns the layout from before
    this.animatePositions(pos, 500, () => { this.changed(); this.fit(); });
    return true;
  }
  animatePositions(pos, ms, done) {
    const from = new Map([...pos.keys()].map((id) => { const c = this.card(id); return [id, { x: c.x, y: c.y }]; }));
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      for (const [id, p] of pos) {
        const c = this.card(id), f = from.get(id);
        if (!c) continue;
        c.x = Math.round(f.x + (p.x - f.x) * e);
        c.y = Math.round(f.y + (p.y - f.y) * e);
        this.placeCard(c);
      }
      this.renderLinks();
      if (t < 1) requestAnimationFrame(tick);
      else done?.();
    };
    requestAnimationFrame(tick);
  }

  // ---------- gravity ----------
  setGravity(on) {
    if (on === this.gravity.running) return;
    if (on) {
      if (!this.data) return;
      this.snapshot(); // one undo step returns the layout from before gravity
      this.gravity.start();
    } else {
      this.gravity.stop();
      if (this.gravityMoved) this.changed();
      this.gravityMoved = false;
    }
    this.onGravity?.(on);
  }
  // In the All view of a choice, the cards of its branches can lie on each other: gravity leaves them alone.
  gravityCards() { return this.visibleCards().filter((c) => !this.branch?.ghost.has(c.id)); }
  afterGravityTick() {
    for (const c of this.gravityCards()) this.placeCard(c);
    this.renderLinks();
    this.gravityMoved = true;
  }
  onGravitySettled() {
    if (this.gravityMoved) this.changed();
    this.gravityMoved = false;
    this.onGravity?.('settled');
  }
  flash(e) {
    e.classList.remove('flash');
    void e.offsetWidth;
    e.classList.add('flash');
  }

  // ---------- rendering ----------
  // The dictionary changed: draw the cards again, so their terms show (not a card that is being written in).
  refreshTerms() {
    if (!this.data) return;
    for (const c of this.data.cards) if (!this.els.get(c.id)?.classList.contains('editing')) this.refreshCard(c);
    this.renderLinks();
  }
  // The theme changed: draw the arrows and the ink again (their colours come from the script).
  retheme() {
    if (!this.data) return;
    this.renderBoardInk();
    for (const c of this.data.cards) this.renderCardInk(c);
    this.renderLinks();
  }
  renderAll() {
    this.cardsEl.replaceChildren();
    this.els.clear();
    this.ro.disconnect();
    for (const c of this.data.cards) this.mountCard(c);
    this.renderBoardInk();
    this.renderFrames();
    this.renderLinks();
    this.applySearch(this.query);
    this.updateSelection();
    this.updateHint();
  }

  // ---------- groups: labelled frames that hold cards ----------
  // A card belongs to a frame while its centre is inside the frame.
  frame(id) { return (this.data.groups || []).find((g) => g.id === id); }
  frameMembers(g) {
    return this.data.cards.filter((c) => {
      const r = this.rectOf(c.id);
      if (!r) return false;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h;
    });
  }
  renderFrames() {
    if (!this.framesEl) return;
    this.framesEl.replaceChildren(...(this.data.groups || []).map((g) => {
      const f = el('div', 'frame');
      f.dataset.id = g.id;
      if (g.color) f.style.setProperty('--fc', g.color);
      Object.assign(f.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      const head = el('div', 'frame-head', { title: 'Drag to move the group and its cards · double-click to rename' });
      const title = el('span', 'frame-title');
      title.textContent = g.title || 'Group';
      const count = el('span', 'frame-count');
      count.textContent = `${this.frameMembers(g).length}`;
      const color = el('span', 'frame-color', { title: 'Right-click the title bar to rename, recolour or remove the zone' });
      head.append(title, count, color);
      f.append(head, el('div', 'frame-resize', { title: 'Drag to resize' }));
      return f;
    }));
  }
  // Draw a zone: drag a box on the empty board. Cards whose middle is inside it belong to it and move with it.
  startZone(e) {
    e.preventDefault();
    const p0 = this.toWorld(e.clientX, e.clientY);
    const draft = el('div', 'frame zone-draft');
    this.framesEl.append(draft);
    let box = null;
    this.drag(e, (ev) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      box = { x: Math.round(Math.min(p0.x, p.x)), y: Math.round(Math.min(p0.y, p.y)), w: Math.round(Math.abs(p.x - p0.x)), h: Math.round(Math.abs(p.y - p0.y)) };
      Object.assign(draft.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    }, () => {
      draft.remove();
      if (!box || box.w < 80 || box.h < 60) return;
      this.snapshot();
      const n = (this.data.groups || []).length;
      const id = uid();
      this.data.groups.push({ id, title: `Zone ${n + 1}`, ...box, color: ZONE_COLORS[n % ZONE_COLORS.length] });
      this.renderFrames();
      this.changed();
      this.setTool('move');
      this.renameGroup(id); // name it now (Cancel keeps "Zone N")
    });
  }
  recolorGroup(id) {
    const g = this.frame(id);
    if (!g) return;
    this.snapshot();
    const i = ZONE_COLORS.indexOf(g.color);
    g.color = ZONE_COLORS[(i + 1) % ZONE_COLORS.length];
    this.renderFrames();
    this.changed();
  }
  addGroup(title = 'Group') {
    const c = this.viewCenter();
    this.snapshot();
    this.data.groups.push({ id: uid(), title, x: Math.round(c.x - 300), y: Math.round(c.y - 200), w: 600, h: 400 });
    this.renderFrames();
    this.changed();
  }
  async renameGroup(id) {
    const g = this.frame(id);
    if (!g) return;
    const title = await this.ask('Name this zone', g.title || 'Group', { okLabel: 'Save' });
    if (!title || title === g.title) return;
    this.snapshot();
    g.title = title;
    this.renderFrames();
    this.changed();
  }
  deleteGroup(id) {
    this.snapshot();
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    this.renderFrames();
    this.changed();
  }
  startFrameMove(e, g) {
    const members = this.frameMembers(g);
    const p0 = this.toWorld(e.clientX, e.clientY);
    const start = { x: g.x, y: g.y, cards: members.map((c) => [c, c.x, c.y]) };
    let moved = false;
    this.drag(e, (ev) => {
      if (!moved) { this.snapshot(); moved = true; }
      const p = this.toWorld(ev.clientX, ev.clientY), dx = Math.round(p.x - p0.x), dy = Math.round(p.y - p0.y);
      g.x = start.x + dx; g.y = start.y + dy;
      for (const [c, x, y] of start.cards) { c.x = x + dx; c.y = y + dy; this.placeCard(c); }
      this.renderFrames();
      this.renderLinks();
    }, () => { if (moved) this.changed(); });
  }
  startFrameResize(e, g) {
    const p0 = this.toWorld(e.clientX, e.clientY), w0 = g.w, h0 = g.h;
    let moved = false;
    this.drag(e, (ev) => {
      if (!moved) { this.snapshot(); moved = true; }
      const p = this.toWorld(ev.clientX, ev.clientY);
      g.w = Math.round(Math.max(200, w0 + p.x - p0.x));
      g.h = Math.round(Math.max(120, h0 + p.y - p0.y));
      this.renderFrames();
    }, () => { if (moved) this.changed(); });
  }
  // One frame per document, its cards inside in document order. Other cards get a frame of their own.
  groupByDocument() {
    const cards = this.visibleCards();
    if (!cards.length) return false;
    this.setGravity(false);
    const PAD = 28, HEAD = 46, GAP = 26, COL_H = 1500, FRAME_GAP = 140;
    const byDoc = new Map();
    for (const c of cards) {
      const key = c.source?.pdfId || '';
      if (!byDoc.has(key)) byDoc.set(key, { name: c.source?.name || 'Other cards', color: c.source ? null : '#8a8f98', cards: [] });
      byDoc.get(key).cards.push(c);
    }
    const docs = [...byDoc.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || a[1].name.localeCompare(b[1].name));
    const topOf = (c) => c.source?.rects?.[0]?.[4] ?? c.source?.rect?.[3] ?? 0;
    const x0 = Math.min(...cards.map((c) => c.x)), y0 = Math.min(...cards.map((c) => c.y));
    const pos = new Map(), groups = [];
    let fx = x0;
    for (const [pdfId, d] of docs) {
      d.cards.sort((a, b) => (a.source?.page || 0) - (b.source?.page || 0) || topOf(b) - topOf(a) || a.y - b.y);
      // Fill columns top to bottom, a new column when one gets tall.
      let cx = fx + PAD, cy = y0 + HEAD, colW = 0, bottom = cy;
      for (const c of d.cards) {
        const h = this.els.get(c.id)?.offsetHeight || 120;
        if (cy > y0 + HEAD && cy + h > y0 + HEAD + COL_H) { cx += colW + GAP; cy = y0 + HEAD; colW = 0; }
        pos.set(c.id, { x: cx, y: cy });
        cy += h + GAP;
        colW = Math.max(colW, c.w);
        bottom = Math.max(bottom, cy);
      }
      const w = cx + colW + PAD - fx;
      groups.push({ id: uid(), title: d.name, pdfId: pdfId || null, x: fx, y: y0, w, h: bottom - y0 + PAD - GAP, ...(d.color ? { color: d.color } : {}) });
      fx += w + FRAME_GAP;
    }
    this.snapshot(); // one undo step returns cards and groups as they were
    const ids = new Set(cards.map((c) => c.id));
    this.data.groups = [...(this.data.groups || []).filter((g) => !this.frameMembers(g).some((c) => ids.has(c.id))), ...groups];
    this.animatePositions(pos, 500, () => { this.renderFrames(); this.changed(); this.fit(); });
    this.renderFrames();
    return true;
  }
  updateHint() { this.hint.hidden = this.data.cards.length > 0; }

  mountCard(c) {
    const e = el('div', `card card-${c.type}${c.snipRef ? ' card-ref' : ''}`);
    e.dataset.id = c.id;
    this.branchClasses(c, e);
    if (c.color) e.style.setProperty('--accent', c.color);
    // A picture first (area snippets, and text snippets with a picture), then the quoted text.
    if (c.type !== 'note' && c.image) {
      const media = el('div', 'media');
      media.style.aspectRatio = `${c.imgW} / ${c.imgH}`;
      const img = el('img', '', { src: `/files/images/${c.image}`, alt: c.snipText || '', draggable: 'false' });
      media.append(img, svgEl('svg', { class: 'ink', viewBox: `0 0 ${c.imgW} ${c.imgH}`, preserveAspectRatio: 'none' }));
      // Highlights over the picture: boxes, in fractions of its width and height.
      for (const m of (c.marks || []).filter((x) => x.box)) {
        const [x0, y0, x1, y1] = m.box;
        const linked = this.data.links.some((l) => (l.from === c.id && l.fromSub === m.id) || (l.to === c.id && l.toSub === m.id));
        const b = el('mark', `sub box${linked ? ' linked' : ''}`, { 'data-sub': m.id, title: 'Highlighted on the board' });
        Object.assign(b.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
        b.style.setProperty('--c', m.color);
        media.append(b);
      }
      e.append(media);
    }
    if (c.type === 'quote') {
      const q = el('blockquote', `quote${c.image ? ' short' : ''}`);
      if (c.image) q.textContent = plainSnipText(c.snipText);
      else {
        fillSnipText(q, c.snipText, [...(c.snipSubs || []).map((x) => ({
          ...x, linked: !!x.links?.length || !!x.into,
          title: [x.text, ...(x.links || []).map((l) => `↗ ${l.label}: ${l.to ? l.toText : `the whole of ${l.toPdfName}`}`),
            ...(x.into ? [`← ${x.into} link${x.into > 1 ? 's' : ''} into this word`] : [])].join('\n'),
        })), ...this.boardMarks(c)]);
      }
      e.append(q);
    }
    if (c.snipFoot) {
      // Footnotes the snippet points to, carried from the bottom of its page.
      const box = el('div', 'sfoot', { title: 'Footnotes from the page' });
      for (const line of c.snipFoot.split('\n')) {
        const [mark, ...rest] = line.split(' ');
        const row = el('div', 'sfoot-row');
        const sup = el('sup');
        sup.textContent = mark;
        row.append(sup, ` ${rest.join(' ')}`);
        box.append(row);
      }
      e.append(box);
    }
    if (c.snipNote) {
      const sn = el('div', 'snote', { title: 'Note from the reader' });
      sn.textContent = c.snipNote;
      e.append(sn);
    }
    const ph = c.type === 'note' ? 'Write a note…' : 'Double-click to add a board note';
    const text = el('div', `text ${c.type === 'note' ? `note-text size-${c.size || 'm'}` : 'caption'}`, { 'data-ph': ph });
    if (c.type === 'note') drawNote(text, c);
    else text.textContent = c.text || '';
    e.append(text);
    const links = allLinks(c);
    if (links.length) {
      const box = el('div', 'slinks');
      links.forEach((l, i) => {
        const row = el('div', 'slink-row');
        const other = l.toPdfId !== c.source?.pdfId;
        const go = el('button', 'slink', { 'data-i': i, title: l.to ? 'Go to this card, or place it beside this one' : 'Open the document' });
        const what = l.to ? (l.toText.length > 60 ? `${l.toText.slice(0, 59)}…` : l.toText) : `the whole of ${l.toPdfName}`;
        go.textContent = `↗ ${l.sub ? `“${short(l.subText, 24)}” ` : ''}${l.label}: ${what}${other && l.to ? ` · ${l.toPdfName}` : ''}`;
        const pdfBtn = el('button', 'slink-pdf', { 'data-i': i, title: 'Open it in the PDF' });
        pdfBtn.textContent = 'PDF';
        row.append(go, pdfBtn);
        box.append(row);
      });
      e.append(box);
    }
    if (c.snipSection) {
      const sec = el('div', 'ssec', { title: c.snipSection });
      sec.textContent = `§ ${c.snipSection}`;
      e.append(sec);
    }
    if (c.source) {
      // The card's own source: its name and page, and a PDF button that opens it in the reader.
      const row = el('div', 'source-row');
      const s = el('button', 'source', { title: 'Open the source in the PDF' });
      s.textContent = `${c.source.name} · p.${c.source.page}`;
      const pdf = el('button', 'card-pdf', { title: 'Open this snippet in its PDF' });
      pdf.textContent = 'PDF';
      row.append(s, pdf);
      // This snippet has more than one card on the board: a mark that goes to the next one.
      const copies = this.copiesOf(c);
      if (copies.length > 1) {
        const k = el('button', 'card-copies', { title: `This snippet has ${copies.length} cards on this board. Click to go to the next one.` });
        k.textContent = `⧉ ${copies.indexOf(c) + 1}/${copies.length}`;
        k.onclick = (ev) => { ev.stopPropagation(); this.focusCard(copies[(copies.indexOf(c) + 1) % copies.length].id); };
        row.insertBefore(k, pdf);
      }
      // A problem with the source (withdrawn, superseded, or this text changed on its web page).
      const flag = this.sourceFlag?.(c);
      if (flag) {
        const w = el('span', 'card-warn', { title: flag.title });
        w.textContent = `⚠ ${flag.text}`;
        row.insertBefore(w, pdf);
      }
      e.append(row);
    }
    const cardInk = svgEl('svg', { class: 'card-ink' });
    cardInk.append(...(c.cardStrokes || []).map((x) => this.strokeEl(x)));
    e.append(cardInk);
    for (const side of Object.keys(SIDES)) e.append(el('div', `handle h-${side}`, { 'data-side': side, title: 'Drag to another card to connect' }));
    const grip = c.image ? 'Drag to resize (the picture keeps its shape)' : 'Drag to resize. Double-click to fit the height to the text';
    e.append(el('div', 'resize', { 'data-edge': 'se', title: grip }), el('div', 'resize rs-e', { 'data-edge': 'e', title: 'Drag to change the width' }));
    if (!c.image) e.append(el('div', 'resize rs-s', { 'data-edge': 's', title: 'Drag to change the height. Double-click to fit the text' }));
    if (c.choice) this.renderChoiceBar(c, e);
    this.onDecorate?.(e, c); // dictionary terms in the card's text
    this.cardsEl.append(e);
    this.els.set(c.id, e);
    this.ro.observe(e);
    this.placeCard(c);
    if (c.strokes) this.renderInk(c);
    return e;
  }

  placeCard(c) {
    const e = this.els.get(c.id);
    e.style.left = `${c.x}px`;
    e.style.top = `${c.y}px`;
    e.style.width = `${c.w}px`;
    // A set height (text and note cards only): the text scrolls inside the card.
    const sized = !!c.h && !c.image;
    e.classList.toggle('sized', sized);
    e.style.height = sized ? `${c.h}px` : '';
    e.style.zIndex = c.z || 1;
  }

  renderCardInk(c) {
    const ink = this.els.get(c.id)?.querySelector('.card-ink');
    if (ink) ink.replaceChildren(...(c.cardStrokes || []).map((s) => this.strokeEl(s)));
  }
  renderBoardInk() {
    this.inkSvg.replaceChildren(...(this.data?.ink || []).map((s) => this.strokeEl(s)));
  }
  renderInk(c) {
    const ink = this.els.get(c.id)?.querySelector('.ink');
    if (ink) ink.replaceChildren(...(c.strokes || []).map((s) => this.strokeEl(s, false)));
  }
  strokeEl(s, swap = true) {
    const marker = s.t !== 'pen';
    return svgEl('path', {
      d: pathD(s.p), class: marker ? 'mk' : 'pen', stroke: swap ? shown(s.c) : s.c, 'stroke-width': s.w, fill: 'none',
      'stroke-linecap': marker ? 'square' : 'round', 'stroke-linejoin': 'round', 'stroke-opacity': marker ? 0.45 : 1,
    });
  }

  // ---------- arrows ----------
  rectOf(id) {
    const c = this.card(id), e = this.els.get(id);
    return c && e ? { x: c.x, y: c.y, w: c.w, h: e.offsetHeight } : null;
  }
  anchor(r, side) {
    const [nx, ny] = SIDES[side];
    return { x: r.x + r.w / 2 + (nx * r.w) / 2, y: r.y + r.h / 2 + (ny * r.h) / 2 };
  }
  // Pick the facing sides of two cards, then draw a smooth curve between them.
  // The height of a marked word on its card, in board units, or null when it is not shown.
  subY(cardId, subId) {
    const e = this.els.get(cardId), c = this.card(cardId);
    const m = e?.querySelector(`mark.sub[data-sub="${CSS.escape(subId)}"]`);
    if (!m) return null;
    const er = e.getBoundingClientRect(), mr = m.getBoundingClientRect();
    if (!er.height || !mr.height) return null;
    return clamp(c.y + (mr.top + mr.height / 2 - er.top) / this.data.view.z, c.y + 8, c.y + e.offsetHeight - 8);
  }
  // An arrow that starts or ends level with a marked word: it leaves and enters by the left or right side.
  subEnds(ra, rb, ya, yb) {
    const ca = ra.x + ra.w / 2, cb = rb.x + rb.w / 2, apart = Math.abs(cb - ca) > (ra.w + rb.w) / 4;
    const sa = apart ? (cb > ca ? 'e' : 'w') : 'e', sb = apart ? (cb > ca ? 'w' : 'e') : 'e';
    const a = { x: sa === 'e' ? ra.x + ra.w : ra.x, y: ya ?? ra.y + ra.h / 2 };
    const b = { x: sb === 'e' ? rb.x + rb.w : rb.x, y: yb ?? rb.y + rb.h / 2 };
    return { a, sa, b, sb };
  }
  cardEnds(ra, rb) {
    const dx = rb.x + rb.w / 2 - (ra.x + ra.w / 2), dy = rb.y + rb.h / 2 - (ra.y + ra.h / 2);
    const horiz = Math.abs(dx) / (ra.w + rb.w) > Math.abs(dy) / (ra.h + rb.h);
    const sa = horiz ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
    const sb = { e: 'w', w: 'e', n: 's', s: 'n' }[sa];
    const [a, b] = this.slideEnds(ra, sa, rb, sb);
    return { a, sa, b, sb };
  }
  // The path of an arrow between its ends. In a trunk (see trunks), it joins the shared middle run and leaves it
  // again near its own cards.
  pathFor(g, trunk = null, avoid = [], all = []) {
    let { a, sa, b, sb } = g;
    if (this.arrowStyle() === 'circuit') {
      // Around every card, its own two included (the short stubs leave and enter them).
      let { pts, score } = orthoRoute(a, sa, b, sb, all, trunk?.bus ?? null);
      if (trunk?.bus != null && score >= 100000) {
        // The shared run crosses a card for this arrow: let it find its own way when that is clearer.
        const own = orthoRoute(a, sa, b, sb, all);
        if (own.score < score) { pts = own.pts; trunk = null; }
      }
      return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(''), mid: trunk?.busMid || polyMid(pts), pad: a };
    }
    // An end that changed side for free space was put level with the other card. In a shared run, put it level
    // with the end of the run, so the arrow does not bend back to it.
    if (trunk && g.roomB) b = this.slideTo(g.rb, sb, trunk.t2);
    if (trunk && g.roomA) a = this.slideTo(g.ra, sa, trunk.t1);
    // Around other cards: when the straight run would cross a card, the arrow bends around it.
    const [nax0, nay0] = SIDES[sa], [nbx0, nby0] = SIDES[sb];
    const lead = 26, a2 = { x: a.x + nax0 * lead, y: a.y + nay0 * lead }, b2 = { x: b.x + nbx0 * lead, y: b.y + nby0 * lead };
    let way = avoid.length ? detour([a2, ...(trunk ? [trunk.t1, trunk.t2] : []), b2], avoid) : null;
    // A bend behind a card's side would make the arrow hook round to it: enter (or leave) by the side that
    // faces the bend instead.
    const reSide = (r, pt) => {
      const dx = pt.x - (r.x + r.w / 2), dy = pt.y - (r.y + r.h / 2);
      const side = Math.abs(dx) / r.w > Math.abs(dy) / r.h ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
      const at = this.slideTo(r, side, pt);
      return { side, at, lead: { x: at.x + SIDES[side][0] * lead, y: at.y + SIDES[side][1] * lead } };
    };
    const behind = (pt, end, side) => (pt.x - end.x) * SIDES[side][0] + (pt.y - end.y) * SIDES[side][1] < 0;
    // A bend right next to an end, no further from the card's side than the lead point: the arrow would go
    // out to the lead point and hook back (a bunch of turns in a small space). Go from the bend straight into
    // the card.
    const near = (end, side, next) => {
      if (!next) return false;
      const [nx, ny] = SIDES[side];
      const out = (next.x - end.x) * nx + (next.y - end.y) * ny, along = Math.abs((next.x - end.x) * ny - (next.y - end.y) * nx);
      return out > 2 && out < lead * 1.3 && along > 6 && along < lead * 4;
    };
    // The way round other cards ends at a bend that is past a corner of the card (not in front of the side that
    // the arrow uses). The side next to it, round that corner, faces the bend as well. Where that side has more
    // free space in front of it, use it: the arrow does not push into a small gap between two cards.
    const better = (r, side, pt, id) => {
      const alt = side === 'n' || side === 's' ? (pt.x < r.x ? 'w' : pt.x > r.x + r.w ? 'e' : null) : (pt.y < r.y ? 'n' : pt.y > r.y + r.h ? 's' : null);
      if (!alt || !this.rooms) return null;
      const now = this.sideRoom(r, side, this.rooms, id);
      if (now >= 160 || this.sideRoom(r, alt, this.rooms, id) < 1.5 * now) return null;
      const at = this.slideTo(r, alt, pt);
      return { side: alt, at, lead: { x: at.x + SIDES[alt][0] * lead, y: at.y + SIDES[alt][1] * lead } };
    };
    if (way) {
      let moved = false;
      if (g.rb && !g.fixedB) {
        const pt = way[way.length - 2];
        const n = behind(pt, b, sb) ? reSide(g.rb, pt) : better(g.rb, sb, pt, g.idb);
        if (n) { b = n.at; sb = n.side; moved = true; }
      }
      if (g.ra && !g.fixedA) {
        const pt = way[1];
        const n = behind(pt, a, sa) ? reSide(g.ra, pt) : better(g.ra, sa, pt, g.ida);
        if (n) { a = n.at; sa = n.side; moved = true; }
      }
      if (moved) {
        // New sides: find the way round the other cards again from them.
        const s2 = (p, side) => ({ x: p.x + SIDES[side][0] * lead, y: p.y + SIDES[side][1] * lead });
        const pts = [s2(a, sa), ...(trunk ? [trunk.t1, trunk.t2] : []), s2(b, sb)];
        way = detour(pts, avoid) || pts;
      }
      const isTrunk = (p) => trunk && (p === trunk.t1 || p === trunk.t2);
      let leadA = true, leadB = true; // the first and the last point of the way are the lead points
      if (way.length > 2 && !isTrunk(way[way.length - 2]) && near(b, sb, way[way.length - 2])) { way = way.slice(0, -1); leadB = false; }
      if (way.length > 2 && !isTrunk(way[1]) && near(a, sa, way[1])) { way = way.slice(1); leadA = false; }
      // Bends that are almost at one place (the way round a card can give several) make a kink: keep one of
      // them. The lead points and the points of a shared run always stay.
      const last = way.length - 1, kept = [];
      way.forEach((p, i) => {
        const q = kept[kept.length - 1], fixed = isTrunk(p) || (i === 0 && leadA) || (i === last && leadB);
        if (!fixed && q && !q.fixed && dist(q.p, p) <= lead * 1.5) return;
        kept.push({ p, fixed });
      });
      way = kept.map((k) => k.p);
      return smoothPath([a, ...way, b], trunk);
    }
    if (!trunk) return this.curve(a, SIDES[sa], b, SIDES[sb]);
    // The shared run ends behind the side that the arrow enters (or starts behind the side that it leaves).
    if (g.rb && !g.fixedB && behind(trunk.t2, b, sb)) { const n = reSide(g.rb, trunk.t2); b = n.at; sb = n.side; }
    if (g.ra && !g.fixedA && behind(trunk.t1, a, sa)) { const n = reSide(g.ra, trunk.t1); a = n.at; sa = n.side; }
    const { t1, t2 } = trunk, len = Math.hypot(t2.x - t1.x, t2.y - t1.y) || 1, u = { x: (t2.x - t1.x) / len, y: (t2.y - t1.y) / len };
    const ka = clamp(Math.hypot(t1.x - a.x, t1.y - a.y) * 0.5, 16, 140), kb = clamp(Math.hypot(b.x - t2.x, b.y - t2.y) * 0.5, 16, 140);
    const [nax, nay] = SIDES[sa], [nbx, nby] = SIDES[sb];
    const P = (p) => `${p.x} ${p.y}`;
    // The shared run starts (or ends) right next to the card, beside the point on its side: a curve that leaves
    // the side at a right angle would wiggle there. Go straight between the two, and bend into the run only.
    const flat = (p, end, [nx, ny]) => { const o = (p.x - end.x) * nx + (p.y - end.y) * ny; return o < 0 ? { x: p.x - nx * o, y: p.y - ny * o } : p; };
    const nearA = near(a, sa, t1), nearB = near(b, sb, t2);
    const ja = Math.min(ka, Math.hypot(t1.x - a.x, t1.y - a.y) / 3), jb = Math.min(kb, Math.hypot(b.x - t2.x, b.y - t2.y) / 3);
    const a1 = nearA ? a : { x: a.x + nax * ka, y: a.y + nay * ka };
    const a2c = nearA ? flat({ x: t1.x - u.x * ja, y: t1.y - u.y * ja }, a, SIDES[sa]) : { x: t1.x - u.x * ka, y: t1.y - u.y * ka };
    const b1 = nearB ? flat({ x: t2.x + u.x * jb, y: t2.y + u.y * jb }, b, SIDES[sb]) : { x: t2.x + u.x * kb, y: t2.y + u.y * kb };
    const b2c = nearB ? b : { x: b.x + nbx * kb, y: b.y + nby * kb };
    return {
      d: `M${P(a)}C${P(a1)} ${P(a2c)} ${P(t1)}`
        + `L${P(t2)}C${P(b1)} ${P(b2c)} ${P(b)}`,
      mid: { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 },
      split: { x: (t2.x + b.x) / 2, y: (t2.y + b.y) / 2 },
    };
  }
  // Circuit arrows of a trunk share one middle run (a bus): the position that crosses the fewest cards for all of them.
  circuitBuses(trunks, geo, boxes) {
    const groups = new Map();
    for (const [id, t] of trunks.of) { if (!groups.has(t)) groups.set(t, []); groups.get(t).push(id); }
    trunks.labels = [];
    for (const [t, ids] of groups) {
      const g0 = geo.get(ids[0]), H = g0.sa === 'e' || g0.sa === 'w';
      const same = ids.filter((id) => { const s = geo.get(id).sa; return (s === 'e' || s === 'w') === H; });
      const mid = H ? (t.t1.x + t.t2.x) / 2 : (t.t1.y + t.t2.y) / 2;
      const edges = boxes.flatMap((r) => (H ? [r.x0 - 16, r.x1 + 16] : [r.y0 - 16, r.y1 + 16]))
        .filter((v) => Math.abs(v - mid) < Math.abs((H ? t.t2.x - t.t1.x : t.t2.y - t.t1.y)) + 200);
      let best = null;
      for (const bus of [mid, ...edges]) {
        const score = same.reduce((sum, id) => { const g = geo.get(id); return sum + orthoRoute(g.a, g.sa, g.b, g.sb, boxes, bus).score; }, 0);
        if (!best || score < best.score) best = { bus, score };
      }
      const ys = same.flatMap((id) => { const g = geo.get(id); return H ? [g.a.y, g.b.y] : [g.a.x, g.b.x]; });
      const across = (Math.min(...ys) + Math.max(...ys)) / 2;
      t.bus = best.bus;
      t.busMid = H ? { x: best.bus, y: across } : { x: across, y: best.bus };
      for (const id of ids) if (!same.includes(id)) trunks.of.delete(id);
      if (same.length > 1) trunks.labels.push({ id: same[0], label: this.link(same[0]).label, count: same.length, at: t.busMid });
      else trunks.of.delete(same[0]);
    }
  }
  // Arrows with the same label whose starts are close together and whose ends are close together run as one
  // trunk in the middle, and split apart near their cards. Returns link id → { t1, t2 } and one label per trunk.
  trunks(geo, boxes = []) {
    const NEAR = 260, MIN = 280, groups = [];
    for (const [id, g] of geo) {
      const l = this.link(id);
      if (!l?.label) continue;
      const fit = groups.find((c) => c.label === l.label
        && Math.hypot(c.a.x - g.a.x, c.a.y - g.a.y) < NEAR && Math.hypot(c.b.x - g.b.x, c.b.y - g.b.y) < NEAR);
      if (fit) {
        fit.ids.push(id);
        const k = fit.ids.length;
        fit.a = { x: fit.a.x + (g.a.x - fit.a.x) / k, y: fit.a.y + (g.a.y - fit.a.y) / k };
        fit.b = { x: fit.b.x + (g.b.x - fit.b.x) / k, y: fit.b.y + (g.b.y - fit.b.y) / k };
      } else groups.push({ label: l.label, ids: [id], a: { ...g.a }, b: { ...g.b } });
    }
    const of = new Map(), labels = [];
    for (const c of groups) {
      if (c.ids.length < 2 || Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) < MIN) continue;
      const at = (t) => ({ x: c.a.x + (c.b.x - c.a.x) * t, y: c.a.y + (c.b.y - c.a.y) * t });
      let trunk = { t1: at(0.3), t2: at(0.7) };
      // A shared run that would cross a card moves sideways, as little as it can, until it is clear.
      const own = new Set(c.ids.flatMap((id) => [this.link(id).from, this.link(id).to]));
      const others = boxes.filter((r) => !own.has(r.id));
      const blocked = (t) => others.some((r) => crosses(t.t1, t.t2, r) || within(t.t1, r) || within(t.t2, r));
      if (blocked(trunk)) {
        const len = dist(trunk.t1, trunk.t2) || 1, nx = -(trunk.t2.y - trunk.t1.y) / len, ny = (trunk.t2.x - trunk.t1.x) / len;
        for (let k = 1; k <= 12; k++) {
          const tryAt = [k, -k].map((j) => ({ t1: { x: trunk.t1.x + nx * j * 36, y: trunk.t1.y + ny * j * 36 }, t2: { x: trunk.t2.x + nx * j * 36, y: trunk.t2.y + ny * j * 36 } }))
            .find((t) => !blocked(t));
          if (tryAt) { trunk = tryAt; break; }
        }
      }
      for (const id of c.ids) of.set(id, trunk);
      labels.push({ id: c.ids[0], label: c.label, count: c.ids.length, at: { x: (trunk.t1.x + trunk.t2.x) / 2, y: (trunk.t1.y + trunk.t2.y) / 2 } });
    }
    return { of, labels };
  }
  // Links that leave one card with the same label share one start point (a bundle). Returns the start of each
  // bundled link ({ x, y, side }) and one label per bundle, placed a little out from the start.
  bundleStarts() {
    const starts = new Map(), labels = [], byKey = new Map();
    for (const l of this.shownLinks()) {
      if (!l.label || l.fromSub) continue;
      const k = `${l.from}\u0000${l.label}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(l);
    }
    for (const all of byKey.values()) {
      const ra = this.rectOf(all[0].from);
      if (!ra) continue;
      // Leave by the side that faces the targets on average, at the point on it nearest their middle.
      const place = (list) => {
        const ends = list.map((l) => this.rectOf(l.to));
        const tx = ends.reduce((v, r) => v + r.x + r.w / 2, 0) / ends.length, ty = ends.reduce((v, r) => v + r.y + r.h / 2, 0) / ends.length;
        const dx = tx - (ra.x + ra.w / 2), dy = ty - (ra.y + ra.h / 2);
        const side = Math.abs(dx) / ra.w > Math.abs(dy) / ra.h ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
        return { side, at: this.slideTo(ra, side, { x: tx, y: ty }) };
      };
      let list = all.filter((l) => this.rectOf(l.to));
      if (list.length < 2) continue;
      let { side, at } = place(list);
      // A target behind that side would make its arrow hook back round the card: that arrow goes its own way.
      const ahead = list.filter((l) => {
        const r = this.rectOf(l.to);
        return (r.x + r.w / 2 - at.x) * SIDES[side][0] + (r.y + r.h / 2 - at.y) * SIDES[side][1] > 0;
      });
      if (ahead.length < list.length) {
        if (ahead.length < 2) continue;
        list = ahead;
        ({ side, at } = place(list));
      }
      for (const l of list) starts.set(l.id, { ...at, side });
      const [nx, ny] = SIDES[side];
      labels.push({ id: list[0].id, label: list[0].label, count: list.length, at: { x: at.x + nx * 34, y: at.y + ny * 22 }, ids: list.map((l) => l.id) });
    }
    return { starts, labels };
  }
  // The free space in front of a side of a card: the distance to the nearest other card there (400 at most).
  sideRoom(r, side, rects, id) {
    let room = 400;
    const up = side === 'n' || side === 's';
    for (const o of rects) {
      if (o.id === id) continue;
      if (up ? o.x >= r.x + r.w || o.x + o.w <= r.x : o.y >= r.y + r.h || o.y + o.h <= r.y) continue; // not in front of this side
      const gap = side === 'n' ? r.y - (o.y + o.h) : side === 's' ? o.y - (r.y + r.h) : side === 'w' ? r.x - (o.x + o.w) : o.x - (r.x + r.w);
      if (gap > -8) room = Math.min(room, Math.max(0, gap));
    }
    return room;
  }
  // Which side an arrow end uses is a balance of two things: how far apart the two cards are in that direction
  // (the gap between their edges, left to right or top to bottom), and how much free space is in front of the
  // side. A side with another card close in front counts for less (down to 0.35 of its value). So an arrow that
  // could use either of two sides takes the one with free space, and a card that is far to the left is entered
  // from the left. r: this end's card, o: the other card, to: the arrow's other end.
  // Returns { side, at } for a change of side, or null.
  roomySide(r, side, o, to, rects, id) {
    const dx = o.x + o.w / 2 - (r.x + r.w / 2), dy = o.y + o.h / 2 - (r.y + r.h / 2);
    const faces = {
      h: Math.max(0, dx > 0 ? o.x - (r.x + r.w) : r.x - (o.x + o.w)),
      v: Math.max(0, dy > 0 ? o.y - (r.y + r.h) : r.y - (o.y + o.h)),
    };
    const up = side === 'n' || side === 's';
    const alt = up ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
    const weight = (sd) => 0.35 + 0.65 * Math.min(this.sideRoom(r, sd, rects, id), 160) / 160;
    const now = (up ? faces.v : faces.h) * weight(side), other = (up ? faces.h : faces.v) * weight(alt);
    if (other <= now * 1.1) return null; // the same, or near enough: keep the side
    const [nx, ny] = SIDES[alt], p = this.anchor(r, alt);
    // The other end must be clearly on that side of the card, or the arrow would hook round the corner.
    if ((to.x - p.x) * nx + (to.y - p.y) * ny < 52) return null;
    return { side: alt, at: this.slideTo(r, alt, to) };
  }
  // The arrow ends on one side of a card are in the order of where their arrows go, and not on each other: the
  // arrow to the card that is further down leaves (or enters) further down. Without this, an arrow that goes
  // straight across near a corner and an arrow that goes on past that corner would cross each other at the card.
  // Ends that are fixed (at a highlighted word, or a shared start point) do not move.
  orderEnds(geo) {
    const GAP = 12, M = 14, sides = new Map();
    for (const g of geo.values()) {
      for (const [end, other, side, r, fixed] of [['a', 'b', g.sa, g.ra, g.fixedA], ['b', 'a', g.sb, g.rb, g.fixedB]]) {
        if (fixed) continue;
        const k = `${end === 'a' ? g.ida : g.idb}|${side}`;
        if (!sides.has(k)) sides.set(k, { r, across: side === 'e' || side === 'w', list: [] });
        sides.get(k).list.push({ g, end, other });
      }
    }
    for (const { r, across, list } of sides.values()) {
      if (list.length < 2) continue;
      const ax = across ? 'y' : 'x';
      const lo = (across ? r.y : r.x) + Math.min(M, (across ? r.h : r.w) / 2), hi = (across ? r.y + r.h : r.x + r.w) - Math.min(M, (across ? r.h : r.w) / 2);
      // In the order of the other ends. Two arrows to one place keep the order that they have.
      list.sort((p, q) => p.g[p.other][ax] - q.g[q.other][ax] || p.g[p.end][ax] - q.g[q.end][ax]);
      const was = list.map((it) => it.g[it.end][ax]), pos = [...was];
      const gap = Math.min(GAP, (hi - lo) / (list.length - 1));
      for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + gap);
      pos[pos.length - 1] = Math.min(pos[pos.length - 1], hi);
      for (let i = pos.length - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - gap);
      pos[0] = Math.max(pos[0], lo);
      for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + gap);
      list.forEach((it, i) => {
        const d = pos[i] - was[i];
        if (Math.abs(d) < 0.5) return;
        const g = it.g, straight = Math.abs(g[it.end][ax] - g[it.other][ax]) < 0.5;
        g[it.end] = { ...g[it.end], [ax]: pos[i] };
        // An arrow that went straight across stays straight where its other end can move with it.
        const fixedOther = it.other === 'a' ? g.fixedA : g.fixedB, ro = it.other === 'a' ? g.ra : g.rb, so = it.other === 'a' ? g.sa : g.sb;
        if (straight && !fixedOther && (so === 'e' || so === 'w') === across) {
          const l2 = (across ? ro.y : ro.x) + Math.min(M, (across ? ro.h : ro.w) / 2), h2 = (across ? ro.y + ro.h : ro.x + ro.w) - Math.min(M, (across ? ro.h : ro.w) / 2);
          if (pos[i] >= l2 && pos[i] <= h2) g[it.other] = { ...g[it.other], [ax]: pos[i] };
        }
      });
    }
  }
  // The point on a side of a card that is nearest to a point, but not near a corner: an arrow that comes from
  // beyond the corner needs room to turn in, and the space at a corner (between two cards) is often small.
  // The distance from the corner is 48 px, or about a third of a short side.
  slideTo(r, side, pt) {
    const p = this.anchor(r, side);
    if (side === 'e' || side === 'w') { const c = Math.min(r.h * 0.35, 48); return { x: p.x, y: clamp(pt.y, r.y + c, r.y + r.h - c) }; }
    const c = Math.min(r.w * 0.35, 48);
    return { x: clamp(pt.x, r.x + c, r.x + r.w - c), y: p.y };
  }
  // An arrow from a fixed start point to a card: it enters by the side that faces the start.
  pointEnds(a, rb, yb = null) {
    const dx = a.x - (rb.x + rb.w / 2), dy = a.y - (rb.y + rb.h / 2);
    const sb = yb != null ? (dx > 0 ? 'e' : 'w') : Math.abs(dx) / rb.w > Math.abs(dy) / rb.h ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
    const b = this.slideTo(rb, sb, a);
    if (yb != null) b.y = yb;
    return { a: { x: a.x, y: a.y }, sa: a.side, b, sb };
  }
  // Arrow ends slide along the sides that face each other. Where the two sides overlap, both ends meet the middle
  // of the overlap, so the arrow runs straight. Else each end goes as near the other card's centre as its side allows.
  slideEnds(ra, sa, rb, sb) {
    const M = 14; // keep ends this far from the corners
    const horiz = sa === 'e' || sa === 'w';
    const lo = (r) => (horiz ? r.y : r.x) + Math.min(M, (horiz ? r.h : r.w) / 2);
    const hi = (r) => (horiz ? r.y + r.h : r.x + r.w) - Math.min(M, (horiz ? r.h : r.w) / 2);
    const mid = (r) => (horiz ? r.y + r.h / 2 : r.x + r.w / 2);
    const from = Math.max(lo(ra), lo(rb)), to = Math.min(hi(ra), hi(rb));
    let pa, pb;
    if (to >= from) pa = pb = (from + to) / 2;
    else {
      // The two sides do not face each other: each end goes toward the other card, but not near the corner.
      const c = (r) => Math.min((horiz ? r.h : r.w) * 0.35, 48), s0 = (r) => (horiz ? r.y : r.x), s1 = (r) => (horiz ? r.y + r.h : r.x + r.w);
      pa = clamp(mid(rb), s0(ra) + c(ra), s1(ra) - c(ra));
      pb = clamp(mid(ra), s0(rb) + c(rb), s1(rb) - c(rb));
    }
    const at = (r, side, v) => {
      const p = this.anchor(r, side);
      return horiz ? { x: p.x, y: v } : { x: v, y: p.y };
    };
    return [at(ra, sa, pa), at(rb, sb, pb)];
  }
  arrowStyle() { return this.data?.style?.arrows || 'curved'; }
  setArrowStyle(style) {
    if (style === this.arrowStyle()) return;
    this.snapshot();
    this.data.style = { ...(this.data.style || {}), arrows: style };
    this.renderLinks();
    this.changed();
  }
  // Circuit trace: straight runs with 90° turns, leaving and entering each card square to its side.
  circuit(a, sa, b, sb) {
    const STUB = 18;
    const [nax, nay] = SIDES[sa], [nbx, nby] = SIDES[sb];
    const pa = { x: a.x + nax * STUB, y: a.y + nay * STUB }, pb = { x: b.x + nbx * STUB, y: b.y + nby * STUB };
    let pts;
    if (nax) {
      // Leaves sideways. Turn at the middle x, or detour through the middle y if the cards overlap in x.
      const forward = (pb.x - pa.x) * nax >= 0;
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      pts = forward ? [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
        : [a, pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb, b];
    } else {
      const forward = (pb.y - pa.y) * nay >= 0;
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      pts = forward ? [a, { x: a.x, y: my }, { x: b.x, y: my }, b]
        : [a, pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb, b];
    }
    // Drop points that do not turn.
    pts = pts.filter((p, i) => i === 0 || i === pts.length - 1
      || !((pts[i - 1].x === p.x && p.x === pts[i + 1].x) || (pts[i - 1].y === p.y && p.y === pts[i + 1].y)));
    // The label sits halfway along the trace.
    const seg = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    let half = seg.reduce((s, v) => s + v, 0) / 2, mid = pts[0];
    for (let i = 0; i < seg.length; i++) {
      if (half <= seg[i]) {
        const t = seg[i] ? half / seg[i] : 0;
        mid = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
        break;
      }
      half -= seg[i];
    }
    return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(''), mid, pad: a };
  }
  curve(a, na, b, nb) {
    const k = clamp(Math.hypot(b.x - a.x, b.y - a.y) * 0.4, 24, 160);
    const c1 = { x: a.x + na[0] * k, y: a.y + na[1] * k };
    const c2 = nb ? { x: b.x + nb[0] * k, y: b.y + nb[1] * k } : b;
    return {
      d: `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`,
      mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 },
    };
  }
  scheduleLinks() {
    if (this.linksQueued) return;
    this.linksQueued = true;
    requestAnimationFrame(() => { this.linksQueued = false; if (this.data) this.renderLinks(); });
  }
  renderLinks() {
    const groups = [], labels = [], colors = new Set([this.colors.link]);
    this.linkMid = new Map();
    const bundles = this.bundleStarts();
    // Ends of every arrow first, so arrows that run together can share a trunk.
    const geo = new Map();
    let rooms = null;
    for (const l of this.shownLinks()) {
      const ra = this.rectOf(l.from), rb = this.rectOf(l.to);
      if (!ra || !rb) continue;
      const ya = l.fromSub ? this.subY(l.from, l.fromSub) : null, yb = l.toSub ? this.subY(l.to, l.toSub) : null;
      const start = bundles.starts.get(l.id);
      const e = start ? this.pointEnds(start, rb, yb) : ya == null && yb == null ? this.cardEnds(ra, rb) : this.subEnds(ra, rb, ya, yb);
      const fixedA = !!start || ya != null, fixedB = yb != null;
      // The free space in front of each side counts in the choice of side (see roomySide).
      rooms ||= (this.rooms = this.data.cards.filter((c) => !this.offSet?.has(c.id)).map((c) => ({ id: c.id, ...this.rectOf(c.id) })).filter((r) => r.w));
      const nb = !fixedB && this.roomySide(rb, e.sb, ra, e.a, rooms, l.to);
      if (nb) { e.b = nb.at; e.sb = nb.side; }
      const na = !fixedA && this.roomySide(ra, e.sa, rb, e.b, rooms, l.from);
      if (na) { e.a = na.at; e.sa = na.side; }
      geo.set(l.id, { ...e, ra, rb, fixedA, fixedB, roomA: !!na, roomB: !!nb, ida: l.from, idb: l.to });
    }
    this.orderEnds(geo);
    // The cards an arrow should go around (all visible cards but its own two), a little larger than the cards.
    const boxes = this.data.cards.filter((c) => !this.els.get(c.id)?.classList.contains('iso-out') && !this.offSet?.has(c.id)).map((c) => {
      const r = this.rectOf(c.id), m = 6;
      return r && { id: c.id, x0: r.x - m, y0: r.y - m, x1: r.x + r.w + m, y1: r.y + r.h + m };
    }).filter(Boolean);
    const trunks = this.trunks(geo, boxes);
    if (this.arrowStyle() === 'circuit') this.circuitBuses(trunks, geo, boxes);
    const shared = []; // the labels of arrows that start at one point: they get their place after the arrows
    const own = []; // the labels of single arrows
    const slid = []; // the labels that the user can slide along an arrow: { t (the label), on (the id of that arrow) }
    const counted = (b) => this.shownLinks().filter((l) => l.from === this.link(b.id)?.from && l.label === b.label).every((l) => trunks.of.has(l.id));
    for (const b of [...trunks.labels, ...bundles.labels.filter((b) => !counted(b))]) {
      const t = el('div', 'link-label bundle');
      t.dataset.id = b.id;
      t.title = `${b.count} connections labelled “${b.label}”`;
      t.append(el('span', 'll-text'));
      t.firstChild.textContent = b.label;
      t.style.left = `${b.at.x}px`;
      t.style.top = `${b.at.y}px`;
      if (b.ids) shared.push({ t, ids: b.ids });
      else slid.push({ t, on: b.id }); // the label of a shared run: on the arrow that it stands for
      labels.push(t);
    }
    for (const l of this.data.links) {
      const g0 = geo.get(l.id);
      if (!g0) continue;
      const color = shown(this.linkColor(l));
      colors.add(color);
      const start = bundles.starts.get(l.id), trunk = trunks.of.get(l.id);
      const avoid = boxes.filter((r) => r.id !== l.from && r.id !== l.to);
      const { d, mid, pad, split } = this.pathFor(g0, trunk, avoid, boxes);
      this.linkMid.set(l.id, mid);
      const g = svgEl('g', { class: `link${pad ? ' circuit' : ''}`, 'data-id': l.id });
      // Direction: forward (from → to, the default), back (to → from), both, or none.
      const dir = l.dir || 'forward', marker = `url(#${markerId(color)})`;
      // Line style (pattern, texture) and width.
      const w = LINK_WIDTHS[l.width] || LINK_WIDTHS.normal, st = LINK_STYLES[linkStyle(l)];
      g.style.setProperty('--w', w);
      for (const [k, c, op, dash, cap] of st.under || []) {
        const u = svgEl('path', { d, class: 'under', 'stroke-width': w * k, 'stroke-opacity': op });
        u.style.stroke = c || color;
        if (dash) u.setAttribute('stroke-dasharray', dash(w));
        if (cap) u.style.strokeLinecap = cap;
        g.append(u);
      }
      const str = svgEl('path', { d, class: `str${st.main === false ? ' ghost' : ''}`, stroke: color });
      if (dir === 'forward' || dir === 'both') str.setAttribute('marker-end', marker);
      if (dir === 'back' || dir === 'both') str.setAttribute('marker-start', marker);
      if (st.dash) str.setAttribute('stroke-dasharray', st.dash(w));
      g.append(str, svgEl('path', { d, class: 'hit' }));
      if (pad) g.append(svgEl('circle', { cx: pad.x, cy: pad.y, r: 3.5, class: 'pad', fill: color }));
      groups.push(g);
      // A link in a bundle or a trunk shows its label once, on the shared part. Its note still shows on its own arrow.
      const label = start || trunk ? '' : l.label;
      if (label || l.note) {
        const t = el('div', `link-label${l.note ? ' has-note' : ''}${label ? '' : ' note-only'}`);
        t.dataset.id = l.id;
        t.append(el('span', 'll-text'));
        t.firstChild.textContent = label || '✎';
        if (l.note) {
          t.title = l.note;
          const n = el('div', 'lnote');
          n.textContent = l.note;
          t.append(n);
        }
        t.style.left = `${(split || mid).x}px`;
        t.style.top = `${(split || mid).y}px`;
        labels.push(t);
        if (label) own.push({ t, l, at: split || mid, g: g0 });
      }
    }
    // A label on a short arrow covers the arrow. Where another arrow from the same card shows the same label,
    // the short arrow goes without it (its note still shows). Else the label goes beside the arrow, not on it.
    const long = (o) => Math.hypot(o.g.b.x - o.g.a.x, o.g.b.y - o.g.a.y) >= o.l.label.length * 6.4 + 60;
    for (const o of own) {
      slid.push({ t: o.t, on: o.l.id });
      if (o.l.labelT != null || long(o)) continue; // a label that the user put somewhere along the arrow stays there
      const twin = own.some((p) => p !== o && p.l.from === o.l.from && p.l.label === o.l.label && long(p))
        || shared.some((p) => this.link(p.ids[0])?.from === o.l.from && this.link(p.ids[0])?.label === o.l.label);
      if (twin) {
        if (o.l.note) { o.t.firstChild.textContent = '✎'; o.t.classList.add('note-only'); }
        else labels.splice(labels.indexOf(o.t), 1);
        continue;
      }
      const dx = o.g.b.x - o.g.a.x, dy = o.g.b.y - o.g.a.y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; } // the side that is up (or left, for an arrow straight up or down)
      const off = Math.abs(nx) > 0.5 ? o.l.label.length * 3.2 + 16 : 16; // a label is wider than it is high
      o.t.style.left = `${o.at.x + nx * off}px`;
      o.t.style.top = `${o.at.y + ny * off}px`;
    }
    const defs = svgEl('defs');
    for (const c of colors) {
      const m = svgEl('marker', {
        id: markerId(c), viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11,
        markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
      });
      m.append(svgEl('path', { d: 'M0 1L10 5L0 9z', fill: c, style: `fill: ${c}; stroke: none` })); // inline: the CSS hides path fills
      defs.append(m);
    }
    this.svg.replaceChildren(defs, ...groups);
    // The label of arrows that start at one point goes on the longest of them, at its middle. At the start point
    // it would cover a short arrow to a card that is near.
    for (const { t, ids } of shared) {
      const len = (id) => { const g = geo.get(id); return g ? Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) : 0; };
      const longest = ids.reduce((p, q) => (len(q) > len(p) ? q : p)), mid = this.linkMid.get(longest);
      if (mid) { t.style.left = `${mid.x}px`; t.style.top = `${mid.y}px`; }
      slid.push({ t, on: longest });
    }
    this.labelsEl.replaceChildren(...labels);
    // A label that the user moved sits at that place along its arrow (link.labelT: 0 at the start, 1 at the end),
    // and to a side of it by part of the way to "just off the edge" (link.labelSide: -1 to 1). This comes after the labels are in
    // the page, because the distance to the side comes from the size of the label.
    for (const { t, on } of slid) {
      t.dataset.on = on;
      const l = this.link(t.dataset.id), path = l?.labelT != null && this.svg.querySelector(`g.link[data-id="${CSS.escape(on)}"] path`);
      if (l?.labelAt) delete l.labelAt; // the free place of the first version of this: not used any more
      if (!path || !t.isConnected) continue;
      const p = this.labelSpot(path, l.labelT, l.labelSide || 0, t);
      t.style.left = `${p.x}px`;
      t.style.top = `${p.y}px`;
    }
    if (this.tempLink) this.svg.append(this.tempLink);
    this.decorateLinks();
    this.placeLinkBar();
  }

  // ---------- connection bar: label, note, direction, dashes, delete ----------
  linkBarEl() {
    if (this.bar) return this.bar;
    const bar = el('div', 'link-bar');
    bar.hidden = true;
    const label = el('input', 'lb-label', { type: 'text', placeholder: 'Label (e.g. cites, defined by)', maxlength: '80' });
    const note = el('input', 'lb-note', { type: 'text', placeholder: 'Note on this connection…', maxlength: '600' });
    const dirs = el('div', 'lb-dirs');
    for (const [d, sym, tip] of [['forward', '→', 'Arrow from the first card to the second'], ['back', '←', 'Arrow the other way'],
      ['both', '↔', 'Arrows both ways'], ['none', '—', 'No arrowhead']]) {
      const b = el('button', 'lb-dir', { 'data-dir': d, title: tip });
      b.textContent = sym;
      dirs.append(b);
    }
    const del = el('button', 'lb-del', { title: 'Delete this connection (Del)' });
    del.textContent = '×';
    const row = el('div', 'lb-row');
    row.append(dirs, del);
    // Colour, line style and width.
    const colors = el('div', 'lb-colors');
    for (const c of PALETTES.link) {
      const b = el('button', 'lb-color', { 'data-color': c, title: 'Colour' });
      b.style.setProperty('--c', c);
      colors.append(b);
    }
    const styles = el('div', 'lb-styles');
    for (const [k, v] of Object.entries(LINK_STYLES)) {
      const b = el('button', 'lb-style', { 'data-style': k, title: v.label });
      const sv = svgEl('svg', { viewBox: '0 0 36 12', width: 26, height: 12 });
      for (const [kk, c, op, dash, cap] of v.under || []) {
        const u = svgEl('path', { d: 'M2 6H34', 'stroke-width': 1.6 * kk, 'stroke-opacity': op, fill: 'none' });
        u.style.stroke = c === 'var(--bg, #f6f6f4)' ? 'var(--panel, #fff)' : c || 'currentColor';
        if (dash) u.setAttribute('stroke-dasharray', dash(1.6));
        if (cap) u.style.strokeLinecap = cap;
        sv.append(u);
      }
      const ln = svgEl('path', { d: 'M2 6H34', stroke: 'currentColor', 'stroke-width': v.main === false ? 0 : 1.6, fill: 'none', 'stroke-linecap': 'round' });
      if (v.dash) ln.setAttribute('stroke-dasharray', v.dash(1.6));
      sv.append(ln);
      b.append(sv);
      styles.append(b);
    }
    const widths = el('div', 'lb-widths');
    for (const [k, w] of Object.entries(LINK_WIDTHS)) {
      const b = el('button', 'lb-width', { 'data-width': k, title: `${k[0].toUpperCase()}${k.slice(1)} line` });
      const sv = svgEl('svg', { viewBox: '0 0 20 12', width: 20, height: 12 });
      sv.append(svgEl('path', { d: 'M2 6H18', stroke: 'currentColor', 'stroke-width': w, 'stroke-linecap': 'round' }));
      b.append(sv);
      widths.append(b);
    }
    const row2 = el('div', 'lb-row lb-look');
    row2.append(colors);
    const row3 = el('div', 'lb-row lb-look');
    row3.append(styles, widths);
    bar.append(label, note, row, row2, row3);
    this.pane.append(bar);
    const current = () => (this.sel?.kind === 'link' ? this.link(this.sel.id) : null);
    let snapped = false;
    for (const [input, key] of [[label, 'label'], [note, 'note']]) {
      input.addEventListener('focus', () => { snapped = false; });
      input.addEventListener('input', () => {
        const l = current();
        if (!l) return;
        if (!snapped) { this.snapshot(); snapped = true; }
        l[key] = input.value.trim();
        this.renderLinks();
      });
      input.addEventListener('change', () => this.changed());
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); input.blur(); } });
    }
    dirs.addEventListener('click', (e) => {
      const d = e.target.closest('.lb-dir')?.dataset.dir, l = current();
      if (!d || !l) return;
      this.snapshot();
      l.dir = d;
      this.renderLinks();
      this.changed();
    });
    const setLook = (fn) => { const l = current(); if (!l) return; this.snapshot(); fn(l); this.renderLinks(); this.changed(); };
    colors.addEventListener('click', (e) => { const c = e.target.closest('.lb-color')?.dataset.color; if (c) setLook((l) => { l.color = c; l.ownColor = true; }); });
    styles.addEventListener('click', (e) => { const k = e.target.closest('.lb-style')?.dataset.style; if (k) setLook((l) => { l.style = k; delete l.dash; }); });
    widths.addEventListener('click', (e) => { const k = e.target.closest('.lb-width')?.dataset.width; if (k) setLook((l) => { l.width = k; }); });
    del.onclick = () => { const l = current(); if (l) this.deleteLink(l.id); };
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('dblclick', (e) => e.stopPropagation());
    bar.addEventListener('wheel', (e) => e.stopPropagation());
    return (this.bar = bar);
  }
  placeLinkBar() {
    const bar = this.linkBarEl();
    const l = this.sel?.kind === 'link' ? this.link(this.sel.id) : null;
    const mid = l && this.linkMid?.get(l.id);
    // The bar opens on purpose (right-click → Edit connection, Enter, or a double-click on the label), not on a click.
    if (!l || !mid || this.barLink !== l.id) { bar.hidden = true; this.barFor = null; this.barAt = null; return; }
    // Fill the fields only when another connection is chosen, so typing is never overwritten.
    if (this.barFor !== l.id) {
      bar.querySelector('.lb-label').value = l.label || '';
      bar.querySelector('.lb-note').value = l.note || '';
      this.barFor = l.id;
    }
    for (const b of bar.querySelectorAll('.lb-dir')) b.classList.toggle('on', (l.dir || 'forward') === b.dataset.dir);
    for (const b of bar.querySelectorAll('.lb-color')) b.classList.toggle('on', this.linkColor(l) === b.dataset.color);
    for (const b of bar.querySelectorAll('.lb-style')) b.classList.toggle('on', linkStyle(l) === b.dataset.style);
    for (const b of bar.querySelectorAll('.lb-width')) b.classList.toggle('on', (l.width || 'normal') === b.dataset.width);
    const { x, y, z } = this.data.view;
    bar.hidden = false;
    const p = this.barAt || mid;
    bar.style.left = `${p.x * z + x}px`;
    bar.style.top = `${p.y * z + y + (this.barAt ? 6 : 18)}px`;
  }
  openLinkBar(id) {
    const at = this.barAt;
    this.select({ kind: 'link', id });
    this.barLink = id;
    this.barAt = at; // where the right-click was, if it was one
    this.placeLinkBar();
  }
  focusLinkLabel() {
    if (this.sel?.kind === 'link' && this.barLink !== this.sel.id) { this.barLink = this.sel.id; this.barAt = null; }
    this.placeLinkBar();
    const input = this.bar?.querySelector('.lb-label');
    if (input && !this.bar.hidden) { input.focus(); input.select(); }
  }
  decorateLinks() {
    const dim = new Set(this.query ? this.data.cards.filter((c) => !this.matches(c)).map((c) => c.id) : []);
    for (const node of [...this.svg.querySelectorAll('.link'), ...this.labelsEl.children]) {
      const l = this.link(node.dataset.id);
      if (!l) continue;
      node.classList.toggle('selected', this.sel?.kind === 'link' && this.sel.id === l.id);
      node.classList.toggle('dim', dim.has(l.from) || dim.has(l.to));
      node.classList.toggle('iso-out', !!this.isoSet && !(this.isoSet.has(l.from) && this.isoSet.has(l.to)));
    }
  }

  // ---------- selection, search, colors ----------
  select(sel) {
    if (sel && sel.kind === 'card' && !this.card(sel.id)) sel = null;
    this.sel = sel;
    if (sel?.kind === 'card') this.lastCard = sel.id;
    this.updateSelection();
    this.onSelect?.(sel);
  }
  updateSelection() {
    if (this.sel && !(this.sel.kind === 'card' ? this.card(this.sel.id) : this.link(this.sel.id))) this.sel = null;
    for (const [id, e] of this.els) e.classList.toggle('selected', this.sel?.kind === 'card' && this.sel.id === id);
    this.decorateLinks();
    this.placeLinkBar();
  }
  matches(c) {
    const q = this.query;
    return !q || [c.text, c.snipText, c.snipNote, c.snipSection, c.source?.name].some((s) => s && s.toLowerCase().includes(q));
  }
  applySearch(q) {
    this.query = (q || '').trim().toLowerCase();
    return this.applyFilter();
  }
  // Search dims cards. Focus hides every card outside the chosen distance.
  applyFilter() {
    if (!this.data) return 0;
    if (this.iso && !this.card(this.iso.root)) { this.iso = null; this.onIso?.(null); }
    this.isoSet = this.iso ? this.reach(this.iso.root, this.iso.depth) : null;
    // Choices: the cards of the branches that are not shown go off the board.
    const br = (this.branch = this.branchState());
    this.offSet = br.off;
    const sig = `${[...br.off].sort().join(',')}|${[...br.ghost].sort().join(',')}`;
    if (this.sel?.kind === 'card' && br.off.has(this.sel.id)) this.sel = null;
    let n = 0;
    for (const c of this.data.cards) {
      const e = this.els.get(c.id);
      if (!e) continue;
      this.branchClasses(c, e);
      if (c.choice) this.renderChoiceBar(c, e);
      const hit = this.matches(c);
      if (hit) n++;
      e.classList.toggle('dim', !hit);
      const d = this.isoSet?.get(c.id);
      e.classList.toggle('iso-out', !!this.isoSet && d === undefined);
      e.classList.toggle('iso-root', !!this.isoSet && d === 0);
      if (d === undefined) delete e.dataset.depth; else e.dataset.depth = d;
    }
    // Another branch shows now: its arrows go on the board, and the arrows of the branch before go off it.
    if (sig !== this.branchSig) { this.branchSig = sig; this.renderLinks(); this.updateSelection(); }
    else this.decorateLinks();
    return n;
  }
  // ---------- choices: a split in the document ("try A, if that fails B…"), one branch at a time ----------
  // A choice card (c.choice) has options: the cards that its arrows point to. c.choice.pick is the option whose
  // branch shows (null: all of them). The branch of an option is every card that the arrows lead to from it.
  // The cards of the other branches go off the board, so two branches can use the same space. These stay:
  // the option cards, the cards before the choice, and a card that another shown card leads to as well.
  // The look of a card for the choices: off the board, see-through (the All view), an option, an option not shown.
  branchClasses(c, e) {
    const br = this.branch;
    if (!br) return;
    const o = br.opts.get(c.id);
    e.classList.toggle('br-off', br.off.has(c.id));
    e.classList.toggle('br-ghost', br.ghost.has(c.id));
    e.classList.toggle('br-opt', !!o);
    e.classList.toggle('br-opt-off', !!o && !o.picked && !o.all);
  }
  // Show the branch that a card is in (for "Find on board" and other jumps to a card that is off the board).
  reveal(id) {
    for (let i = 0; i < 8 && this.offSet?.has(id); i++) {
      const out = new Map();
      for (const l of this.data.links) { if (!out.has(l.from)) out.set(l.from, []); out.get(l.from).push(l.to); }
      const reaches = (from) => { const seen = new Set([from]); let f = [from]; while (f.length) { const n = []; for (const x of f) for (const t of out.get(x) || []) if (!seen.has(t)) { seen.add(t); n.push(t); } f = n; } return seen.has(id); };
      const hit = this.data.cards.filter((x) => x.choice?.pick && !this.offSet.has(x.id)).flatMap((x) => this.optionsOf(x).filter((o) => o !== x.choice.pick).map((o) => [x, o])).find(([, o]) => reaches(o));
      if (!hit) break;
      this.setChoice(hit[0], hit[1]);
    }
  }
  optionsOf(x) {
    const seen = new Set();
    return this.data.links.filter((l) => l.from === x.id && l.to !== x.id && this.card(l.to) && !seen.has(l.to) && seen.add(l.to)).map((l) => l.to);
  }
  branchState() {
    const off = new Set(), ghost = new Set(), opts = new Map();
    const choices = this.data.cards.filter((c) => c.choice);
    if (!choices.length) return { off, ghost, opts };
    const links = this.data.links, back = this.backLinks(choices);
    // The colour that the user gave an arrow (not a colour that it takes from a highlighted word).
    const own = (l) => (l.ownColor && l.color ? String(l.color).toLowerCase() : '');
    const out = new Map(), into = new Map();
    for (const l of links) {
      if (back.has(l)) continue;
      if (!out.has(l.from)) out.set(l.from, []);
      out.get(l.from).push([l.to, own(l)]);
      if (!into.has(l.to)) into.set(l.to, []);
      into.get(l.to).push(l.from);
    }
    const before = (start, stop) => { // every card that leads to start
      const seen = new Set();
      let front = [start];
      while (front.length) {
        const next = [];
        for (const id of front) for (const t of into.get(id) || []) if (!seen.has(t) && !stop.has(t)) { seen.add(t); next.push(t); }
        front = next;
      }
      return seen;
    };
    // The path of an option has a colour: the colour of the last arrow on it that the user gave a colour ('' for
    // none). Where two paths come to one card and go different ways after it, the colours tell them apart: a
    // path does not follow an arrow that has the colour of another path at that card. So the user gives the
    // arrow that brings path A to the shared card, and the arrow that continues path A after it, one colour, and
    // does the same for path B with another colour. Arrows with no colour, or with a colour that no other path
    // has at that card, are part of every path that comes to them.
    // starts: [[card, colour]]. claims(card): the colours of the other paths there. Returns card -> its colours.
    const follow = (starts, stop, claims) => {
      const at = new Map(), seen = new Set(starts.map(([id, c]) => `${id}|${c}`));
      let front = starts;
      while (front.length) {
        const next = [];
        for (const [id, c] of front) {
          const taken = claims(id);
          for (const [t, d] of out.get(id) || []) {
            if (stop?.has(t) || (d && d !== c && taken.has(d))) continue;
            const c2 = d || c, k = `${t}|${c2}`;
            if (!at.has(t)) at.set(t, new Set());
            at.get(t).add(c2);
            if (!seen.has(k)) { seen.add(k); next.push([t, c2]); }
          }
        }
        front = next;
      }
      return at;
    };
    const none = new Set(), blocked = new Set(), keep = new Set();
    const hidden = [], shown = []; // the paths of the options that do not show, and of the ones that show
    for (const x of choices) {
      const options = this.optionsOf(x);
      if (x.choice.pick && !options.includes(x.choice.pick)) x.choice.pick = null; // that option is gone
      const stop = new Set([x.id, ...options]);
      // An option starts with the colour of its arrow from the choice card, if the user gave that arrow one.
      const first = new Map(options.map((o) => [o, links.filter((l) => l.from === x.id && l.to === o).map(own).find(Boolean) || '']));
      // The paths, with no card held back at first. Then again, with what the other paths have at each card.
      let paths = new Map(options.map((o) => [o, follow([[o, first.get(o)]], stop, () => none)]));
      for (let round = 0; round < 3; round++) {
        const prev = paths;
        paths = new Map(options.map((o) => [o, follow([[o, first.get(o)]], stop, (id) => {
          const taken = new Set();
          for (const p of options) if (p !== o) for (const c of prev.get(p).get(id) || []) if (c) taken.add(c);
          return taken;
        })]));
      }
      // These stay for this choice: the choice card, the cards before it, and its option cards. (A choice
      // inside a branch of another choice goes off the board with that branch.)
      const stay = new Set([x.id, ...options, ...before(x.id, new Set(options))]);
      for (const id of stay) keep.add(id);
      for (const o of options) {
        opts.set(o, { choice: x.id, picked: x.choice.pick === o, all: !x.choice.pick, colour: first.get(o) || null });
        const branch = [...paths.get(o).keys()].filter((id) => !stay.has(id));
        if (!x.choice.pick) for (const id of branch) ghost.add(id);
        else if (o !== x.choice.pick) { blocked.add(o); hidden.push(paths.get(o)); for (const id of branch) off.add(id); }
        else shown.push([o, paths.get(o)]);
      }
    }
    // A card that another shown card leads to shows as well: not through an option that is not shown, and not
    // along an arrow that has the colour of a path that does not show (and of no path that shows) at that card.
    const starts = this.data.cards.map((c) => c.id).filter((id) => !off.has(id) && !blocked.has(id)).map((id) => [id, '']);
    const rest = follow(starts, blocked, (id) => {
      const taken = new Set();
      for (const p of hidden) for (const c of p.get(id) || []) if (c) taken.add(c);
      for (const [, p] of shown) for (const c of p.get(id) || []) taken.delete(c);
      return taken;
    });
    for (const id of rest.keys()) off.delete(id);
    for (const id of off) ghost.delete(id);
    return { off, ghost, opts };
  }
  // An arrow from a card in a branch back to a card before the choice ("see clause 5") makes a loop: the cards
  // before the choice would then be in the branch, and the branch would be before the choice. Such an arrow does
  // not count for the branches. Which arrow of a loop goes back: the one that comes to a card at or above the
  // level of the choice (the level is the distance from the cards that no arrow comes to). Where there is no such
  // start card, it is the arrow of the loop that was made last.
  backLinks(choices) {
    const links = this.data.links, back = new Set();
    const order = new Map(links.map((l, i) => [l, i])), outL = new Map(), hasIn = new Set();
    for (const l of links) {
      if (!outL.has(l.from)) outL.set(l.from, []);
      outL.get(l.from).push(l);
      hasIn.add(l.to);
    }
    const depth = new Map();
    let level = this.data.cards.map((c) => c.id).filter((id) => !hasIn.has(id));
    for (const id of level) depth.set(id, 0);
    for (let d = 1; level.length; d++) {
      const next = [];
      for (const id of level) for (const l of outL.get(id) || []) if (!depth.has(l.to)) { depth.set(l.to, d); next.push(l.to); }
      level = next;
    }
    for (const x of choices) {
      const options = new Set(this.optionsOf(x));
      for (let n = 0; n < 30; n++) {
        // A way from an option back to the choice card.
        const prev = new Map(), seen = new Set(options);
        let front = [...options], last = null;
        while (front.length && !last) {
          const next = [];
          for (const id of front) {
            for (const l of outL.get(id) || []) {
              if (back.has(l)) continue;
              if (l.to === x.id) { last = l; break; }
              if (!seen.has(l.to)) { seen.add(l.to); prev.set(l.to, l); next.push(l.to); }
            }
            if (last) break;
          }
          front = next;
        }
        if (!last) break;
        const path = [];
        for (let at = last.from; prev.has(at); at = prev.get(at).from) path.unshift(prev.get(at));
        if (!path.length) break; // an option points straight at the choice card: the walks stop there
        const dx = depth.get(x.id);
        const cut = (dx != null && path.find((l) => depth.has(l.to) && depth.get(l.to) <= dx)) || path.reduce((a, b) => (order.get(b) > order.get(a) ? b : a));
        back.add(cut);
      }
    }
    return back;
  }
  // The first line of a card, for the buttons of a choice.
  cardTitle(c) {
    const t = (c.text || c.snipText || c.source?.name || 'Card').replace(/^[\u2003\s#>*-]+/, '').split('\n')[0].replace(/\*\*|`/g, '').trim() || 'Card';
    return t.length > 26 ? `${t.slice(0, 25)}…` : t;
  }
  // The row of buttons on a choice card: one for each option, and All.
  renderChoiceBar(c, e) {
    let bar = e.querySelector(':scope > .choice-bar');
    if (!bar) { bar = el('div', 'choice-bar'); e.insertBefore(bar, e.querySelector(':scope > .card-ink')); }
    const options = this.optionsOf(c);
    const chip = (label, pick, tip) => {
      const b = el('button', `choice-chip${(c.choice.pick || null) === pick ? ' on' : ''}`, { title: tip });
      b.textContent = label;
      b.onclick = (ev) => { ev.stopPropagation(); this.setChoice(c, pick); };
      return b;
    };
    bar.replaceChildren(el('span', 'choice-mark'),
      ...options.map((id) => {
        const b = chip(this.cardTitle(this.card(id)), id, 'Show only the cards that follow from this option');
        // The colour of the option (of its arrow from this card): arrows with it are part of this option only.
        const col = this.branch?.opts.get(id)?.colour;
        if (col) { const dot = el('span', 'choice-dot'); dot.style.background = col; b.prepend(dot); }
        return b;
      }),
      chip('All', null, 'Show the cards of every option (see-through, so you can see where they are)'));
    bar.firstChild.textContent = options.length ? '⑂' : '⑂ Draw arrows from this card to its options';
  }
  setChoice(c, pick) {
    if (!c.choice || (c.choice.pick || null) === (pick || null)) return;
    this.snapshot();
    c.choice = { pick: pick || null };
    this.applyFilter();
    this.changed();
    this.gravity.wake();
  }
  toggleChoice(c) {
    this.snapshot();
    if (c.choice) delete c.choice; else c.choice = { pick: null };
    this.refreshCard(c);
    this.applyFilter();
    this.renderLinks();
    this.changed();
  }
  // A click on an option card of a choice shows its branch.
  pickOption(c) {
    const o = this.branch?.opts.get(c.id);
    if (o && !o.picked) this.setChoice(this.card(o.choice), c.id);
  }
  setTool(t) {
    this.tool = t;
    this.pane.dataset.tool = t;
    this.onTool?.(t);
  }
  paletteContext() {
    if (this.tool === 'pen') return this.tool;
    // A connection's colour is picked in its right-click menu (or its bar), not in the side bar.
    const c = this.sel?.kind === 'card' && this.card(this.sel.id);
    return c?.type === 'note' ? 'note' : null;
  }
  currentColor(ctx) {
    if (ctx === 'link' && this.sel?.kind === 'link') return this.link(this.sel.id)?.color || PALETTES.link[0];
    if (ctx === 'note' && this.sel?.kind === 'card') return this.card(this.sel.id)?.color || PALETTES.note[0];
    return this.colors[ctx];
  }
  // A connection's colour: the one picked for it, else the colour of the marked word it starts (or ends) at,
  // so a word and its arrows match. Else the default.
  linkColor(l) {
    if (l.ownColor && l.color) return l.color;
    const word = (cardId, subId) => subId && (this.card(cardId)?.snipSubs?.find((x) => x.id === subId)?.color || this.boardMark(this.card(cardId) || {}, subId)?.color);
    return word(l.from, l.fromSub) || word(l.to, l.toSub) || l.color || PALETTES.link[0];
  }
  setColor(ctx, color) {
    this.colors[ctx] = color;
    const target = this.sel?.kind === 'link' ? this.link(this.sel.id) : this.sel && this.card(this.sel.id);
    if ((ctx === 'link' || ctx === 'note') && target) {
      this.snapshot();
      target.color = color;
      if (ctx === 'link') { target.ownColor = true; this.renderLinks(); }
      else this.els.get(target.id).style.setProperty('--accent', color);
      this.changed();
    }
  }
  // Snippets changed in the reader: copy colour, text and note onto their cards.
  syncSnippets(snippets) {
    this.snippets = snippets;
    if (!this.data) return;
    const newLinks = []; // [card id, link] for links that are new on a card, to draw as arrows
    const byKey = new Map(snippets.map((h) => [`${h.pdfId}:${h.id}`, h]));
    let hit = false;
    // Repair: a card whose snippet id no longer exists gets the snippet with the same PDF, page and
    // text, when exactly one matches. (Rebuilt snippets get new ids.)
    const byText = new Map();
    for (const h of snippets) {
      const k = `${h.pdfId}|${h.page}|${h.text}`;
      byText.set(k, byText.has(k) ? null : h);
    }
    for (const c of this.data.cards) {
      if (!c.source?.hl || byKey.has(`${c.source.pdfId}:${c.source.hl}`) || !snippets.some((h) => h.pdfId === c.source.pdfId)) continue;
      const h = byText.get(`${c.source.pdfId}|${c.source.page}|${c.snipText}`);
      if (h) { c.source.hl = h.id; c.source.rects = h.rects; hit = true; }
    }
    for (const c of this.data.cards) {
      const h = c.source?.hl && byKey.get(`${c.source.pdfId}:${c.source.hl}`);
      if (!h) continue;
      const next = { color: h.color, snipText: h.text || '', snipNote: h.note || '', snipSection: sectionLabel(h), snipRef: h.ref ? 'ref' : '', snipFoot: footText(h) };
      const links = cardLinks(h), subs = this.subsOf(h);
      const sameName = !h.pdfName || c.source.name === h.pdfName;
      const sameLinks = JSON.stringify(c.snipLinks || []) === JSON.stringify(links);
      const sameSubs = JSON.stringify(c.snipSubs || []) === JSON.stringify(subs);
      const samePic = (c.image || '') === (h.image || '');
      if (sameName && sameLinks && sameSubs && samePic && Object.keys(next).every((k) => (c[k] || '') === next[k])) continue;
      // Links that are new on this card (all links of its inner snippets, the first time it has them).
      const key = (l) => `${l.sub || ''}>${l.toPdfId}:${l.to}`;
      const before = new Set(allLinks(c).map(key));
      const hadSubs = !!c.snipSubs;
      // Arrows that started or ended at a marked word that is gone: they go too.
      if (hadSubs) {
        const ids = new Set([...subs.map((x) => x.id), ...(c.marks || []).map((m) => m.id)]);
        this.data.links = this.data.links.filter((l) => !((l.from === c.id && l.fromSub && !ids.has(l.fromSub)) || (l.to === c.id && l.toSub && !ids.has(l.toSub))));
      }
      Object.assign(c, next, { snipLinks: links, snipSubs: subs });
      for (const l of allLinks(c)) if (l.to && !before.has(key(l)) && (l.sub ? true : hadSubs)) newLinks.push([c.id, l]);
      // A new or changed picture: take it, with a card width that suits it. Old marks no longer fit, so they go.
      if (h.image && (c.image !== h.image)) {
        if (c.image) { c.strokes = []; c.marks = (c.marks || []).filter((m) => !m.box); }
        Object.assign(c, { image: h.image, imgW: h.imgW, imgH: h.imgH, w: Math.round((h.w || 300) + 24) });
      } else if (!h.image && c.type === 'quote') {
        for (const k of ['image', 'imgW', 'imgH', 'strokes']) delete c[k];
      }
      if (h.pdfName) c.source.name = h.pdfName;
      const old = this.els.get(c.id);
      this.ro.unobserve(old);
      old.replaceWith(this.mountCard(c));
      old.remove();
      hit = true;
    }
    // Draw the new links as arrows, when their targets are on this board.
    for (const [id, l] of newLinks) {
      const t = this.cardAt(l.toPdfId, l.to);
      if (t && t.card !== id) this.connectCards(id, t.card, l.label, { fromSub: l.sub, toSub: t.sub });
    }
    if (hit) {
      this.updateSelection();
      this.applySearch(this.query);
      this.scheduleLinks();
      this.changed('sync');
    }
  }

  // ---------- adding & removing ----------
  spot(w, at) {
    const p = at || this.viewCenter();
    const k = at ? 0 : 1;
    return { x: Math.round(p.x - w / 2 + jitter(90) * k), y: Math.round(p.y - 40 + jitter(70) * k) };
  }
  addCard(c) {
    this.snapshot();
    c.z = this.maxZ() + 1;
    this.data.cards.push(c);
    const e = this.mountCard(c);
    this.updateHint();
    this.applySearch(this.query);
    this.select({ kind: 'card', id: c.id });
    this.flash(e);
    this.changed('structure');
    this.gravity.wake();
    return e;
  }
  // A second, separate card with the same content (the same snippet, picture, highlights and notes), for a card
  // that has a place in two paths. The copy has no arrows: the user draws the arrows of its own path. The two
  // cards stay copies of one snippet: a change of the snippet in the reader shows on both.
  duplicateCard(c) {
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid();
    copy.x = c.x + 36;
    copy.y = c.y + 36;
    delete copy.choice;
    const e = this.addCard(copy);
    for (const o of this.copiesOf(copy)) if (o.id !== copy.id) this.refreshCard(o); // their "copies" mark
    this.renderLinks();
    return e;
  }
  // The cards of the same snippet on this board (a card and its copies).
  copiesOf(c) {
    return c.source?.hl ? this.data.cards.filter((o) => o.source?.hl === c.source.hl && o.source.pdfId === c.source.pdfId) : [c];
  }
  // A PDF highlight becomes a card that remembers where it came from.
  addHighlight(meta, h, at) {
    const source = { pdfId: meta.id, name: meta.name, page: h.page, rects: h.rects, hl: h.id };
    const common = {
      id: uid(), color: h.color, snipText: h.text || '', snipNote: h.note || '', snipSection: sectionLabel(h), snipLinks: cardLinks(h), snipRef: h.ref ? 'ref' : '', snipFoot: footText(h),
      snipSubs: this.subsOf({ ...h, pdfId: meta.id }), text: '', source,
    };
    if (h.kind === 'area') {
      const w = (h.w || 300) + 24;
      return this.addCard({ ...common, type: 'snippet', ...this.spot(w, at), w, image: h.image, imgW: h.imgW, imgH: h.imgH, strokes: [] });
    }
    const pic = h.image ? { image: h.image, imgW: h.imgW, imgH: h.imgH, strokes: [] } : {};
    const w = h.image ? (h.w || 300) + 24 : clamp(Math.sqrt((h.text || '').length) * 22, 220, 380);
    return this.addCard({ ...common, ...pic, type: 'quote', ...this.spot(w, at), w });
  }
  addImage({ image, imgW, imgH, at }) {
    const w = clamp(imgW / 2, 160, 380) + 24;
    return this.addCard({ id: uid(), type: 'image', ...this.spot(w, at), w, image, imgW, imgH, text: '', strokes: [] });
  }
  addNote(at) {
    const e = this.addCard({ id: uid(), type: 'note', ...this.spot(220, at), w: 220, text: '' });
    this.startEdit(e.querySelector('.text'), this.card(e.dataset.id), true);
  }
  deleteCard(id) {
    this.snapshot();
    const gone = this.card(id), others = gone ? this.copiesOf(gone).filter((o) => o.id !== id) : [];
    this.data.cards = this.data.cards.filter((c) => c.id !== id);
    this.data.links = this.data.links.filter((l) => l.from !== id && l.to !== id);
    this.els.get(id)?.remove();
    this.els.delete(id);
    for (const o of others) this.refreshCard(o); // their "copies" mark
    this.select(null);
    this.renderLinks();
    this.applyFilter();
    this.updateHint();
    this.changed('structure');
    this.gravity.wake();
  }
  // Join two cards with an arrow, unless they are already joined. Used for snippet links and layers.
  // fromSub, toSub: the inner snippets (marked words) the arrow starts or ends at.
  connectCards(fromId, toId, label = '', { fromSub = null, toSub = null } = {}) {
    if (fromId === toId || !this.card(fromId) || !this.card(toId)) return false;
    const same = (l, f, fs, t, ts) => l.from === f && l.to === t && (l.fromSub || null) === fs && (l.toSub || null) === ts;
    if (this.data.links.some((l) => same(l, fromId, fromSub, toId, toSub) || same(l, toId, toSub, fromId, fromSub))) return false;
    const link = { id: uid(), from: fromId, to: toId, color: this.colors.link, label };
    if (fromSub) link.fromSub = fromSub;
    if (toSub) link.toSub = toSub;
    this.data.links.push(link);
    this.renderLinks();
    this.applyFilter();
    this.changed();
    this.gravity.wake();
    return true;
  }
  // Wait for a click on a marked word or a card, then call cb(card, subId). Esc or a click on the board cancels.
  pickTarget(cb) {
    this.pickCb = cb;
    this.pane.classList.add('picking');
  }
  endPick() {
    this.pickCb = null;
    this.pane.classList.remove('picking');
  }
  // After a Mark-tool selection in a card's text: the selected range of the card's snippet text.
  onMarkerUp(e) {
    if (this.tool !== 'mark' || this.pickCb) return;
    const bx = e.target.closest?.('mark.box'), bc = bx && this.card(bx.closest('.card')?.dataset.id);
    if (bc) return this.onMarkClick?.(bc, bx.dataset.sub, bx.getBoundingClientRect());
    const sel = getSelection(), q = e.target.closest?.('.card .quote');
    const cardEl = q?.closest('.card'), c = cardEl && this.card(cardEl.dataset.id);
    if (!c || c.image) return;
    const at = (node, off) => {
      const line = (node.nodeType === 1 ? node : node.parentElement)?.closest('.sl');
      if (!line || !q.contains(line)) return null;
      const r = document.createRange();
      r.setStart(line, 0);
      r.setEnd(node, off);
      return +line.dataset.off + r.toString().length;
    };
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      const m = e.target.closest('mark.sub');
      if (m) this.onMarkClick?.(c, m.dataset.sub, m.getBoundingClientRect());
      return;
    }
    const range = sel.getRangeAt(0);
    let start = at(range.startContainer, range.startOffset), end = at(range.endContainer, range.endOffset);
    if (start == null || end == null) return;
    const text = c.snipText || '';
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) this.onMarkText?.(c, start, end, range.getBoundingClientRect());
  }

  // The card that shows a snippet: its own card, else a card that has it as an inner snippet ({ card, sub }).
  cardAt(pdfId, hlId) {
    const own = this.data.cards.find((c) => c.source?.pdfId === pdfId && c.source.hl === hlId);
    if (own) return { card: own.id, sub: null };
    const host = this.data.cards.find((c) => c.source?.pdfId === pdfId && c.snipSubs?.some((x) => x.id === hlId));
    return host ? { card: host.id, sub: hlId } : null;
  }
  // The text snippets inside a text snippet, with where their words are in its text.
  subsOf(h) {
    if (h.kind !== 'text' || h.image || !h.text || !this.snippets) return [];
    const inner = this.snippets.filter((x) => x.pdfId === h.pdfId && x.id !== h.id && x.kind === 'text' && x.text && inside(x, h));
    const places = locateSubs(h, inner);
    return inner
      .map((x, i) => {
        const at = places[i];
        // into: how many snippets of this project link to the word.
        const into = this.snippets.filter((y) => (y.links || []).some((l) => l.to === x.id && (l.toPdfId || l.pdfId || y.pdfId) === h.pdfId)).length;
        return at && { id: x.id, start: at.start, end: at.end, color: x.color, text: x.text, links: cardLinks(x), ...(into ? { into } : {}), ...(x.ref ? { ref: true } : {}) };
      })
      .filter(Boolean);
  }
  // A click on a marked word: show what its links point to and what links into it. With none, go along its arrow.
  followSub(cardId, subId, rect) {
    const c = this.card(cardId), links = allLinks(c).filter((x) => x.sub === subId);
    if (this.onSubPopup) return this.onSubPopup(c, subId, links, rect);
    this.travelSub(cardId, subId);
  }
  travelSub(cardId, subId) {
    const l = this.data.links.find((x) => (x.from === cardId && x.fromSub === subId) || (x.to === cardId && x.toSub === subId));
    if (l) { this.lastCard = cardId; this.travel(l.id); }
  }
  // Light up the arrows of a marked word and the marked word at their other end.
  hotSub(cardId, subId) {
    for (const n of this.world.querySelectorAll('.hot')) n.classList.remove('hot');
    if (!subId) return;
    for (const l of this.data.links) {
      let other = null;
      if (l.from === cardId && l.fromSub === subId) other = [l.to, l.toSub];
      else if (l.to === cardId && l.toSub === subId) other = [l.from, l.fromSub];
      if (!other) continue;
      this.svg.querySelector(`.link[data-id="${l.id}"]`)?.classList.add('hot');
      if (other[1]) this.els.get(other[0])?.querySelector(`mark.sub[data-sub="${CSS.escape(other[1])}"]`)?.classList.add('hot');
      else this.els.get(other[0])?.classList.add('hot');
    }
  }

  deleteLink(id) {
    this.snapshot();
    this.data.links = this.data.links.filter((l) => l.id !== id);
    this.select(null);
    this.renderLinks();
    this.applyFilter();
    this.changed();
    this.gravity.wake();
  }
  async editLabel(id) {
    const l = this.link(id);
    if (!l) return;
    const label = await this.ask('Label for this connection (leave it empty to remove the label)', l.label || '', { okLabel: 'Save', allowEmpty: true });
    if (label === null || label === l.label || !this.link(id)) return;
    this.snapshot();
    l.label = label.trim();
    this.renderLinks();
    this.changed();
  }

  // ---------- text editing ----------
  startEdit(textEl, c, fresh = false) {
    if (c.type === 'note') return this.startNoteEdit(textEl, c, fresh);
    if (textEl.isContentEditable) return;
    const before = this.snapshotData(), old = c.text || '';
    const cardEl = this.els.get(c.id);
    try { textEl.contentEditable = 'plaintext-only'; } catch { textEl.contentEditable = 'true'; }
    cardEl.classList.add('editing');
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const onInput = () => { c.text = textEl.innerText.replace(/\n$/, ''); };
    textEl.addEventListener('input', onInput);
    textEl.addEventListener('blur', () => {
      textEl.removeEventListener('input', onInput);
      textEl.contentEditable = 'false';
      cardEl.classList.remove('editing');
      if (c.text !== old) {
        this.history.push(before);
        this.future = [];
        this.changed();
      }
      this.applySearch(this.query);
    }, { once: true });
  }
  // A note card: the document editor (docedit). You see the format while you type. The card keeps the document
  // (c.doc), and a plain-text copy (c.text) for search and titles.
  startNoteEdit(textEl, c, fresh = false) {
    const cardEl = this.els.get(c.id);
    if (cardEl.classList.contains('editing')) return;
    const before = this.snapshotData(), size0 = c.size;
    const start = c.doc || fromMarkdown(c.text || ''), was = JSON.stringify(start);
    textEl.classList.remove('de-doc');
    textEl.replaceChildren();
    cardEl.classList.add('editing');
    let ed = null, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const doc = ed.getDoc(), changed = JSON.stringify(doc) !== was;
      ed.destroy();
      this.noteEditing = null;
      cardEl.classList.remove('editing');
      if (changed) {
        if (isEmptyDoc(doc)) { delete c.doc; c.text = ''; }
        else { c.doc = doc; c.text = docToText(doc); }
      }
      textEl.replaceChildren();
      drawNote(textEl, c);
      this.onDecorate?.(cardEl, c);
      if (fresh) {
        // A brand-new note: its creation snapshot already covers the text. It stays, even with no text.
        this.changed('structure');
      } else if (changed || c.size !== size0) {
        this.history.push(before);
        this.future = [];
        this.changed();
      }
      this.applySearch(this.query);
    };
    const size = {
      id: 'size', label: 'Aa', title: 'Text size: small, medium, large',
      run: () => {
        c.size = { s: 'm', m: 'l', l: 's' }[c.size || 'm'];
        textEl.classList.remove('size-s', 'size-m', 'size-l');
        textEl.classList.add(`size-${c.size}`);
        this.placeNoteBar();
      },
    };
    ed = createEditor(textEl, { doc: start, placeholder: 'Write a note…', onBlur: finish, buttons: [size] });
    ed.toolbar.classList.add('note-tools');
    this.pane.append(ed.toolbar);
    this.noteEditing = { c, textEl, bar: ed.toolbar };
    this.placeNoteBar();
    ed.focus('end');
  }

  // Tick or untick a task line of a note.
  toggleTask(c, i) {
    if (c.doc) {
      this.snapshot();
      c.doc = toggleTask(c.doc, i);
    } else {
      const lines = (c.text || '').split('\n');
      if (lines[i] == null) return;
      this.snapshot();
      lines[i] = lines[i].replace(/\[( |x|X)\]/, (m, v) => (v === ' ' ? '[x]' : '[ ]'));
      c.text = lines.join('\n');
    }
    drawNote(this.els.get(c.id).querySelector('.note-text'), c);
    this.onDecorate?.(this.els.get(c.id), c);
    this.changed();
  }
  // ---------- highlights made on the board (they stay on the card, not in the PDF) ----------
  // The card's own highlights, placed in its text. A highlight whose words moved (the text changed) is found again.
  boardMarks(c) {
    const T = c.snipText || '';
    return (c.marks || []).filter((m) => !m.box).map((m) => {
      let { start, end } = m;
      if (m.text && T.slice(start, end) !== m.text) {
        let best = -1;
        for (let i = T.indexOf(m.text); i >= 0; i = T.indexOf(m.text, i + 1)) if (best < 0 || Math.abs(i - start) < Math.abs(best - start)) best = i;
        if (best < 0) return null;
        start = best; end = best + m.text.length;
      }
      const linked = this.data.links.some((l) => (l.from === c.id && l.fromSub === m.id) || (l.to === c.id && l.toSub === m.id));
      return { id: m.id, start, end, color: m.color, linked, title: `${m.text}\nHighlighted on the board` };
    }).filter(Boolean);
  }
  boardMark(c, id) { return (c.marks || []).find((m) => m.id === id) || null; }
  addBoardMark(c, start, end, color) {
    this.snapshot();
    const m = { id: uid(), start, end, text: (c.snipText || '').slice(start, end), color };
    c.marks = [...(c.marks || []), m];
    this.refreshCard(c);
    this.changed();
    return m;
  }
  // A highlight over part of a picture. box: [x0, y0, x1, y1] in fractions of the picture.
  addBoardBox(c, box, color) {
    this.snapshot();
    const m = { id: uid(), box, color, text: '' };
    c.marks = [...(c.marks || []), m];
    this.refreshCard(c);
    this.changed();
    return m;
  }
  // Highlight tool on a picture: drag a box. Then the app asks for its colour (onMarkBox).
  startBox(e, c, media) {
    const at = (ev) => {
      const r = media.getBoundingClientRect();
      return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
    };
    const p0 = at(e);
    for (const d of this.world.querySelectorAll('.box-draft')) d.remove();
    const draft = el('div', 'box-draft');
    let box = null;
    this.drag(e, (ev) => {
      const p = at(ev);
      box = [Math.min(p0[0], p[0]), Math.min(p0[1], p[1]), Math.max(p0[0], p[0]), Math.max(p0[1], p[1])];
      if (!draft.isConnected) media.append(draft);
      Object.assign(draft.style, { left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` });
    }, () => {
      const r = media.getBoundingClientRect();
      if (!box || (box[2] - box[0]) * r.width < 6 || (box[3] - box[1]) * r.height < 6) return draft.remove();
      this.onMarkBox?.(c, box.map((v) => Math.round(v * 10000) / 10000), draft.getBoundingClientRect());
    });
  }
  recolorBoardMark(c, id, color) {
    const m = this.boardMark(c, id);
    if (!m) return;
    this.snapshot();
    m.color = color;
    this.refreshCard(c);
    this.renderLinks();
    this.changed();
  }
  removeBoardMark(c, id) {
    this.snapshot();
    c.marks = (c.marks || []).filter((m) => m.id !== id);
    this.data.links = this.data.links.filter((l) => !((l.from === c.id && l.fromSub === id) || (l.to === c.id && l.toSub === id)));
    this.refreshCard(c);
    this.renderLinks();
    this.changed();
  }
  // Draw a card again (after its text, highlights or picture changed).
  refreshCard(c) {
    const old = this.els.get(c.id);
    if (!old) return;
    this.ro.unobserve(old);
    old.replaceWith(this.mountCard(c));
    old.remove();
    this.updateSelection();
  }
  // ---------- note toolbar (while a note is being written) ----------
  // The bar comes from the document editor. It stays above the card.
  placeNoteBar() {
    const ed = this.noteEditing;
    if (!ed) return;
    const r = this.els.get(ed.c.id)?.getBoundingClientRect(), pr = this.pane.getBoundingClientRect();
    if (!r) return;
    ed.bar.style.left = `${Math.max(4, Math.min(r.left - pr.left, pr.width - ed.bar.offsetWidth - 4))}px`;
    ed.bar.style.top = `${Math.max(4, r.top - pr.top - ed.bar.offsetHeight - 8)}px`;
  }

  // ---------- input ----------
  bindEvents() {
    const p = this.pane;
    p.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === 1) this.hideContextMenu(); this.onDown(e); });
    // The pane has no scroll of its own. The browser scrolls it to keep a cursor in view (a card that you write
    // in, near the edge): make that a move of the board, so that every position on the board stays correct.
    p.addEventListener('scroll', () => {
      if (!p.scrollLeft && !p.scrollTop) return;
      const v = this.data?.view;
      if (v) { v.x -= p.scrollLeft; v.y -= p.scrollTop; }
      p.scrollLeft = 0;
      p.scrollTop = 0;
      if (v) { this.applyView(); this.changed('view'); }
    });
    p.addEventListener('wheel', () => this.hideContextMenu(), { passive: true });
    p.addEventListener('contextmenu', (e) => this.onContext(e));
    p.addEventListener('pointerup', (e) => setTimeout(() => this.onMarkerUp(e), 0));
    p.addEventListener('mouseover', (e) => {
      const m = e.target.closest?.('mark.sub'), key = m ? `${m.closest('.card')?.dataset.id}:${m.dataset.sub}` : '';
      if (key === this.hotKey) return;
      this.hotKey = key;
      this.hotSub(m?.closest('.card')?.dataset.id, m?.dataset.sub);
    });
    p.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    p.addEventListener('dblclick', (e) => this.onDbl(e));
    p.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card && e.target.closest('.source, .card-pdf')) this.onOpenSource?.(this.card(card.dataset.id));
      const link = e.target.closest('.slink, .slink-pdf');
      if (card && link) {
        const c = this.card(card.dataset.id);
        const l = c && allLinks(c)[+link.dataset.i];
        if (l) this.onCardLink?.(c, l, link.classList.contains('slink-pdf') ? 'pdf' : 'board', link.getBoundingClientRect());
      }
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => { if (e.key === ' ') { this.spaceDown = false; p.classList.remove('space'); } });
  }

  // Track a pointer drag on the pane until release.
  drag(e, move, up) {
    e.preventDefault();
    const p = this.pane;
    p.setPointerCapture(e.pointerId);
    const done = (ev) => {
      p.removeEventListener('pointermove', move);
      p.removeEventListener('pointerup', done);
      p.removeEventListener('pointercancel', done);
      up?.(ev);
    };
    p.addEventListener('pointermove', move);
    p.addEventListener('pointerup', done);
    p.addEventListener('pointercancel', done);
  }

  onDown(e) {
    const t = e.target;
    if (t.isContentEditable || t.closest('#snipPreview, .link-bar, .note-tools, .card.editing .note-text')) return;
    const active = document.activeElement;
    if (active?.isContentEditable || active?.tagName === 'INPUT') active.blur();
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) return this.startPan(e);
    if (e.button !== 0) return;
    // A label of a connection: a press selects the connection, a drag moves the label, two presses edit it.
    // (The drag takes the pointer, so the browser's dblclick does not come: count the presses here.)
    const lab = t.closest('.link-label');
    if (lab && this.link(lab.dataset.id)) {
      e.preventDefault();
      const id = lab.dataset.id, now = Date.now(), last = this.lastLabel;
      this.select({ kind: 'link', id });
      this.lastLabel = { id, at: now };
      if (last?.id === id && now - last.at < 400) { this.lastLabel = null; this.noDblUntil = now + 600; return this.focusLinkLabel(); }
      return this.startLabelDrag(e, this.link(id), lab);
    }
    const linkNode = t.closest('.link, .link-label');
    if (linkNode) { e.preventDefault(); return this.select({ kind: 'link', id: linkNode.dataset.id }); }
    const frameEl = t.closest('.frame');
    if (frameEl && !t.closest('.card')) {
      const g = this.frame(frameEl.dataset.id);

      if (g && t.closest('.frame-head')) {
        // The move drag captures the pointer, so the browser's dblclick misses the title bar. Count the presses here.
        const now = Date.now(), last = this.lastHead;
        this.lastHead = { id: g.id, at: now };
        if (last?.id === g.id && now - last.at < 400) {
          this.lastHead = null;
          this.noDblUntil = now + 600;
          e.preventDefault();
          return this.renameGroup(g.id);
        }
      }
      if (g && t.closest('.frame-resize')) return this.startFrameResize(e, g);
      if (g && t.closest('.frame-head')) { this.select(null); return this.startFrameMove(e, g); }
    }
    const cardEl = t.closest('.card');
    if (this.pickCb) {
      // Picking a link target: a marked word, or a card.
      e.preventDefault();
      const cb = this.pickCb;
      this.endPick();
      return cb(cardEl ? this.card(cardEl.dataset.id) : null, t.closest('mark.sub')?.dataset.sub || null);
    }
    if (!cardEl) {
      this.select(null);
      if (this.tool === 'pen') return this.startInk(e, this.inkSurface(t, null));
      if (this.tool === 'erase') return this.startErase(e);
      if (this.tool === 'zone') return this.startZone(e);
      return this.startPan(e);
    }
    if (t.closest('.source, .card-pdf, .slink, .slink-pdf, .choice-chip, .card-copies')) return;
    const c = this.card(cardEl.dataset.id);
    if (!c) return; // the blur above may have just removed an empty note
    // Mark tool on a card's text: select words to mark (the browser makes the selection).
    if (this.tool === 'mark' && t.closest('.quote') && !c.image) { this.select({ kind: 'card', id: c.id }); return; }
    // Highlight tool on a picture: drag a box over it. A click on a box opens its menu (see onMarkerUp).
    if (this.tool === 'mark' && c.image && t.closest('.media')) {
      this.select({ kind: 'card', id: c.id });
      if (!t.closest('mark.box')) this.startBox(e, c, t.closest('.media'));
      return;
    }
    this.select({ kind: 'card', id: c.id });
    c.z = this.maxZ() + 1;
    cardEl.style.zIndex = c.z;
    if (t.classList.contains('handle') && !['mark', 'pen', 'erase'].includes(this.tool)) return this.startLink(e, c, t.dataset.side);
    if (t.classList.contains('resize')) {
      // The resize drag captures the pointer, so the browser's dblclick misses the grip. Count the presses here.
      const now = Date.now(), last = this.lastGrip;
      this.lastGrip = { id: c.id, at: now };
      if (last?.id === c.id && now - last.at < 400) {
        this.lastGrip = null;
        this.noDblUntil = now + 600;
        e.preventDefault();
        return this.fitHeight(c);
      }
      return this.startResize(e, c, t.dataset.edge);
    }
    if (this.tool === 'pen') return this.startInk(e, this.inkSurface(t, cardEl));
    if (this.tool === 'erase') return this.startErase(e);
    return this.startMove(e, c, cardEl);
  }

  startPan(e) {
    const v = this.data.view, sx = e.clientX, sy = e.clientY, ox = v.x, oy = v.y;
    this.pane.classList.add('panning');
    this.drag(e, (ev) => {
      v.x = ox + ev.clientX - sx;
      v.y = oy + ev.clientY - sy;
      this.applyView();
    }, () => {
      this.pane.classList.remove('panning');
      if (v.x !== ox || v.y !== oy) this.changed('view');
    });
  }

  startMove(e, c, cardEl) {
    const p0 = this.toWorld(e.clientX, e.clientY), ox = c.x, oy = c.y;
    let moved = false;
    this.dragging = c.id;
    this.drag(e, (ev) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      if (!moved) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        if (!this.gravity.running) this.snapshot();
        moved = true;
        cardEl.classList.add('dragging');
      }
      c.x = Math.round(ox + p.x - p0.x);
      c.y = Math.round(oy + p.y - p0.y);
      // Guides: the card goes in line with the edges and middles of other cards. Alt turns this off for a drag.
      if (this.guidesOn(ev)) { const g = this.snapMove(c, cardEl.offsetHeight); c.x = g.x; c.y = g.y; this.showGuides(g.lines); } else this.showGuides([]);
      this.placeCard(c);
      this.renderLinks();
      this.gravity.wake(0.3);
    }, () => {
      this.dragging = null;
      this.showGuides([]);
      this.renderFrames();
      cardEl.classList.remove('dragging');
      if (moved) { this.changed(); this.gravity.wake(0.3); }
      else if (e.target.closest?.('.ncheck') && !cardEl.classList.contains('editing')) this.toggleTask(c, +e.target.closest('.ncheck').dataset.line);
      else if (e.target.closest?.('.de-check') && !cardEl.classList.contains('editing')) this.toggleTask(c, +e.target.closest('.de-check').dataset.i);
      else if (e.target.closest?.('mark.sub')) this.followSub(c.id, e.target.closest('mark.sub').dataset.sub, e.target.closest('mark.sub').getBoundingClientRect());
      else this.pickOption(c);
    });
  }

  // edge: 'e' changes the width, 's' the height, 'se' both. A picture card keeps the shape of its picture.
  startResize(e, c, edge = 'se') {
    const p0 = this.toWorld(e.clientX, e.clientY), ow = c.w, oh = this.els.get(c.id).offsetHeight;
    let moved = false;
    this.drag(e, (ev) => {
      if (!moved) { this.snapshot(); moved = true; }
      const p = this.toWorld(ev.clientX, ev.clientY), dx = p.x - p0.x, dy = p.y - p0.y;
      if (c.image) {
        const grow = edge === 'e' ? dx : Math.abs(dx) > Math.abs(dy * c.imgW / c.imgH) ? dx : (dy * c.imgW) / c.imgH;
        c.w = Math.round(clamp(ow + grow, 140, 2000));
      } else {
        if (edge !== 's') c.w = Math.round(clamp(ow + dx, 140, 2000));
        if (edge !== 'e') c.h = Math.round(clamp(oh + dy, 60, 4000));
      }
      // Guides: the edge goes in line with an edge of another card, or the card gets the size of another card.
      if (this.guidesOn(ev)) {
        const lines = [];
        const sx = c.image || edge !== 's' ? this.snapSize(c, 'w', c.w) : null;
        if (sx) { c.w = Math.round(clamp(sx.size, 140, 2000)); lines.push(...sx.lines); }
        this.placeCard(c);
        const sy = !c.image && edge !== 'e' ? this.snapSize(c, 'h', c.h) : null;
        if (sy) { c.h = Math.round(clamp(sy.size, 60, 4000)); lines.push(...sy.lines); }
        this.showGuides(lines);
      } else this.showGuides([]);
      this.placeCard(c);
      this.renderLinks();
    }, () => { this.showGuides([]); if (moved) this.changed(); });
  }
  // Where a label sits: at part t of its arrow's length, and to a side of the arrow by a part of the way (side,
  // from -1 to 1) to "just off the edge": there the label does not cover the line. 0 is on the arrow. Also
  // gives the direction to that side (n) and the full distance (off), for the drag.
  labelSpot(path, t, side, lab) {
    const total = path.getTotalLength(), d = t * total;
    const p = path.getPointAtLength(d), a = path.getPointAtLength(Math.max(0, d - 2)), b = path.getPointAtLength(Math.min(total, d + 2));
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    // Half of the label across the arrow, and a small space.
    const off = Math.abs(n.x) * lab.offsetWidth / 2 + Math.abs(n.y) * lab.offsetHeight / 2 + 5;
    return { x: p.x + n.x * off * side, y: p.y + n.y * off * side, n, off, on: p };
  }
  // Drag a label of a connection. Along the arrow: the label goes to the place on the arrow that is nearest to
  // the pointer (l.labelT, a part of the arrow's length, so it stays there when the cards move). To a side: the
  // label goes with the pointer, as far as just off that side of the arrow and no further (l.labelSide, a part
  // of that distance from -1 to 1). Let go on the line near the middle, and the label sits by itself again.
  startLabelDrag(e, l, lab) {
    const path = this.svg.querySelector(`g.link[data-id="${CSS.escape(lab.dataset.on || l.id)}"] path`);
    if (!path) return;
    const total = path.getTotalLength(), pts = [];
    for (let d = 0; d <= total; d += 4) { const p = path.getPointAtLength(d); pts.push([d, p.x, p.y]); }
    let moved = false;
    this.drag(e, (ev) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        this.snapshot();
        moved = true;
        lab.classList.add('dragging');
      }
      const q = this.toWorld(ev.clientX, ev.clientY);
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const d = (p[1] - q.x) ** 2 + (p[2] - q.y) ** 2; if (d < bd) { bd = d; best = p; } }
      // Not on the ends, where the label would cover the card or the arrowhead.
      const t = clamp(total ? best[0] / total : 0.5, 0.06, 0.94);
      const spot = this.labelSpot(path, t, 0, lab);
      // How far the pointer is to the side of the arrow: the label goes that far, up to "just off the edge".
      const across = (q.x - spot.on.x) * spot.n.x + (q.y - spot.on.y) * spot.n.y;
      let side = clamp(across / spot.off, -1, 1);
      if (Math.abs(side) < 0.12) side = 0; // on the line
      lab.style.left = `${spot.on.x + spot.n.x * spot.off * side}px`;
      lab.style.top = `${spot.on.y + spot.n.y * spot.off * side}px`;
      if (!side && Math.abs(t - 0.5) < 0.03) { delete l.labelT; delete l.labelSide; }
      else { l.labelT = Math.round(t * 1000) / 1000; if (side) l.labelSide = Math.round(side * 100) / 100; else delete l.labelSide; }
    }, () => {
      lab.classList.remove('dragging');
      if (moved) { this.renderLinks(); this.changed(); }
    });
  }
  // ---------- guides: line a card up with other cards, and give it the size of another card ----------
  // On while you move or size a card (not with gravity on, not while Alt is down, not when turned off in Options).
  guidesOn(ev) { return this.guides !== false && !ev.altKey && !this.gravity.running; }
  // How near (in board units) an edge must be to go to a guide: about 7 px on the screen.
  guideReach() { return 7 / (this.data.view.z || 1); }
  // The other cards that show, as rectangles.
  guideRects(id) {
    return this.visibleCards().filter((o) => o.id !== id && !this.els.get(o.id)?.classList.contains('iso-out')).map((o) => this.rectOf(o.id)).filter(Boolean);
  }
  // A card that moves: its left edge, middle or right edge goes to the same of another card, and the same for
  // top, middle and bottom. Returns the place and the guide lines to draw.
  snapMove(c, h) {
    const T = this.guideReach(), others = this.guideRects(c.id), lines = [];
    let { x, y } = c;
    const pick = (mine, theirs) => {
      let best = null;
      for (const m of mine) for (const t of theirs) { const d = t - m; if (Math.abs(d) <= T && (!best || Math.abs(d) < Math.abs(best))) best = d; }
      return best;
    };
    const dx = pick([x, x + c.w / 2, x + c.w], others.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]));
    if (dx != null) x = Math.round(x + dx);
    const dy = pick([y, y + h / 2, y + h], others.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]));
    if (dy != null) y = Math.round(y + dy);
    const near = (a, b) => Math.abs(a - b) < 0.75;
    if (dx != null) {
      const found = [x, x + c.w / 2, x + c.w].map((v) => {
        const hit = others.filter((r) => [r.x, r.x + r.w / 2, r.x + r.w].some((t) => near(t, v)));
        return hit.length ? { x: v, y0: Math.min(y, ...hit.map((r) => r.y)), y1: Math.max(y + h, ...hit.map((r) => r.y + r.h)) } : null;
      });
      // The two edges in line say it all: the line through the middle is left out then.
      lines.push(...found.filter((l, i) => l && !(i === 1 && found[0] && found[2])));
    }
    if (dy != null) {
      const found = [y, y + h / 2, y + h].map((v) => {
        const hit = others.filter((r) => [r.y, r.y + r.h / 2, r.y + r.h].some((t) => near(t, v)));
        return hit.length ? { y: v, x0: Math.min(x, ...hit.map((r) => r.x)), x1: Math.max(x + c.w, ...hit.map((r) => r.x + r.w)) } : null;
      });
      lines.push(...found.filter((l, i) => l && !(i === 1 && found[0] && found[2])));
    }
    return { x, y, lines };
  }
  // A card that changes size (dim: 'w' or 'h'): its right or bottom edge goes to an edge of another card, or the
  // card gets the width or height of another card. Returns { size, lines } or null.
  snapSize(c, dim, size) {
    const T = this.guideReach(), others = this.guideRects(c.id), wide = dim === 'w';
    const at = wide ? c.x : c.y, edge = at + size;
    let best = null;
    for (const r of others) {
      for (const t of wide ? [r.x, r.x + r.w] : [r.y, r.y + r.h]) { const d = t - edge; if (Math.abs(d) <= T && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, edge: t }; }
      const same = wide ? r.w : r.h, d = same - size;
      if (Math.abs(d) <= T && (!best || Math.abs(d) <= Math.abs(best.d))) best = { d, same };
    }
    if (!best) return null;
    const out = Math.round(size + best.d), lines = [], me = this.rectOf(c.id);
    const near = (a, b) => Math.abs(a - b) < 0.75;
    if (best.same != null) {
      // The same size: a bar along each card that has it, and along this card.
      for (const r of [...others.filter((o) => near(wide ? o.w : o.h, out)), { x: c.x, y: c.y, w: wide ? out : me.w, h: wide ? me.h : out }]) {
        lines.push(wide ? { y: r.y - 8, x0: r.x, x1: r.x + r.w, size: true } : { x: r.x - 8, y0: r.y, y1: r.y + r.h, size: true });
      }
    } else {
      const hit = others.filter((r) => (wide ? [r.x, r.x + r.w] : [r.y, r.y + r.h]).some((t) => near(t, best.edge)));
      lines.push(wide ? { x: best.edge, y0: Math.min(c.y, ...hit.map((r) => r.y)), y1: Math.max(c.y + me.h, ...hit.map((r) => r.y + r.h)) }
        : { y: best.edge, x0: Math.min(c.x, ...hit.map((r) => r.x)), x1: Math.max(c.x + me.w, ...hit.map((r) => r.x + r.w)) });
    }
    return { size: out, lines };
  }
  // Draw the guide lines (none: remove them). A line keeps its thickness on the screen at any zoom.
  showGuides(lines) {
    if (!this.guidesEl) { if (!lines.length) return; this.guidesEl = el('div', 'guides'); this.world.append(this.guidesEl); }
    const t = 1.5 / (this.data.view.z || 1);
    this.guidesEl.replaceChildren(...lines.map((l) => {
      const d = el('div', `guide${l.size ? ' size' : ''}`);
      if (l.x != null) Object.assign(d.style, { left: `${l.x - t / 2}px`, top: `${l.y0}px`, width: `${t}px`, height: `${l.y1 - l.y0}px` });
      else Object.assign(d.style, { left: `${l.x0}px`, top: `${l.y - t / 2}px`, width: `${l.x1 - l.x0}px`, height: `${t}px` });
      return d;
    }));
  }
  // Remove a card's set height, so the card fits its text again.
  fitHeight(c) {
    if (!c?.h) return;
    this.snapshot();
    delete c.h;
    this.placeCard(c);
    this.renderLinks();
    this.changed();
  }

  startLink(e, c, side) {
    const a = this.anchor(this.rectOf(c.id), side);
    const tmp = svgEl('path', { class: 'str temp', stroke: this.colors.link, 'marker-end': `url(#${markerId(this.colors.link)})` });
    this.tempLink = tmp;
    this.svg.append(tmp);
    let target = null;
    const cardUnder = (ev) => document.elementsFromPoint(ev.clientX, ev.clientY)
      .map((n) => n.closest?.('.card')).find((n) => n && n.dataset.id !== c.id) || null;
    this.drag(e, (ev) => {
      tmp.setAttribute('d', this.curve(a, SIDES[side], this.toWorld(ev.clientX, ev.clientY)).d);
      const next = cardUnder(ev);
      if (next !== target) { target?.classList.remove('link-target'); next?.classList.add('link-target'); target = next; }
    }, (ev) => {
      tmp.remove();
      this.tempLink = null;
      target?.classList.remove('link-target');
      const to = cardUnder(ev)?.dataset.id;
      if (!to) return;
      if (this.data.links.some((l) => (l.from === c.id && l.to === to) || (l.from === to && l.to === c.id))) return;
      this.snapshot();
      const l = { id: uid(), from: c.id, to, color: this.colors.link, label: '' };
      this.data.links.push(l);
      this.renderLinks();
      this.applyFilter();
      this.select({ kind: 'link', id: l.id });
      this.changed();
      this.gravity.wake();
      this.focusLinkLabel();
    });
  }

  // Client point → image pixel coordinates of a card's media.
  toImage(ev, c, media) {
    const p = this.toWorld(ev.clientX, ev.clientY);
    const k = c.imgW / media.offsetWidth;
    return { x: (p.x - c.x - media.offsetLeft) * k, y: (p.y - c.y - media.offsetTop) * k, k };
  }

  // Where a stroke goes: on a card's picture (picture pixels), on a card (card units), or on the board (board units).
  inkSurface(t, cardEl) {
    const c = cardEl && this.card(cardEl.dataset.id), media = c && t.closest('.media');
    if (media && cardEl.contains(media)) {
      return { paper: true, svg: media.querySelector('.ink'), at: (ev) => this.toImage(ev, c, media), get: () => c.strokes || [], set: (v) => { c.strokes = v; }, render: () => this.renderInk(c) };
    }
    const world = (ev) => this.toWorld(ev.clientX, ev.clientY);
    if (c) {
      return {
        svg: cardEl.querySelector('.card-ink'), at: (ev) => { const p = world(ev); return { x: p.x - c.x, y: p.y - c.y, k: 1 }; },
        get: () => c.cardStrokes || [], set: (v) => { c.cardStrokes = v; }, render: () => this.renderCardInk(c),
      };
    }
    return { svg: this.inkSvg, at: (ev) => ({ ...world(ev), k: 1 }), get: () => this.data.ink || [], set: (v) => { this.data.ink = v; }, render: () => this.renderBoardInk() };
  }

  startInk(e, surf) {
    e.preventDefault();
    const tool = this.tool;
    const first = surf.at(e);
    const s = { t: tool, c: this.colors[tool], w: +(INK_WIDTH[tool] * first.k).toFixed(1), p: [] };
    const path = this.strokeEl(s, !surf.paper);
    surf.svg.append(path);
    const r1 = (v) => Math.round(v * 10) / 10;
    const add = (ev) => {
      const q = surf.at(ev);
      const pt = [r1(q.x), r1(q.y)];
      if (ev.shiftKey && s.p.length) s.p = [s.p[0], pt];
      else {
        const last = s.p[s.p.length - 1];
        if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 2 * q.k) return;
        s.p.push(pt);
      }
      path.setAttribute('d', pathD(s.p));
    };
    add(e);
    this.drag(e, add, () => {
      if (s.p.length === 1) s.p.push([s.p[0][0] + 0.5, s.p[0][1]]);
      this.snapshot();
      surf.set([...surf.get(), s]);
      surf.render();
      this.changed();
    });
  }

  // Erase strokes under the pointer: on the board, and on the card and picture under it.
  startErase(e) {
    e.preventDefault();
    let snapped = false;
    const hit = (strokes, q, r) => strokes.filter((s) =>
      !s.p.some((pt, i) => distToSeg(q.x, q.y, pt, s.p[Math.min(i + 1, s.p.length - 1)]) < r + s.w / 2));
    const erase = (ev) => {
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const cardEl = els.find((n) => n.classList?.contains('card') && this.cardsEl.contains(n));
      const surfaces = [this.inkSurface(this.pane, null)];
      if (cardEl) {
        surfaces.push(this.inkSurface(cardEl, cardEl));
        const media = els.find((n) => n.classList?.contains('media') && cardEl.contains(n));
        if (media) surfaces.push(this.inkSurface(media, cardEl));
      }
      for (const surf of surfaces) {
        const q = surf.at(ev), before = surf.get(), keep = hit(before, q, (8 / this.data.view.z) * q.k);
        if (keep.length === before.length) continue;
        if (!snapped) { this.snapshot(); snapped = true; }
        surf.set(keep);
        surf.render();
      }
    };
    erase(e);
    this.drag(e, erase, () => { if (snapped) this.changed(); });
  }

  onWheel(e) {
    if (e.target.closest('#snipPreview')) return; // let the preview scroll
    if (!e.ctrlKey && !e.metaKey && this.canScroll(e.target, e.deltaY)) return; // let a sized card's text scroll
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) return this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.01));
    const v = this.data.view;
    v.x -= e.deltaX * unit;
    v.y -= e.deltaY * unit;
    this.applyView();
    this.changed('view');
  }

  canScroll(t, dy) {
    const box = t.closest?.('.card.sized .quote, .card.sized .text');
    if (!box || box.scrollHeight <= box.clientHeight + 1) return false;
    return dy < 0 ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1;
  }

  onDbl(e) {
    if (Date.now() < (this.noDblUntil || 0)) return; // a double-click on a resize grip
    const t = e.target;
    if (t.isContentEditable || t.closest('#snipPreview, .note-tools, .card.editing .note-text')) return;
    const label = t.closest('.link-label');
    if (label) { this.select({ kind: 'link', id: label.dataset.id }); return this.focusLinkLabel(); }
    const fhead = t.closest('.frame-head');
    if (fhead) return this.renameGroup(fhead.parentElement.dataset.id);
    const linkNode = t.closest('.link');
    if (linkNode) return this.travel(linkNode.dataset.id);
    const cardEl = t.closest('.card');
    if (cardEl) {
      if (t.closest('.source, .card-pdf, .handle, .slink, .slink-pdf')) return;
      if (t.closest('.media') && this.tool !== 'move') return;
      return this.startEdit(cardEl.querySelector('.text'), this.card(cardEl.dataset.id));
    }
  }
  // Right-click: a menu. On the empty board: a custom card or a zone at that point. On a card: write in it,
  // open its source, or delete it.
  onContext(e) {
    const t = e.target;
    if (t.isContentEditable || t.closest('#snipPreview, .link-bar, .note-tools, .card.editing .note-text, .ctx-menu, input, textarea')) return;
    e.preventDefault();
    const at = this.toWorld(e.clientX, e.clientY), cardEl = t.closest('.card');
    const c = cardEl && this.card(cardEl.dataset.id);
    const linkNode = !c && t.closest('.link, .link-label'), l = linkNode && this.link(linkNode.dataset.id);
    const headEl = !c && t.closest('.frame-head'), zone = headEl ? this.frame(headEl.parentElement.dataset.id)
      : !c && !l ? (this.data.groups || []).find((g) => at.x >= g.x && at.x <= g.x + g.w && at.y >= g.y && at.y <= g.y + g.h) : null;
    const items = [];
    if (c) {
      this.select({ kind: 'card', id: c.id });
      items.push([c.type === 'note' ? '✎ Write in this card' : '✎ Add a board note', () => this.startEdit(cardEl.querySelector('.text'), c)]);
      if (c.source) items.push(['↗ Open in the PDF', () => this.onOpenSource?.(c)]);
      if (c.type === 'note') items.push({ swatches: PALETTES.note, current: c.color || PALETTES.note[0], pick: (col) => { this.snapshot(); c.color = col; this.els.get(c.id).style.setProperty('--accent', col); this.changed(); } });
      if (c.h && !c.image) items.push(['↕ Fit the height to the text', () => this.fitHeight(c)]);
      if (c.snipSubs?.length && this.onMoveHighlights) items.push(['⇣ Its highlights only on this card', () => this.onMoveHighlights(c)]);
      items.push(['⧉ Duplicate card', () => this.duplicateCard(c)]);
      if (c.choice) items.push(['⑂ Not a choice (show all its branches)', () => this.toggleChoice(c)]);
      else if (this.optionsOf(c).length > 1) items.push(['⑂ Make this a choice (one branch at a time)', () => this.toggleChoice(c)]);
      items.push(['× Delete card', () => this.deleteCard(c.id), 'danger']);
    } else if (l) {
      // A connection: its own bar (label, note, direction, colour, style, width, delete), where you clicked.
      this.barAt = at;
      this.openLinkBar(l.id);
      return;
    } else {
      items.push(['＋ Add custom card', () => this.addNote(at)]);
      if (!zone) items.push(['▭ Add a zone here', () => this.addZoneAt(at)]);
    }
    if (zone) {
      items.push({ heading: zone.title || 'Zone' });
      items.push(['✎ Rename zone', () => this.renameGroup(zone.id)]);
      items.push({ swatches: ZONE_COLORS, current: zone.color || ZONE_COLORS[0], pick: (col) => { this.snapshot(); zone.color = col; this.renderFrames(); this.changed(); } });
      items.push(['× Remove zone (the cards stay)', () => this.deleteGroup(zone.id), 'danger']);
    }
    this.showContextMenu(e.clientX, e.clientY, items);
  }
  showContextMenu(x, y, items) {
    this.hideContextMenu();
    const m = el('div', 'ctx-menu');
    for (const it of items) {
      if (it.heading) { const h = el('div', 'ctx-head'); h.textContent = it.heading; m.append(h); continue; }
      if (it.swatches) {
        // A row of colours.
        const row = el('div', 'ctx-swatches');
        for (const col of it.swatches) {
          const b = el('button', `ctx-swatch${col === it.current ? ' on' : ''}`, { title: 'Colour' });
          b.style.setProperty('--c', col);
          b.onclick = () => { this.hideContextMenu(); it.pick(col); };
          row.append(b);
        }
        m.append(row);
        continue;
      }
      const [label, fn, cls] = it;
      const b = el('button', cls || '');
      b.textContent = label;
      b.onclick = () => { this.hideContextMenu(); fn(); };
      m.append(b);
    }
    m.addEventListener('pointerdown', (e) => e.stopPropagation());
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    this.pane.append(m);
    const pr = this.pane.getBoundingClientRect();
    m.style.left = `${Math.min(x - pr.left, pr.width - m.offsetWidth - 6)}px`;
    m.style.top = `${Math.min(y - pr.top, pr.height - m.offsetHeight - 6)}px`;
    this.ctxMenu = m;
  }
  hideContextMenu() {
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }
  addZoneAt(at) {
    this.snapshot();
    const n = (this.data.groups || []).length, id = uid();
    this.data.groups.push({ id, title: `Zone ${n + 1}`, x: Math.round(at.x), y: Math.round(at.y), w: 600, h: 400, color: ZONE_COLORS[n % ZONE_COLORS.length] });
    this.renderFrames();
    this.changed();
    this.renameGroup(id);
  }

  onKey(e) {
    if (this.ctxMenu && e.key === 'Escape') { this.hideContextMenu(); return; }
    if (this.pickCb && e.key === 'Escape') { this.endPick(); this.onNotice?.('Link cancelled.'); return; }
    const a = document.activeElement;
    const typing = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    if (typing) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) a.blur();
      return;
    }
    if (!this.data || document.querySelector('dialog[open]') || !this.pane.offsetParent) return; // board hidden
    if (getSelection()?.toString() && !e.metaKey && !e.ctrlKey) return; // the user is working in the PDF text
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (mod && k === 'y') { e.preventDefault(); return this.redo(); }
    if (mod || e.altKey) return;
    if (e.key === ' ') { this.spaceDown = true; this.pane.classList.add('space'); e.preventDefault(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.sel) return;
      e.preventDefault();
      return this.sel.kind === 'card' ? this.deleteCard(this.sel.id) : this.deleteLink(this.sel.id);
    }
    if (e.key === 'Escape') {
      if (this.iso) return this.isolate(0);
      this.select(null);
      return this.setTool('move');
    }
    if (e.key === 'Enter' && this.sel?.kind === 'link') { e.preventDefault(); return this.focusLinkLabel(); }
    if (['0', '1', '2', '3'].includes(e.key)) {
      if (!this.isolate(+e.key)) this.onNotice?.('Select a card first, then press 1, 2 or 3.');
      return;
    }
    if (k === 'g') return this.setGravity(!this.gravity.running);
    if (k === 'l') return this.structure();
    if (e.key === 'Enter' && this.sel?.kind === 'card') {
      e.preventDefault();
      return this.startEdit(this.els.get(this.sel.id).querySelector('.text'), this.card(this.sel.id));
    }
    const tool = { v: 'move', h: 'mark', m: 'mark', p: 'pen', e: 'erase', z: 'zone' }[k];
    if (tool) return this.setTool(tool);
    if (k === 'n') { e.preventDefault(); return this.addNote(); }
    if (k === 'f') return this.fit();
  }
}
