import { api, uploadPdf, uploadImage, captureFile, captureWeb } from './api.js';
import { Board, PALETTES } from './board.js';
import { PdfView, DRAG_TYPE, snippetItem, setDragData, HL_COLORS, locateRange, setPdfRevs, relocateSnippets } from './pdfview.js';
import { createEditor } from '/vendor/docedit/docedit.js';
import { exportHtml } from './export.js';
import { askText, askConfirm } from './ask.js';
import { initAutoscroll } from './autoscroll.js';
import { buildMatcher, decorateTerms, guessEntry, formsOf } from './terms.js';
import { parentOf, excerpt, LINK_LABELS, sectionPathOf, fillSnipText, plainSnipText, locateSub, inside } from './snips.js';

const $ = (s) => document.querySelector(s);
// Settings kept in this browser. Keys used to start with "pepe." (the app's old name): those are read once and moved.
const store = {
  get(k) {
    try {
      const v = localStorage.getItem(k);
      if (v != null || !k.startsWith('corkboard.')) return v;
      const old = localStorage.getItem(`pepe.${k.slice(10)}`);
      if (old != null) localStorage.setItem(k, old);
      return old;
    } catch { return null; }
  },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let reviewTimer = null; // a short wait before the review list is drawn again
// Windows of this app talk to each other, so Read and Board can sit on two screens.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('corkboard') : null;
const windowId = crypto.randomUUID();
const post = (msg) => channel?.postMessage({ ...msg, from: windowId });

let statusAt = 0; // a save does not cover a message shown in the last few seconds
function status(msg, cls = '') {
  if (msg !== 'Saved') statusAt = Date.now();
  const s = $('#status');
  s.textContent = msg;
  s.className = cls;
}
function fail(err) {
  console.error(err);
  status(`⚠ ${err.message || err}`, 'err');
}

// ---------- views ----------
const VIEWS = ['projects', 'read', 'board'];
function setView(v) {
  if (!VIEWS.includes(v)) v = 'read';
  if (v !== 'projects' && !project) v = 'projects'; // Read and Board need an open project (or the library)
  if (v === 'board' && project?.library) { status('Boards belong to projects. Add this PDF to a project to use it on a board.'); v = 'read'; }
  if (v === 'board' && project?.kind === 'review') v = 'read'; // a review has no board
  if (docEdit && v !== 'read') finishDocEdit().catch(fail); // a doc that is open in the editor is saved first
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('active', b.dataset.view === v);
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  if (v === 'board') { board.scheduleLinks(); renderTray(); }
  if (v === 'read') { pdf.shown(); if (tabs[tabAt]?.pending) placeTab(); board.setGravity(false); renderFiles(); } // the Files panel is not drawn while the Projects view shows
  if (v === 'projects') { board.setGravity(false); loadProjects().then(() => showLibTab(libTab)).catch(fail); }
}
$('#views').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.view; if (v) setView(v); });
function popout() {
  const other = document.body.dataset.view === 'board' ? 'read' : 'board';
  window.open(`${location.pathname}#${other}`, `corkboard-${other}`, 'popup=no');
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));

// ---------- board ----------
const board = new Board({
  ask: askText,
  pane: $('#boardPane'), world: $('#world'), cardsEl: $('#cards'), svg: $('#strings'), framesEl: $('#frames'),
  labelsEl: $('#labels'), hint: $('#boardHint'),
  onChange: (kind) => {
    scheduleSave();
    if (kind !== 'view') { pdf.renderHighlights(); pdf.renderList(); renderTray(); }
  },
  onSelect: () => renderSwatches(),
  onTool: (t) => {
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
    renderSwatches();
  },
  onOpenSource: (card) => openSource(card.source),
  onMarkText: (card, start, end, rect) => markMenu(card, { start, end }, rect),
  onMoveHighlights: (card) => moveHighlightsToCards([{ cardId: card.id, subIds: (card.snipSubs || []).map((x) => x.id) }]).catch(fail),
  onMarkClick: (card, subId, rect) => markMenu(card, { subId }, rect),
  onDecorate: (el, c) => decorateCard(el, c),
  sourceFlag: (c) => (c.source ? sourceFlag(c.source.pdfId, c.source.hl) : null),
  onMarkBox: (card, box, rect) => { document.querySelector('.mark-menu')?.remove(); boardMarkMenu(card, { box }, null, rect); },
  onCardLink: (card, l, where, rect) => (where === 'pdf' ? openLinkTarget(l.toPdfId, l.to) : showLinkPopup(card, [l], rect)).catch(fail),
  // A marked word: its own links and the links into it. With none, the board goes along its arrow.
  onSubPopup: (card, subId, links, rect) => showLinkPopup(card, links, rect, { pdfId: card.source.pdfId, id: subId })
    .then((shown) => { if (!shown) board.travelSub(card.id, subId); }).catch(fail),
  onNotice: (msg) => status(msg),
  onIso: (iso) => {
    for (const b of document.querySelectorAll('#isoBtns button')) b.classList.toggle('active', +b.dataset.depth === (iso?.depth || 0));
    status(iso ? `Focus: ${board.isoSet?.size || 1} cards within ${iso.depth} link${iso.depth > 1 ? 's' : ''}` : '');
  },
  onGravity: (state) => {
    $('#gravityStop').hidden = !board.gravity.running;
    $('#gravityStop').classList.toggle('settled', state === 'settled');
    $('#gravityItem').classList.toggle('checked', board.gravity.running);
    if (state === true) status('Gravity on — drag cards to steer, G to stop');
    if (state === 'settled') status('Gravity: settled');
    if (state === false) status('Gravity off');
  },
});

// ---------- reader ----------
let pdfList = [];
const pdf = new PdfView({
  scroller: $('#pdfScroll'), pagesEl: $('#pdfPages'), emptyEl: $('#pdfEmpty'),
  listEl: $('#hlList'), menuEl: $('#hlMenu'),
  getOnBoard: (id) => board.highlightCards(id),
  onFindOnBoard: (cardId) => { setView('board'); board.focusCard(cardId); },
  onListChange: (n) => {
    $('#hlCount').textContent = n ? `(${n})` : '';
    if (project?.kind === 'review') { clearTimeout(reviewTimer); reviewTimer = setTimeout(() => renderReview().catch(fail), 150); }
  },
  outlineEl: $('#outlineList'),
  onOutlineChange: (n) => { $('#secCount').textContent = n ? `(${n})` : ''; },
  onAskSection: async (page) => {
    const title = await askText(`New section starting on page ${page}`, '', { okLabel: 'Add', placeholder: 'Section title' });
    if (title) pdf.addSection({ title, page, y: null, level: 1 });
  },
  onRenameSection: async (sec) => {
    const title = await askText('Rename section', sec.title, { okLabel: 'Rename' });
    if (title) pdf.updateSection(sec, { title });
  },
  onFindChange: () => { if (!$('#findBar').hidden) findCount(pdf.findHits?.length || 0); },
  onOpened: (meta) => {
    $('#editDocBtn').hidden = !isDoc(meta);
    pdf.setTermMatcher(dict.project.length || dict.global.length ? matcherFor(meta.id) : null);
    if (found && found.pdfId !== meta.id) found = null;
    renderTerms();
    detectTerms().catch(fail);
    if (sideTab === 'details') renderDetails().catch(fail);
    if (!$('#findBar').hidden && $('#findInput').value.trim()) runFind().catch(fail); // find again in the new PDF
  },
  onPickLink: (h) => pickLink(h).catch(fail),
  flagOf: (h) => (h.lost ? { text: 'not in the doc now', title: 'The doc changed, and these words are not in it any more. The snippet keeps its old place.' } : sourceFlag(pdf.meta?.id, h.id)),
  onTermHover: (t, rect) => (t ? showTermTip(t, rect) : hideTermTip()),
  onDefineTerm: (p) => {
    const g = guessEntry(p.text);
    openTermDialog({ term: g.term, forms: [], def: g.def, scope: hasProject() ? 'project' : 'global', source: { pdfId: pdf.meta.id, name: pdf.meta.name, page: p.page, rects: p.rects } }, true);
  },
  onOpenLink: (pdfId, hlId) => openLinkTarget(pdfId, hlId).catch(fail),
  onStatus: (msg) => status(msg),
  onSaved: (pdfId) => { post({ type: 'snippets', pdfId }); loadSnippets().catch(fail); },
  onError: fail,
});

const inScope = (path) => (project?.library ? path : `${path}?project=${project.id}`);
async function loadPdfs(selectId) {
  if (!project) return;
  pdfList = await api('GET', inScope('/api/pdfs'));
  setPdfRevs(pdfList);
  const sel = $('#pdfSelect');
  sel.replaceChildren(new Option(pdfList.length ? '— choose a source —' : '— no sources here yet —', ''),
    ...pdfList.map((p) => new Option(p.name, p.id)));
  sel.value = selectId || (pdfList.some((p) => p.id === pdf.meta?.id) ? pdf.meta.id : '');
  renderTrayFilter();
  renderFiles();
  // The global folders list every PDF in the library: keep that list current too.
  api('GET', '/api/pdfs').then((list) => { allPdfs = list; setPdfRevs(list); if (scopeNow() === 'global') renderFiles(); }).catch(() => {});
}
// ---------- reader tabs ----------
// Each tab is a view of a PDF: which PDF, and where it is scrolled to. Two tabs can show the same PDF at different
// places. There is one reader: a change of tab opens the tab's PDF (if it is another one) and goes to its place.
let tabs = []; // [{ id, pdfId, name, r (scroll ratio), page, z (zoom, when it is not fit-width) }]
let tabAt = -1;
const tabKey = () => `corkboard.tabs.${project.library ? '@library' : project.id}`;
function saveTabs() {
  if (!project) return;
  store.set(tabKey(), JSON.stringify({ at: tabAt, tabs: tabs.map(({ pdfId, name, r, page, z }) => ({ pdfId, name, r, page, z })) }));
}
// Remember where the open tab is, before the reader shows something else.
function keepTabPlace() {
  const t = tabs[tabAt], sc = $('#pdfScroll');
  if (!t || t.pending || pdf.meta?.id !== t.pdfId || !sc.clientWidth) return;
  t.r = sc.scrollTop / Math.max(1, sc.scrollHeight);
  t.page = pdf.currentPage();
  t.z = Math.abs(pdf.scale - pdf.fitScale()) > 0.01 ? pdf.scale : undefined;
}
function renderTabs() {
  const bar = $('#pdfTabs');
  bar.hidden = !tabs.length;
  bar.replaceChildren(...tabs.map((t, i) => {
    const b = mk('div', `pdf-tab${i === tabAt ? ' active' : ''}`);
    b.title = `${t.name} · page ${t.page || 1}`;
    b.append(mk('span', 'pt-name', t.name), mk('span', 'pt-page', `p.${t.page || 1}`));
    const x = mk('button', 'pt-close', '×');
    x.title = 'Close this tab';
    x.onclick = (e) => { e.stopPropagation(); closeTab(i).catch(fail); };
    b.append(x);
    b.onclick = () => showTab(i).catch(fail);
    b.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i).catch(fail); } };
    return b;
  }), Object.assign(mk('button', 'pt-new', '＋'), { title: 'New tab: a second view of this PDF, at the same place. Then scroll it, or pick another PDF', onclick: () => newTab().catch(fail) }));
}
// Show tab i: open its PDF and go to its place.
async function showTab(i, { keep = true } = {}) {
  if (docEdit) await finishDocEdit({ reopen: false }); // another source opens: the doc is saved first
  if (keep) keepTabPlace();
  const t = tabs[i];
  if (!t) return;
  tabAt = i;
  renderTabs();
  const meta = pdfList.find((p) => p.id === t.pdfId) || (await api('GET', '/api/pdfs')).find((p) => p.id === t.pdfId);
  // A doc whose PDF was made again just now: the reader must not keep the pages from before.
  if (meta) { setPdfRevs([meta]); if ((await freshDoc(meta)) && pdf.meta?.id === meta.id) pdf.close(); }
  if (!meta) { tabs.splice(i, 1); tabAt = Math.min(tabAt, tabs.length - 1); renderTabs(); saveTabs(); throw new Error('That PDF is not in the library any more.'); }
  t.name = meta.name;
  $('#pdfSelect').value = pdfList.some((p) => p.id === t.pdfId) ? t.pdfId : '';
  if (pdf.meta?.id !== t.pdfId) status(`Opening ${meta.name}…`);
  await pdf.open(meta);
  if (tabs[tabAt] !== t) return; // another tab was shown while this one loaded
  if (project) store.set(`corkboard.pdf.${project.library ? '@library' : project.id}`, t.pdfId);
  status('');
  placeTab();
  renderTabs();
  saveTabs();
  renderFiles(); // the open file shows in the Files panel
}
// Put the reader at the open tab's zoom and place. While the reader is hidden it has no size: do it when it shows.
function placeTab() {
  const t = tabs[tabAt], sc = $('#pdfScroll');
  if (!t || pdf.meta?.id !== t.pdfId) return;
  if (!sc.clientWidth) { t.pending = true; return; }
  delete t.pending;
  pdf.setScale(t.z || pdf.fitScale());
  sc.scrollTop = (t.r || 0) * sc.scrollHeight;
}
async function newTab() {
  keepTabPlace();
  const t = tabs[tabAt];
  if (!t) return;
  tabs.splice(tabAt + 1, 0, { ...t, id: uid8() });
  await showTab(tabAt + 1, { keep: false });
}
async function closeTab(i) {
  if (i !== tabAt) keepTabPlace();
  tabs.splice(i, 1);
  if (!tabs.length) { tabAt = -1; pdf.close(); $('#pdfSelect').value = ''; if (project) store.set(`corkboard.pdf.${project.library ? '@library' : project.id}`, ''); renderTabs(); saveTabs(); return; }
  const was = tabAt;
  tabAt = i < was ? was - 1 : Math.min(was, tabs.length - 1);
  if (i === was) await showTab(tabAt, { keep: false });
  else { renderTabs(); saveTabs(); }
}
// A PDF left the project or the library: its tabs go.
async function dropTabsOf(pdfId) {
  const cur = tabs[tabAt];
  tabs = tabs.filter((t) => t.pdfId !== pdfId);
  if (pdf.meta?.id === pdfId) pdf.close();
  tabAt = tabs.indexOf(cur);
  if (tabAt < 0) { tabAt = tabs.length ? 0 : -1; if (tabs.length) await showTab(0, { keep: false }); }
  renderTabs();
  saveTabs();
}
// The tabs of the project that was just opened.
function loadTabs() {
  tabs = []; tabAt = -1;
  try {
    const saved = JSON.parse(store.get(tabKey()) || 'null');
    tabs = (saved?.tabs || []).filter((t) => project.library || pdfList.some((p) => p.id === t.pdfId)).map((t) => ({ ...t, id: uid8() }));
    tabAt = tabs.length ? clamp(saved.at | 0, 0, tabs.length - 1) : -1;
  } catch { /* no saved tabs */ }
  renderTabs();
}
// Open a PDF in the reader. here: in the open tab, always (the PDF list does this). Otherwise the open tab if it
// shows this PDF, else another tab that shows it, else the open tab changes to it.
async function openPdf(id, page, rects, { here = false } = {}) {
  keepTabPlace();
  let i = tabs[tabAt]?.pdfId === id || here ? tabAt : tabs.findIndex((t) => t.pdfId === id);
  if (i < 0) i = tabAt;
  if (i < 0) { tabs.push({ id: uid8(), pdfId: id, name: '', r: 0, page: 1 }); i = tabs.length - 1; }
  else if (tabs[i].pdfId !== id) Object.assign(tabs[i], { pdfId: id, r: 0, page: 1, z: undefined });
  await showTab(i, { keep: false });
  if (page) pdf.goTo(page, rects);
}
// Keep the open tab's page number current while it scrolls.
{
  let wait = 0;
  $('#pdfScroll').addEventListener('scroll', () => {
    if (wait) return;
    wait = setTimeout(() => {
      wait = 0;
      const t = tabs[tabAt];
      if (!t || pdf.meta?.id !== t.pdfId) return;
      const before = t.page;
      keepTabPlace();
      if (t.page !== before) renderTabs();
      saveTabs();
    }, 250);
  }, { passive: true });
}
// From a card: use a Read window on another screen if one answers, else switch this window.
function openSource(src) {
  const go = () => { setView('read'); openPdf(src.pdfId, src.page, src.rects || src.rect).catch(fail); };
  if (!channel || document.body.dataset.view === 'read') return go();
  const ask = crypto.randomUUID();
  let answered = false;
  const onAck = (e) => { if (e.data.type === 'ack' && e.data.ask === ask) answered = true; };
  channel.addEventListener('message', onAck);
  post({ type: 'open-source', src, ask });
  setTimeout(() => { channel.removeEventListener('message', onAck); if (!answered) go(); }, 250);
}
async function addPdfFiles(files) {
  let last;
  for (const f of files) {
    status(`Uploading ${f.name}…`);
    last = await uploadPdf(f, project && !project.library ? project.id : null);
  }
  await loadPdfs(last.id);
  await loadSnippets();
  post({ type: 'projects' });
  setView('read');
  await openPdf(last.id);
  status('PDF ready — select text to make a snippet', 'ok');
}

// ---------- snippet tray (board view) ----------
let snippets = [], sectionsByPdf = {};
async function loadSnippets() {
  if (!project) return;
  [snippets, sectionsByPdf] = await Promise.all([api('GET', inScope('/api/snippets')), api('GET', inScope('/api/sections'))]);
  board.syncSnippets(snippets);
  renderSectionFilter();
  renderTray();
}
function renderTrayFilter() {
  const sel = $('#trayPdf'), keep = sel.value || store.get('corkboard.trayPdf') || '';
  sel.replaceChildren(new Option('All sources in this project', ''), ...pdfList.map((p) => new Option(p.name, p.id)));
  sel.value = pdfList.some((p) => p.id === keep) ? keep : '';
  renderSectionFilter();
}
// With one PDF chosen, its sections can narrow the tray further.
function renderSectionFilter() {
  const sel = $('#traySection'), pdfId = $('#trayPdf').value, keep = sel.value;
  const secs = (pdfId && sectionsByPdf[pdfId]) || [];
  sel.hidden = !secs.length;
  sel.replaceChildren(new Option('All sections', ''),
    ...secs.map((x) => new Option(`${'\u2003'.repeat(x.level - 1)}${x.title}`, x.id)));
  sel.value = secs.some((x) => x.id === keep) ? keep : '';
}
function renderTray() {
  if (document.body.dataset.view !== 'board' || !board.data) return;
  const list = $('#trayList');
  const pdfId = $('#trayPdf').value, secId = $('#traySection').hidden ? '' : $('#traySection').value;
  const q = $('#traySearch').value.trim().toLowerCase();
  const hidePlaced = $('#trayHidePlaced').checked;
  const placed = new Set(board.data.cards.filter((c) => c.source?.hl).map((c) => `${c.source.pdfId}:${c.source.hl}`));
  // Marked words inside a card on this board count as on the board too.
  for (const c of board.data.cards) for (const x of c.snipSubs || []) if (c.source?.pdfId) placed.add(`${c.source.pdfId}:${x.id}`);
  const shown = snippets
    .filter((h) => !pdfId || h.pdfId === pdfId)
    .filter((h) => !secId || (h.section || []).some((x) => x.id === secId))
    .filter((h) => !hidePlaced || !placed.has(`${h.pdfId}:${h.id}`))
    .filter((h) => !q || [h.text, h.note, h.pdfName, ...(h.section || []).map((x) => x.title)].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => a.pdfName.localeCompare(b.pdfName) || a.page - b.page || b.rects[0][4] - a.rects[0][4]);
  list.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'hl-empty';
    empty.textContent = snippets.length
      ? (hidePlaced ? 'Every snippet here is already on this board.' : 'No snippets match.')
      : 'No snippets yet. Make some in Read view.';
    return list.append(empty);
  }
  let lastPdf = null;
  for (const h of shown) {
    if (!pdfId && h.pdfId !== lastPdf) {
      lastPdf = h.pdfId;
      const n = shown.filter((x) => x.pdfId === h.pdfId).length;
      const head = mk('div', 'tray-doc', `${h.pdfName} `);
      head.append(mk('span', '', `(${n})`));
      list.append(head);
    }
    const same = snippets.filter((x) => x.pdfId === h.pdfId);
    const parent = parentOf(h, same);
    const item = snippetItem(h, {
      placed: placed.has(`${h.pdfId}:${h.id}`), pdfName: pdfId ? null : h.pdfName, parent: parent ? excerpt(parent, 40) : null,
      links: (h.links || []).map((l) => ({ label: l.label, text: excerpt(same.find((x) => x.id === l.to) || {}, 40) })).filter((l) => l.text),
      flag: sourceFlag(h.pdfId, h.id),
    });
    item.title = 'Drag onto the board · double-click to drop it in the centre';
    item.addEventListener('dragstart', (ev) => setDragData(ev, h.pdfId, h));
    item.addEventListener('click', () => previewSnippet(h));
    item.addEventListener('dblclick', () => { closePreview(); placeSnippet(h); });
    item.dataset.key = `${h.pdfId}:${h.id}`;
    if (previewKey === item.dataset.key) item.classList.add('previewing');
    list.append(item);
  }
}
// Links and layers between snippets of one PDF, as [from snippet, to snippet, label].
// Links (also across PDFs) and layers, as [[pdfId, snippetId], [pdfId, snippetId], label].
function snippetRelations(h) {
  const same = snippets.filter((s) => s.pdfId === h.pdfId);
  const rel = [];
  for (const l of h.links || []) if (l.to) rel.push([[h.pdfId, h.id], [l.toPdfId || l.pdfId || h.pdfId, l.to], l.label || 'defined by']);
  for (const s of snippets) {
    for (const l of s.links || []) {
      if (l.to === h.id && (l.toPdfId || l.pdfId || s.pdfId) === h.pdfId) rel.push([[s.pdfId, s.id], [h.pdfId, h.id], l.label || 'defined by']);
    }
  }
  const p = parentOf(h, same);
  if (p) rel.push([[h.pdfId, h.id], [h.pdfId, p.id], 'in']);
  for (const s of same) if (s.id !== h.id && parentOf(s, same)?.id === h.id) rel.push([[h.pdfId, s.id], [h.pdfId, h.id], 'in']);
  return rel;
}
// ---------- tray preview: a snippet in the middle of the board, before (or without) placing it ----------
let previewKey = null;
function closePreview() {
  $('#snipPreview').hidden = true;
  previewKey = null;
  for (const el of document.querySelectorAll('#trayList .previewing')) el.classList.remove('previewing');
}
function previewSnippet(h) {
  // Already on the board: bring its card to the middle instead.
  const card = board.data?.cards.find((c) => c.source?.pdfId === h.pdfId && c.source.hl === h.id);
  if (card) { closePreview(); return board.focusCard(card.id); }
  previewKey = `${h.pdfId}:${h.id}`;
  for (const el of document.querySelectorAll('#trayList .hl-item')) el.classList.toggle('previewing', el.dataset.key === previewKey);
  const box = $('#snipPreview');
  const panel = mk('div', 'sp-card');
  panel.style.setProperty('--accent', h.color);
  if (h.image) {
    const img = Object.assign(document.createElement('img'), { src: `/files/images/${h.image}`, alt: h.text || 'Snippet picture' });
    panel.append(img);
  }
  if (h.text) panel.append(h.image ? mk('blockquote', 'sp-quote short', plainSnipText(h.text)) : fillSnipText(mk('blockquote', 'sp-quote'), h.text));
  for (const f of h.footnotes || []) panel.append(mk('div', 'hl-foot', `${f.mark} ${f.text}`));
  if (h.note) panel.append(mk('div', 'snote', h.note));
  const path = (h.section || []).map((x) => x.title || x).join(' › ');
  if (path) panel.append(mk('div', 'ssec', `§ ${path}`));
  for (const l of h.links || []) {
    if (l.missing) continue;
    const b = mk('button', 'slink', `↗ ${l.label}: ${l.to ? excerpt({ text: l.toText }, 70) : `the whole of ${l.toPdfName}`}${(l.toPdfId || h.pdfId) !== h.pdfId ? ` · ${l.toPdfName}` : ''}`);
    b.onclick = () => {
      if (!l.to) return openLinkTarget(l.toPdfId, null).catch(fail);
      const t = snippets.find((s) => s.pdfId === (l.toPdfId || h.pdfId) && s.id === l.to);
      if (t) previewSnippet(t); else openLinkTarget(l.toPdfId, l.to).catch(fail);
    };
    panel.append(b);
  }
  panel.append(mk('div', 'sp-meta', `${h.pdfName} · p.${h.page}`));
  const acts = mk('div', 'sp-acts');
  const place = mk('button', 'primary', '＋ Place on board');
  place.onclick = () => { closePreview(); placeSnippet(h); };
  const open = mk('button', '', 'Open in PDF');
  open.onclick = () => { closePreview(); openSource({ pdfId: h.pdfId, page: h.page, rects: h.rects }); };
  const close = mk('button', '', 'Close');
  close.onclick = closePreview;
  acts.append(close, open, place);
  panel.append(acts);
  box.replaceChildren(panel);
  box.hidden = false;
}
// ←/→ step through the tray while the preview is open. Esc closes it. A click outside closes it.
document.addEventListener('keydown', (e) => {
  if ($('#snipPreview').hidden || document.querySelector('dialog[open]')) return;
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  if (e.key === 'Escape') { e.stopPropagation(); return closePreview(); }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const items = [...document.querySelectorAll('#trayList .hl-item')];
  const i = items.findIndex((el) => el.dataset.key === previewKey);
  const next = items[i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.scrollIntoView({ block: 'nearest' });
  next.click();
}, true);
$('#boardPane').addEventListener('pointerdown', (e) => { if (!$('#snipPreview').hidden && !e.target.closest('#snipPreview')) closePreview(); }, true);

function placeSnippet(h, at) {
  const e = board.addHighlight({ id: h.pdfId, name: h.pdfName }, h, at);
  // Arrows to the cards of linked or layered snippets that are already on the board. The snippets inside this
  // one (its marked words) count too: their arrows start at the marked word.
  const subs = (board.card(e.dataset.id)?.snipSubs || []).map((x) => snippets.find((s) => s.pdfId === h.pdfId && s.id === x.id)).filter(Boolean);
  let joined = 0;
  for (const [a, b, label] of [h, ...subs].flatMap(snippetRelations)) {
    const A = board.cardAt(...a), B = board.cardAt(...b);
    if (!A || !B || A.card === B.card) continue;
    // A snippet on its own card, inside a snippet on another card: the arrow ends at its marked word there.
    const toSub = B.sub || (label === 'in' && board.card(B.card)?.snipSubs?.some((x) => x.id === a[1]) ? a[1] : null);
    if (board.connectCards(A.card, B.card, label, { fromSub: A.sub, toSub })) joined++;
  }
  if (joined) status(`Joined to ${plural(joined, 'card')} by its links and layers`, 'ok');
  return e;
}
// ---------- link popup: what a card's links point to, and what points at a marked word ----------
function closeLinkPopup() { document.querySelector('.link-pop')?.remove(); }
// A snippet by PDF and id, with the snippets of its PDF (to find the paragraph a marked word sits in).
async function findSnippet(pdfId, id, pdfName) {
  const pool = snippets.filter((s) => s.pdfId === pdfId);
  const h = pool.find((s) => s.id === id);
  if (h) return { h, pool };
  const a = await pdf.loadForeign(pdfId);
  const found = (a.highlights || []).find((x) => x.id === id);
  return found && { h: { ...found, pdfId, pdfName, section: sectionPathOf(a.sections || [], found.page, found.rects[0][4]) }, pool: (a.highlights || []).map((x) => ({ ...x, pdfId, pdfName })) };
}
// The paragraph a marked word sits in (a text snippet that holds it), or null.
function outerOf(t) {
  const outer = t.h.kind === 'text' && parentOf(t.h, t.pool);
  return outer && outer.kind === 'text' && !outer.image && placeIn(outer, t) ? outer : null;
}
// Where a marked word sits in its paragraph's text, kept apart from other marked words with the same text.
const placeIn = (outer, t) => locateSub(outer, t.h, t.pool.filter((x) => x.kind === 'text' && x.text && inside(x, outer)));
// Show a snippet in a popup block: a marked word inside its paragraph, else the snippet itself.
function snippetBlock(box, t) {
  const h = t.h, outer = outerOf(t);
  if (outer) fillSnipText(box.appendChild(mk('blockquote', 'sp-quote')), outer.text, [{ ...placeIn(outer, t), id: h.id, color: h.color }]);
  else {
    if (h.image) box.append(Object.assign(document.createElement('img'), { src: `/files/images/${h.image}`, alt: h.text || 'Snippet picture' }));
    if (h.text) box.append(h.image ? mk('blockquote', 'sp-quote short', plainSnipText(h.text)) : fillSnipText(mk('blockquote', 'sp-quote'), h.text));
  }
  for (const f of h.footnotes || []) box.append(mk('div', 'hl-foot', `${f.mark} ${f.text}`));
  if (h.note) box.append(mk('div', 'snote', h.note));
  const path = (h.section || []).map((x) => x.title || x).join(' › ');
  if (path) box.append(mk('div', 'ssec', `§ ${path}`));
  box.append(mk('div', 'sp-meta', `${h.pdfName || ''} · p.${h.page}`));
}
// The snippets that link to a snippet: in this project's PDFs, and in other PDFs of the library.
async function linksInto(pdfId, id) {
  const out = [];
  for (const s of snippets) {
    for (const l of s.links || []) if (l.to === id && (l.toPdfId || l.pdfId || s.pdfId) === pdfId) out.push({ pdfId: s.pdfId, id: s.id, pdfName: s.pdfName, label: l.label || 'linked' });
  }
  const here = new Set(snippets.map((s) => s.pdfId));
  for (const b of await api('GET', `/api/backlinks/${pdfId}`).catch(() => [])) {
    if (b.link.to === id && !here.has(b.fromPdfId)) out.push({ pdfId: b.fromPdfId, id: b.from.id, pdfName: b.fromPdfName, label: b.link.label || 'linked' });
  }
  return out;
}
// links: the card's links to show. into: { pdfId, id } of a marked word, to also show the links that point at it.
async function showLinkPopup(card, links, rect, into = null) {
  closeLinkPopup();
  const incoming = into ? await linksInto(into.pdfId, into.id) : [];
  if (!links.length && !incoming.length) return false;
  const pop = mk('div', 'link-pop');
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('wheel', (e) => e.stopPropagation());
  const item = async (head, pdfId, id, pdfName, onBring) => {
    const box = mk('div', 'lp-item');
    box.append(head);
    const acts = mk('div', 'sp-acts');
    const open = mk('button', '', 'Open in PDF');
    open.onclick = () => { closeLinkPopup(); openLinkTarget(pdfId, id).catch(fail); };
    acts.append(open);
    const t = id ? await findSnippet(pdfId, id, pdfName).catch(() => null) : null;
    if (!id) box.append(mk('div', 'lp-whole', `The whole of ${pdfName || 'the document'}`));
    else if (!t) box.append(mk('div', 'lp-whole', 'This snippet does not exist any more.'));
    else {
      snippetBlock(box, t);
      const go = mk('button', 'primary', board.cardAt(pdfId, id) ? 'Go to card' : '＋ Place on board');
      go.onclick = () => { closeLinkPopup(); onBring().catch(fail); };
      acts.append(go);
    }
    box.append(acts);
    pop.append(box);
  };
  for (const l of links) {
    await item(mk('div', 'lp-head', `↗ ${l.sub ? `“${excerpt({ text: l.subText }, 30)}” ` : ''}${l.label}`), l.toPdfId, l.to, l.toPdfName, () => followCardLink(card, l));
  }
  if (incoming.length) {
    const word = card.snipSubs?.find((x) => x.id === into.id)?.text || '';
    pop.append(mk('div', 'lp-section', `← Links into “${excerpt({ text: word }, 30)}” (${incoming.length})`));
    for (const x of incoming) {
      await item(mk('div', 'lp-head in', `← ${x.label} from ${x.pdfName || 'another PDF'}`), x.pdfId, x.id, x.pdfName, async () => {
        const src = await bringSnippet(card, x.pdfId, x.id, x.pdfName, -1);
        if (!src) return;
        board.connectCards(src.card, card.id, x.label, { fromSub: src.sub, toSub: into.id });
        board.focusCard(src.card);
      });
    }
  }
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - r.width - 8))}px`;
  pop.style.top = `${rect.bottom + 8 + r.height <= innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - r.height - 8)}px`;
  return true;
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.link-pop')) closeLinkPopup(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLinkPopup(); });

// The card that shows a snippet: its own card or a card that holds it as a marked word. When none is on the board,
// place it beside card (side 1: right, -1: left). A marked word is placed with its paragraph. Returns { card, sub }.
async function bringSnippet(card, pdfId, id, pdfName, side = 1) {
  const there = board.cardAt(pdfId, id);
  if (there && there.card !== card.id) return there;
  const t = await findSnippet(pdfId, id, pdfName);
  if (!t) { status('The linked snippet does not exist any more.', 'err'); return null; }
  const outer = outerOf(t);
  const h = outer ? { ...outer, pdfId, pdfName: outer.pdfName || t.h.pdfName, section: outer.section || t.h.section } : t.h;
  const el = board.els.get(card.id);
  const x = side > 0 ? card.x + card.w + 140 + 150 : card.x - 140 - 150;
  const e = placeSnippet(h, { x, y: card.y + (el?.offsetHeight || 120) / 2 });
  return { card: e.dataset.id, sub: outer ? t.h.id : null };
}
// A link on a card: go to the target's card, or place the target beside this card.
// l.sub: the link belongs to a marked word on the card, so the arrow starts there.
async function followCardLink(card, l) {
  if (!l.to) return openLinkTarget(l.toPdfId, null);
  const to = await bringSnippet(card, l.toPdfId, l.to, l.toPdfName);
  if (!to) return;
  board.connectCards(card.id, to.card, l.label, { fromSub: l.sub || null, toSub: to.sub });
  board.focusCard(to.card);
}
$('#trayPdf').onchange = (e) => { store.set('corkboard.trayPdf', e.target.value); renderSectionFilter(); renderTray(); };
$('#traySection').onchange = renderTray;
$('#traySearch').oninput = renderTray;
$('#trayHidePlaced').onchange = renderTray;

// ---------- boards & saving ----------
let saveTimer = null, dirty = false, saving = Promise.resolve();

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}
function save() {
  clearTimeout(saveTimer);
  if (!dirty || !board.data) return saving;
  dirty = false;
  const data = board.data, { id } = data;
  saving = saving
    // Build the body when it is sent, so a queued save carries the version from the save before it.
    .then(() => api('PUT', `/api/boards/${id}`, JSON.stringify(data),
      { 'Content-Type': 'application/json', 'X-Base-Updated': String(data.updated || '') }))
    .then((res) => { data.updated = res.updated; post({ type: 'board', id }); if (!dirty && Date.now() - statusAt > 2500) status('Saved', 'ok'); })
    .catch((e) => {
      if (/→ 410/.test(e.message)) {
        board.data = null;
        return loadBoards().then(() => status('That board was deleted in another window.', 'err'));
      }
      if (/→ 409/.test(e.message)) {
        // Another window or a script saved this board after we loaded it: take theirs.
        return openBoard(id, true, true).then(() => status('This board changed in another window. Reloaded it.', 'err'));
      }
      dirty = true;
      fail(e);
      saveTimer = setTimeout(save, 3000);
    });
  return saving;
}
window.addEventListener('pagehide', () => {
  pdf.flushAnnots();
  if (!dirty || !board.data) return;
  fetch(`/api/boards/${board.data.id}`, {
    method: 'PUT', body: JSON.stringify(board.data), keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Base-Updated': String(board.data.updated || '') },
  });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); pdf.flushAnnots(); } });

async function loadBoards(selectId) {
  if (!project || project.library) return;
  let list = await api('GET', `/api/boards?project=${project.id}`);
  if (!list.length) list = [await api('POST', '/api/boards', { name: 'Board 1', projectId: project.id })];
  $('#boardSelect').replaceChildren(...list.map((b) => new Option(b.name, b.id)));
  const want = [selectId, store.get(`corkboard.board.${project.id}`)].find((id) => list.some((b) => b.id === id)) || list[0].id;
  $('#boardSelect').value = want;
  if (board.data?.id !== want) await openBoard(want);
}
async function openBoard(id, keepView = false, discard = false) {
  if (discard) dirty = false;
  else await save();
  const view = board.data?.id === id && keepView ? board.data.view : null;
  const data = await api('GET', `/api/boards/${id}`);
  if (view) data.view = view;
  board.load(data);
  board.syncSnippets(snippets);
  if (project) store.set(`corkboard.board.${project.id}`, id);
  $('#search').value = '';
  pdf.renderHighlights();
  pdf.renderList();
  renderTray();
}

channel?.addEventListener('message', (e) => {
  const m = e.data;
  if (m.from === windowId) return;
  if (m.type === 'snippets') { loadSnippets().catch(fail); if (m.pdfId) pdf.reloadAnnots(m.pdfId).catch(fail); }
  if (m.type === 'board' && board.data?.id === m.id && !dirty) openBoard(m.id, true).catch(fail);
  if (m.type === 'boards') loadBoards(board.data?.id).catch(fail);
  if (m.type === 'pdfs') loadPdfs().catch(fail);
  if (m.type === 'projects') loadProjects().catch(fail);
  if (m.type === 'terms' && project) loadTerms().catch(fail);
  if ((m.type === 'files' || m.type === 'pdfs') && project) loadFiles().catch(fail);
  if (['projects', 'pdfs', 'boards'].includes(m.type) && document.body.dataset.view === 'projects') refreshLibrary().catch(fail);
  if (m.type === 'open-source' && document.body.dataset.view === 'read') {
    post({ type: 'ack', ask: m.ask });
    openPdf(m.src.pdfId, m.src.page, m.src.rects || m.src.rect).then(() => window.focus()).catch(fail);
  }
});

// ---------- board toolbar ----------
const PALETTE_NAMES = { marker: 'Marker colour', pen: 'Pen colour', note: 'Card colour', link: 'Connection colour' };
function renderSwatches() {
  const ctx = board.paletteContext(), box = $('#swatches');
  if (!ctx) return box.replaceChildren();
  const current = board.currentColor(ctx);
  box.title = PALETTE_NAMES[ctx];
  box.replaceChildren(...PALETTES[ctx].map((c) => {
    const b = document.createElement('button');
    b.className = `swatch${c === current ? ' active' : ''}`;
    b.style.setProperty('--c', c);
    b.title = PALETTE_NAMES[ctx];
    b.onclick = () => { board.setColor(ctx, c); renderSwatches(); };
    return b;
  }));
}

$('#tools').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tool; if (t) board.setTool(t); });
$('#addNote').onclick = () => board.addNote();
$('#fit').onclick = () => board.fit();
const zoomBoard = (f) => { const r = $('#boardPane').getBoundingClientRect(); board.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
$('#isoBtns').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !board.isolate(+b.dataset.depth)) status('Select a card first, then pick 1°, 2° or 3°.');
});
$('#gravityStop').onclick = () => board.setGravity(false);
$('#boardZoomIn').onclick = () => zoomBoard(1.25);
$('#boardZoomOut').onclick = () => zoomBoard(0.8);
$('#search').addEventListener('input', (e) => {
  const n = board.applySearch(e.target.value);
  status(e.target.value.trim() ? `${n} match${n === 1 ? '' : 'es'}` : '');
});

$('#boardSelect').onchange = (e) => openBoard(e.target.value).catch(fail);
$('#newBoard').onclick = async () => {
  const name = await askText('Name for the new board', 'New board', { okLabel: 'Create' });
  if (!name) return;
  await save();
  const b = await api('POST', '/api/boards', { name, projectId: project.id });
  await loadBoards(b.id);
  post({ type: 'projects' });
  post({ type: 'boards' });
};
async function renameBoard() {
  const name = await askText('Rename board', board.data.name, { okLabel: 'Rename' });
  if (!name || name === board.data.name) return;
  board.data.name = name;
  scheduleSave();
  await save();
  await loadBoards(board.data.id);
  post({ type: 'boards' });
}
async function deleteBoard() {
  const ok = await askConfirm(`Move “${board.data.name}” to the trash?`, 'The file goes to data/trash, so you can restore it by hand.', { okLabel: 'Move to trash', danger: true });
  if (!ok) return;
  dirty = false;
  await api('DELETE', `/api/boards/${board.data.id}`);
  board.data = null;
  await loadBoards();
  post({ type: 'boards' });
  post({ type: 'projects' });
}

// ---------- projects ----------
let project = null;      // the open project (a summary from /api/projects)
let devMode = false;
let projectList = [];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function loadProjects() {
  projectList = await api('GET', '/api/projects');
  if (project && !project.library) {
    const fresh = projectList.find((p) => p.id === project.id);
    if (!fresh) return closeProject('That project was deleted.');
    project = fresh;
    showProjectName();
  }
  renderProjects();
}
function showProjectName() {
  // A review project has no board: the Board view is hidden and the reader shows the Links tab.
  if (project?.kind === 'review') document.body.dataset.kind = 'review'; else delete document.body.dataset.kind;
  $('#projName').textContent = project ? project.name : '';
  $('#projName').hidden = !project;
  document.title = `${project ? `${project.name} · ` : ''}Corkboard${devMode ? ' (dev)' : ''}`;
}
async function openProject(id, view) {
  const p = projectList.find((x) => x.id === id);
  if (!p) throw new Error('That project does not exist any more.');
  await save();
  if (project?.id !== id) {
    keepTabPlace();
    saveTabs();
    delete document.body.dataset.library;
    project = p;
    store.set('corkboard.project', id);
    board.data = null;
    snippets = [];
    if (pdf.meta) pdf.close();
    tabs = []; tabAt = -1;
  }
  showProjectName();
  await loadPdfs();
  await loadFiles();
  showFiles(store.get('corkboard.files') === '1');
  await loadSnippets();
  await loadTerms();
  await loadBoards();
  const last = store.get(`corkboard.pdf.${id}`);
  if (!pdf.meta) {
    loadTabs();
    if (tabs.length) await showTab(tabAt, { keep: false });
    else if (last && pdfList.some((x) => x.id === last)) await openPdf(last);
  }
  setView(view || (p.cards && p.kind !== 'review' ? 'board' : 'read'));
  checkSources().catch(() => {}); // the sources that were not checked in the last 30 days
  if (p.kind === 'review') showSide('review');
}
function closeProject(msg) {
  project = null;
  delete document.body.dataset.library;
  store.set('corkboard.project', '');
  board.data = null;
  keepTabPlace();
  saveTabs();
  if (pdf.meta) pdf.close();
  tabs = []; tabAt = -1;
  renderTabs();
  showProjectName();
  setView('projects');
  if (msg) status(msg, 'err');
}
// kind: 'review' for a review project: one PDF whose passages you mark and link to snippets that already exist.
async function newProject(kind = 'board') {
  const review = kind === 'review';
  const name = await askText(review ? 'Name for the new review' : 'Name for the new project', review ? 'New review' : 'New project', { okLabel: 'Create' });
  if (!name) return;
  const p = await api('POST', '/api/projects', { name, ...(review ? { kind } : {}) });
  post({ type: 'projects' });
  await loadProjects();
  await openProject(p.id, 'read');
  if (review) openAddPdf().catch(fail); // the PDF to review
}
async function renameProject(p) {
  const name = await askText('Rename project', p.name, { okLabel: 'Rename' });
  if (!name || name === p.name) return;
  await api('PATCH', `/api/projects/${p.id}`, { name });
  post({ type: 'projects' });
  await loadProjects();
}
async function deleteProject(p) {
  const boards = plural(p.boards.length, 'board');
  // PDFs that no other project uses: offer to trash them too.
  const shared = new Set(projectList.filter((o) => o.id !== p.id).flatMap((o) => o.pdfs.map((x) => x.id)));
  const own = p.pdfs.filter((x) => !shared.has(x.id));
  const ok = await askConfirm(`Delete the project “${p.name}”?`, [
    `The project and its ${boards} go to data/trash.`,
    own.length ? 'Its PDFs stay in the library unless you tick the box.' : (p.pdfs.length ? 'Its PDFs stay in the library, because other projects use them.' : ''),
  ].filter(Boolean), {
    okLabel: 'Delete project', danger: true,
    checkbox: own.length ? { label: `Also move ${plural(own.length, 'PDF')} that only this project uses (${own.map((x) => x.name).join(', ')}) and their snippets to the trash`, checked: false } : null,
  });
  if (!ok) return;
  if (project?.id === p.id) { dirty = false; closeProject(); }
  await api('DELETE', `/api/projects/${p.id}${ok.checked ? '?pdfs=unshared' : ''}`);
  post({ type: 'projects' });
  post({ type: 'pdfs' });
  await loadProjects();
  status(`Deleted “${p.name}”${ok.checked ? ` and ${plural(own.length, 'PDF')}` : ''}.`, 'ok');
}
// Remove the open PDF: from this project (it stays in the library), or, with the box ticked, to the trash.
// In the library there is no project, so it goes to the trash.
async function removePdfFromProject() {
  if (!pdf.meta || !project) return status('Open a PDF first. Then Remove takes it out.');
  const meta = pdf.meta;
  const n = snippets.filter((s) => s.pdfId === meta.id).length;
  const others = projectList.filter((p) => p.id !== project.id && p.pdfs.some((x) => x.id === meta.id)).map((p) => p.name);
  const trashLines = [
    `Its ${plural(n, 'snippet')} go with it. The files go to data/trash.`,
    others.length ? `It also leaves these projects: ${others.join(', ')}.` : '',
    'Cards already on boards stay, but their link to the PDF stops working.',
  ].filter(Boolean);
  let trash;
  if (project.library) {
    if (!(await askConfirm(`Move “${meta.name}” to the trash?`, trashLines, { okLabel: 'Move to trash', danger: true }))) return;
    trash = true;
  } else {
    const ok = await askConfirm(`Remove “${meta.name}” from “${project.name}”?`, [
      'The PDF and its snippets stay in the library, unless you tick the box. Cards already on boards stay.',
    ], {
      okLabel: 'Remove', danger: true,
      checkbox: { label: `Also delete the PDF: move it and its ${plural(n, 'snippet')} to the trash${others.length ? ` (it also leaves ${others.join(', ')})` : ''}`, checked: false },
    });
    if (!ok) return;
    trash = ok.checked;
  }
  if (trash) await api('DELETE', `/api/pdfs/${meta.id}`);
  else await api('DELETE', `/api/projects/${project.id}/pdfs/${meta.id}`);
  await loadProjects();
  await loadPdfs();
  await dropTabsOf(meta.id);
  await loadSnippets();
  post({ type: 'pdfs' });
  post({ type: 'projects' });
  status(trash ? `Moved “${meta.name}” to the trash.` : `Removed “${meta.name}” from “${project.name}”. It is still in the library.`, 'ok');
}

// A small drawing of a project's newest board: card boxes in their colours, and the links.
function previewSvg(pv) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  if (!pv) {
    svg.setAttribute('viewBox', '0 0 300 170');
    const t = document.createElementNS(NS, 'text');
    Object.entries({ x: 150, y: 92, 'text-anchor': 'middle', class: 'pv-empty' }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = 'Empty board';
    svg.append(t);
    return svg;
  }
  const [x0, y0, x1, y1] = pv.box, pad = Math.max(40, (x1 - x0) * 0.04);
  svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const [ax, ay, bx, by] of pv.links) {
    const l = document.createElementNS(NS, 'line');
    Object.entries({ x1: ax, y1: ay, x2: bx, y2: by, class: 'pv-link' }).forEach(([k, v]) => l.setAttribute(k, v));
    svg.append(l);
  }
  for (const [x, y, w, h, color] of pv.cards) {
    const r = document.createElementNS(NS, 'rect');
    Object.entries({ x, y, width: w, height: h, rx: 10, class: 'pv-card' }).forEach(([k, v]) => r.setAttribute(k, v));
    svg.append(r);
    if (color) {
      const bar = document.createElementNS(NS, 'rect');
      Object.entries({ x, y, width: Math.min(14, w / 6), height: h, rx: 4, fill: color }).forEach(([k, v]) => bar.setAttribute(k, v));
      svg.append(bar);
    }
  }
  return svg;
}
function renderProjects() {
  const grid = $('#projGrid'), q = $('#projFilter').value.trim().toLowerCase();
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, ...(text != null ? { textContent: text } : {}) });
  const add = el('button', 'proj-card proj-new');
  add.append(el('span', 'proj-plus', '＋'), el('span', '', 'New project'));
  add.onclick = () => newProject().catch(fail);
  const addReview = el('button', 'proj-card proj-new review');
  addReview.title = 'Check a PDF against snippets you already have: mark its passages and link each one to them';
  addReview.append(el('span', 'proj-plus', '＋'), el('span', '', 'New review'));
  addReview.onclick = () => newProject('review').catch(fail);
  const shown = projectList.filter((p) => !q || [p.name, ...p.pdfs.map((x) => x.name), ...p.boards.map((b) => b.name)]
    .some((t) => t.toLowerCase().includes(q)));
  grid.replaceChildren(add, addReview, ...shown.map((p) => {
    const card = el('div', `proj-card${project?.id === p.id ? ' current' : ''}${p.kind === 'review' ? ' review' : ''}`);
    card.tabIndex = 0;
    card.title = `Open ${p.name}`;
    const pv = el('div', 'proj-preview');
    pv.append(p.kind === 'review' ? reviewPreview(p) : previewSvg(p.preview));
    const body = el('div', 'proj-body');
    body.append(
      el('div', 'proj-title', p.name),
      el('div', 'proj-meta', p.kind === 'review' ? ['Review', plural(p.pdfs.length, 'PDF'), plural(p.snippets, 'snippet')].join(' · ')
        : [plural(p.pdfs.length, 'PDF'), plural(p.boards.length, 'board'), plural(p.snippets, 'snippet'), plural(p.cards, 'card')].join(' · ')),
      el('div', 'proj-meta', `Changed ${when(p.updated)}`),
    );
    if (p.pdfs.length) body.append(el('div', 'proj-files', p.pdfs.map((x) => x.name).join(', ')));
    const actions = el('div', 'proj-actions');
    const ren = el('button', '', 'Rename');
    ren.onclick = (e) => { e.stopPropagation(); renameProject(p).catch(fail); };
    const del = el('button', 'danger', 'Delete');
    del.onclick = (e) => { e.stopPropagation(); deleteProject(p).catch(fail); };
    actions.append(ren, del);
    card.append(pv, body, actions);
    const open = () => openProject(p.id).catch(fail);
    card.onclick = open;
    card.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    return card;
  }));
  $('#projEmpty').hidden = libTab !== 'projects' || projectList.length > 0;
}
// ---------- libraries (tabs in the Projects view) ----------
let libTab = store.get('corkboard.libTab') || 'projects';
let pdfLibrary = [], boardLibrary = [];
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const mk = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', ...(text != null ? { textContent: text } : {}) });

function showLibTab(tab) {
  libTab = ['projects', 'pdfs', 'boards'].includes(tab) ? tab : 'projects';
  store.set('corkboard.libTab', libTab);
  for (const b of document.querySelectorAll('#libTabs button')) b.classList.toggle('active', b.dataset.tab === libTab);
  for (const el of document.querySelectorAll('#projectsView [data-tab]')) if (el.parentElement.id !== 'libTabs') el.hidden = el.dataset.tab !== libTab;
  $('#projEmpty').hidden = libTab !== 'projects' || projectList.length > 0;
  $('#libUpload').hidden = libTab !== 'pdfs';
  $('#newProject').hidden = libTab !== 'projects';
  return refreshLibrary();
}
async function refreshLibrary() {
  if (libTab === 'pdfs') {
    [pdfLibrary, gfiles] = await Promise.all([api('GET', '/api/library/pdfs'), api('GET', '/api/files/global').catch(() => gfiles)]);
    setPdfRevs(pdfLibrary);
    renderPdfLibrary();
  }
  if (libTab === 'boards') { boardLibrary = await api('GET', '/api/library/boards'); renderBoardLibrary(); }
}
function projectChip(p, onOpen) {
  const c = mk('button', 'chip', p.name);
  c.title = `Open ${p.name}`;
  c.onclick = onOpen;
  return c;
}
// The library tab is the global folder browser: the global folders with every PDF of the library. A click
// on a file opens it by itself, outside any project, to read it and to make snippets. A right-click has the
// other actions.
function renderPdfLibrary() {
  fileTree($('#pdfLib'), {
    list: pdfLibrary, q: $('#projFilter').value.trim().toLowerCase(), again: renderPdfLibrary,
    onOpen: (x) => openStandalone(x.id).catch(fail), onMenu: libFileMenu,
    sub: (x) => `${plural(x.snippets, 'snippet')} · ${x.projects.length ? x.projects.map((p) => p.name).join(', ') : 'in no project'}`,
  });
}
async function libAddTo(x, target) {
  if (target === '@new') {
    const name = await askText('Name for the new project', x.name.replace(/\.pdf$/i, ''), { okLabel: 'Create' });
    if (!name) return;
    target = (await api('POST', '/api/projects', { name })).id;
  }
  await api('POST', `/api/projects/${target}/pdfs`, { id: x.id });
  post({ type: 'projects' });
  post({ type: 'pdfs' });
  await loadProjects();
  await refreshLibrary();
  if (project?.id === target) { await loadPdfs(); await loadSnippets(); }
}
async function libDelete(x) {
  const used = x.projects.map((p) => p.name).join(', ');
  const ok = await askConfirm(`Move “${x.name}” to the trash?`, [
    `Its ${plural(x.snippets, 'snippet')} go with it. The files go to data/trash.`,
    used ? `It leaves these projects: ${used}.` : '',
    'Cards already on boards stay, but their link to the PDF stops working.',
  ].filter(Boolean), { okLabel: 'Move to trash', danger: true });
  if (!ok) return;
  await api('DELETE', `/api/pdfs/${x.id}`);
  await dropTabsOf(x.id);
  post({ type: 'projects' });
  post({ type: 'pdfs' });
  await loadProjects();
  await refreshLibrary();
  if (project) { await loadPdfs(); await loadSnippets(); }
}
function libFileMenu(x, px, py) {
  const here = gfiles.filed[x.id] || null;
  const others = projectList.filter((p) => !x.projects.some((u) => u.id === p.id));
  popMenu([
    ['Open', () => openStandalone(x.id).catch(fail)],
    ...(isDoc(x) ? [['✎ Edit the doc', async () => { await openStandalone(x.id); await startDocEdit(); }]] : []),
    ...x.projects.slice(0, 6).map((p) => [`Open in “${p.name}”`, () => { store.set(`corkboard.pdf.${p.id}`, x.id); openProject(p.id, 'read').catch(fail); }]),
    null,
    ...others.slice(0, 10).map((p) => [`＋ Add to “${p.name}”`, () => libAddTo(x, p.id).catch(fail)]),
    ['＋ Add to a new project…', () => libAddTo(x, '@new').catch(fail)],
    null,
    ['✎ Rename', () => renamePdf(x).catch(fail)],
    ['＋ New folder here', () => newFolder(here).catch(fail)],
    ...(here ? [['↥ Move to the top', () => moveFile({ kind: 'pdf', id: x.id }, null)]] : []),
    ...folderLines().filter(([, id]) => id !== here).slice(0, 12).map(([label, id]) => [`→ ${label.trim()}`, () => moveFile({ kind: 'pdf', id: x.id }, id)]),
    null,
    ['× Delete…', () => libDelete(x).catch(fail), 'danger'],
  ], px, py);
}
function renderBoardLibrary() {
  const q = $('#projFilter').value.trim().toLowerCase();
  const rows = boardLibrary.filter((b) => !q || [b.name, b.project?.name || ''].some((t) => t.toLowerCase().includes(q)));
  const open = (b) => { store.set(`corkboard.board.${b.project.id}`, b.id); openProject(b.project.id, 'board').catch(fail); };
  $('#boardLib').replaceChildren(...(rows.length ? rows.map((b) => {
    const row = mk('div', 'lib-item');
    const main = mk('div', 'lib-main');
    const chips = mk('div', 'lib-chips');
    chips.append(b.project ? projectChip(b.project, () => open(b)) : mk('span', 'chip none', 'In no project'));
    main.append(mk('div', 'lib-name', b.name),
      mk('div', 'lib-sub', `${plural(b.cards, 'card')} · ${plural(b.links, 'link')} · changed ${when(b.updated)}`), chips);
    const acts = mk('div', 'lib-acts');
    const openBtn = mk('button', '', 'Open');
    openBtn.onclick = () => open(b);
    const move = mk('select');
    move.append(new Option('Move to project…', ''), ...projectList.filter((p) => p.id !== b.project?.id).map((p) => new Option(p.name, p.id)),
      new Option('＋ New project…', '@new'));
    move.onchange = async () => {
      let target = move.value;
      move.value = '';
      if (!target) return;
      if (target === '@new') {
        const name = await askText('Name for the new project', b.name, { okLabel: 'Create' });
        if (!name) return;
        const created = await api('POST', '/api/projects', { name, noBoard: true });
        target = created.id;
      }
      await save();
      await api('POST', `/api/projects/${target}/boards`, { id: b.id });
      post({ type: 'projects' });
      post({ type: 'boards' });
      await loadProjects();
      await refreshLibrary();
      if (project && board.data?.id === b.id) { board.data = null; await loadBoards(); }
    };
    const del = mk('button', 'danger', 'Delete…');
    del.onclick = async () => {
      const ok = await askConfirm(`Move the board “${b.name}” to the trash?`, 'The file goes to data/trash, so you can restore it by hand.', { okLabel: 'Move to trash', danger: true });
      if (!ok) return;
      if (board.data?.id === b.id) { dirty = false; board.data = null; }
      await api('DELETE', `/api/boards/${b.id}`);
      post({ type: 'projects' });
      post({ type: 'boards' });
      await loadProjects();
      await refreshLibrary();
      if (project && !board.data) await loadBoards();
    };
    acts.append(openBtn, move, del);
    row.append(main, acts);
    return row;
  }) : [mk('p', 'lib-empty', boardLibrary.length ? 'No boards match.' : 'No boards yet.')]));
}
$('#libTabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) showLibTab(t).catch(fail); });
$('#libUpload').onclick = (e) => { e.preventDefault(); openAddPdf({ tab: 'upload', targetId: null }).catch(fail); };
$('#projFilter').oninput = () => { renderProjects(); if (libTab === 'pdfs') renderPdfLibrary(); if (libTab === 'boards') renderBoardLibrary(); };
$('#newProject').onclick = () => newProject().catch(fail);
$('#projName').onclick = () => setView('projects');

// ---------- add-PDF dialog ----------
// target: a project id, or null for the library only.
let apTargetId = null, apPicked = new Set(), apLibrary = [];
function apShow(tab) {
  for (const b of document.querySelectorAll('#apTabs button')) b.classList.toggle('active', b.dataset.ap === tab);
  for (const el of document.querySelectorAll('#addPdfDialog .ap-pane')) el.hidden = el.dataset.ap !== tab;
  $('#apAdd').hidden = tab !== 'library';
  if (tab === 'library') renderApLibrary();
}
async function openAddPdf({ tab = 'upload', targetId = project && !project.library ? project.id : null } = {}) {
  apTargetId = targetId;
  apPicked = new Set();
  const target = projectList.find((p) => p.id === targetId);
  $('#apTarget').textContent = target ? `to “${target.name}”` : 'to the library';
  $('#apTabs [data-ap="library"]').hidden = !target;
  $('#apUploads').replaceChildren();
  $('#apSearch').value = '';
  $('#apInfo').textContent = '';
  apLibrary = target ? await api('GET', '/api/library/pdfs') : [];
  if (target) gfiles = await api('GET', '/api/files/global').catch(() => gfiles);
  // Web pages and other files need the desktop app.
  const canCapture = !!(await api('GET', '/api/info').catch(() => ({}))).capture;
  $('#apWebForm').hidden = !canCapture;
  $('#apDocForm').hidden = !canCapture;
  $('#apDocNote').hidden = canCapture;
  $('#apDocNote').textContent = 'A doc can be written in the desktop app only.';
  $('#apDocName').value = '';
  $('#apWebNote').textContent = canCapture
    ? 'The page is opened in a hidden window and saved as a PDF snapshot, with its address and the date. Then you can snip it like any PDF.'
    : 'Web pages, images and text files can be added in the desktop app only. Here, only PDFs can be added.';
  apShow(target || tab !== 'library' ? tab : 'upload');
  $('#addPdfDialog').showModal();
  if (tab === 'doc') $('#apDocName').focus();
}
// The "From the library" tab is the global folder browser: the global folders with every PDF of the library.
// Tick files, or a folder for all the files in it. A PDF that is in the project already shows as such.
let apShut = new Set();
function renderApLibrary() {
  const q = $('#apSearch').value.trim().toLowerCase();
  const inProject = (x) => x.projects.some((p) => p.id === apTargetId);
  const hit = (x) => !q || [x.name, x.description].some((t) => t && t.toLowerCase().includes(q));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const kids = (id) => gfiles.folders.filter((f) => (f.parent || null) === id).sort(byName);
  const pdfsOf = (id) => apLibrary.filter((x) => (gfiles.filed[x.id] || null) === id && hit(x)).sort(byName);
  const under = (id) => [...pdfsOf(id), ...kids(id).flatMap((k) => under(k.id))];
  const rows = [];
  const walk = (parent, depth) => {
    for (const f of kids(parent)) {
      const all = under(f.id), free = all.filter((x) => !inProject(x));
      if (!all.length) continue; // an empty folder, or no match
      const open = q ? true : !apShut.has(f.id);
      const row = mk('div', 'fp-row fp-folder');
      row.style.setProperty('--d', depth);
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', title: 'All the files in this folder' });
      const on = free.filter((x) => apPicked.has(x.id)).length;
      box.checked = free.length > 0 && on === free.length;
      box.indeterminate = on > 0 && on < free.length;
      box.disabled = !free.length;
      box.onclick = (e) => e.stopPropagation();
      box.onchange = () => { for (const x of free) { if (box.checked) apPicked.add(x.id); else apPicked.delete(x.id); } renderApLibrary(); };
      row.append(mk('span', 'fp-caret', open ? '▼' : '▶'), box, mk('span', 'fp-icon', '📁'), mk('span', 'fp-name', f.name), mk('span', 'fp-count', String(all.length)));
      row.onclick = () => { if (apShut.has(f.id)) apShut.delete(f.id); else apShut.add(f.id); renderApLibrary(); };
      rows.push(row);
      if (open) walk(f.id, depth + 1);
    }
    for (const x of pdfsOf(parent)) {
      const here = inProject(x);
      const row = mk('label', `fp-row fp-file${here ? ' fp-out' : ''}${apPicked.has(x.id) ? ' active' : ''}`);
      row.style.setProperty('--d', depth);
      row.title = x.description ? `${x.name}\n${x.description.slice(0, 200)}` : x.name;
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: here || apPicked.has(x.id), disabled: here });
      box.onchange = () => { if (box.checked) apPicked.add(x.id); else apPicked.delete(x.id); renderApLibrary(); };
      row.append(mk('span', 'fp-caret', ''), box, mk('span', 'fp-icon', x.source?.kind === 'web' ? '🌐' : '📄'), mk('span', 'fp-name', x.name),
        mk('span', 'fp-count', here ? 'in this project' : plural(x.snippets, 'snippet')));
      rows.push(row);
    }
  };
  walk(null, 0);
  $('#apLibrary').replaceChildren(...(rows.length ? rows : [mk('p', 'lib-empty', apLibrary.length ? 'No files match.' : 'The library is empty.')]));
  syncApAdd();
}
function syncApAdd() {
  $('#apAdd').textContent = apPicked.size ? `Add ${plural(apPicked.size, 'PDF')}` : 'Add selected';
  $('#apAdd').disabled = !apPicked.size;
}
// PDFs are stored as they are. Images, HTML, text and Markdown are saved as PDFs by the desktop app.
async function apUpload(files) {
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  let last = null;
  for (const f of files) {
    const state = mk('span', 'ap-state', isPdf(f) ? 'Uploading…' : 'Saving as a PDF…');
    const row = mk('div', 'ap-row');
    row.append(mk('div', 'lib-main lib-name', f.name), state);
    $('#apUploads').append(row);
    try {
      last = isPdf(f) ? await uploadPdf(f, apTargetId) : await captureFile(f, apTargetId);
      state.textContent = isPdf(f) ? 'Added' : `Added as ${last.name}`;
      state.className = 'ap-state ok';
    } catch (e) {
      state.textContent = 'Failed';
      state.className = 'ap-state err';
      state.title = e.message;
      $('#apInfo').textContent = e.message;
    }
  }
  if (last) await afterPdfsAdded(last.id);
}
// A web page: a PDF snapshot of it, made by the desktop app.
$('#apWebForm').onsubmit = async (e) => {
  e.preventDefault();
  let url = $('#apUrl').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const state = mk('span', 'ap-state', 'Saving a snapshot…');
  const row = mk('div', 'ap-row');
  row.append(mk('div', 'lib-main lib-name', url), state);
  $('#apWebList').prepend(row);
  try {
    const meta = await captureWeb(url, apTargetId);
    state.textContent = `Added as ${meta.name}`;
    state.className = 'ap-state ok';
    $('#apUrl').value = '';
    await afterPdfsAdded(meta.id);
  } catch (err) {
    state.textContent = 'Failed';
    state.className = 'ap-state err';
    state.title = err.message;
    $('#apInfo').textContent = err.message;
  }
};
// A doc: a source that you write here. It opens at once, with the editor.
$('#apDocForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#apDocName').value.trim();
  if (!name) return;
  try {
    $('#addPdfDialog').close();
    await newDoc(name, apTargetId);
  } catch (err) { fail(err); }
};
async function afterPdfsAdded(openId) {
  post({ type: 'pdfs' });
  post({ type: 'projects' });
  await loadProjects();
  if (document.body.dataset.view === 'projects') await refreshLibrary();
  if (project && (project.library || project.id === apTargetId)) {
    await loadPdfs(openId);
    await loadSnippets();
    if (document.body.dataset.view === 'read' && openId) await openPdf(openId);
  }
}
$('#apTabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.ap; if (t) apShow(t); });
$('#apSearch').oninput = renderApLibrary;
$('#apDrop input').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; apUpload(f).catch(fail); };
$('#apDrop').addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); $('#apDrop').classList.add('over'); });
$('#apDrop').addEventListener('dragleave', () => $('#apDrop').classList.remove('over'));
$('#apDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('#apDrop').classList.remove('over');
  apUpload([...(e.dataTransfer?.files || [])]).catch(fail);
});
$('#apClose').onclick = () => $('#addPdfDialog').close();
$('#apAdd').onclick = async () => {
  const ids = [...apPicked];
  for (const id of ids) await api('POST', `/api/projects/${apTargetId}/pdfs`, { id });
  $('#addPdfDialog').close();
  await afterPdfsAdded(ids[ids.length - 1]);
  status(`${plural(ids.length, 'PDF')} added`, 'ok');
};
$('#addPdfBtn').onclick = () => openAddPdf().catch(fail);
$('#removePdfBtn').onclick = () => removePdfFromProject().catch(fail);

// ---------- skip running headers and footers in selections (on by default) ----------
function setSkipRunning(on) {
  pdf.setSkipRunning(on);
  store.set('corkboard.skipRunning', on ? '1' : '0');
  $('#skipRunningItem').classList.toggle('checked', on);
}
setSkipRunning(store.get('corkboard.skipRunning') !== '0');

// ---------- find text in the PDF ----------
let findTimer = null;
function findCount(n) {
  $('#findCount').textContent = n == null ? '' : n ? `${pdf.findIdx + 1} of ${n}` : 'No matches';
}
async function runFind() {
  const q = $('#findInput').value;
  if (!q.trim()) { pdf.clearFind(); return findCount(null); }
  $('#findCount').textContent = 'Searching…';
  const n = await pdf.find(q);
  if (n != null) findCount(n);
}
function openFind() {
  $('#findBar').hidden = false;
  $('#findInput').focus();
  $('#findInput').select();
  if ($('#findInput').value.trim()) runFind().catch(fail);
}
function closeFind() {
  $('#findBar').hidden = true;
  pdf.clearFind();
  findCount(null);
}
const stepFind = (dir) => { pdf.findStep(dir); findCount(pdf.findHits?.length || 0); };
$('#pdfFind').onclick = () => ($('#findBar').hidden ? openFind() : closeFind());
$('#findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind().catch(fail), 200); });
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); if (pdf.findHits?.length) stepFind(e.shiftKey ? -1 : 1); else runFind().catch(fail); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$('#findPrev').onclick = () => stepFind(-1);
$('#findNext').onclick = () => stepFind(1);
$('#findClose').onclick = closeFind;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && document.body.dataset.view === 'read') { e.preventDefault(); openFind(); }
  // Ctrl+Tab and Ctrl+Shift+Tab: the next and the previous reader tab.
  if (e.ctrlKey && e.key === 'Tab' && document.body.dataset.view === 'read' && tabs.length > 1) {
    e.preventDefault();
    showTab((tabAt + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length).catch(fail);
  }
});

// ---------- review: each marked passage of the reviewed PDF, with the snippets it links to ----------
let reviewOnlyOpen = false;
function reviewPreview(p) {
  const box = mk('div', 'rev-preview');
  box.append(mk('div', 'rev-preview-icon', '⇄'), mk('div', '', p.pdfs[0]?.name || 'No PDF yet'));
  return box;
}
async function renderReview() {
  const box = $('#reviewPanel');
  if (project?.kind !== 'review') return;
  if (!pdf.meta) {
    $('#revCount').textContent = '';
    box.replaceChildren(mk('p', 'hl-empty', 'Add the PDF to review (＋ Add PDF), then mark its passages.'));
    return;
  }
  const token = (renderReview.token = Symbol());
  const names = new Map((await api('GET', '/api/library/pdfs')).map((x) => [x.id, x.name]));
  if (token !== renderReview.token) return;
  const hs = [...pdf.highlights].filter((x) => !x.plain).sort((a, b) => a.page - b.page || b.rects[0][4] - a.rects[0][4] || a.rects[0][1] - b.rects[0][1]);
  const linked = hs.filter((h) => (h.links || []).length);
  $('#revCount').textContent = hs.length ? `(${linked.length}/${hs.length})` : '';
  const head = mk('div', 'rev-head');
  const only = mk('label', 'rev-only');
  const cb = Object.assign(mk('input'), { type: 'checkbox', checked: reviewOnlyOpen });
  cb.onchange = () => { reviewOnlyOpen = cb.checked; renderReview().catch(fail); };
  only.append(cb, ' Only passages with no link');
  head.append(mk('div', 'rev-sum', `${plural(hs.length, 'passage')} · ${linked.length} linked · ${hs.length - linked.length} with no link`), only);
  if (!hs.length) head.append(mk('p', 'hl-empty', 'Select text in the PDF and pick a colour to mark a passage. Then link it to a snippet you already have.'));
  const items = [];
  for (const h of hs) {
    const links = h.links || [];
    if (reviewOnlyOpen && links.length) continue;
    const it = mk('div', `rev-item${links.length ? '' : ' open'}`);
    it.style.setProperty('--c', h.color);
    const q = mk('button', 'rev-passage');
    q.type = 'button';
    q.title = 'Show this passage in the PDF';
    q.append(mk('span', 'rev-page', `p.${h.page}`), document.createTextNode(` ${excerpt(h, 160)}`));
    q.onclick = () => pdf.goToHighlight(h.id);
    it.append(q);
    for (const l of links) {
      const toPdf = l.pdfId || pdf.meta.id, name = names.get(toPdf) || 'another PDF';
      const t = l.to ? await findSnippet(toPdf, l.to, name).catch(() => null) : null;
      if (token !== renderReview.token) return;
      const tgt = mk('div', 'rev-target');
      tgt.append(mk('div', 'rev-label', `↗ ${l.label || 'linked'}${toPdf !== pdf.meta.id ? ` · ${name}` : ''}`));
      if (!l.to) tgt.append(mk('div', 'lp-whole', `The whole of ${name}`));
      else if (!t) tgt.append(mk('div', 'lp-whole', 'This snippet does not exist any more.'));
      else snippetBlock(tgt, t);
      const acts = mk('div', 'sp-acts');
      const open = mk('button', '', 'Open');
      open.onclick = () => openLinkTarget(toPdf, l.to).catch(fail);
      const unlink = mk('button', '', 'Unlink');
      unlink.onclick = () => pdf.removeLink(h, l.id);
      acts.append(unlink, open);
      tgt.append(acts);
      it.append(tgt);
    }
    const add = mk('button', 'rev-add', links.length ? '＋ Another link' : '＋ Link to a snippet');
    add.onclick = () => pickLink(h).catch(fail);
    it.append(add);
    items.push(it);
  }
  box.replaceChildren(head, ...items);
}

// ---------- marking words on a board card ----------
const uid8 = () => crypto.randomUUID().slice(0, 8);
// Change a PDF's snippets from the board. The reader's copy is used when it has that PDF open, so the two agree.
async function editAnnots(pdfId, fn) {
  if (pdf.meta?.id === pdfId) {
    const r = fn(pdf.annots);
    pdf.changedHighlights();
    await pdf.flushAnnots();
    await loadSnippets();
    return r;
  }
  const a = await api('GET', `/api/annotations/${pdfId}`);
  a.highlights ||= [];
  const r = fn(a);
  await api('PUT', `/api/annotations/${pdfId}`, a);
  post({ type: 'snippets', pdfId });
  await loadSnippets();
  return r;
}
// A link from a snippet, made on the board (the same rules as PdfView.addLink).
const addLinkTo = (pdfId, hlId, toId, label, scope) => editAnnots(pdfId, (a) => {
  const x = a.highlights.find((y) => y.id === hlId);
  if (!x) return;
  const other = scope && scope !== pdfId ? scope : undefined;
  x.links = (x.links || []).filter((l) => !(l.to === toId && (l.pdfId || undefined) === other));
  x.links.push({ id: uid8(), to: toId, label, ...(other ? { pdfId: other } : {}) });
});
function closeMarkMenu() {
  document.querySelector('.mark-menu')?.remove();
  for (const d of document.querySelectorAll('.box-draft')) d.remove();
}
// The menu for a selection in a card's text (target.start/end) or for a marked word (target.subId).
function markMenu(card, target, rect) {
  closeMarkMenu();
  // Highlights made on the board stay on the card. They do not go back to the PDF.
  const own = target.subId ? board.boardMark(card, target.subId) : null;
  if (!target.subId || own) return boardMarkMenu(card, target, own, rect);
  const pdfId = card.source?.pdfId, outer = snippets.find((s) => s.pdfId === pdfId && s.id === card.source?.hl);
  if (!outer) return status('This card’s snippet is not in this project’s PDFs.', 'err');
  const sub = target.subId && snippets.find((s) => s.pdfId === pdfId && s.id === target.subId);
  const m = mk('div', 'mark-menu');
  m.addEventListener('pointerdown', (e) => e.stopPropagation());
  m.append(mk('div', 'mm-text', sub ? `“${excerpt(sub, 50)}”` : `Highlight “${excerpt({ text: outer.text.slice(target.start, target.end) }, 40)}”`));
  const sw = mk('div', 'hl-swatches');
  for (const c of HL_COLORS) {
    const b = mk('button', `hl-swatch${sub?.color === c ? ' active' : ''}`);
    b.style.setProperty('--c', c);
    b.title = sub ? 'Change colour' : 'Highlight in this colour';
    b.onclick = () => run(async () => {
      if (sub) {
        await editAnnots(pdfId, (a) => { const x = a.highlights.find((y) => y.id === sub.id); if (x) x.color = c; });
        return closeMarkMenu();
      }
      const rects = await locateRange(pdfId, outer, target.start, target.end);
      if (!rects?.length) return status('Could not find those words on the PDF page. Highlight them in the reader instead.', 'err');
      const h = { id: uid8(), kind: 'text', page: rects[0][0], rects, text: outer.text.slice(target.start, target.end).replace(/\s+/g, ' ').trim(), color: c, created: Date.now() };
      await editAnnots(pdfId, (a) => { a.highlights.push(h); });
      getSelection().removeAllRanges();
      status('Highlighted. It is a snippet in the PDF too.', 'ok');
      markMenu(board.card(card.id) || card, { subId: h.id }, rect);
    });
    sw.append(b);
  }
  m.append(sw);
  if (sub) {
    const link = mk('button', 'hl-action', '↗ Link to…');
    link.onclick = () => {
      closeMarkMenu();
      pickLink(sub, {
        meta: { id: pdfId, name: card.source.name }, highlights: snippets.filter((s) => s.pdfId === pdfId), sections: sectionsByPdf[pdfId] || [],
        addLink: (toId, label, scope) => addLinkTo(pdfId, sub.id, toId, label, scope).then(() => status(`Linked: ${label}`, 'ok')).catch(fail),
        pick: (label) => {
          status('Click the highlighted word or the card to link to. Esc cancels.');
          board.pickTarget((to, toSub) => {
            if (!to?.source?.hl) return status('No link made.');
            const toId = toSub || to.source.hl;
            if (toId === sub.id) return status('No link made.');
            addLinkTo(pdfId, sub.id, toId, label, to.source.pdfId).then(() => status(`Linked: ${label}`, 'ok')).catch(fail);
          });
        },
        pickLabel: 'Pick on the board instead', pickAnyPdf: true,
      }).catch(fail);
    };
    const del = mk('button', 'hl-action danger', 'Remove highlight');
    del.title = 'Remove this highlight (it is deleted from the PDF too)';
    del.onclick = () => run(async () => {
      await editAnnots(pdfId, (a) => {
        a.highlights = a.highlights.filter((y) => y.id !== sub.id);
        for (const y of a.highlights) if (y.links) y.links = y.links.filter((l) => !(l.to === sub.id && (!l.pdfId || l.pdfId === pdfId)));
      });
      closeMarkMenu();
    });
    const keep = mk('button', 'hl-action', 'Only on this card');
    keep.title = 'Take this highlight out of the PDF. It stays on this card, with its arrows.';
    keep.onclick = () => { closeMarkMenu(); moveHighlightsToCards([{ cardId: card.id, subIds: [sub.id] }]).catch(fail); };
    m.append(link, keep, del);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - r.width - 8))}px`;
  m.style.top = `${rect.bottom + 8 + r.height > innerHeight ? Math.max(8, rect.top - r.height - 8) : rect.bottom + 8}px`;
}
// Move highlights that are snippets in a PDF (inner snippets shown on cards) to their cards only.
// Each keeps its id, so its arrows on the board stay. Its links in the PDF go with it.
// A highlight that is also a card of its own on this board stays in the PDF (its card needs it).
async function moveHighlightsToCards(list) {
  let moved = 0, kept = 0;
  const byPdf = new Map();
  board.snapshot();
  for (const { cardId, subIds } of list) {
    const c = board.card(cardId);
    if (!c?.source) continue;
    for (const id of subIds) {
      const s = (c.snipSubs || []).find((x) => x.id === id);
      if (!s) continue;
      const own = board.data.cards.find((x) => x.source?.pdfId === c.source.pdfId && x.source.hl === id);
      if (own) { kept++; continue; }
      c.marks = [...(c.marks || []).filter((m) => m.id !== id), { id, start: s.start, end: s.end, text: (c.snipText || '').slice(s.start, s.end), color: s.color }];
      if (!byPdf.has(c.source.pdfId)) byPdf.set(c.source.pdfId, new Set());
      byPdf.get(c.source.pdfId).add(id);
      moved++;
    }
    board.refreshCard(c);
  }
  board.changed();
  for (const [pdfId, ids] of byPdf) {
    await editAnnots(pdfId, (a) => {
      a.highlights = a.highlights.filter((y) => !ids.has(y.id));
      for (const y of a.highlights) if (y.links) y.links = y.links.filter((l) => !(ids.has(l.to) && (!l.pdfId || l.pdfId === pdfId)));
    });
  }
  status(moved ? `${plural(moved, 'highlight')} now only on ${moved === 1 ? 'its card' : 'their cards'}${kept ? `. ${kept} kept in the PDF, because ${kept === 1 ? 'it is a card' : 'they are cards'} of ${kept === 1 ? 'its' : 'their'} own here` : ''}.`
    : kept ? 'Nothing moved: those highlights are cards of their own on this board.' : 'Nothing to move.', moved ? 'ok' : '');
}
// The menu for a board highlight (or for new words to highlight): colours, a link to a word or card, remove.
function boardMarkMenu(card, target, own, rect) {
  const c = board.card(card.id) || card;
  const m = mk('div', 'mark-menu');
  m.addEventListener('pointerdown', (e) => e.stopPropagation());
  const box = own ? own.box : target.box;
  const words = own ? own.text : (c.snipText || '').slice(target.start, target.end);
  m.append(mk('div', 'mm-text', box ? (own ? 'Highlighted part of the picture' : 'Highlight this part of the picture') : `${own ? '' : 'Highlight '}“${excerpt({ text: words }, 40)}”`));
  const sw = mk('div', 'hl-swatches');
  for (const col of HL_COLORS) {
    const b = mk('button', `hl-swatch${own?.color === col ? ' active' : ''}`);
    b.style.setProperty('--c', col);
    b.title = own ? 'Change colour' : 'Highlight in this colour';
    b.onclick = () => {
      if (own) { board.recolorBoardMark(c, own.id, col); return closeMarkMenu(); }
      const made = box ? board.addBoardBox(c, box, col) : board.addBoardMark(c, target.start, target.end, col);
      getSelection().removeAllRanges();
      closeMarkMenu();
      boardMarkMenu(c, { subId: made.id }, made, rect);
    };
    sw.append(b);
  }
  m.append(sw);
  if (own) {
    const link = mk('button', 'hl-action', '↗ Link to a word or card');
    link.title = 'Then click a highlighted word or a card on the board';
    link.onclick = () => {
      closeMarkMenu();
      status('Click the highlighted word or the card to link to. Esc cancels.');
      board.pickTarget((to, toSub) => {
        if (!to || (to.id === c.id && (!toSub || toSub === own.id))) return status('No link made.');
        board.connectCards(c.id, to.id, '', { fromSub: own.id, toSub });
        board.refreshCard(c);
        status('Linked.', 'ok');
      });
    };
    const del = mk('button', 'hl-action danger', 'Remove highlight');
    del.onclick = () => { board.removeBoardMark(c, own.id); closeMarkMenu(); };
    m.append(link, del);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - r.width - 8))}px`;
  m.style.top = `${rect.bottom + 8 + r.height > innerHeight ? Math.max(8, rect.top - r.height - 8) : rect.bottom + 8}px`;
}
const run = (fn) => Promise.resolve().then(fn).catch(fail);
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mark-menu')) closeMarkMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMarkMenu(); });

// ---------- link picker: choose the snippet a term links to ----------
// from: where the snippet lives. The reader is the default. The board passes its own (see markMenu).
async function pickLink(h, from = null) {
  from ||= {
    meta: pdf.meta, highlights: pdf.highlights, sections: pdf.sections,
    addLink: (toId, label, scope) => pdf.addLink(h, toId, label, scope),
    pick: (label) => pdf.startLinkPick(h, label), pickLabel: 'Pick in the PDF instead', pickAnyPdf: false,
  };
  const here = from.meta;
  // PDFs to link into: this one, then the project's, then the rest of the library.
  const library = await api('GET', '/api/library/pdfs');
  const inProject = new Set(pdfList.map((x) => x.id));
  const choices = [here, ...library.filter((x) => x.id !== here.id && inProject.has(x.id)), ...library.filter((x) => x.id !== here.id && !inProject.has(x.id))];
  let scope = here.id, source = { highlights: from.highlights, sections: from.sections };

  const dlg = mk('dialog', 'ask-dialog link-dialog');
  dlg.append(mk('h3', '', 'Link this snippet to…'), mk('div', 'lp-from', `From: “${excerpt(h, 90)}”`));
  const scopeSel = mk('select', 'lp-scope');
  scopeSel.append(new Option(`This PDF: ${here.name}`, here.id), new Option('Every PDF in the library', '*'),
    ...choices.slice(1).map((x) => new Option(`${inProject.has(x.id) ? '' : 'Library: '}${x.name} (${plural(x.snippets || 0, 'snippet')})`, x.id)));
  const top = mk('div', 'lp-top');
  const search = Object.assign(mk('input'), { type: 'search', placeholder: 'Search snippets…' });
  const label = mk('select');
  label.append(...LINK_LABELS.map((l) => new Option(l, l)));
  label.value = store.get('corkboard.linkLabel') || 'defined by';
  label.onchange = () => store.set('corkboard.linkLabel', label.value);
  top.append(search, label);
  const list = mk('div', 'lp-list');
  const pathOf = (x) => sectionPathOf(x._sections || source.sections, x.page, x.rects[0][4]);
  const render = () => {
    const others = source.highlights.filter((x) => !x.plain && !((x._pdf || scope) === here.id && x.id === h.id));
    // Snippets in a section whose name mentions definitions come first.
    const isDef = (x) => pathOf(x).some((sec) => /defin|term|glossar|abbrev/i.test(sec.title));
    const q = search.value.trim().toLowerCase();
    // Matches in the snippet's own text come before matches in its note.
    const inText = (x) => (x.text || '').toLowerCase().includes(q);
    const rows = others.filter((x) => !q || inText(x) || (x.note || '').toLowerCase().includes(q))
      .sort((a, b) => (q ? inText(b) - inText(a) : 0) || (isDef(b) - isDef(a)) || a.page - b.page || b.rects[0][4] - a.rects[0][4]);
    list.replaceChildren(...(rows.length ? rows.map((x) => {
      const row = mk('button', 'lp-row');
      row.type = 'button';
      const path = pathOf(x).map((sec) => sec.title).join(' › ');
      row.append(mk('div', 'lp-text', excerpt(x, 160)), mk('div', 'lp-meta', [x._pdfName, `p.${x.page}`, path].filter(Boolean).join(' · ')));
      row.onclick = () => {
        from.addLink(x.id, label.value, x._pdf || scope);
        dlg.close();
        status(`Linked: ${label.value} “${excerpt(x, 40)}”`, 'ok');
      };
      return row;
    }) : [mk('p', 'hl-empty', others.length ? 'No snippets match.' : 'That PDF has no snippets yet. Make the definition a snippet first, or link to the whole document.')]));
    pickInPdf.hidden = !from.pickAnyPdf && scope !== here.id;
    whole.hidden = scope === here.id || scope === '*';
  };
  // Every PDF in the library at once: each snippet knows its PDF (for the row and for the link).
  const loadAll = async () => {
    const all = await Promise.all(library.map(async (x) => {
      const a = x.id === here.id ? { highlights: from.highlights, sections: from.sections } : await pdf.loadForeign(x.id);
      return (a.highlights || []).map((y) => ({ ...y, _pdf: x.id, _pdfName: x.name, _sections: a.sections || [] }));
    }));
    return { highlights: all.flat(), sections: [] };
  };
  scopeSel.onchange = async () => {
    scope = scopeSel.value;
    source = scope === '*' ? await loadAll() : scope === here.id ? { highlights: from.highlights, sections: from.sections } : await pdf.loadForeign(scope);
    source = { highlights: source.highlights || [], sections: source.sections || [] };
    render();
  };
  search.oninput = render;
  const foot = mk('div', 'lp-foot');
  const pickInPdf = mk('button', '', from.pickLabel);
  pickInPdf.type = 'button';
  pickInPdf.onclick = () => { dlg.close(); from.pick(label.value); };
  const whole = mk('button', '', 'Link to the whole document');
  whole.type = 'button';
  whole.onclick = () => {
    from.addLink(null, label.value, scope);
    dlg.close();
    status(`Linked: ${label.value} ${choices.find((x) => x.id === scope)?.name}`, 'ok');
  };
  const cancel = mk('button', '', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => dlg.close();
  foot.append(pickInPdf, whole, cancel);
  dlg.append(scopeSel, top, list, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  if (from.scope || project?.kind === 'review') { scopeSel.value = from.scope || '*'; await scopeSel.onchange(); } // a review links into other PDFs
  else render();
  dlg.showModal();
  search.focus();
}

// ---------- following a link into another PDF, and back ----------
const trail = []; // where you were before each jump: { pdfId, scrollTop }
function showBack() {
  $('#backBtn').hidden = !trail.length;
  const last = trail[trail.length - 1];
  if (last) $('#backBtn').title = `Back to ${last.name}`;
}
async function openLinkTarget(pdfId, hlId) {
  if (pdf.meta) trail.push({ pdfId: pdf.meta.id, name: pdf.meta.name, scrollTop: $('#pdfScroll').scrollTop });
  showBack();
  setView('read');
  await openPdf(pdfId);
  if (hlId) pdf.goToHighlight(hlId);
}
$('#backBtn').onclick = async () => {
  const last = trail.pop();
  showBack();
  if (!last) return;
  await openPdf(last.pdfId);
  $('#pdfScroll').scrollTo({ top: last.scrollTop, behavior: 'smooth' });
};

// ---------- standalone PDFs (no project) ----------
const LIBRARY = { id: null, library: true, name: 'Library', pdfs: [], boards: [], cards: 0 };
async function openStandalone(pdfId) {
  await save();
  const fresh = project !== LIBRARY;
  if (fresh) { keepTabPlace(); saveTabs(); if (pdf.meta) pdf.close(); }
  project = LIBRARY;
  store.set('corkboard.project', '@library');
  board.data = null;
  document.body.dataset.library = '1';
  showProjectName();
  await loadPdfs(pdfId);
  await loadFiles();
  showFiles(store.get('corkboard.files') === '1');
  await loadSnippets();
  await loadTerms();
  setView('read');
  if (fresh) loadTabs();
  if (pdfId) await openPdf(pdfId);
  else if (fresh && tabs.length) await showTab(tabAt, { keep: false });
}

// ---------- reader sidebar: Snippets · Sections · Details ----------
let sideTab = store.get('corkboard.sideTab') || 'snippets';
function showSide(tab) {
  sideTab = ['snippets', 'sections', 'details', 'review', 'terms'].includes(tab) ? tab : 'snippets';
  if (sideTab === 'review' && project?.kind !== 'review') sideTab = 'snippets';
  store.set('corkboard.sideTab', sideTab);
  for (const b of document.querySelectorAll('#sideTabs button')) b.classList.toggle('active', b.dataset.side === sideTab);
  for (const el of document.querySelectorAll('#readSide > [data-side]')) el.hidden = el.dataset.side !== sideTab;
  if (sideTab === 'sections') pdf.renderOutline();
  if (sideTab === 'details') renderDetails().catch(fail);
  if (sideTab === 'review') renderReview().catch(fail);
}
$('#sideTabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.side; if (t) showSide(t); });

// Title and description belong to the PDF, so every project sees them.
async function renderDetails() {
  const box = $('#pdfDetails'), meta = pdf.meta;
  if (!meta) return box.replaceChildren(mk('p', 'hl-empty', 'Open a PDF to see its details.'));
  const info = (await api('GET', '/api/library/pdfs')).find((x) => x.id === meta.id) || {};
  if (pdf.meta?.id !== meta.id) return;
  const title = Object.assign(document.createElement('input'), { type: 'text', value: info.name || meta.name });
  const desc = Object.assign(document.createElement('textarea'), {
    value: info.description || '', placeholder: 'What is this document? Notes for anyone who uses it in a project.',
  });
  const saveField = async (field, value) => {
    const updated = await api('PATCH', `/api/pdfs/${meta.id}`, { [field]: value });
    if (field === 'name') {
      meta.name = updated.name;
      const opt = [...$('#pdfSelect').options].find((o) => o.value === meta.id);
      if (opt) opt.textContent = updated.name;
      for (const p of pdfList) if (p.id === meta.id) p.name = updated.name;
      await loadSnippets(); // cards pick up the new name
    }
    post({ type: 'pdfs' });
    post({ type: 'snippets' });
    status('PDF details saved', 'ok');
  };
  title.onchange = () => { if (title.value.trim()) saveField('name', title.value.trim()).catch(fail); };
  desc.onchange = () => saveField('description', desc.value).catch(fail);
  const l1 = mk('label', '', 'Title');
  l1.append(title);
  const l2 = mk('label', '', 'Description');
  l2.append(desc);
  const facts = mk('div', 'det-facts');
  facts.append(
    mk('div', '', `${plural(pdf.doc?.numPages || 0, 'page')} · ${kb(info.size || 0)} · added ${when(info.added)}`),
    mk('div', '', `${plural(info.snippets || 0, 'snippet')} · ${plural(info.sections || 0, 'section')}`),
  );
  // A snapshot of a web page (or of a file that was not a PDF): where it came from, and when.
  if (info.source?.kind === 'web') {
    const row = mk('div', 'det-source');
    const open = mk('a', '', info.source.url);
    open.href = info.source.url;
    open.target = '_blank';
    open.rel = 'noopener';
    row.append(mk('span', '', `Web page snapshot, saved ${when(info.source.captured)}: `), open);
    facts.append(row);
  } else if (info.source?.kind === 'disk') {
    facts.append(mk('div', 'det-source', `Copied from ${info.source.path}, ${when(info.source.captured)}`));
  } else if (info.source?.kind === 'file') {
    facts.append(mk('div', 'det-source', `Saved as a PDF from ${info.source.original}, ${when(info.source.captured)}`));
  }
  const chips = mk('div', 'lib-chips');
  for (const p of info.projects || []) {
    chips.append(projectChip(p, () => { store.set(`corkboard.pdf.${p.id}`, meta.id); openProject(p.id, 'read').catch(fail); }));
  }
  if (!(info.projects || []).length) chips.append(mk('span', 'chip none', 'In no project'));
  const used = mk('label', '', 'Used in');
  used.append(chips);
  const refresh = mk('button', 'det-refresh', `↻ Refresh the text of all ${plural(pdf.highlights.length, 'snippet')}`);
  refresh.title = 'Put back the line breaks of lists and paragraphs. The words of each snippet stay the same.';
  refresh.onclick = async () => {
    refresh.disabled = true;
    const n = await pdf.refreshAllText();
    refresh.disabled = false;
    status(n ? `Refreshed the text of ${plural(n, 'snippet')}` : 'All snippet text is already up to date', 'ok');
  };
  // Headers and footers: found by themselves, plus any marked by hand. A selection skips them while the option is on.
  const marked = pdf.annots?.running || [];
  const found = pdf.runningBands?.size || 0;
  const hf = mk('div', 'det-running');
  hf.append(mk('p', 'det-facts', `Headers and footers: ${found ? `found on ${plural(found, 'page')}` : 'none found'}${marked.length ? `, ${plural(marked.length, 'area')} marked by hand` : ''}. ${pdf.skipRunning ? 'Selections skip them.' : 'Selections include them (Options → Skip headers and footers).'}`));
  if (marked.length) {
    const clear = mk('button', 'det-refresh', 'Forget the header and footer areas marked by hand');
    clear.onclick = () => { pdf.clearRunning(); renderDetails().catch(fail); };
    hf.append(clear);
  }
  box.replaceChildren(l1, l2, used, facts, watchSection(meta, info), refresh, hf,
    mk('p', 'det-facts', 'Sections, snippets, notes and these details belong to the PDF. Every project that uses it sees them.'));
}

// ---------- export ----------
async function downloadHtml(embedPdfs) {
  await save();
  status('Exporting…');
  const { html, filename, views, complete } = await exportHtml(board, { embedPdfs, terms: [...dict.project, ...dict.global], onProgress: (m) => status(m) });
  const blob = new Blob([html], { type: 'text/html' });
  const saved = await api('POST', '/api/exports', blob, { 'Content-Type': 'text/html', 'X-Filename': encodeURIComponent(filename) });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const more = views > 1 ? ` · ${views} views of the choices${complete ? '' : ' (not all: there are too many combinations)'}` : '';
  status(`Exported ${(blob.size / 1048576).toFixed(1)} MB${more} · copy in ${saved.path}`, complete ? 'ok' : 'err');
}

// ---------- options menu ----------
const menu = $('#optionsMenu'), optBtn = $('#optionsBtn');
function syncMenu() {
  for (const r of document.querySelectorAll('input[name=arrowStyle]')) r.checked = r.value === board.arrowStyle();
  for (const r of document.querySelectorAll('input[name=theme]')) r.checked = r.value === window.corkboardTheme.get();
  $('#optTray').checked = !tray.classList.contains('collapsed');
  $('#optGuides').checked = board.guides !== false;
  $('#gravityItem').classList.toggle('checked', board.gravity.running);
}
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  optBtn.setAttribute('aria-expanded', open);
  if (open) syncMenu();
}
optBtn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('.opt-wrap')) toggleMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); toggleMenu(false); } }, true);
menu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  toggleMenu(false);
  if (act === 'rename') renameBoard().catch(fail);
  if (act === 'delete') deleteBoard().catch(fail);
  if (act === 'structure' && !board.structure()) status('Nothing to arrange: the board needs two or more visible cards.');
  if (act === 'group-doc' && !board.groupByDocument()) status('Nothing to group: the board has no cards.');
  if (act === 'group-new') board.addGroup();
  if (act === 'move-highlights') {
    const list = board.data.cards.filter((c) => c.snipSubs?.length).map((c) => ({ cardId: c.id, subIds: c.snipSubs.map((x) => x.id) }));
    const n = list.reduce((sum, x) => sum + x.subIds.length, 0);
    if (!n) status('No card on this board has highlights from a PDF.');
    else askConfirm(`Remove ${plural(n, 'highlight')} from the PDFs?`, [
      'Highlighted words on the cards of this board stay on their cards, with their arrows. They are taken out of the PDFs.',
      'This includes words you highlighted in the reader inside these cards. A highlight that is a card of its own here stays in the PDF.',
    ], { okLabel: 'Remove from the PDFs' }).then((ok) => ok && moveHighlightsToCards(list)).catch(fail);
  }
  if (act === 'gravity') board.setGravity(!board.gravity.running);
  if (act === 'skip-running') setSkipRunning(!pdf.skipRunning);
  if (act === 'popout') popout();
  if (act === 'export' || act === 'export-lite') downloadHtml(act === 'export').catch(fail);
  if (act === 'help') $('#helpDialog').showModal();
  if (act === 'dictionary') openDictionary();
  if (act === 'sources') openSources();
  if ((act === 'remove-pdf' || act === 'rename-project') && project?.library) return status('This PDF is open on its own, in no project.');
  if (act === 'remove-pdf') removePdfFromProject().catch(fail);
  if (act === 'rename-project') renameProject(project).catch(fail);
});
menu.addEventListener('change', (e) => {
  if (e.target.name === 'arrowStyle') board.setArrowStyle(e.target.value);
  if (e.target.name === 'theme') window.corkboardTheme.set(e.target.value);
  if (e.target.id === 'optGuides') { board.guides = e.target.checked; store.set('corkboard.guides', e.target.checked ? '1' : '0'); }
  if (e.target.id === 'optTray') {
    const w = e.target.checked ? 300 : 0;
    setTrayWidth(w);
    store.set('corkboard.trayWidth', w);
    board.scheduleLinks();
  }
});

// ---------- reader toolbar ----------
$('#pdfSelect').onchange = (e) => { if (e.target.value) openPdf(e.target.value, 0, null, { here: true }).catch(fail); };
$('#pdfMode').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.mode;
  if (!m) return;
  pdf.setMode(m);
  for (const b of document.querySelectorAll('#pdfMode button')) b.classList.toggle('active', b.dataset.mode === m);
  $('#markColors').hidden = m !== 'highlight';
});
// Highlight mode's colour: the swatches under the Highlight button.
function setMarkColor(c) {
  pdf.markColor = c;
  store.set('corkboard.markColor', c);
  for (const b of document.querySelectorAll('#markColors button')) b.classList.toggle('active', b.dataset.color === c);
}
$('#markColors').replaceChildren(...HL_COLORS.map((c) => {
  const b = mk('button', 'mark-color');
  b.dataset.color = c;
  b.title = 'Highlight colour';
  b.style.setProperty('--c', c);
  b.onclick = () => setMarkColor(c);
  return b;
}));
setMarkColor(store.get('corkboard.markColor') || HL_COLORS[0]);
pdf.onMarkColor = setMarkColor;
$('#pdfZoomIn').onclick = () => pdf.setScale(pdf.scale * 1.2);
$('#pdfZoomOut').onclick = () => pdf.setScale(pdf.scale / 1.2);
$('#pdfFit').onclick = () => pdf.fit();

// ---------- tray resize ----------
const tray = $('#tray');
function setTrayWidth(w) {
  tray.style.width = `${w}px`;
  tray.classList.toggle('collapsed', w === 0);
}
const savedTray = store.get('corkboard.trayWidth');
setTrayWidth(savedTray === null || savedTray === '' ? 300 : clamp(+savedTray, 0, 600));
$('#divider').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const d = e.currentTarget, x0 = tray.getBoundingClientRect().left;
  d.setPointerCapture(e.pointerId);
  const move = (ev) => setTrayWidth(ev.clientX - x0 < 100 ? 0 : clamp(ev.clientX - x0, 220, 600));
  const up = () => {
    d.removeEventListener('pointermove', move);
    d.removeEventListener('pointerup', up);
    store.set('corkboard.trayWidth', parseFloat(tray.style.width));
    board.scheduleLinks();
  };
  d.addEventListener('pointermove', move);
  d.addEventListener('pointerup', up);
});
$('#divider').addEventListener('dblclick', () => {
  const w = tray.classList.contains('collapsed') ? 300 : 0;
  setTrayWidth(w);
  store.set('corkboard.trayWidth', w);
});

// ---------- sidebar widths in the reader ----------
// A grip between a sidebar and the PDF. dir: 1 for a sidebar at the left of its grip, -1 for one at the right.
function sideGrip(grip, pane, { key, def, min, dir }) {
  // The PDF keeps 320 px at least.
  const most = () => Math.max(min, Math.min(900, pane.getBoundingClientRect().width + $('#readMain').getBoundingClientRect().width - 320));
  const set = (w) => { pane.style.width = `${w}px`; };
  const saved = +store.get(key);
  set(saved ? clamp(saved, min, 900) : def);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = pane.getBoundingClientRect().width, top = most();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag');
    const move = (ev) => set(clamp(w0 + (ev.clientX - x0) * dir, min, top));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.classList.remove('drag');
      store.set(key, Math.round(parseFloat(pane.style.width)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { set(def); store.set(key, def); });
  // A smaller window: the sidebar gives room back to the PDF. The saved width stays.
  window.addEventListener('resize', () => {
    const w = pane.getBoundingClientRect().width;
    if (w && w > most()) set(most());
  });
}
sideGrip($('#filesGrip'), $('#filesPane'), { key: 'corkboard.filesWidth', def: 250, min: 180, dir: 1 });
sideGrip($('#sideGrip'), $('#readSide'), { key: 'corkboard.sideWidth', def: 340, min: 240, dir: -1 });

// ---------- drop & paste ----------
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  const types = [...(e.dataTransfer?.types || [])];
  if (types.includes('Files')) document.body.classList.add('dropping');
  if (types.includes(DRAG_TYPE)) e.dataTransfer.dropEffect = e.target.closest?.('#boardPane') ? 'copy' : 'none';
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const onBoard = e.target.closest?.('#boardPane');
  const snipData = e.dataTransfer?.getData(DRAG_TYPE);
  if (snipData) {
    const { pdfId, id } = JSON.parse(snipData);
    if (!onBoard) return;
    const at = board.toWorld(e.clientX, e.clientY);
    const h = snippets.find((s) => s.pdfId === pdfId && s.id === id);
    if (h) return placeSnippet(h, at);
    // Dragged from a reader before its save reached this window: fetch, then place.
    loadSnippets().then(() => {
      const fresh = snippets.find((s) => s.pdfId === pdfId && s.id === id);
      if (fresh) placeSnippet(fresh, at);
    }).catch(fail);
    return;
  }
  const files = [...(e.dataTransfer?.files || [])];
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (pdfs.length) {
    apTargetId = project && !project.library ? project.id : null;
    addPdfFiles(pdfs).then(() => post({ type: 'pdfs' })).catch(fail);
  }
  imgs.forEach((f, i) => addImage(f, onBoard ? { x: e.clientX + i * 30, y: e.clientY + i * 30 } : null).catch(fail));
});
window.addEventListener('paste', (e) => {
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) return;
  if (document.body.dataset.view !== 'board') return;
  const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  imgs.forEach((f) => addImage(f).catch(fail));
});
async function addImage(file, clientPt) {
  status('Adding image…');
  const [img, bmp] = await Promise.all([uploadImage(file), createImageBitmap(file)]);
  setView('board');
  board.addImage({ image: img.id, imgW: bmp.width, imgH: bmp.height, at: clientPt && board.toWorld(clientPt.x, clientPt.y) });
  status('Image added', 'ok');
}

window.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  if (e.key === '?' && !(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)))) $('#helpDialog').showModal();
});

// Arrows and ink take their colours from the script, so draw them again when the theme changes.
window.addEventListener('themechange', () => board.retheme());
board.guides = store.get('corkboard.guides') !== '0'; // guides while you move or size a card: on unless turned off
// ---------- the Files panel: the sources of the project in folders ----------
// ---------- docs: sources that the user writes ----------
// A doc is a source like a PDF or a web page: it is in the library, in folders and in projects, and the reader
// shows it as pages, so snippets, sections and links work. Its text is a document of the note-card editor
// (docedit). "✎ Edit" puts the editor in the place of the pages. "Done" saves the document, the server makes
// the PDF again, and the snippets of the doc are found again in the new pages.
let docEdit = null; // { id, ed, dirty, changed, timer, page } while a doc is open in the editor
const isDoc = (meta) => meta?.source?.kind === 'doc';
const kindIcon = (p) => (isDoc(p) ? '📝' : p.source?.kind === 'web' ? '🌐' : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p.source?.original || '') ? '🖼' : '📄');
async function newDoc(name, targetId) {
  status('Making the doc…');
  const meta = await api('POST', '/api/docs', { name, project: targetId || '' });
  setPdfRevs([meta]);
  apTargetId = targetId || null;
  await afterPdfsAdded(null);
  if (document.body.dataset.view === 'projects' || !project || (targetId && project.id !== targetId)) await openStandalone(meta.id);
  else { setView('read'); await openPdf(meta.id); }
  status('');
  await startDocEdit();
}
// A doc whose PDF is older than its text (the app closed during an edit): make the PDF now.
async function freshDoc(meta) {
  if (!isDoc(meta) || !meta.source.draft || docEdit) return false;
  try {
    const m = await api('PUT', `/api/docs/${meta.id}`, { render: true });
    Object.assign(meta, m);
    setPdfRevs([m]);
    await relocateSnippets(m.id);
    return true;
  } catch { return false; } // the browser version can not make the PDF: the reader shows the PDF from before
}
async function startDocEdit() {
  const meta = pdf.meta;
  if (!isDoc(meta) || docEdit) return;
  if (!(await api('GET', '/api/info').catch(() => ({}))).capture) return status('A doc can be changed in the desktop app only.', 'err');
  const { doc } = await api('GET', `/api/docs/${meta.id}`);
  if (pdf.meta !== meta || docEdit) return;
  const state = { id: meta.id, ed: null, dirty: false, changed: false, timer: 0, page: pdf.currentPage() };
  $('#readMain').classList.add('doc-editing');
  $('#docEdit').hidden = false;
  $('#docEditState').textContent = '';
  state.ed = createEditor($('#docEditPage'), {
    doc, placeholder: 'Write the doc…',
    onChange: () => {
      state.dirty = true;
      $('#docEditState').textContent = '';
      clearTimeout(state.timer);
      state.timer = setTimeout(() => saveDocDraft(state).catch(fail), 1500);
    },
  });
  $('#docEditTools').replaceChildren(state.ed.toolbar);
  docEdit = state;
  $('#editDocBtn').hidden = true;
  state.ed.focus('end');
}
// While you write, the text is saved as a draft (the PDF is not made again until Done).
async function saveDocDraft(state) {
  if (!state.dirty) return;
  state.dirty = false;
  state.changed = true;
  await api('PUT', `/api/docs/${state.id}`, { doc: state.ed.getDoc(), render: false });
  if (docEdit === state) $('#docEditState').textContent = 'Draft saved';
}
// End the edit. reopen: show the new pages in the reader (false when another source opens next).
async function finishDocEdit({ reopen = true } = {}) {
  const d = docEdit;
  if (!d) return;
  docEdit = null;
  clearTimeout(d.timer);
  const doc = d.ed.getDoc(), changed = d.changed || d.dirty;
  d.ed.destroy();
  $('#docEditPage').replaceChildren();
  $('#docEditTools').replaceChildren();
  $('#docEdit').hidden = true;
  $('#readMain').classList.remove('doc-editing');
  $('#editDocBtn').hidden = !isDoc(pdf.meta);
  if (!changed) return;
  status('Saving the doc…');
  const meta = await api('PUT', `/api/docs/${d.id}`, { doc, render: true });
  setPdfRevs([meta]);
  const moved = await relocateSnippets(d.id);
  post({ type: 'pdfs' });
  post({ type: 'snippets' });
  const open = pdf.meta?.id === d.id;
  if (open) pdf.close(); // the reader has the pages from before: it must load the new ones
  await loadPdfs();
  if (open && reopen) { await showTab(tabAt, { keep: false }); pdf.goTo(Math.min(d.page, pdf.pages.length || 1)); }
  await loadSnippets();
  if (inLibraryTab()) await refreshLibrary();
  status(moved.lost ? `Doc saved. The words of ${plural(moved.lost, 'snippet')} are not in the doc now.` : 'Doc saved', moved.lost ? 'err' : 'ok');
}
$('#editDocBtn').onclick = () => startDocEdit().catch(fail);
$('#docEditDone').onclick = () => finishDocEdit().catch(fail);
// A click on the page below the text puts the cursor at the end of the text.
$('#docEditPage').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget && docEdit) { e.preventDefault(); docEdit.ed.focus('end'); } });

// A project has folders of its own for its PDFs (files.folders: [{ id, name, parent }], files.filed: { pdfId:
// folderId }). A PDF that is in no folder is at the top. The folders are a way to find things in this project:
// nothing moves on the disk, and another project can file the same PDF in another way.
// There are also global folders, as for the dictionary: one tree for every PDF in the library, the same in every
// project (gfiles, kept in data/files.json). The panel shows one of the two: Project or Global.
let files = { folders: [], filed: {} }, gfiles = { folders: [], filed: {} }, allPdfs = [];
let fileScope = store.get('corkboard.fileScope') === 'global' ? 'global' : 'project';
// With no project open, and in the library tab of the Projects view: only the global folders.
const inLibraryTab = () => document.body.dataset.view === 'projects';
const scopeNow = () => (inLibraryTab() || !hasProject() ? 'global' : fileScope);
const F = () => (scopeNow() === 'global' ? gfiles : files);
const listNow = () => (scopeNow() === 'global' ? allPdfs : pdfList);
const shutKey = () => `corkboard.filesShut.${scopeNow() === 'global' ? '@global' : project?.id}`;
const filesShut = () => { try { return new Set(JSON.parse(store.get(shutKey()) || '[]')); } catch { return new Set(); } };
async function loadFiles() {
  files = { folders: [], filed: {} };
  if (hasProject()) {
    const p = await api('GET', `/api/projects/${project.id}`).catch(() => null);
    files = { folders: p?.folders || [], filed: p?.filed || {} };
  }
  [gfiles, allPdfs] = await Promise.all([api('GET', '/api/files/global').catch(() => ({ folders: [], filed: {} })), api('GET', '/api/pdfs').catch(() => [])]);
  renderFiles();
}
async function saveFiles() {
  if (!project && !inLibraryTab()) return;
  renderFiles();
  if (scopeNow() === 'global') gfiles = await api('PUT', '/api/files/global', gfiles);
  else files = await api('PUT', `/api/projects/${project.id}/files`, files);
  post({ type: 'files' });
}
function setFileScope(scope) {
  fileScope = scope === 'global' ? 'global' : 'project';
  store.set('corkboard.fileScope', fileScope);
  renderFiles();
}
function showFiles(on) {
  const can = !!project;
  $('#filesBtn').hidden = !can;
  $('#filesPane').hidden = !can || !on;
  $('#filesBtn').classList.toggle('on', can && on);
  if (can) store.set('corkboard.files', on ? '1' : '0');
  // The PDF has more or less room now: keep it at the width of its pane if it was.
  if (pdf.doc && $('#pdfScroll').clientWidth && Math.abs(pdf.scale - (pdf.lastFit ?? pdf.scale)) < 0.01) pdf.fit();
  pdf.lastFit = pdf.doc && $('#pdfScroll').clientWidth ? pdf.fitScale() : undefined;
}
const folderKids = (id) => F().folders.filter((f) => (f.parent || null) === id).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
const pdfsIn = (id) => listNow().filter((p) => (F().filed[p.id] || null) === id).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
// Every folder inside a folder, at any depth (and the folder itself).
function folderTree(id) {
  const out = [id];
  for (const k of F().folders.filter((f) => f.parent === id)) out.push(...folderTree(k.id));
  return out;
}
const FILE_DRAG = 'application/x-corkboard-file';
// Draw a tree of folders and files into `tree`. The folders are those of the scope that shows (F()).
//   list: the PDFs.  q: the filter text.  onOpen(p), onMenu(p, x, y): a click and a right-click on a file.
//   sub(p): a short text at the right of a file.  again(): draw this tree again (after a folder closes or opens).
function fileTree(tree, { list, q, onOpen, onMenu, sub, again }) {
  const shut = filesShut(), global = scopeNow() === 'global';
  const mine = new Set(pdfList.map((p) => p.id)), grey = (p) => global && hasProject() && !inLibraryTab() && !mine.has(p.id);
  const hit = (p) => !q || [p.name, p.description, ...(p.projects || []).map((x) => x.name)].some((t) => t && t.toLowerCase().includes(q));
  const here = (id) => list.filter((p) => (F().filed[p.id] || null) === id).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const count = (id) => folderTree(id).reduce((n, f) => n + list.filter((p) => F().filed[p.id] === f && hit(p)).length, 0);
  const rows = [];
  const drop = (row, folderId) => {
    row.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes(FILE_DRAG)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; row.classList.add('over'); } });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', (e) => {
      const data = e.dataTransfer.getData(FILE_DRAG);
      if (!data) return;
      e.preventDefault(); e.stopPropagation();
      row.classList.remove('over');
      moveFile(JSON.parse(data), folderId);
    });
  };
  const walk = (parent, depth) => {
    for (const f of folderKids(parent)) {
      const n = count(f.id);
      if (q && !n) continue; // a filter shows only the folders that have a match
      const open = q ? true : !shut.has(f.id);
      const row = mk('div', 'fp-row fp-folder');
      row.style.setProperty('--d', depth);
      row.draggable = true;
      // The top folder of a snapshot of a disk folder shows where it came from.
      const link = global && (gfiles.links || []).find((l) => l.root === f.id);
      if (link) row.title = `A snapshot of ${link.path}, taken ${when(link.at)}`;
      row.append(mk('span', 'fp-caret', open ? '▼' : '▶'), mk('span', 'fp-icon', link ? '🗂' : '📁'), mk('span', 'fp-name', f.name), mk('span', 'fp-count', String(n)));
      row.onclick = () => { const s = filesShut(); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); store.set(shutKey(), JSON.stringify([...s])); again(); };
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(FILE_DRAG, JSON.stringify({ kind: 'folder', id: f.id })); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); folderMenu(f, e.clientX, e.clientY); });
      drop(row, f.id);
      rows.push(row);
      if (open) walk(f.id, depth + 1);
    }
    for (const p of here(parent)) {
      if (!hit(p)) continue;
      // In the global folders: a PDF that is not in the open project shows grey.
      const row = mk('div', `fp-row fp-file${pdf.meta?.id === p.id && !inLibraryTab() ? ' active' : ''}${grey(p) ? ' fp-out' : ''}`);
      row.style.setProperty('--d', depth);
      row.draggable = true;
      row.title = grey(p) ? `${p.name} (not in this project)` : p.name;
      const flag = sourceFlag(p.id);
      row.append(mk('span', 'fp-caret', ''), mk('span', 'fp-icon', kindIcon(p)), mk('span', 'fp-name', p.name));
      if (sub) row.append(mk('span', 'fp-sub', sub(p)));
      if (flag) row.append(Object.assign(mk('span', 'fp-warn', '⚠'), { title: flag.title }));
      row.onclick = () => onOpen(p);
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(FILE_DRAG, JSON.stringify({ kind: 'pdf', id: p.id })); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onMenu(p, e.clientX, e.clientY); });
      rows.push(row);
    }
  };
  walk(null, 0);
  tree.replaceChildren(...(rows.length ? rows : [mk('p', 'fp-empty', q ? 'No files match.' : 'No files.')]));
}
// Draw the folders where they show: the Files panel of the reader, or the library tab of the Projects view.
function renderFiles() {
  if (inLibraryTab()) { if (libTab === 'pdfs') renderPdfLibrary(); return; }
  if (!$('#fpTree')) return;
  $('#fpScope').hidden = !hasProject();
  for (const b of $('#fpScope').children) b.classList.toggle('on', b.dataset.scope === scopeNow());
  fileTree($('#fpTree'), {
    list: listNow(), q: $('#fpFilter').value.trim().toLowerCase(), again: renderFiles,
    onOpen: (p) => openPdf(p.id, 0, null, { here: true }).catch(fail), onMenu: fileMenu,
  });
}
// Move a PDF or a folder into a folder (null: the top). A folder cannot go into itself or into a folder in it.
function moveFile({ kind, id }, folderId) {
  if (kind === 'pdf') {
    if ((F().filed[id] || null) === folderId) return;
    if (folderId) F().filed[id] = folderId; else delete F().filed[id];
  } else {
    const f = F().folders.find((x) => x.id === id);
    if (!f || (f.parent || null) === folderId || (folderId && folderTree(id).includes(folderId))) return;
    f.parent = folderId;
  }
  if (folderId) { const s = filesShut(); if (s.delete(folderId)) store.set(shutKey(), JSON.stringify([...s])); }
  saveFiles().catch(fail);
}
async function newFolder(parent = null) {
  const name = await askText('New folder', '', { okLabel: 'Add', placeholder: 'Folder name' });
  if (!name) return;
  F().folders.push({ id: uid8(), name, parent });
  await saveFiles();
}
// A small menu at the pointer: items are [label, action, class] or null for a line.
function popMenu(items, x, y) {
  document.querySelector('.pop-menu')?.remove();
  const m = mk('div', 'ctx-menu pop-menu');
  for (const it of items) {
    if (!it) { m.append(mk('div', 'ctx-sep')); continue; }
    const b = mk('button', it[2] || '', it[0]);
    b.onclick = () => { m.remove(); it[1](); };
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.pop-menu')) document.querySelector('.pop-menu')?.remove(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.pop-menu')?.remove(); });
// The folders as lines for a "Move to" menu, with the depth as space at the start.
function folderLines(skip = new Set()) {
  const out = [];
  const walk = (parent, depth) => { for (const f of folderKids(parent)) { if (skip.has(f.id)) continue; out.push([`${' '.repeat(depth)}📁 ${f.name}`, f.id]); walk(f.id, depth + 1); } };
  walk(null, 0);
  return out;
}
function folderMenu(f, x, y) {
  const inside = new Set(folderTree(f.id));
  const link = scopeNow() === 'global' && (gfiles.links || []).find((l) => l.root === f.id);
  popMenu([
    ...(link ? [[`↻ Snapshot again (${link.path.split(/[\\/]/).filter(Boolean).pop()})`, () => snapshotFolder(f.id).catch(fail)]] : []),
    ['＋ New folder in here', () => newFolder(f.id).catch(fail)],
    ['✎ Rename', async () => { const name = await askText('Rename the folder', f.name, { okLabel: 'Rename' }); if (name) { f.name = name; saveFiles().catch(fail); } }],
    ...(f.parent ? [['↥ Move to the top', () => moveFile({ kind: 'folder', id: f.id }, null)]] : []),
    ...folderLines(inside).filter(([, id]) => id !== f.parent).slice(0, 12).map(([label, id]) => [`→ ${label.trim()}`, () => moveFile({ kind: 'folder', id: f.id }, id)]),
    null,
    ['× Delete the folder (its files stay)', () => {
      // What is in the folder goes one level up.
      const S = F();
      for (const k of S.folders) if (k.parent === f.id) k.parent = f.parent || null;
      for (const [pid, fid] of Object.entries(S.filed)) if (fid === f.id) { if (f.parent) S.filed[pid] = f.parent; else delete S.filed[pid]; }
      S.folders = S.folders.filter((k) => k.id !== f.id);
      saveFiles().catch(fail);
    }, 'danger'],
  ], x, y);
}
function fileMenu(p, x, y) {
  const here = F().filed[p.id] || null;
  const outside = hasProject() && !pdfList.some((x) => x.id === p.id);
  popMenu([
    ['Open', () => openPdf(p.id, 0, null, { here: true }).catch(fail)],
    ['Open in a new tab', async () => { await newTab(); await openPdf(p.id, 0, null, { here: true }); }],
    ...(isDoc(p) ? [['✎ Edit the doc', async () => { await openPdf(p.id, 0, null, { here: true }); await startDocEdit(); }]] : []),
    ['✎ Rename', () => renamePdf(p).catch(fail)],
    ['＋ New folder here', () => newFolder(here).catch(fail)],
    ...(outside ? [['＋ Add to this project', async () => {
      await api('POST', `/api/projects/${project.id}/pdfs`, { id: p.id });
      post({ type: 'projects' }); post({ type: 'pdfs' });
      await loadProjects(); await loadPdfs(); await loadSnippets();
      status(`Added “${p.name}” to this project.`, 'ok');
    }]] : []),
    null,
    ...(here ? [['↥ Move to the top', () => moveFile({ kind: 'pdf', id: p.id }, null)]] : []),
    ...folderLines().filter(([, id]) => id !== here).slice(0, 14).map(([label, id]) => [`→ ${label.trim()}`, () => moveFile({ kind: 'pdf', id: p.id }, id)]),
  ], x, y);
}
// Give a PDF another name (its title), from the Files panel.
async function renamePdf(p) {
  const name = await askText('Rename the file', p.name, { okLabel: 'Rename' });
  if (!name || name === p.name) return;
  const updated = await api('PATCH', `/api/pdfs/${p.id}`, { name });
  if (pdf.meta?.id === p.id) pdf.meta.name = updated.name;
  for (const t of tabs) if (t.pdfId === p.id) t.name = updated.name;
  renderTabs();
  post({ type: 'pdfs' });
  post({ type: 'snippets' });
  await loadPdfs();
  await loadSnippets(); // cards pick up the new name
  if (inLibraryTab()) await refreshLibrary();
  if (sideTab === 'details') renderDetails().catch(fail);
}
// A right-click on the empty part of the panel (or of the library tab): a new folder at the top.
for (const zone of [$('#filesPane'), $('#pdfLib')]) {
  zone.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fp-row, input, button')) return;
    e.preventDefault();
    popMenu([
      ['＋ New folder', () => newFolder(null).catch(fail)],
      ['＋ New doc', async () => { const name = await askText('New doc', '', { okLabel: 'Write it', placeholder: 'The name of the doc' }); if (name) await newDoc(name, inLibraryTab() || !hasProject() ? null : project.id); }],
      ...(scopeNow() === 'global' ? [['⤓ Snapshot a folder from the disk…', () => snapshotFolder().catch(fail)]] : []),
    ], e.clientX, e.clientY);
  });
}
// Copy a folder of the disk into the global folders: its PDFs go into the library, and the global folders get the
// same structure. root: the global folder of an earlier snapshot, to take what is new in its disk folder.
async function snapshotFolder(root = null) {
  status(root ? 'Taking a new snapshot…' : 'Pick the folder in the window that opened…');
  const r = await api('POST', '/api/files/snapshot', root ? { root } : {});
  if (r.canceled) return status('');
  post({ type: 'pdfs' });
  await loadPdfs();
  await loadFiles();
  if (inLibraryTab()) await refreshLibrary();
  const parts = [`${plural(r.found, 'PDF')} in “${r.name}”`, `${r.added} new in the library`];
  if (r.other) parts.push(`${plural(r.other, 'file')} of another type left out`);
  if (r.bad) parts.push(`${r.bad} could not be read`);
  if (r.capped) parts.push('stopped at 3000 files');
  status(`Snapshot: ${parts.join(', ')}.`, r.bad || r.capped ? 'err' : 'ok');
}
$('#filesBtn').onclick = () => showFiles($('#filesPane').hidden);
$('#fpNew').onclick = () => newFolder(null).catch(fail);
$('#fpFilter').oninput = () => renderFiles();
$('#fpScope').onclick = (e) => { const s = e.target.closest('button')?.dataset.scope; if (s) setFileScope(s); };
// A drop on the panel (or on the library tab), not on a folder: to the top.
for (const zone of [$('#filesPane'), $('#pdfLib')]) {
  zone.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes(FILE_DRAG)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } });
  zone.addEventListener('drop', (e) => {
    const data = e.dataTransfer.getData(FILE_DRAG);
    if (!data) return;
    e.preventDefault(); e.stopPropagation();
    moveFile(JSON.parse(data), null);
  });
}

// ---------- watching the sources ----------
// A source (a PDF, or the snapshot of a web page) has a watch: the status that the user set (current, superseded,
// withdrawn), a note, an address to check, and the result of the last check. A check loads the address and looks
// at the status that the page declares. For a web page it also looks if the text of each snippet is still there.
// A check runs when a project opens, for each source that was not checked in the last 30 days, and on request.
const STATUS_NAMES = { unknown: 'Not set', current: 'Current', superseded: 'Superseded', withdrawn: 'Withdrawn' };
const CHECK_EVERY = 30 * 24 * 3600 * 1000;
const metaOf = (id) => pdfList.find((p) => p.id === id);
const watchUrl = (m) => m?.watch?.url || (m?.source?.kind === 'web' ? m.source.url : '');
const watchMode = (m) => m?.watch?.mode || (m?.source?.kind === 'web' ? 'page' : 'status');
// What is wrong with a source, or with one snippet of it: { text, title } or null.
function sourceFlag(pdfId, hlId) {
  const m = metaOf(pdfId), w = m?.watch;
  if (!w) return null;
  if (w.status === 'withdrawn' || w.status === 'superseded') {
    return { text: w.status, title: `This source is marked as ${w.status}.${w.note ? ` ${w.note}` : ''}` };
  }
  if (hlId && w.result?.missing?.includes(hlId)) {
    return { text: 'changed at source', title: `This text was not on the web page at the last check (${when(w.checkedAt)}). The page may have changed.` };
  }
  return null;
}
// What the last check found, in words. needsLook: the user should look at this source.
function checkSummary(m) {
  const w = m?.watch, r = w?.result;
  if (!r) return { lines: [watchUrl(m) ? 'Not checked yet.' : 'No address to check.'], needsLook: false };
  const lines = [`Checked ${when(r.at)}.`];
  let needsLook = false;
  if (r.error) return { lines: [...lines, `The page did not load: ${r.error}`], needsLook: true };
  if (r.found) {
    lines.push(`The page says: “${r.declared}”${r.weak ? ' (not in a status line, so this is a weak sign)' : ''}.`);
    // A look is needed when the page declares withdrawn or superseded and the user's status does not say so yet.
    if ((r.found === 'withdrawn' || r.found === 'superseded') && r.found !== w.status) needsLook = true;
  } else lines.push('The page declares no status that Corkboard can read.');
  if (r.was != null) { lines.push(`At the check before, it said: “${r.was || 'nothing'}”.`); needsLook = true; }
  if (r.mode === 'page') {
    const n = r.missing?.length || 0;
    if (!r.total) lines.push('This source has no text snippets to look for.');
    else if (!n) lines.push(`The text of all ${plural(r.total, 'snippet')} is on the page.`);
    else if (n === r.total) { lines.push(`The text of none of the ${plural(r.total, 'snippet')} is on the page. The page may need a sign-in, or it moved.`); needsLook = true; }
    else { lines.push(`The text of ${n} of ${plural(r.total, 'snippet')} is not on the page any more. Those snippets have a mark.`); needsLook = true; }
  }
  return { lines, needsLook };
}
async function setWatch(id, patch) {
  const updated = await api('PATCH', `/api/pdfs/${id}`, { watch: patch });
  const m = metaOf(id);
  if (m) m.watch = updated.watch;
  post({ type: 'pdfs' });
  showWatchMarks();
  return updated;
}
// Draw the marks again where they show: the snippet list, the cards, the tray.
function showWatchMarks() {
  pdf.renderList();
  board.refreshTerms();
  renderTray();
}
async function checkSource(id) {
  const updated = await api('POST', `/api/watch/check/${id}`);
  const m = metaOf(id);
  if (m) m.watch = updated.watch;
  return updated;
}
let checking = false;
// Check the sources of the open project. all: every source with an address. Else only those that are due.
async function checkSources(all = false) {
  if (checking || !project) return;
  if (!(await api('GET', '/api/info').catch(() => ({}))).capture) { if (all) status('Sources can be checked in the desktop app only.', 'err'); return; }
  const due = pdfList.filter((m) => watchUrl(m) && (all || !m.watch?.checkedAt || Date.now() - m.watch.checkedAt > CHECK_EVERY));
  if (!due.length) { if (all) status('No source of this project has an address to check. Add one in the Details tab of a PDF.'); return; }
  checking = true;
  const here = project.id;
  let look = 0;
  try {
    for (let i = 0; i < due.length && project?.id === here; i++) {
      status(`Checking source ${i + 1} of ${due.length}: ${due[i].name}…`);
      await checkSource(due[i].id).catch(() => {});
      if (checkSummary(metaOf(due[i].id)).needsLook) look++;
    }
  } finally { checking = false; }
  if (project?.id !== here) return;
  post({ type: 'pdfs' });
  showWatchMarks();
  if (sideTab === 'details') renderDetails().catch(fail);
  status(look ? `Checked ${plural(due.length, 'source')}. ${look} need${look === 1 ? 's' : ''} a look: Options → Sources.` : `Checked ${plural(due.length, 'source')}. Nothing changed.`, look ? 'err' : 'ok');
}
// The part of the Details tab for the open PDF.
function watchSection(meta, info) {
  const m = metaOf(meta.id) || info, w = m.watch || {};
  const box = mk('div', 'det-watch');
  box.append(mk('div', 'det-watch-title', 'Source status'));
  const sel = document.createElement('select');
  for (const [v, name] of Object.entries(STATUS_NAMES)) sel.append(new Option(name, v));
  sel.value = w.status || 'unknown';
  sel.onchange = () => setWatch(meta.id, { status: sel.value }).then(() => { status('Status saved', 'ok'); renderDetails().catch(fail); }).catch(fail);
  const l1 = mk('label', '', 'Status (you set this)');
  l1.append(sel);
  const note = Object.assign(document.createElement('input'), { type: 'text', value: w.note || '', placeholder: 'For example: replaced by the online dictionary' });
  note.onchange = () => setWatch(meta.id, { note: note.value }).then(() => status('Note saved', 'ok')).catch(fail);
  const l2 = mk('label', '', 'Note');
  l2.append(note);
  const url = Object.assign(document.createElement('input'), { type: 'url', value: watchUrl(m), placeholder: 'https://… the page that shows the status of this document', spellcheck: false });
  url.onchange = () => setWatch(meta.id, { url: url.value }).then(() => { status('Address saved', 'ok'); renderDetails().catch(fail); }).catch(fail);
  const l3 = mk('label', '', 'Address to check');
  l3.append(url);
  const mode = document.createElement('select');
  mode.append(new Option('The declared status only (for a catalogue page of a standard)', 'status'), new Option('The declared status, and the text of each snippet (for a public web page)', 'page'));
  mode.value = watchMode(m);
  mode.onchange = () => setWatch(meta.id, { mode: mode.value }).then(() => status('Saved', 'ok')).catch(fail);
  const l4 = mk('label', '', 'What to check');
  l4.append(mode);
  const acts = mk('div', 'det-watch-acts');
  const check = mk('button', 'det-refresh', 'Check now');
  check.disabled = !watchUrl(m);
  check.onclick = async () => {
    check.disabled = true;
    status(`Checking ${meta.name}…`);
    try { await checkSource(meta.id); status('Checked', 'ok'); } catch (e) { fail(e); }
    post({ type: 'pdfs' });
    showWatchMarks();
    renderDetails().catch(fail);
  };
  const signin = mk('button', 'det-refresh', 'Sign in to this site…');
  signin.title = 'Open the address in a window, where you sign in yourself. Corkboard keeps that session for later checks and snapshots.';
  signin.disabled = !watchUrl(m);
  signin.onclick = () => api('POST', '/api/watch/signin', { url: watchUrl(m) }).then(() => status('Sign in in the window that opened. Close it when you are done, then click Check now.')).catch(fail);
  acts.append(check, signin);
  const sum = checkSummary(m), res = mk('div', `det-watch-result${sum.needsLook ? ' look' : ''}`);
  for (const line of sum.lines) res.append(mk('div', '', line));
  // The page declares a status that is not the one the user set: offer it. Corkboard does not set it by itself.
  const r = w.result;
  if (r && !r.error && r.found && r.found !== (w.status || 'unknown')) {
    const take = mk('button', 'det-refresh', `Set the status to ${STATUS_NAMES[r.found]}`);
    take.onclick = () => setWatch(meta.id, { status: r.found }).then(() => { status('Status saved', 'ok'); renderDetails().catch(fail); }).catch(fail);
    res.append(take);
  }
  if (r && !r.error && r.mode === 'page' && r.missing?.length && m.source?.kind === 'web' && hasProject()) {
    const snap = mk('button', 'det-refresh', 'Save a new snapshot of the page');
    snap.title = 'Add the page as it is now, as a new source in this project. The old snapshot and its snippets stay.';
    snap.onclick = async () => {
      snap.disabled = true;
      status('Saving a new snapshot…');
      try { const made = await captureWeb(watchUrl(m), project.id); await loadPdfs(); post({ type: 'pdfs' }); status(`Saved “${made.name}”. It is in the PDF list.`, 'ok'); } catch (e) { fail(e); }
      snap.disabled = false;
    };
    res.append(snap);
  }
  box.append(l1, l2, l3, l4, acts, res);
  return box;
}
// Options → Sources: every source of the project with its status and its last check.
function openSources() {
  const dlg = mk('dialog', 'dict-dialog sources-dialog');
  const head = mk('div', 'dd-head');
  const close = mk('button', '', 'Close');
  close.onclick = () => dlg.close();
  const all = mk('button', '', 'Check all now');
  all.onclick = async () => { all.disabled = true; await checkSources(true).catch(fail); all.disabled = false; fill(); };
  const btns = mk('div', 'dd-btns');
  btns.append(all, close);
  head.append(mk('h3', '', 'Sources'), btns);
  const list = mk('div', 'terms-panel src-list');
  const fill = () => {
    list.replaceChildren(...(pdfList.length ? pdfList.map((m) => {
      const sum = checkSummary(m), row = mk('div', `term-item src-item${sum.needsLook ? ' look' : ''}`);
      const st = m.watch?.status || 'unknown';
      const h = mk('div', 'ti-head');
      h.append(mk('span', 'ti-term', m.name), mk('span', `ti-badge st-${st}`, STATUS_NAMES[st]));
      row.append(h);
      if (m.watch?.note) row.append(mk('div', 'ti-def', m.watch.note));
      if (watchUrl(m)) row.append(mk('div', 'src-url', watchUrl(m)));
      for (const line of sum.lines) row.append(mk('div', 'src-line', line));
      row.title = 'Click to open this source and its Details tab';
      row.onclick = () => { dlg.close(); setView('read'); openPdf(m.id).then(() => showSide('details')).catch(fail); };
      return row;
    }) : [mk('p', 'tp-empty', 'This project has no sources yet.')]));
  };
  dlg.append(head, mk('p', 'src-help', 'A check loads the address of each source. It runs when you open a project, for each source that was not checked in the last 30 days. Set the address and the status of a source in its Details tab.'), list);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  fill();
  dlg.showModal();
}

// ---------- dictionary: terms and their definitions ----------
// Two scopes: the project's terms and the global terms. A term that came from a document keeps a link to its
// passage there (source). Each use of a term is underlined in the reader and on cards. A hover shows the definition.
let dict = { project: [], global: [], seen: {} }; // seen: { pdfId: how many terms it gave } (looked at already)
let found = null; // terms found in the open PDF that wait for a review: { pdfId, name, title, page, entries }
const matchers = new Map();
const hasProject = () => !!project && !project.library;
const termById = (id) => dict.project.find((t) => t.id === id) || dict.global.find((t) => t.id === id);
// Where a document is given, its own terms win over the project's other terms. Those win over the global ones.
function matcherFor(pdfId) {
  const key = pdfId || '';
  if (!matchers.has(key)) {
    const own = dict.project.filter((t) => pdfId && t.source?.pdfId === pdfId);
    matchers.set(key, buildMatcher([...own, ...dict.project.filter((t) => !own.includes(t)), ...dict.global]));
  }
  return matchers.get(key);
}
function decorateCard(el, c) {
  if (!dict.project.length && !dict.global.length) return;
  const match = matcherFor(c.source?.pdfId);
  for (const part of el.querySelectorAll('.quote, .snote, .note-text, .sfoot')) decorateTerms(part, match);
}
async function loadTerms() {
  const [g, p] = await Promise.all([api('GET', '/api/terms/global'), hasProject() ? api('GET', `/api/terms/${project.id}`) : { terms: [], seen: {} }]);
  dict = {
    global: (g.terms || []).map((t) => ({ ...t, scope: 'global' })),
    project: (p.terms || []).map((t) => ({ ...t, scope: 'project' })),
    seen: p.seen || {},
  };
  if (found && found.pdfId !== pdf.meta?.id) found = null;
  applyTerms();
}
async function saveTerms(scope) {
  if (scope === 'global') await api('PUT', '/api/terms/global', { terms: dict.global });
  else if (hasProject()) await api('PUT', `/api/terms/${project.id}`, { terms: dict.project, seen: dict.seen });
  post({ type: 'terms' });
}
// The dictionary changed: draw the underlines again, in the reader and on the cards.
function applyTerms() {
  matchers.clear();
  pdf.setTermMatcher(dict.project.length || dict.global.length ? matcherFor(pdf.meta?.id) : null);
  board.refreshTerms();
  renderTerms();
}
// Look in the open PDF for a section called Definitions, Terms or Terminology. This runs once for each PDF of a
// project (seen), and again when you ask for it.
async function detectTerms(manual = false) {
  const meta = pdf.meta;
  if (!meta) { if (manual) status('Open a PDF first.'); return; }
  if (!manual && (!hasProject() || dict.seen[meta.id] != null)) return;
  if (manual) status('Looking for a terms section…');
  const res = await pdf.findDefinitions();
  if (pdf.meta?.id !== meta.id) return;
  const have = new Set([...dict.project, ...dict.global].filter((t) => t.source?.pdfId === meta.id).map((t) => t.term.toLowerCase()));
  const entries = (res?.entries || []).filter((e) => !have.has(e.term.toLowerCase()));
  if (!entries.length) {
    if (hasProject() && dict.seen[meta.id] == null) { dict.seen[meta.id] = 0; saveTerms('project').catch(fail); }
    if (manual) status(res ? 'All the terms of that section are in the dictionary already.' : 'No section called Definitions, Terms or Terminology was found in this PDF.');
    return;
  }
  found = { pdfId: meta.id, name: meta.name, title: res.title, page: res.page, entries };
  renderTerms();
  status(`Found ${plural(entries.length, 'term')} in “${res.title}” (p.${res.page}). Review them in the Terms tab.`, 'ok');
  if (manual) reviewFound();
}
function dismissFound() {
  if (!found) return;
  if (hasProject()) { dict.seen[found.pdfId] = 0; saveTerms('project').catch(fail); }
  found = null;
  renderTerms();
}
// The review list: the entries a PDF gave, each with a tick box. You correct them, then add the ticked ones.
// Each entry reads as text (the term in bold, then its definition in full). A click in it lets you correct it.
function reviewFound() {
  if (!found) return;
  const f = found, scope = hasProject() ? 'project' : 'global';
  const dlg = mk('dialog', 'ask-dialog term-review');
  dlg.append(mk('h3', '', `Terms found in “${f.name}”`),
    mk('p', '', `From the section “${f.title}” on page ${f.page}. Clear the box of an entry that is wrong, or click its text to correct it. The ticked entries go into the ${scope === 'project' ? 'project' : 'global'} dictionary.`));
  const tools = mk('div', 'tr-tools');
  const filter = Object.assign(mk('input', 'tr-filter'), { type: 'search', placeholder: 'Filter the entries…', autocomplete: 'off', spellcheck: false });
  const count = mk('span', 'tr-count');
  const all = mk('button', 'tr-all', 'Clear all');
  all.type = 'button';
  tools.append(filter, count, all);
  const list = mk('div', 'tr-list');
  const rows = f.entries.map((e) => {
    const row = mk('div', 'tr-row');
    const box = Object.assign(mk('input'), { type: 'checkbox', checked: true, title: 'Add this entry' });
    const term = Object.assign(mk('textarea', 'tr-term'), { value: e.term, rows: 1, spellcheck: false });
    const def = Object.assign(mk('textarea', 'tr-def'), { value: e.def, rows: 1 });
    const left = mk('div', 'tr-left');
    left.append(term, mk('span', 'tr-page', `p.${e.page}`));
    row.append(box, left, def);
    list.append(row);
    return { e, row, box, term, def };
  });
  const sync = () => {
    const on = rows.filter((r) => r.box.checked).length;
    count.textContent = `${on} of ${rows.length} ticked`;
    all.textContent = on ? 'Clear all' : 'Tick all';
    ok.textContent = `Add ${plural(on, 'term')}`;
    ok.disabled = !on;
    for (const r of rows) r.row.classList.toggle('off', !r.box.checked);
  };
  const foot = mk('div', 'ask-buttons');
  const cancel = mk('button', '', 'Not now');
  cancel.type = 'button';
  cancel.onclick = () => dlg.close();
  const ok = mk('button', 'primary', 'Add');
  ok.type = 'button';
  all.onclick = () => { const on = !rows.some((r) => r.box.checked); for (const r of rows) if (!r.row.hidden) r.box.checked = on; sync(); };
  list.addEventListener('change', (ev) => { if (ev.target.type === 'checkbox') sync(); });
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = !!q && !`${r.term.value} ${r.def.value}`.toLowerCase().includes(q);
  };
  ok.onclick = () => {
    const add = rows.filter((r) => r.box.checked && r.term.value.trim() && r.def.value.trim()).map((r) => ({
      id: uid8(), term: r.term.value.replace(/\s+/g, ' ').trim(), forms: r.e.forms || [], def: r.def.value.trim(), scope, auto: true,
      source: { pdfId: f.pdfId, name: f.name, page: r.e.page, rects: r.e.rects }, created: Date.now(),
    }));
    dict[scope].push(...add);
    if (hasProject()) dict.seen[f.pdfId] = add.length;
    found = null;
    dlg.close();
    saveTerms(scope).catch(fail);
    applyTerms();
    status(`Added ${plural(add.length, 'term')} to the ${scope} dictionary.`, 'ok');
  };
  foot.append(cancel, ok);
  dlg.append(tools, list, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  sync();
  dlg.showModal();
  filter.focus();
}
// Add or change one term. t: the term (a new one has no id yet).
function openTermDialog(t, isNew = !t.id) {
  const dlg = mk('dialog', 'ask-dialog term-dialog');
  const form = mk('form');
  form.method = 'dialog';
  form.append(mk('h3', '', isNew ? 'Add a term' : 'Edit the term'));
  const field = (label, node) => { const l = mk('label', 'td-field', label); l.append(node); form.append(l); return node; };
  const term = field('Term', Object.assign(mk('input'), { type: 'text', value: t.term || '', spellcheck: false, placeholder: 'For example: HAC' }));
  const forms = field('Other forms of the term (separate them with commas)', Object.assign(mk('input'), { type: 'text', value: (t.forms || []).join(', '), spellcheck: false, placeholder: 'For example: Hearing Aid Compatibility' }));
  const def = field('Definition', Object.assign(mk('textarea'), { value: t.def || '', rows: 5 }));
  const scopes = mk('div', 'td-scopes');
  let scope = t.scope || (hasProject() ? 'project' : 'global');
  for (const [val, label, tip] of [['project', 'This project', 'The term applies to the PDFs and boards of this project'], ['global', 'Global', 'The term applies in every project']]) {
    const l = mk('label', '', ` ${label}`);
    const r = Object.assign(mk('input'), { type: 'radio', name: 'termScope', value: val, checked: scope === val, disabled: val === 'project' && !hasProject() });
    r.onchange = () => { scope = val; };
    l.title = tip;
    l.prepend(r);
    scopes.append(l);
  }
  form.append(mk('div', 'td-label', 'Where it applies'), scopes);
  let source = t.source || null;
  if (source) {
    const src = mk('div', 'td-source', `Source: ${source.name} · p.${source.page} `);
    const drop = mk('button', 'td-drop', 'Remove the source');
    drop.type = 'button';
    drop.onclick = () => { source = null; src.remove(); };
    src.append(drop);
    form.append(src);
  }
  const foot = mk('div', 'ask-buttons');
  if (!isNew) {
    const del = mk('button', 'danger', 'Delete');
    del.type = 'button';
    del.onclick = () => {
      dict[t.scope] = dict[t.scope].filter((x) => x.id !== t.id);
      dlg.close();
      saveTerms(t.scope).catch(fail);
      applyTerms();
    };
    foot.append(del, mk('span', 'td-gap'));
  }
  const cancel = mk('button', '', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => dlg.close();
  const ok = mk('button', 'primary', isNew ? 'Add' : 'Save');
  ok.type = 'submit';
  const sync = () => { ok.disabled = !term.value.trim() || !def.value.trim(); };
  term.oninput = sync; def.oninput = sync;
  sync();
  foot.append(cancel, ok);
  form.append(foot);
  form.onsubmit = () => {
    const next = { ...t, id: t.id || uid8(), term: term.value.trim(), forms: forms.value.split(',').map((x) => x.trim()).filter(Boolean), def: def.value.trim(), scope, created: t.created || Date.now() };
    if (source) next.source = source; else delete next.source;
    const was = isNew ? null : t.scope;
    if (was) dict[was] = dict[was].filter((x) => x.id !== t.id);
    dict[scope].push(next);
    if (was && was !== scope) saveTerms(was).catch(fail);
    saveTerms(scope).catch(fail);
    applyTerms();
  };
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  (term.value ? def : term).focus();
}
// The list of terms: in the reader's Terms tab, and in the Dictionary dialog (Options).
function renderTerms() {
  const n = dict.project.length + dict.global.length;
  $('#termCount').textContent = n ? `(${n})` : '';
  for (const box of document.querySelectorAll('.terms-panel')) fillTermsPanel(box);
}
function fillTermsPanel(box) {
  if (!box.dataset.ready) {
    box.dataset.ready = '1';
    const bar = mk('div', 'tp-bar');
    const filter = Object.assign(mk('input', 'tp-filter'), { type: 'search', placeholder: 'Filter terms…', autocomplete: 'off', spellcheck: false });
    filter.oninput = () => fillTermsPanel(box);
    const add = mk('button', 'tp-add', '＋ Add');
    add.title = 'Add a term and its definition';
    add.onclick = () => openTermDialog({ term: '', forms: [], def: '' }, true);
    bar.append(filter, add);
    const find = mk('button', 'tp-find', 'Find the terms section of this PDF');
    find.title = 'Look in the open PDF for a section called Definitions, Terms or Terminology, and read its entries';
    find.onclick = () => detectTerms(true).catch(fail);
    box.append(bar, mk('div', 'tp-banner'), mk('div', 'tp-list'), find);
  }
  const q = box.querySelector('.tp-filter').value.trim().toLowerCase();
  const banner = box.querySelector('.tp-banner');
  banner.hidden = !found;
  banner.replaceChildren();
  if (found) {
    banner.append(mk('span', '', `${plural(found.entries.length, 'term')} found in “${found.title}” (p.${found.page})`));
    const rev = mk('button', 'primary', 'Review');
    rev.onclick = reviewFound;
    const no = mk('button', '', 'Dismiss');
    no.onclick = dismissFound;
    banner.append(rev, no);
  }
  box.querySelector('.tp-find').hidden = !pdf.meta || document.body.dataset.view !== 'read';
  const all = [...dict.project, ...dict.global]
    .filter((t) => !q || [t.term, ...(t.forms || []), t.def].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
  const list = box.querySelector('.tp-list');
  list.replaceChildren(...(all.length ? all.map((t) => {
    const row = mk('div', 'term-item');
    row.title = 'Click to edit';
    const head = mk('div', 'ti-head');
    head.append(mk('span', 'ti-term', t.term));
    if (t.forms?.length) head.append(mk('span', 'ti-forms', t.forms.join(', ')));
    head.append(mk('span', `ti-badge ${t.scope}`, t.scope === 'global' ? 'Global' : 'Project'));
    if (t.auto) head.append(Object.assign(mk('span', 'ti-badge auto', 'auto'), { title: 'Read from the terms section of its document' }));
    row.append(head, mk('div', 'ti-def', t.def));
    if (t.source) {
      const src = mk('button', 'ti-src', `↗ ${t.source.name} · p.${t.source.page}`);
      src.title = 'Open the passage that defines this term';
      src.onclick = (e) => { e.stopPropagation(); box.closest('dialog')?.close(); openSource(t.source); };
      row.append(src);
    }
    row.onclick = () => openTermDialog(t);
    return row;
  }) : [mk('p', 'tp-empty', q ? 'No terms match.' : 'No terms yet. Add one here, or select text in a PDF and click “Define term”. A PDF with a section called Definitions, Terms or Terminology gives its terms automatically.')]));
}
function openDictionary() {
  const dlg = mk('dialog', 'dict-dialog');
  const head = mk('div', 'dd-head');
  const close = mk('button', '', 'Close');
  close.onclick = () => dlg.close();
  head.append(mk('h3', '', 'Dictionary'), close);
  const panel = mk('div', 'terms-panel');
  dlg.append(head, panel);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  fillTermsPanel(panel);
  dlg.showModal();
}
// The definition of the term under the pointer. It stays while the pointer is on the term or on the box.
const termTip = mk('div', 'term-tip');
termTip.hidden = true;
document.body.append(termTip);
let tipFor = null, tipTimer = 0;
function showTermTip(t, rect) {
  clearTimeout(tipTimer);
  tipTimer = 0;
  if (tipFor === t.id && !termTip.hidden) return;
  tipFor = t.id;
  termTip.replaceChildren();
  const head = mk('div', 'tt-head');
  head.append(mk('span', 'tt-term', t.term));
  if (t.forms?.length) head.append(mk('span', 'tt-forms', t.forms.join(', ')));
  termTip.append(head, mk('div', 'tt-def', t.def));
  const foot = mk('div', 'tt-foot');
  foot.append(mk('span', '', t.scope === 'global' ? 'Global term' : 'Project term'));
  if (t.source) {
    const src = mk('button', 'tt-src', `↗ ${t.source.name} · p.${t.source.page}`);
    src.onclick = () => { termTip.hidden = true; tipFor = null; openSource(t.source); };
    foot.append(src);
  }
  const edit = mk('button', 'tt-edit', 'Edit');
  edit.onclick = () => { termTip.hidden = true; tipFor = null; openTermDialog(termById(t.id) || t); };
  foot.append(edit);
  termTip.append(foot);
  termTip.hidden = false;
  const r = termTip.getBoundingClientRect();
  termTip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - r.width - 8))}px`;
  termTip.style.top = `${rect.bottom + 6 + r.height > innerHeight ? Math.max(8, rect.top - r.height - 6) : rect.bottom + 6}px`;
}
function hideTermTip() {
  if (termTip.hidden || tipTimer) return;
  tipTimer = setTimeout(() => { tipTimer = 0; termTip.hidden = true; tipFor = null; }, 300);
}
termTip.addEventListener('mouseenter', () => { clearTimeout(tipTimer); tipTimer = 0; });
termTip.addEventListener('mouseleave', hideTermTip);
document.addEventListener('mouseover', (e) => {
  const s = e.target.closest?.('.card .term');
  const t = s && !e.buttons && termById(s.dataset.term);
  if (t) showTermTip(t, s.getBoundingClientRect());
});
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.card .term')) hideTermTip(); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.term-tip')) { termTip.hidden = true; tipFor = null; } }, true);

initAutoscroll({
  board: {
    isTarget: (el) => !!el.closest?.('#boardPane') && !el.closest('#tray, .link-bar, .note-tools'),
    panBy: (dx, dy) => { if (!board.data) return; board.data.view.x += dx; board.data.view.y += dy; board.applyView(); },
    done: () => board.changed('view'),
  },
});
window.corkboard = { board, pdf }; // for debugging in the browser console

// The dev copy says so, so it is never mistaken for the installed one.
api('GET', '/api/info').then((info) => {
  if (info.mode === 'installed') {
    $('#helpDialog h2').textContent = `Using Corkboard${info.version ? ` (version ${info.version})` : ''}`;
    return;
  }
  devMode = true;
  const tag = Object.assign(document.createElement('span'), { className: 'dev-tag', textContent: 'DEV' });
  tag.title = `Development copy · data in ${info.data}`;
  $('#views').before(tag);
  showProjectName();
}).catch(() => {});

// ---------- start ----------
board.setTool('move');
const startView = location.hash.slice(1); // read it before setView() rewrites the address
setView('projects');
(async () => {
  await loadProjects();
  const want = startView;
  const last = store.get('corkboard.project');
  if (want !== 'projects' && last === '@library') await openStandalone(store.get('corkboard.pdf.@library'));
  else if (want !== 'projects' && last && projectList.some((p) => p.id === last)) await openProject(last, VIEWS.includes(want) ? want : undefined);
  showSide(sideTab);
})().catch(fail);
