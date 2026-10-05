// Export a board as one self-contained HTML file: cards, arrows, images and (optionally) source PDFs.
// The file has its own small viewer: pan, zoom, search, focus on a card, travel along arrows, choices (one
// branch at a time), links between cards and between words, and the terms of the dictionary.

const toDataUrl = async (url) => {
  // A doc that the user wrote gets a new PDF at each change, at the same address: take it from the server, not from the cache.
  const blob = await (await fetch(url, /\.pdf$/.test(url) ? { cache: 'reload' } : {})).blob();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// A card's links, as the board lists them on the card (the same order as the buttons).
const cardLinks = (c) => [...(c.snipLinks || []), ...(c.snipSubs || []).flatMap((s) => (s.links || []).map((l) => ({ ...l, sub: s.id })))];
const MAX_STATES = 400, MAX_TRIES = 3000;

// Choices: the board shows one branch of a choice at a time, and the arrows go other ways for each branch.
// The file holds every view that the buttons of the choices can make: which cards are off the board, and the
// arrows and labels of that view. Arrows that are the same in many views are in the file one time (the pool).
function choiceStates(board, onProgress) {
  const data = board.data, choices = data.cards.filter((c) => c.choice);
  const pool = [], at = new Map();
  const put = (node) => {
    const n = node.cloneNode(true);
    for (const x of [n, ...n.querySelectorAll('*')]) { x.classList?.remove('selected', 'dim', 'iso-out', 'hot'); x.removeAttribute?.('contenteditable'); }
    const html = n.outerHTML;
    if (!at.has(html)) { at.set(html, pool.length); pool.push(html); }
    return at.get(html);
  };
  const first = new Map(choices.map((c) => [c.id, c.choice.pick || null]));
  const set = (picks) => {
    for (const c of choices) c.choice = { pick: picks.get(c.id) || null };
    board.branchSig = null; // draw the arrows again, also when the same cards show
    board.applyFilter();
  };
  const states = [], seen = new Set(), tried = new Set(), queue = [first];
  let tries = 0;
  while (queue.length && states.length < MAX_STATES && tries < MAX_TRIES) {
    const picks = queue.shift(), full = choices.map((c) => picks.get(c.id) || '').join('|');
    if (tried.has(full)) continue;
    tried.add(full);
    tries++;
    set(picks);
    const br = board.branch, shown = choices.filter((c) => !br.off.has(c.id));
    // Two sets of picks give the same view when they differ only in a choice that is off the board.
    const key = shown.map((c) => `${c.id}=${picks.get(c.id) || ''}`).join(';');
    for (const c of shown) for (const p of [null, ...board.optionsOf(c)]) if (p !== (picks.get(c.id) || null)) queue.push(new Map(picks).set(c.id, p));
    if (seen.has(key)) continue;
    seen.add(key);
    states.push({
      picks: Object.fromEntries(shown.map((c) => [c.id, picks.get(c.id) || null])),
      off: [...br.off], ghost: [...br.ghost],
      // An option card: [its choice, 1 when its branch shows, 1 in the All view, the colour of its arrow].
      opt: Object.fromEntries([...br.opts].map(([id, o]) => [id, [o.choice, o.picked ? 1 : 0, o.all ? 1 : 0, o.colour || '']])),
      links: [...board.svg.children].map(put), labels: [...board.labelsEl.children].map(put),
    });
    if (states.length % 10 === 0) onProgress?.(`Choices: ${states.length} views…`);
  }
  set(first); // back to the view that the board had
  return { states, pool, picks: Object.fromEntries(first), complete: !queue.some((p) => !tried.has(choices.map((c) => p.get(c.id) || '').join('|'))) };
}

export async function exportHtml(board, { embedPdfs = true, terms = [], onProgress } = {}) {
  const data = board.data;
  // Render every card, unfiltered, then copy the drawing.
  const saved = { iso: board.iso, query: board.query, sel: board.sel };
  let world, views;
  try {
    board.iso = null;
    board.query = '';
    views = choiceStates(board, onProgress);
    world = board.world.cloneNode(true);
  } finally {
    board.iso = saved.iso;
    board.branchSig = null;
    board.applySearch(saved.query);
    board.sel = saved.sel;
    board.updateSelection();
  }

  world.querySelectorAll('.handle, .resize, .guides').forEach((n) => n.remove());
  world.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
  // The viewer draws the arrows and the labels of the view that shows.
  world.querySelector('#strings').replaceChildren();
  world.querySelector('#labels').replaceChildren();
  const pdfs = {};
  const pdfOf = (id, name) => { if (id && !pdfs[id]) pdfs[id] = { name: name || 'a PDF', embed: false }; return pdfs[id]; };
  for (const c of data.cards) if (c.source) pdfOf(c.source.pdfId, c.source.name).embed = true;
  world.querySelectorAll('.card').forEach((n) => {
    n.classList.remove('selected', 'dim', 'iso-out', 'iso-root', 'flash', 'editing', 'dragging', 'link-target', 'hot');
    delete n.dataset.depth;
    const c = data.cards.find((x) => x.id === n.dataset.id);
    if (!c) return;
    for (const src of n.querySelectorAll('.source, .card-pdf')) {
      if (!c.source) continue;
      src.dataset.pdf = c.source.pdfId;
      src.dataset.page = c.source.page;
    }
    // The links in the list of a card: the card of the target when it is on the board, and its PDF.
    const links = cardLinks(c);
    for (const b of n.querySelectorAll('.slink, .slink-pdf')) {
      const l = links[+b.dataset.i];
      if (!l) continue;
      const to = l.to ? board.cardAt(l.toPdfId, l.to) : null;
      if (to) { b.dataset.card = to.card; if (to.sub) b.dataset.sub = to.sub; }
      pdfOf(l.toPdfId, l.toPdfName);
      b.dataset.pdf = l.toPdfId;
      b.dataset.page = (to && board.card(to.card)?.source?.page) || 1;
    }
    // The buttons of a choice: which choice, and which option ('' is All).
    if (c.choice) {
      const options = board.optionsOf(c);
      n.querySelectorAll(':scope > .choice-bar .choice-chip').forEach((chip, i) => { chip.dataset.choice = c.id; chip.dataset.pick = options[i] || ''; });
    }
  });
  world.style.transform = '';

  const imgs = [...world.querySelectorAll('img')];
  let done = 0;
  const cache = new Map();
  for (const img of imgs) {
    const src = img.getAttribute('src');
    if (!cache.has(src)) cache.set(src, await toDataUrl(src));
    img.setAttribute('src', cache.get(src));
    onProgress?.(`Embedding images ${++done}/${imgs.length}…`);
  }

  // The terms that the cards show, with their definitions.
  const used = new Set([...world.querySelectorAll('.term[data-term]')].map((n) => n.dataset.term));
  const dict = {};
  for (const t of terms) {
    if (!used.has(t.id)) continue;
    dict[t.id] = { term: t.term, forms: t.forms || [], def: t.def || '', scope: t.scope === 'global' ? 'Global term' : 'Project term' };
    if (t.source?.pdfId) { pdfOf(t.source.pdfId, t.source.name); dict[t.id].src = { pdf: t.source.pdfId, name: t.source.name || 'the PDF', page: t.source.page || 1 }; }
  }

  if (embedPdfs) {
    for (const [id, p] of Object.entries(pdfs)) {
      if (!p.embed) continue; // only the PDFs of the cards go in the file
      onProgress?.(`Embedding ${p.name}…`);
      p.data = (await toDataUrl(`/files/pdfs/${id}.pdf`)).split(',')[1];
    }
  }
  for (const p of Object.values(pdfs)) delete p.embed;

  // The note cards use the styles of the document editor. Its one font file (script letters in equations) stays out.
  const noteCss = (await (await fetch('/vendor/docedit/docedit.css')).text()).replace(/@font-face\s*{[^}]*}/g, '');
  const css = `${noteCss}\n${await (await fetch('/style.css')).text()}`;
  const payload = JSON.stringify({
    links: data.links.map((l) => ({ id: l.id, from: l.from, to: l.to, ...(l.fromSub ? { fromSub: l.fromSub } : {}), ...(l.toSub ? { toSub: l.toSub } : {}) })),
    pdfs, terms: dict, states: views.states, pool: views.pool, picks: views.picks,
  }).replace(/</g, '\\u003c');
  const title = data.name || 'Board';
  const stamp = new Date().toISOString().slice(0, 10);
  // The colours of the cards were made for the theme that shows now: the file keeps that theme.
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const nChoices = data.cards.filter((c) => c.choice).length;

  const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${css}
/* export viewer */
body { display: flex; flex-direction: column; }
.ex-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #1f2328; color: #f3f3f1; }
.ex-bar h1 { font-size: 14px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ex-bar .meta { color: #aeb3ba; font-size: 12px; white-space: nowrap; }
.ex-bar input, .ex-bar button { height: 28px; border: 1px solid #3a4048; border-radius: 7px; background: #2d3238; color: #e6e7e9; padding: 0 10px; font: inherit; }
.ex-bar button { cursor: pointer; }
.ex-bar .spacer { flex: 1; }
#boardPane { cursor: grab; }
#boardPane.panning { cursor: grabbing; }
.card { cursor: pointer; }
.source[data-pdf], .card-pdf[data-pdf] { cursor: pointer; }
.ex-hint { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 6px 12px; border-radius: 8px;
  background: var(--panel); border: 1px solid var(--line); color: var(--muted); font-size: 12px; pointer-events: none; }
.ex-hint.say { color: var(--ink); border-color: var(--line-strong); }
</style>
</head>
<body>
<div class="ex-bar">
  <h1>${esc(title)}</h1>
  <span class="meta">${data.cards.length} cards · ${data.links.length} links${nChoices ? ` · ${nChoices} ${nChoices === 1 ? 'choice' : 'choices'}` : ''} · exported ${stamp}</span>
  <span class="spacer"></span>
  <input id="q" type="search" placeholder="Search…" title="Enter goes to the next card that matches">
  <button id="fitBtn">Fit</button>
</div>
<section id="boardPane">
  <div id="world">${world.innerHTML}</div>
  <div class="ex-hint" id="exHint">Drag to pan · scroll or pinch to zoom · click a card to focus its links · double-click an arrow to travel · Esc clears</div>
</section>
<script type="application/json" id="corkboard-data">${payload}</script>
<script>
(${viewer.toString()})();
</script>
</body>
</html>`;
  const filename = `${title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'board'}.html`;
  return { html, filename, views: views.states.length, complete: views.complete };
}

// The viewer of an exported file. This function goes into the file as text, so it can use only what the file has.
function viewer() {
  const D = JSON.parse(document.getElementById('corkboard-data').textContent);
  const pane = document.getElementById('boardPane'), world = document.getElementById('world');
  const strings = world.querySelector('#strings'), labels = world.querySelector('#labels'), hint = document.getElementById('exHint');
  const cards = [...world.querySelectorAll('.card')];
  const byId = new Map(cards.map((c) => [c.dataset.id, c]));
  const v = { x: 0, y: 0, z: 1 };
  const apply = () => {
    world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.z})`;
    pane.style.backgroundPosition = `${v.x}px ${v.y}px`;
    pane.style.backgroundSize = `${24 * v.z}px ${24 * v.z}px`;
  };
  const box = (c) => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });
  const centre = (cx, cy, z) => {
    const r = pane.getBoundingClientRect();
    v.z = z; v.x = r.width / 2 - cx * z; v.y = r.height / 2 - cy * z; apply();
  };
  const onBoard = (c) => !c.classList.contains('br-off');
  const fit = (list) => {
    list = list && list.length ? list : cards.filter(onBoard);
    if (!list.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const c of list) { const b = box(c); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const r = pane.getBoundingClientRect();
    centre((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.1, Math.min(1.5, Math.min(r.width / (x1 - x0 + 120), r.height / (y1 - y0 + 120)))));
  };
  const help = hint.textContent;
  let sayTimer = 0;
  const say = (msg) => {
    clearTimeout(sayTimer);
    hint.textContent = msg;
    hint.classList.add('say');
    sayTimer = setTimeout(() => { hint.textContent = help; hint.classList.remove('say'); }, 3500);
  };

  // Choices: P is the option that each choice has now (null: all of them). S is the view for P.
  const P = { ...D.picks };
  let S = null, focused = null;
  const fits = (s, picks) => Object.keys(s.picks).every((k) => (picks[k] || null) === s.picks[k]);
  const viewFor = (picks) => D.states.filter((s) => fits(s, picks)).sort((a, b) => Object.keys(b.picks).length - Object.keys(a.picks).length)[0] || null;
  function show() {
    const s = viewFor(P);
    if (!s) return false;
    S = s;
    const off = new Set(s.off), ghost = new Set(s.ghost);
    for (const c of cards) {
      const id = c.dataset.id, o = s.opt[id];
      c.classList.toggle('br-off', off.has(id));
      c.classList.toggle('br-ghost', ghost.has(id));
      c.classList.toggle('br-opt', !!o);
      c.classList.toggle('br-opt-off', !!o && !o[1] && !o[2]);
    }
    strings.innerHTML = s.links.map((i) => D.pool[i]).join('');
    labels.innerHTML = s.labels.map((i) => D.pool[i]).join('');
    for (const chip of world.querySelectorAll('.choice-chip[data-choice]')) {
      chip.classList.toggle('on', (P[chip.dataset.choice] || '') === chip.dataset.pick);
      // The dot of an option has the colour of its arrow in this view.
      const o = s.opt[chip.dataset.pick], colour = o && o[0] === chip.dataset.choice ? o[3] : '';
      let dot = chip.querySelector('.choice-dot');
      if (colour && !dot) { dot = document.createElement('span'); dot.className = 'choice-dot'; chip.prepend(dot); }
      if (dot) { if (colour) dot.style.background = colour; else dot.remove(); }
    }
    focus(focused && !off.has(focused) ? focused : null);
    return true;
  }
  function pick(choice, option) {
    const before = P[choice];
    P[choice] = option || null;
    if (show()) return;
    P[choice] = before;
    say('This file does not hold that combination of choices.');
  }
  // Show the branch that a card is in: the view that has the card, with the fewest choices changed.
  function reveal(id) {
    if (!S || !S.off.includes(id)) return true;
    const cost = (s) => Object.keys(s.picks).filter((k) => (P[k] || null) !== s.picks[k]).length;
    // With the same number of changes: the view of one option, before the All view (where the card is see-through).
    const faint = (s) => (s.ghost.includes(id) ? 1 : 0);
    const best = D.states.filter((s) => !s.off.includes(id)).sort((a, b) => cost(a) - cost(b) || faint(a) - faint(b))[0];
    if (!best) return false;
    Object.assign(P, best.picks);
    return show();
  }
  // Go to a card (and to a marked word in it).
  function go(id, sub) {
    const c = byId.get(id);
    if (!c || !reveal(id)) return say('That card is not in a view of this file.');
    const b = box(c);
    centre(b.x + b.w / 2, b.y + b.h / 2, Math.max(v.z, 0.8));
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
    const word = sub && [...c.querySelectorAll('mark.sub')].find((m) => m.dataset.sub === sub);
    if (word) { word.classList.add('hot'); setTimeout(() => word.classList.remove('hot'), 1600); }
  }

  // Pan and zoom.
  pane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.card, .link, .link-label')) return;
    const sx = e.clientX, sy = e.clientY, ox = v.x, oy = v.y;
    pane.setPointerCapture(e.pointerId);
    pane.classList.add('panning');
    const move = (ev) => { v.x = ox + ev.clientX - sx; v.y = oy + ev.clientY - sy; apply(); };
    const up = () => { pane.removeEventListener('pointermove', move); pane.removeEventListener('pointerup', up); pane.classList.remove('panning'); if (Math.hypot(v.x - ox, v.y - oy) < 3) focus(null); };
    pane.addEventListener('pointermove', move);
    pane.addEventListener('pointerup', up);
  });
  pane.addEventListener('wheel', (e) => {
    if (e.target.closest('.term-tip')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = pane.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const nz = Math.max(0.1, Math.min(4, v.z * Math.exp(-e.deltaY * 0.01)));
      v.x = px - (px - v.x) * nz / v.z; v.y = py - (py - v.y) * nz / v.z; v.z = nz;
    } else { v.x -= e.deltaX; v.y -= e.deltaY; }
    apply();
  }, { passive: false });

  // Focus: a card and the cards one link away.
  function focus(id) {
    focused = id;
    const keep = new Set(id ? [id] : []);
    if (id) for (const l of D.links) { if (l.from === id) keep.add(l.to); if (l.to === id) keep.add(l.from); }
    for (const c of cards) { c.classList.toggle('iso-out', !!id && !keep.has(c.dataset.id)); c.classList.toggle('iso-root', c.dataset.id === id); }
    for (const n of world.querySelectorAll('.link, .link-label')) {
      const l = D.links.find((x) => x.id === n.dataset.id);
      n.classList.toggle('iso-out', !!id && !!l && !(keep.has(l.from) && keep.has(l.to)));
    }
  }
  // The arrow of a marked word: the card and the word at its other end.
  const otherEnd = (cardId, sub) => {
    for (const l of D.links) {
      if (l.from === cardId && l.fromSub === sub) return { link: l.id, card: l.to, sub: l.toSub };
      if (l.to === cardId && l.toSub === sub) return { link: l.id, card: l.from, sub: l.fromSub };
    }
    return null;
  };
  world.addEventListener('click', (e) => {
    const chip = e.target.closest('.choice-chip[data-choice]');
    if (chip) return pick(chip.dataset.choice, chip.dataset.pick);
    const src = e.target.closest('.source[data-pdf], .card-pdf[data-pdf]');
    if (src) return openPdf(src.dataset.pdf, src.dataset.page);
    // A link in the list of a card: to its card when the card is on the board, else to the PDF.
    const row = e.target.closest('.slink, .slink-pdf');
    if (row) return row.classList.contains('slink') && row.dataset.card ? go(row.dataset.card, row.dataset.sub) : openPdf(row.dataset.pdf, row.dataset.page);
    const card = e.target.closest('.card');
    if (!card) return;
    const word = e.target.closest('mark.sub'), end = word && otherEnd(card.dataset.id, word.dataset.sub);
    if (end) return go(end.card, end.sub);
    // A click on an option card of a choice shows its branch.
    const o = S && S.opt[card.dataset.id];
    if (o && !o[1]) return pick(o[0], card.dataset.id);
    focus(focused === card.dataset.id ? null : card.dataset.id);
  });
  // A marked word lights its arrow and the word at the other end.
  world.addEventListener('mouseover', (e) => {
    const word = e.target.closest('mark.sub'), card = word && word.closest('.card');
    for (const n of world.querySelectorAll('.hot')) n.classList.remove('hot');
    const end = card && otherEnd(card.dataset.id, word.dataset.sub);
    if (!end) return;
    for (const n of strings.querySelectorAll('.link')) if (n.dataset.id === end.link) n.classList.add('hot');
    const there = byId.get(end.card), mark = there && end.sub && [...there.querySelectorAll('mark.sub')].find((m) => m.dataset.sub === end.sub);
    (mark || there)?.classList.add('hot');
  });

  // Travel: double-click an arrow to go to the end that is not focused (or the farther end).
  world.addEventListener('dblclick', (e) => {
    const n = e.target.closest('.link');
    const l = n && D.links.find((x) => x.id === n.dataset.id);
    if (!l || !byId.get(l.from) || !byId.get(l.to)) return;
    const r = pane.getBoundingClientRect(), mid = { x: (r.width / 2 - v.x) / v.z, y: (r.height / 2 - v.y) / v.z };
    const c = (id) => { const b = box(byId.get(id)); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
    let to = focused === l.from ? l.to : focused === l.to ? l.from : null;
    if (!to) { const a = c(l.from), b = c(l.to); to = Math.hypot(a.x - mid.x, a.y - mid.y) > Math.hypot(b.x - mid.x, b.y - mid.y) ? l.from : l.to; }
    const p = c(to);
    centre(p.x, p.y, Math.max(v.z, 0.6));
    if (focused) focus(to);
  });

  // Search dims cards that do not match. Enter goes to the next match, also when it is in another branch.
  const q = document.getElementById('q');
  let found = [], foundAt = -1;
  q.addEventListener('input', () => {
    const text = q.value.trim().toLowerCase();
    found = [];
    foundAt = -1;
    for (const c of cards) {
      const hit = !text || c.textContent.toLowerCase().includes(text);
      c.classList.toggle('dim', !hit);
      if (text && hit) found.push(c.dataset.id);
    }
  });
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !found.length) return;
    foundAt = (foundAt + (e.shiftKey ? found.length - 1 : 1)) % found.length;
    go(found[foundAt]);
    say(`Match ${foundAt + 1} of ${found.length}`);
  });
  document.getElementById('fitBtn').onclick = () => fit(focused ? cards.filter((c) => onBoard(c) && !c.classList.contains('iso-out')) : null);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') focus(null); });

  // Terms of the dictionary: the definition shows when the pointer is on a word.
  const tip = document.createElement('div');
  tip.className = 'term-tip';
  tip.hidden = true;
  document.body.append(tip);
  let tipTimer = 0;
  const hideTip = () => { tipTimer = setTimeout(() => { tip.hidden = true; }, 250); };
  const part = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  world.addEventListener('mouseover', (e) => {
    const word = e.target.closest('.term[data-term]'), t = word && D.terms[word.dataset.term];
    if (!t) return;
    clearTimeout(tipTimer);
    const head = part('div', 'tt-head', '');
    head.append(part('span', 'tt-term', t.term));
    if (t.forms.length) head.append(part('span', 'tt-forms', t.forms.join(', ')));
    const foot = part('div', 'tt-foot', '');
    foot.append(part('span', '', t.scope));
    if (t.src) {
      const b = part('button', 'tt-src', `↗ ${t.src.name} · p.${t.src.page}`);
      b.onclick = () => openPdf(t.src.pdf, t.src.page);
      foot.append(b);
    }
    tip.replaceChildren(head, part('div', 'tt-def', t.def), foot);
    tip.hidden = false;
    const r = word.getBoundingClientRect(), w = tip.offsetWidth, ht = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    tip.style.top = `${r.bottom + 6 + ht > innerHeight ? Math.max(8, r.top - ht - 6) : r.bottom + 6}px`;
  });
  world.addEventListener('mouseout', (e) => { if (e.target.closest('.term[data-term]')) hideTip(); });
  tip.addEventListener('mouseenter', () => clearTimeout(tipTimer));
  tip.addEventListener('mouseleave', hideTip);

  // Sources: open the embedded PDF at the page, when the export included it.
  const urls = {};
  function openPdf(id, page) {
    const p = D.pdfs[id];
    if (!p || !p.data) return say(`This file does not include ${p ? p.name : 'that PDF'}.`);
    if (!urls[id]) {
      const bin = atob(p.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      urls[id] = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    }
    window.open(`${urls[id]}#page=${page || 1}`, '_blank');
  }

  apply();
  show();
  requestAnimationFrame(() => fit());
}
