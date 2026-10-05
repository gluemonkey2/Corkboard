// Watching the sources: has a web page changed since its snapshot, and what status does a catalogue page declare
// for a standard (current, superseded, withdrawn)? The page text comes from capture.pageText (the desktop app).

// Letters and digits only, in lower case: a snippet is "still on the page" when its words are there in order,
// whatever the page did to spaces, line breaks and punctuation.
const flat = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const WITHDRAWN = /\b(withdrawn|inactive|obsolete|cancell?ed|retired|rescinded|discontinued)\b/i;
const SUPERSEDED = /\b(superseded|superceded|replaced|revised by|historical|historic)\b/i;
const CURRENT = /\b(active|current|published|in force|approved|valid)\b/i;
const classify = (s) => (WITHDRAWN.test(s) ? 'withdrawn' : SUPERSEDED.test(s) ? 'superseded' : CURRENT.test(s) ? 'current' : null);

// The status that a page declares. First a line that names it ("Status: Inactive-Withdrawn", or "Status" with
// the value on the next line). Else a short line or a plain sentence that says the document is withdrawn or
// superseded: that is a weaker sign (weak: true). Returns { status, line, weak } (status null when none).
function statusFrom(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:document |standard |publication |current )?status\s*[:\-–—]?\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const value = (m[1] || lines[i + 1] || '').slice(0, 120);
    const status = classify(value);
    if (status) return { status, line: value, weak: false };
  }
  for (const l of lines) {
    if (l.length > 160) continue;
    const short = l.split(/\s+/).length <= 5;
    const says = /\b(?:this|the) (?:standard|document|publication|edition|version) (?:has been|is|was) (withdrawn|superseded|replaced|cancell?ed)\b/i.test(l);
    if ((short && (WITHDRAWN.test(l) || SUPERSEDED.test(l)) && !/\bactive\b/i.test(l.replace(/inactive/gi, ''))) || says) {
      return { status: WITHDRAWN.test(l) ? 'withdrawn' : 'superseded', line: l.slice(0, 120), weak: true };
    }
  }
  return { status: null, line: '', weak: false };
}

// Which snippets are no longer on the page: [{ id, text }] -> ids.
function missingSnippets(pageText, snippets) {
  const page = flat(pageText);
  return snippets.filter((s) => { const t = flat(s.text); return t.length >= 8 && !page.includes(t); }).map((s) => s.id);
}

module.exports = { flat, statusFrom, missingSnippets };
