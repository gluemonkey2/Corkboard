// Snippet layers and links, shared by the reader, the tray and the board.
// A snippet is "inside" another when every line box of it lies within a line box of the other,
// on the same page. Its parent is the smallest snippet that holds it (a term inside a paragraph).
const TOL = 2; // PDF points

export const areaOf = (h) => h.rects.reduce((s, [, x0, y0, x1, y1]) => s + (x1 - x0) * (y1 - y0), 0);

export function inside(inner, outer) {
  if (inner === outer || inner.id === outer.id) return false;
  return inner.rects.every(([n, x0, y0, x1, y1]) => outer.rects.some(([m, X0, Y0, X1, Y1]) =>
    m === n && x0 >= X0 - TOL && x1 <= X1 + TOL && y0 >= Y0 - TOL && y1 <= Y1 + TOL));
}

export function parentOf(h, list) {
  const a = areaOf(h);
  let best = null, bestArea = Infinity;
  for (const o of list) {
    if (o === h || o.id === h.id) continue;
    const oa = areaOf(o);
    if (oa > a + 0.5 && oa < bestArea && inside(h, o)) { best = o; bestArea = oa; }
  }
  return best;
}

export function depthOf(h, list) {
  let d = 0;
  for (let p = parentOf(h, list); p && d < 6; p = parentOf(p, list)) d++;
  return d;
}

export const LINK_LABELS = ['defined by', 'refers to', 'see also'];
export const excerpt = (h, n = 60) => {
  const t = (h.text || (h.kind === 'area' ? 'Area snippet' : '')).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The sections a place falls under (same rule as PdfView.sectionPath), for PDFs that are not open.
export function sectionPathOf(sections, page, top) {
  const stack = [];
  const sorted = [...(sections || [])].sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));
  for (const s of sorted) {
    const sy = s.y ?? Infinity;
    if (s.page > page || (s.page === page && sy < top - 0.5)) break;
    stack.length = Math.max(0, s.level - 1);
    stack[s.level - 1] = s;
  }
  return stack.filter(Boolean);
}

// ---------- keeping the shape of text ----------
// PDF text arrives one visual line at a time. Join the lines of a paragraph, but keep a line break
// where a list item starts (a), (b), 1., i., •), after a line that ends with ":", after a short line,
// and at blank lines. A word split over two lines by a hyphen is joined again.
const MARKER = /^\s*(?:\(?(?:[a-z]|[ivxlc]{1,5}|\d{1,3})[.)]\s|\d+(?:\.\d+)+\.?\s|[\u2022\u25cf\u25aa\u25e6\u2023\u2043\u2219\u00b7\uf000-\uf0ff*\-–—]\s?)/i;
// Indent levels are stored as two em spaces per level at the start of a line.
const EM = '\u2003';
const levelOf = (line) => Math.floor(/^\u2003*/.exec(line)[0].length / 2);

// Join wrapped lines into paragraphs, and keep list items, lines after a colon and short lines on lines of
// their own. raw: a string, or [{ text, x, r }] where x and r are the line's left and right edges in PDF points
// (null when unknown).
// Lines that start further right than others get an indent level.
export function reflow(raw) {
  const src = Array.isArray(raw)
    ? raw.flatMap((l) => String(l.text || '').split('\n').map((t, i) => ({ text: t, x: i ? null : l.x, r: i ? null : l.r, join: !i && l.join })))
    : String(raw || '').replace(/\r/g, '').split('\n').map((t) => ({ text: t, x: levelOf(t) * 20 }));
  const lines = src.map((l) => ({
    x: l.x, r: l.r ?? null, join: !!l.join,
    text: l.text.replace(/^\u2003+/, '').replace(/[ \t\u00a0]+/g, ' ').trim().replace(/^[\uf000-\uf0ff]\s?/, '• '),
  }));
  const longest = Math.max(0, ...lines.map((l) => l.text.length));
  // The line before ended early: the first word of this line would have fit on it. With the edges known, the
  // right edge is the widest line of the paragraph so far, so a narrow column is not compared with a wide one.
  const endedEarly = (p, l, right) => {
    if (p.x == null || p.r == null || l.r == null) return p.text.length < longest * 0.55 && longest > 30;
    const cw = (p.r - p.x) / Math.max(1, p.text.length);
    const word = (l.text.split(' ')[0].length + 1) * cw;
    return p.r + word < Math.max(right, l.r) - cw;
  };
  const out = []; let cur = null, prev = null, right = -Infinity;
  for (const l of lines) {
    const { text: line, x, join } = l;
    if (!line) { if (cur) out.push(cur); cur = null; prev = null; continue; }
    const hyphen = cur && /[a-z]-$/.test(cur.text) && /^[a-z]/.test(line);
    const fresh = !hyphen && !(join && cur) && (!cur || MARKER.test(line) || /[:;]$/.test(prev.text) || endedEarly(prev, l, right));
    if (hyphen) cur.text = cur.text.slice(0, -1) + line;
    else if (fresh) { if (cur) out.push(cur); cur = { text: line, x }; right = -Infinity; }
    else cur.text += ` ${line}`;
    if (l.r != null) right = Math.max(right, l.r);
    prev = l;
  }
  if (cur) out.push(cur);
  // Group the left edges (3 pt apart or more) into levels. The leftmost is level 0.
  const edges = [...new Set(out.map((l) => l.x).filter((x) => x != null))].sort((a, b) => a - b);
  const levels = [];
  for (const x of edges) if (!levels.length || x - levels[levels.length - 1] > 3) levels.push(x);
  const level = (x) => (x == null ? 0 : Math.max(0, levels.filter((e) => e <= x + 3).length - 1));
  const lv = out.map((l) => level(l.x));
  // Items of one list (a) b) c), 1. 2. 3., i. ii. iii., or the same bullet close by) share the level of the
  // item before them. A small shift on the page must not push the next item one level deeper.
  const keys = out.map((l) => markerKey(l.text));
  for (let i = 0; i < out.length; i++) {
    const k = keys[i];
    if (!k) continue;
    for (let j = i - 1; j >= 0; j--) {
      const p = keys[j];
      if (!p || p.form !== k.form) continue;
      const next = k.bullet
        ? p.bullet === k.bullet && Math.abs((out[j].x ?? 0) - (out[i].x ?? 0)) <= 8
        : k.cands.some((c) => p.cands.some((d) => d.kind === c.kind && d.n === c.n - 1));
      if (next) { lv[i] = lv[j]; break; }
    }
  }
  // Remove empty levels, so the levels stay 0, 1, 2…
  const used = [...new Set(lv)].sort((a, b) => a - b);
  return out.map((l, i) => EM.repeat(2 * used.indexOf(lv[i])) + l.text).join('\n');
}

// The marker of a list item: its form ("a)", "(a)", "a.") and what it counts as (letter, number, roman).
function roman(t) {
  if (!/^(c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/.test(t)) return 0;
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  for (let i = 0; i < t.length; i++) n += v[t[i]] < (v[t[i + 1]] || 0) ? -v[t[i]] : v[t[i]];
  return n;
}
function markerKey(text) {
  const b = /^([\u2022\u25cf\u25aa\u25e6\u2023\u2043\u2219\u00b7*\-–—])\s/.exec(text);
  if (b) return { form: 'bullet', bullet: b[1], cands: [] };
  const m = /^(\()?([a-z]{1,5}|\d{1,3})([.)])\s/i.exec(text);
  if (!m) return null;
  const t = m[2], lo = t.toLowerCase(), cands = [];
  if (/^\d+$/.test(t)) cands.push({ kind: 'num', n: +t });
  if (/^[a-z]$/i.test(t)) cands.push({ kind: t === lo ? 'abc' : 'ABC', n: lo.charCodeAt(0) - 96 });
  const r = roman(lo);
  if (r) cands.push({ kind: t === lo ? 'roman' : 'ROMAN', n: r });
  return cands.length ? { form: (m[1] || '') + m[3], cands } : null;
}

// A snippet's text without its indents, for short quotes.
export const plainSnipText = (t) => String(t || '').replace(/^\u2003+/gm, '');

// Show a snippet's text in el: one block per line, with its indent level and a hanging indent for list items.
// marks: [{ id, start, end, color, title, linked }], ranges of the text to show as marked words (inner snippets).
export function fillSnipText(el, text, marks = []) {
  text = String(text || '');
  // Marks may nest (a term inside a marked sentence). A mark that only overlaps another one is left out.
  const sorted = [...marks].filter((m) => m.end > m.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const fill = (into, a, b, list) => {
    let pos = a;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (Math.max(m.start, a) < pos) continue;
      const inner = [];
      while (i + 1 < list.length && list[i + 1].start < m.end) {
        if (list[i + 1].end <= m.end) inner.push(list[i + 1]);
        i++;
      }
      const s0 = Math.max(m.start, a), s1 = Math.min(m.end, b);
      if (s1 <= s0) continue;
      if (s0 > pos) into.append(text.slice(pos, s0));
      const mk = document.createElement('mark');
      mk.className = `sub${m.linked ? ' linked' : ''}${m.ref ? ' ref' : ''}`;
      mk.dataset.sub = m.id;
      if (m.color) mk.style.setProperty('--c', m.color);
      if (m.title) mk.title = m.title;
      fill(mk, s0, s1, inner);
      into.append(mk);
      pos = s1;
    }
    if (pos < b) into.append(text.slice(pos, b));
  };
  let off = 0;
  el.replaceChildren(...text.split('\n').map((line) => {
    const d = document.createElement('div');
    const lead = /^\u2003*/.exec(line)[0].length, body = line.slice(lead);
    const b0 = off + lead, b1 = off + line.length;
    off = b1 + 1;
    const marker = MARKER.exec(body);
    d.className = marker ? 'sl sl-li' : 'sl';
    d.dataset.off = b0; // where this line's words start in the text, for selections on the board
    d.style.setProperty('--lv', levelOf(line));
    if (marker) d.style.setProperty('--hang', `${Math.min(marker[0].trim().length + 1, 6)}ch`);
    fill(d, b0, b1, sorted.filter((m) => m.end > b0 && m.start < b1));
    return d;
  }));
  return el;
}

// Where an inner snippet's text sits in its outer snippet's text: { start, end } in outer.text, or null.
// A word that occurs more than once is matched to the occurrence nearest to where the inner snippet is on the page.
export function locateSub(outer, sub, siblings = []) {
  return locateSubs(outer, [sub, ...siblings.filter((x) => x.id !== sub.id)])[0];
}
// Where each inner snippet's words sit in the outer snippet's text: [{ start, end } | null], in the order given.
// Each one is placed by where it is on the page. Two inner snippets with the same words (two "may"s) never get
// the same place: they take the occurrences in page order.
export function locateSubs(outer, subs) {
  const text = String(outer.text || '');
  let flat = '', prevSpace = true;
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) { if (!prevSpace) { flat += ' '; map.push(i); prevSpace = true; } }
    else { flat += text[i].toLowerCase(); map.push(i); prevSpace = false; }
  }
  // Characters are spread over the outer snippet's lines by line width, so a short line holds fewer of them.
  const lines = outer.rects || [];
  const widths = lines.map((r) => Math.max(1, r[3] - r[1])), total = widths.reduce((a, b) => a + b, 0) || 1;
  const estimate = (sub) => {
    const [n, x0, y0, , y1] = sub.rects?.[0] || [];
    const cy = (y0 + y1) / 2;
    let k = -1, best = Infinity;
    lines.forEach(([m, , Y0, , Y1], i) => {
      if (m !== n) return;
      const d = cy >= Y0 && cy <= Y1 ? 0 : Math.min(Math.abs(cy - Y0), Math.abs(cy - Y1));
      if (d < best) { best = d; k = i; }
    });
    if (k < 0) return 0;
    const before = widths.slice(0, k).reduce((a, b) => a + b, 0);
    return ((before + clamp01((x0 - lines[k][1]) / widths[k]) * widths[k]) / total) * flat.length;
  };
  const out = subs.map(() => null);
  const groups = new Map();
  subs.forEach((sub, i) => {
    const needle = String(sub.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) return;
    if (!groups.has(needle)) groups.set(needle, []);
    groups.get(needle).push({ i, est: estimate(sub) });
  });
  for (const [needle, list] of groups) {
    const hits = [];
    for (let h = flat.indexOf(needle); h >= 0; h = flat.indexOf(needle, h + 1)) hits.push(h);
    if (!hits.length) continue;
    // In page order, each takes the nearest occurrence that is after the one before it and leaves room for the rest.
    list.sort((a, b) => a.est - b.est);
    let from = 0;
    list.forEach((it, n) => {
      const last = hits.length - (list.length - n);
      if (from > last) return; // more inner snippets than occurrences: the rest stay unplaced
      let pick = from;
      for (let h = from; h <= last; h++) if (Math.abs(hits[h] - it.est) < Math.abs(hits[pick] - it.est)) pick = h;
      out[it.i] = { start: map[hits[pick]], end: map[hits[pick] + needle.length - 1] + 1 };
      from = pick + 1;
    });
  }
  return out;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Put line breaks into a snippet's saved text where the page's lines start, without changing a word.
// lines: the text of each line of the snippet as read from the page.
// lines may be [{ text, x }]. Then the result is [{ text, x }] too, ready for reflow.
export function breakLikeLines(text, lines) {
  const objs = lines.length && typeof lines[0] === 'object';
  const xs = objs ? lines.map((l) => l.x) : null, rs = objs ? lines.map((l) => l.r) : null;
  if (objs) lines = lines.map((l) => l.text);
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const words = lines.map((l) => l.split(/\s+/).filter(Boolean));
  const out = [];
  let at = 0;
  for (let i = 0; i < words.length && at < tokens.length; i++) {
    if (i === words.length - 1) { out.push(tokens.slice(at).join(' ')); at = tokens.length; break; }
    const next = words[i + 1].map(norm).find(Boolean);
    const guess = at + words[i].length;
    let cut = -1;
    for (let d = 0; d <= 4 && cut < 0; d++) {
      for (const j of [guess + d, guess - d]) if (j > at && j < tokens.length && norm(tokens[j]) === next) { cut = j; break; }
    }
    if (cut < 0) cut = Math.min(tokens.length, guess);
    out.push(tokens.slice(at, cut).join(' '));
    at = cut;
  }
  if (at < tokens.length) out.push(tokens.slice(at).join(' '));
  // join: the page line before ended in a split word, so this line continues it.
  if (objs) return out.map((t, i) => ({ text: t, x: xs[i] ?? null, r: rs[i] ?? null, join: i > 0 && /[a-z]-$/.test(lines[i - 1] || '') })).filter((l) => l.text);
  return out.filter(Boolean).join('\n');
}
