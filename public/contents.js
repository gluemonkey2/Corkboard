// Sections from the contents page of a PDF: read the lines "2.1 Basic Considerations ........ 4", then find
// where each heading starts in the text.

const FIRST_PAGES = 40;   // a contents page is in the first pages of a document
const MIN_ENTRIES = 5;    // fewer lines with a page number than this: not a contents page
const ROMAN = /^[ivxlc]{1,7}$/i;

// "4.2.1", "A.1", "Appendix A", "Annex B:", "Chapter 3" at the start of a title.
const NUM = /^((?:\d+(?:\.\d+)*\.?)|(?:[A-Z]\.\d+(?:\.\d+)*\.?)|(?:(?:appendix|annex|chapter|part|section|clause)\s+[A-Z0-9]+(?:\.\d+)*[.:]?))(?:\s+(.*))?$/i;
export function numberOf(text) {
  const m = NUM.exec(text.trim());
  if (!m) return { num: '', title: text.trim() };
  return { num: m[1].replace(/[.:]$/, ''), title: (m[2] || '').trim() };
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// One line of a contents page to { text, printed } (printed: the page number as it is written), or null.
function entryOf(line) {
  // With leaders: "Title ........ 12".
  let m = /^(.*?\S)\s*(?:[.·…_]\s*){3,}\s*(\d{1,4}|[ivxlc]{1,7})$/i.exec(line.text);
  if (m) return { text: m[1].trim(), printed: m[2] };
  // No leaders: the page number is a column of its own at the right.
  const ch = line.chunks;
  if (ch.length >= 2 && /^(\d{1,4}|[ivxlc]{1,7})$/i.test(ch[ch.length - 1].text)) {
    const text = ch.slice(0, -1).map((c) => c.text).join(' ').replace(/(?:\s*[.·…_]){3,}\s*$/, '').trim();
    if (text.length > 1 && /[a-z]/i.test(text)) return { text, printed: ch[ch.length - 1].text };
  }
  return null;
}

// The entries of the contents pages of a document: [{ num, title, printed, level }]. getLines(n): the lines of
// page n (1-based). Returns { pages: [n, …], entries } or null when the document has no contents page.
export async function findContents(numPages, getLines) {
  const pages = [], raw = [];
  for (let n = 1; n <= Math.min(numPages, FIRST_PAGES); n++) {
    const lines = (await getLines(n)).filter((l) => !l.edge || entryOf(l));
    const got = [];
    let pending = [], prev = null; // prev: the last entry and the last line of its title
    const near = (above, below) => above.y - below.y <= Math.max(above.size, below.size) * 1.7;
    // Lines with no page number below an entry, when no later entry took them: the rest of a title whose page
    // number is on its first line.
    const giveBack = (left) => {
      for (const p of left) {
        if (!prev || numberOf(p.text).num || !near(prev.line, p) || p.x0 < prev.entry.x0 - 2 || p.text.length > 140) { prev = null; return; }
        prev.entry.title = `${prev.entry.title} ${p.text}`.trim();
        prev.line = p;
      }
    };
    for (const l of lines) {
      const e = entryOf(l);
      if (!e) { pending.push(l); if (pending.length > 3) giveBack([pending.shift()]); continue; }
      // A title on two or three lines: the lines before this one that are near it and have no page number.
      const own = numberOf(e.text).num;
      let parts = [], below = l;
      for (let k = pending.length - 1; k >= 0 && !own; k--) {
        const p = pending[k];
        if (!near(p, below)) break;
        parts.unshift(p);
        below = p;
        if (numberOf(p.text).num) break;
      }
      // Lines with no number in front join only when this line reads as the rest of a sentence.
      if (parts.length && !numberOf(parts[0].text).num && !/^[a-z(]/.test(e.text)) parts = [];
      giveBack(pending.filter((p) => !parts.includes(p)));
      const first = parts[0] || l;
      const entry = { ...numberOf([...parts.map((p) => p.text), e.text].join(' ')), printed: e.printed, x0: first.x0, size: l.size };
      got.push(entry);
      prev = { entry, line: l };
      pending = [];
    }
    giveBack(pending);
    if (got.length >= (pages.length ? 3 : MIN_ENTRIES)) { pages.push(n); raw.push(...got); }
    else if (pages.length) break; // the contents pages are together
  }
  if (!pages.length) return null;
  const entries = raw.filter((e) => (e.title || e.num) && norm(e.num + e.title).length > 1);
  // Page numbers go up through a contents list. A list where they do not is something else (an index, a table).
  const nums = entries.filter((e) => /^\d+$/.test(e.printed)).map((e) => +e.printed);
  const rising = nums.filter((v, i) => i === 0 || v >= nums[i - 1]).length;
  if (nums.length < MIN_ENTRIES || rising < nums.length * 0.85) return null;
  setLevels(entries);
  return { pages, entries };
}

// Levels 1 to 3: from the number ("4.2.1" is level 3), or from the indent for a title with no number.
function setLevels(entries) {
  const byLevel = new Map();
  for (const e of entries) {
    if (/^(?:\d+|[A-Z])(?:\.\d+)*$/.test(e.num)) e.level = Math.min(3, e.num.split('.').length);
    else if (e.num) e.level = 1; // Appendix A, Chapter 3
    if (e.level) { if (!byLevel.has(e.level)) byLevel.set(e.level, []); byLevel.get(e.level).push(e.x0); }
  }
  const rest = entries.filter((e) => !e.level);
  if (!rest.length) return;
  if (byLevel.size) {
    const mid = [...byLevel].map(([level, xs]) => [level, xs.sort((a, b) => a - b)[xs.length >> 1]]);
    for (const e of rest) e.level = mid.reduce((best, cur) => (Math.abs(cur[1] - e.x0) < Math.abs(best[1] - e.x0) ? cur : best))[0];
    return;
  }
  // No numbers at all: each indent step is a level.
  const steps = [];
  for (const x of [...new Set(rest.map((e) => Math.round(e.x0)))].sort((a, b) => a - b)) if (!steps.length || x - steps[steps.length - 1] > 6) steps.push(x);
  for (const e of rest) e.level = Math.min(3, 1 + steps.reduce((best, x, i) => (Math.abs(x - e.x0) < Math.abs(steps[best] - e.x0) ? i : best), 0));
}

// The line on a page where the heading of an entry starts, or null.
function headingLine(lines, e) {
  const full = norm(e.num + e.title), title = norm(e.title);
  let fallback = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = norm(l.text);
    if (!t || entryOf(l)) continue;
    if (t === full || (title.length >= 4 && t === title)) return l;
    if (full.length >= 6 && t.startsWith(full) && t.length <= full.length + 12) return l;
    // A heading on two lines in the text: this line and the next one make the title.
    if (t.length >= 8 && full.startsWith(t) && lines[i + 1] && full.startsWith(t + norm(lines[i + 1].text).slice(0, full.length - t.length))) return l;
    // The number only ("4.2" and a short line): the title in the text can differ from the contents page.
    if (!fallback && e.num && /\d/.test(e.num) && numberOf(l.text).num.toLowerCase() === e.num.toLowerCase() && l.text.split(/\s+/).length <= 14 && !/[.;,]$/.test(l.text)) fallback = l;
  }
  return fallback;
}

// Where each entry starts: [{ title, page, y, level, found }]. labels: the page labels of the PDF, when it has them.
// onStep(done, total) reports progress.
export async function locateContents({ pages, entries }, numPages, getLines, labels = null, onStep = null) {
  const toc = new Set(pages), lastToc = pages[pages.length - 1];
  const cache = new Map();
  const linesOf = async (n) => { if (!cache.has(n)) cache.set(n, n >= 1 && n <= numPages && !toc.has(n) ? await getLines(n) : []); return cache.get(n); };
  const arabic = entries.filter((e) => /^\d+$/.test(e.printed));
  // The difference between the number printed on a page and its place in the file: the one that puts the most
  // of the first headings on their pages.
  const votes = new Map();
  const sample = arabic.filter((e) => norm(e.title).length >= 6).slice(0, 8);
  for (const e of sample) {
    for (let d = -3; d <= 60; d++) {
      const n = +e.printed + d;
      if (n < 1 || n > numPages) continue;
      if (headingLine(await linesOf(n), e)) votes.set(d, (votes.get(d) || 0) + 1);
    }
  }
  let shift = null;
  for (const [d, v] of votes) if (v >= 2 && (shift == null || v > votes.get(shift) || (v === votes.get(shift) && Math.abs(d) < Math.abs(shift)))) shift = d;
  const out = [];
  let done = 0;
  for (const e of entries) {
    onStep?.(++done, entries.length);
    const label = labels ? labels.findIndex((s) => s && s.toLowerCase() === e.printed.toLowerCase()) + 1 : 0;
    let guess = null;
    if (/^\d+$/.test(e.printed)) guess = shift != null ? +e.printed + shift : label || +e.printed;
    else if (label) guess = label;
    // Look at the page, then at the pages next to it. A page with a roman number: look through the front pages.
    const tries = guess != null ? [guess, guess + 1, guess - 1] : Array.from({ length: Math.min(numPages, lastToc + 12) }, (_, i) => i + 1);
    let hit = null;
    for (const n of tries) {
      const l = headingLine(await linesOf(n), e);
      if (l) { hit = { page: n, y: Math.round((l.y + l.size + 2) * 100) / 100 }; break; }
    }
    if (!hit && (guess == null || guess < 1 || guess > numPages)) continue; // no page to put it on
    const title = [e.num, e.title].filter(Boolean).join(' ');
    out.push({ title, level: e.level, page: hit ? hit.page : guess, y: hit ? hit.y : null, found: !!hit });
  }
  // A heading that was not found stays in the order of the contents page: it goes immediately after the entry
  // before it, when that one is on the same page.
  out.forEach((m, i) => { const b = out[i - 1]; if (!m.found && b && b.page === m.page && b.y != null) m.y = Math.round((b.y - 1) * 100) / 100; });
  return out;
}
