// The dictionary: terms and their definitions.
//   - matching: find the terms in a piece of text (whole words and full terms only);
//   - detection: find a "Definitions" / "Terms" / "Terminology" section in a PDF and read its entries.
// A term: { id, term, forms: [other spellings], def, scope: 'project' | 'global', auto, source: { pdfId, name, page, rects } }.

// ---------- matching ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Capital-letter terms (HAC, RF) match with those capitals only. Other terms match in any case.
const isCaps = (s) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
const WORD = '[\\p{L}\\p{N}]';
function formRegex(form) {
  const body = form.trim().split(/\s+/).map(esc).join('[\\s\\u00a0]+');
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, isCaps(form) ? 'gu' : 'giu');
}
export const formsOf = (t) => [t.term, ...(t.forms || [])].map((f) => (f || '').trim()).filter((f) => f.length > 1);

// A matcher for a list of terms (the first ones win where two match the same words): text -> [{ start, end, term }].
export function buildMatcher(terms) {
  const pats = [];
  terms.forEach((t, rank) => { for (const f of formsOf(t)) pats.push({ re: formRegex(f), t, rank, len: f.length }); });
  return (text) => {
    if (!pats.length || !text) return [];
    const found = [];
    for (const p of pats) {
      p.re.lastIndex = 0;
      for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
        found.push({ start: m.index, end: m.index + m[0].length, term: p.t, rank: p.rank });
        if (!m[0].length) p.re.lastIndex++;
      }
    }
    // The longest match first, then the term with the higher priority. No two matches share a letter.
    found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.rank - b.rank || a.start - b.start);
    const out = [];
    for (const f of found) if (!out.some((o) => f.start < o.end && o.start < f.end)) out.push(f);
    return out.sort((a, b) => a.start - b.start);
  };
}

// Wrap the terms in the text nodes under root in <span class="term" data-term="id">. The text itself does not change.
export function decorateTerms(root, match) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim() && !n.parentElement.closest('.term, .de-math')) nodes.push(n);
  for (const n of nodes) {
    const hits = match(n.data);
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const h of hits) {
      if (h.start > at) frag.append(n.data.slice(at, h.start));
      const s = document.createElement('span');
      s.className = 'term';
      s.dataset.term = h.term.id;
      s.textContent = n.data.slice(h.start, h.end);
      frag.append(s);
      at = h.end;
    }
    if (at < n.data.length) frag.append(n.data.slice(at));
    n.replaceWith(frag);
  }
}

// ---------- detection ----------
const HEAD_WORDS = new Set(['definitions', 'definition', 'terms', 'terminology', 'glossary', 'abbreviations', 'acronyms', 'abbreviated', 'symbols', 'nomenclature']);
const HEAD_FILL = new Set(['and', 'of', '&', 'list', 'the', 'used', 'key']);
// "3 Terms and definitions" -> { num: '3', title: 'terms and definitions' }.
function headingParts(text) {
  const t = text.trim().replace(/^(?:section|chapter|clause|appendix|annex|part)\s+/i, '');
  const m = /^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)+|[A-Z](?=[.)]))[.):]?\s+(.*)$/.exec(t);
  return m ? { num: m[1], title: m[2].trim() } : { num: '', title: t };
}
export function isTermsHeading(text) {
  if (/\.{3,}|…{2,}|\s\d{1,3}\s*$/.test(text)) return false; // a line of the table of contents
  const { title } = headingParts(text);
  const words = title.toLowerCase().replace(/[,;:]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  return words.some((w) => HEAD_WORDS.has(w)) && words.every((w) => HEAD_WORDS.has(w) || HEAD_FILL.has(w));
}

// The lines of a page, top to bottom, from pdf.js text content. skip(y) leaves out running headers and footers.
// view: the page's box [x0, y0, x1, y1]. With it, each line knows if it is near the top or the bottom edge.
export function pageLines(tc, n, skip, view) {
  const rows = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // turned text
    const size = it.height || Math.hypot(c, d) || 10;
    if (skip?.(f + size * 0.3)) continue;
    let row = rows.find((r) => Math.abs(r.y - f) < Math.max(r.size, size) * 0.45);
    if (!row) rows.push((row = { y: f, size, parts: [] }));
    row.parts.push({ x0: e, x1: e + (it.width || 0), str: it.str, size, bold: /bold|black|heavy|semibold/i.test(it.fontName || '') });
    row.size = Math.max(row.size, size);
  }
  rows.sort((p, q) => q.y - p.y);
  return rows.map((r) => {
    r.parts.sort((p, q) => p.x0 - q.x0);
    // Chunks: runs of text with a wide gap between them (the columns of a table).
    const chunks = [];
    for (const p of r.parts) {
      const last = chunks[chunks.length - 1];
      if (last && p.x0 - last.x1 < r.size * 2.2) {
        last.text += (p.x0 - last.x1 > r.size * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(p.str) ? ' ' : '') + p.str;
        last.x1 = Math.max(last.x1, p.x1);
      } else chunks.push({ x0: p.x0, x1: p.x1, text: p.str, bold: p.bold });
    }
    for (const ch of chunks) ch.text = ch.text.replace(/\s+/g, ' ').trim();
    const text = chunks.map((ch) => ch.text).join(' ').trim();
    const rel = view ? (r.y - view[1]) / Math.max(1, view[3] - view[1]) : null;
    return { page: n, y: r.y, size: r.size, x0: r.parts[0].x0, x1: Math.max(...r.parts.map((p) => p.x1)), chunks: chunks.filter((ch) => ch.text), parts: r.parts, text, bold: r.parts.every((p) => p.bold), edge: rel == null ? null : rel < 0.14 || rel > 0.88 };
  }).filter((l) => l.text);
}

// The text of some parts of a line, with a space where there is a gap.
function joinParts(parts, size) {
  let out = '', x1 = null;
  for (const p of parts) {
    out += (x1 != null && p.x0 - x1 > size * 0.18 && !/\s$/.test(out) && !/^\s/.test(p.str) ? ' ' : '') + p.str;
    x1 = p.x1;
  }
  return out.replace(/\s+/g, ' ').trim();
}
const wordsIn = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const SEP = /^(.{1,70}?)\s*(?::|\s[–—-]\s|\s=\s|[–—]\s)\s*(\S.*)$/;
const MEANS = /^["“']?(.{1,70}?)["”']?\s+(?:means|shall mean|refers to|is defined as|denotes|stands for)\s+(\S.*)$/i;
const NUMBERED = /^(\d+(?:\.\d+)+)\.?(?:\s+(\S.*))?$/;
// The start of a line that continues a definition and is never a term: a note, an example, a cross reference.
const NOT_TERM = /^(?:notes?|examples?|syn|synonyms?|see|see also|contrast|compare|cf|figure|fig|table|source|where)\b/i;
const termOk = (t) => t && t.length <= 80 && wordsIn(t) <= 8 && /\p{L}/u.test(t) && !/[.!?]$/.test(t) && !NOT_TERM.test(t.trim());
const rectOf = (l) => [l.page, +l.x0.toFixed(2), +(l.y - l.size * 0.25).toFixed(2), +l.x1.toFixed(2), +(l.y + l.size * 0.85).toFixed(2)];
const joinLines = (a, b) => (/[a-z]-$/.test(a) && /^[a-z]/.test(b) ? a.slice(0, -1) + b : `${a} ${b}`);

// Read the entries of a terms section. lines: the section's lines in reading order (the heading left out).
export function parseEntries(lines) {
  const entries = [];
  const start = (term, def, line) => { entries.push({ term, def: def || '', lines: [line] }); };
  const more = (text, line) => { const e = entries[entries.length - 1]; if (e) { e.def = e.def ? joinLines(e.def, text) : text; e.lines.push(line); } };

  // Which layout? A table (term column, definition column), numbered entries (3.1 term / definition), or
  // "term: definition" lines.
  const twoCol = lines.filter((l) => l.chunks.length >= 2 && wordsIn(l.chunks[0].text) <= 8);
  const numbered = lines.filter((l) => NUMBERED.test(l.text));
  if (twoCol.length >= 3 && twoCol.length >= lines.length * 0.3) {
    // The definition column: the most usual left edge of the second chunk.
    const edges = new Map();
    for (const l of twoCol) { const k = Math.round(l.chunks[1].x0 / 4); edges.set(k, (edges.get(k) || 0) + 1); }
    const col = [...edges].sort((a, b) => b[1] - a[1])[0][0] * 4;
    const near = (x) => Math.abs(x - col) < 10;
    for (const l of lines) {
      const [c0, c1] = l.chunks;
      // A long term can come close to the definition column: split the line where a piece of text starts there.
      const k = (l.parts || []).findIndex((p, i) => i > 0 && near(p.x0));
      if (c1 && near(c1.x0) && c0.x0 < col - 10) start(c0.text, l.chunks.slice(1).map((c) => c.text).join(' '), l);
      else if (k > 0 && l.parts[0].x0 < col - 10) start(joinParts(l.parts.slice(0, k), l.size), joinParts(l.parts.slice(k), l.size), l);
      else if (near(c0.x0)) more(l.text, l);
      else if (c0.x0 < col - 10 && !c1 && entries.length && wordsIn(l.text) <= 4 && !entries[entries.length - 1].def) entries[entries.length - 1].term += ` ${l.text}`;
    }
  } else if (numbered.length >= 2) {
    let wantTerm = false;
    for (const l of lines) {
      const m = NUMBERED.exec(l.text);
      if (m) {
        const rest = m[2] || '';
        const s = SEP.exec(rest) || MEANS.exec(rest);
        if (s && termOk(s[1])) { start(s[1], s[2], l); wantTerm = false; }
        else if (rest) { start(rest, '', l); wantTerm = false; }
        else { start('', '', l); wantTerm = true; }
      } else if (wantTerm) { entries[entries.length - 1].term = l.text; entries[entries.length - 1].lines.push(l); wantTerm = false; }
      else more(l.text, l);
    }
  } else {
    const left = Math.min(...lines.map((l) => l.x0));
    for (const l of lines) {
      const m = SEP.exec(l.text) || MEANS.exec(l.text);
      const prev = entries[entries.length - 1];
      // A new entry starts at the left edge, after the last one ended (or where there is none yet).
      const fresh = !prev || /[.;)]$/.test(prev.def) || l.x0 <= left + 2 || l.chunks[0].bold;
      if (m && termOk(m[1].replace(/^[•▪◦·*-]\s*/, '')) && fresh) start(m[1], m[2], l);
      else more(l.text, l);
    }
  }
  return entries.map((e) => {
    let term = e.term.replace(/^[•▪◦·*-]\s*/, '').replace(/^["“']|["”']$/g, '').replace(/\s*[:–—-]$/, '').trim();
    const forms = [];
    // "Hearing Aid Compatibility (HAC)" -> the term, and HAC as another form.
    const paren = /^(.{2,}?)\s*\(([^()]{2,20})\)$/.exec(term);
    if (paren) { term = paren[1].trim(); forms.push(paren[2].trim()); }
    const def = e.def.replace(/\s+/g, ' ').trim();
    const first = e.lines[0];
    return { term, forms, def, page: first.page, rects: e.lines.filter((l) => l.page === first.page).map(rectOf) };
  }).filter((e) => termOk(e.term) && e.term.length > 1 && e.def.length > 1)
    // One entry for each term: the first one.
    .filter((e, i, all) => all.findIndex((x) => x.term.toLowerCase() === e.term.toLowerCase()) === i)
    .slice(0, 2000);
}

// Find the terms section of a document and read it. getLines(n): the lines of page n (1-based). outline: the
// PDF's own outline titles, when it has one ([{ title, page }]). Returns { title, page, entries } or null.
export async function findDefinitions(numPages, getLines, outline = []) {
  // A numbered heading has a clear end (the next number), so its section can be long. One with no number can not.
  const MAX_NUMBERED = 80, MAX_PLAIN = 8;
  // The pages to look at first: the ones the outline names, then all pages in order.
  const order = [...new Set([...outline.filter((o) => isTermsHeading(o.title) && o.page).map((o) => o.page), ...Array.from({ length: numPages }, (_, i) => i + 1)])];
  for (const n of order) {
    const lines = await getLines(n);
    const body = median(lines.map((l) => l.size));
    const i = lines.findIndex((l) => wordsIn(l.text) <= 9 && isTermsHeading(l.text) && (l.size >= body * 0.98 || l.bold));
    if (i < 0) continue;
    const head = lines[i], { num } = headingParts(head.text);
    // The numbers that the next heading of the same level (or a higher one) can have: after 3.1, 3.2 or 4.
    const nexts = new Set();
    if (/^\d+(\.\d+)*$/.test(num)) {
      const parts = num.split('.').map(Number);
      for (let d = parts.length; d >= 1; d--) nexts.add([...parts.slice(0, d - 1), parts[d - 1] + 1].join('.'));
    }
    const ends = (l) => {
      if (wordsIn(l.text) > 12 || /[.;,:]$/.test(l.text)) return false;
      if (/^(?:annex|appendix|bibliography|references|index)\b/i.test(l.text) && wordsIn(l.text) <= 8) return true;
      const h = headingParts(l.text);
      if (nexts.size) return !!h.title && nexts.has(h.num);
      return l.size > body * 1.08 && l.size >= head.size * 0.98;
    };
    const last = Math.min(numPages, n + (nexts.size ? MAX_NUMBERED : MAX_PLAIN) - 1);
    const pages = [lines.slice(i + 1)];
    for (let p = n + 1; p <= last; p++) pages.push(await getLines(p));
    // Lines near the top or the bottom edge that repeat at one height on the pages (a page header, a footer, a
    // download notice) are not text of the section. Numbers in them (the page number, a time) do not count.
    const key = (l) => `${Math.round(l.y / 4)}|${l.text.toLowerCase().replace(/\d+/g, '#')}`;
    const seen = new Map();
    pages.forEach((pl, k) => { for (const l of new Set(pl.map(key))) seen.set(l, (seen.get(l) || 0) + 1); });
    const need = pages.length >= 3 ? 3 : 2;
    const section = [];
    let done = false;
    for (const pl of pages) {
      for (const l of pl) {
        if (pages.length > 1 && l.edge !== false && seen.get(key(l)) >= need) continue;
        if (ends(l)) { done = true; break; }
        section.push(l);
      }
      if (done) break;
    }
    const entries = parseEntries(section);
    if (entries.length) return { title: head.text, page: n, entries };
  }
  return null;
}
function median(list) {
  if (!list.length) return 10;
  const s = [...list].sort((a, b) => a - b);
  return s[s.length >> 1];
}

// A selection to a first guess of { term, def }: a short selection is the term, "term: definition" is split,
// anything else is the definition.
export function guessEntry(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (wordsIn(t) <= 6 && t.length <= 60) return { term: t.replace(/[.,;:]$/, ''), def: '' };
  const m = SEP.exec(t) || MEANS.exec(t);
  if (m && termOk(m[1])) return { term: m[1].replace(/^["“']|["”']$/g, ''), def: m[2] };
  return { term: '', def: t };
}
