// Steady text selection over pdf.js text layers.
// Adapted from TextLayerBuilder in pdf.js (web/text_layer_builder.js, Apache License 2.0, Mozilla Foundation).
// Without this, a drag through the gap between two lines can jump the selection to far-off text,
// because the browser falls back to the nearest text node in DOM order.
//
// How: each text layer gets an empty "endOfContent" block. While a selection is in progress it covers
// the layer behind the text, and (in older Chromium) it is moved to sit just after the selection's end.
const layers = new Map(); // text layer div -> its endOfContent div
let listening = false;

function reset(end, layer) {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  end.style.userSelect = '';
  layer.classList.remove('selecting');
}

export function attachSelection(layer) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  layers.set(layer, end);
  listen();
}

export function detachSelection(layer) {
  layers.delete(layer);
}

function listen() {
  if (listening) return;
  listening = true;
  let pointerDown = false;
  let modernEngine;
  let prevRange = null;
  const prune = () => { for (const layer of layers.keys()) if (!layer.isConnected) layers.delete(layer); };

  document.addEventListener('pointerdown', () => { pointerDown = true; });
  document.addEventListener('pointerup', () => { pointerDown = false; layers.forEach(reset); });
  snapToText();
  window.addEventListener('blur', () => { pointerDown = false; layers.forEach(reset); });
  document.addEventListener('keyup', () => { if (!pointerDown) layers.forEach(reset); });

  document.addEventListener('selectionchange', () => {
    prune();
    if (!layers.size) return;
    const selection = document.getSelection();
    if (!selection.rangeCount) { layers.forEach(reset); return; }

    const active = new Set();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else reset(end, layer);
    }

    // Firefox and Chromium 148+ select well with the covering block alone.
    if (modernEngine === undefined) {
      const firefox = getComputedStyle(layers.keys().next().value).getPropertyValue('-moz-user-select') === 'none';
      const chromium = navigator.userAgentData
        ? navigator.userAgentData.brands.find(({ brand }) => brand === 'Chromium')?.version
        : /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
      modernEngine = firefox || (!!chromium && parseInt(chromium, 10) >= 148);
    }
    if (modernEngine) return;

    // Older engines: put the block right after the end being dragged.
    const range = selection.getRangeAt(0);
    const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
      || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      do {
        while (!anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor.previousSibling;
      } while (!anchor.childNodes.length);
    }
    const layer = anchor.parentElement?.closest('.textLayer');
    const end = layers.get(layer);
    if (end) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}

// ---------- a drag does not have to stay on the letters ----------
// The browser only moves the end of a selection while the pointer is on a letter's box. So a drag that ends
// just past a full stop, or in the gap below a line, loses the last letters. Here, while the pointer is off the
// letters, the end of the selection goes to the nearest letter: the nearest line first, then the nearest place
// along it (past the end of the line means the end of its last word). A drag that starts off the letters works
// the same way, from the nearest letter.
const leafSpans = (layer) => [...layer.querySelectorAll('span')].filter((el) => !el.classList.contains('sep') && !el.classList.contains('markedContent')
  && el.getAttribute('role') !== 'img' && !el.querySelector('span') && el.textContent.length
  && !(el.closest('.running') && el.closest('.skip-running')));
const caretAt = (x, y) => {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, off: p.offset };
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, off: r.startOffset } : null;
};
// The layer of the page under the point, else of the page nearest to it (up or down).
function layerNear(x, y) {
  const under = document.elementFromPoint(x, y)?.closest?.('.page')?.querySelector('.textLayer');
  if (under && layers.has(under)) return under;
  let best = null, bd = Infinity;
  for (const layer of layers.keys()) {
    if (!layer.isConnected) continue;
    const r = layer.getBoundingClientRect();
    if (!r.height) continue;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bd) { bd = d; best = layer; }
  }
  return best;
}
// The place in the text nearest to a point: { node, off }, or null when the page has no text.
function nearestCaret(x, y) {
  const layer = layerNear(x, y);
  if (!layer) return null;
  let best = null;
  for (const el of leafSpans(layer)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    // The line comes first: a point level with a line belongs to that line, however far along it is.
    const d = dy * 1000 + dx;
    if (!best || d < best.d) best = { d, el, r };
  }
  if (!best) return null;
  const { el, r } = best, text = el.lastChild?.nodeType === 3 ? el.lastChild : null, first = el.firstChild?.nodeType === 3 ? el.firstChild : null;
  if (x >= r.right) return text ? { node: text, off: text.length } : { node: el, off: el.childNodes.length };
  if (x <= r.left) return first ? { node: first, off: 0 } : { node: el, off: 0 };
  // Above or below the word: the letter at that x.
  const c = caretAt(x, (r.top + r.bottom) / 2);
  return c && el.contains(c.node) ? c : (text ? { node: text, off: text.length } : null);
}
const onLetter = (t) => !!(t?.closest?.('.textLayer') && t.tagName === 'SPAN' && !t.classList.contains('sep') && !t.classList.contains('markedContent'));

function snapToText() {
  let drag = null; // { x, y, own (the drag started off the letters: this code makes the whole selection), anchor, on }
  document.addEventListener('pointerdown', (e) => {
    drag = null;
    if (e.button !== 0 || e.altKey || e.detail > 1) return;
    const layer = e.target.closest?.('.textLayer');
    if (!layer || !layers.has(layer) || getComputedStyle(layer).pointerEvents === 'none') return;
    drag = { x: e.clientX, y: e.clientY, own: !onLetter(e.target), anchor: null, on: false };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!drag || !(e.buttons & 1)) return;
    if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.on = true;
    const sel = getSelection();
    const over = onLetter(document.elementFromPoint(e.clientX, e.clientY));
    if (!drag.own) {
      // The browser makes this selection. Off the letters, move its end to the nearest letter.
      if (over || !sel.rangeCount || !sel.anchorNode?.parentElement?.closest('.textLayer')) return;
      const c = nearestCaret(e.clientX, e.clientY);
      if (c && (sel.focusNode !== c.node || sel.focusOffset !== c.off)) sel.extend(c.node, c.off);
      return;
    }
    drag.anchor ||= nearestCaret(drag.x, drag.y);
    const c = (over && caretAt(e.clientX, e.clientY)) || nearestCaret(e.clientX, e.clientY);
    if (drag.anchor && c) sel.setBaseAndExtent(drag.anchor.node, drag.anchor.off, c.node, c.off);
  }, true);
  document.addEventListener('pointerup', () => { drag = null; }, true);
}

// ---------- reading order ----------
// pdf.js puts text in the order the PDF stores it. Many PDFs store the page footer or header first,
// or tables column by column, so a drag from top to bottom jumps all over the page.
// This puts the spans in visual reading order with a simple XY-cut: split the page at its widest
// blank band (across or down), and repeat in each part. Columns, headers, footers and tables then
// read in a sensible order. A <br> ends each line, so copied text and snippets read top to bottom too.
export function orderTextLayer(layer) {
  const spans = [...layer.querySelectorAll('span')]
    .filter((s) => !s.classList.contains('markedContent') && !s.classList.contains('sep') && !s.querySelector('span') && s.textContent.length);
  if (spans.length < 2) return;
  const origin = layer.getBoundingClientRect();
  const boxes = spans.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, x0: r.left - origin.left, y0: r.top - origin.top, x1: r.right - origin.left, y1: r.bottom - origin.top };
  }).filter((b) => b.y1 > b.y0);
  if (boxes.length < 2) return;
  const heights = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  const lineH = heights[heights.length >> 1] || 10;

  // The widest empty band along one axis, and the boxes on each side of it.
  const widestGap = (list, lo, hi) => {
    const sorted = [...list].sort((a, b) => a[lo] - b[lo]);
    let reach = sorted[0][hi], best = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i][lo] - reach;
      if (gap > 0 && (!best || gap > best.gap)) best = { gap, at: (reach + sorted[i][lo]) / 2 };
      reach = Math.max(reach, sorted[i][hi]);
    }
    return best && { ...best, before: list.filter((b) => b[hi] <= best.at), after: list.filter((b) => b[hi] > best.at) };
  };
  const byLines = (list) => {
    // Same line when the vertical centres are close; then left to right.
    const sorted = [...list].sort((a, b) => a.y0 - b.y0);
    const lines = [];
    for (const b of sorted) {
      const c = (b.y0 + b.y1) / 2, last = lines[lines.length - 1];
      if (last && Math.abs(c - last.c) < lineH * 0.5) last.items.push(b);
      else lines.push({ c, items: [b] });
    }
    return lines.flatMap((l) => l.items.sort((a, b) => a.x0 - b.x0));
  };
  // Real text columns have several lines that fill most of the column's width. Table cells do not.
  const textColumns = (split) => [split.before, split.after].every((side) => {
    const x0 = Math.min(...side.map((b) => b.x0)), x1 = Math.max(...side.map((b) => b.x1));
    return side.filter((b) => b.x1 - b.x0 >= 0.6 * (x1 - x0)).length >= 4;
  });
  const cut = (list, depth = 0) => {
    if (list.length < 2 || depth > 80) return byLines(list);
    const across = widestGap(list, 'y0', 'y1'); // a blank band from left to right: top part, then bottom
    const down = widestGap(list, 'x0', 'x1');   // a blank band from top to bottom: left part, then right
    const okAcross = across && across.gap >= lineH * 0.1;
    const okDown = down && down.gap >= lineH * 1.2;
    let pick = null;
    // Rows first (tables read row by row), except where the page has real text columns.
    if (okAcross && okDown) pick = textColumns(down) ? down : across;
    else pick = okAcross ? across : okDown ? down : null;
    if (!pick || !pick.before.length || !pick.after.length) return byLines(list);
    return [...cut(pick.before, depth + 1), ...cut(pick.after, depth + 1)];
  };
  const ordered = cut(boxes);

  // Rebuild the layer in that order: drop pdf.js's line breaks and empty wrappers, then add our own.
  layer.querySelectorAll('br').forEach((br) => br.remove());
  let prev = null;
  for (const b of ordered) {
    if (prev && (b.y0 >= prev.y1 - lineH * 0.3 || b.x0 < prev.x0 - 1)) {
      const br = document.createElement('br');
      br.setAttribute('role', 'presentation');
      layer.append(br);
    } else if (prev && (b.x0 - prev.x1 > lineH * 0.15 || b.y1 <= prev.y0 + lineH * 0.3)
      && !/\s$/.test(prev.el.textContent) && !/^\s/.test(b.el.textContent)) {
      // Next word, or the next cell up in a table. A bare text node would be dropped from copied text.
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' ';
      layer.append(sep);
    }
    layer.append(b.el);
    prev = b;
  }
  layer.querySelectorAll('.markedContent').forEach((m) => { if (!m.textContent.trim()) m.remove(); });
}
