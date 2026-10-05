// A card's group: an explicit group name, else its colour.
export const groupKey = (c) => c.group || c.color || 'none';

// Lane layout: one column per group, in the groups' current left-to-right order.
// Inside a lane, each card moves level with the cards it links to. Lane headers stay on top.
// nodes: [{ id, x, y, w, h, group, header }] where header is true (top of its lane) or '*' (above all lanes).
export function laneLayout(nodes, links, { gapX = 110, gapY = 36, gridGap = 26, gridRows = 9 } = {}) {
  const ox = Math.min(...nodes.map((n) => n.x)), oy = Math.min(...nodes.map((n) => n.y));
  const out = new Map();

  // Cards above all lanes (a legend or title), in their current order.
  let top = oy;
  for (const n of nodes.filter((n) => n.header === '*').sort((a, b) => a.y - b.y || a.x - b.x)) {
    out.set(n.id, { x: ox, y: top });
    top += n.h + gapY;
  }

  const lanes = new Map();
  for (const n of nodes) {
    if (n.header === '*') continue;
    if (!lanes.has(n.group)) lanes.set(n.group, []);
    lanes.get(n.group).push(n);
  }
  // Lane order: a lane's header card sets its place (drag a header to move the lane), else the cards' mean x.
  const laneX = (members) => {
    const h = members.find((n) => n.header === true);
    return h ? h.x : mean(members, 'x');
  };
  const order = [...lanes.entries()].sort((a, b) => laneX(a[1]) - laneX(b[1]) || mean(a[1], 'x') - mean(b[1], 'x'));

  const ids = new Set(nodes.map((n) => n.id));
  const nbrs = new Map(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to) continue;
    nbrs.get(l.from).push(l.to);
    nbrs.get(l.to).push(l.from);
  }

  // Reading order: document order (PDF, page, place on the page) when every card has a source, else top to bottom.
  const reading = (list) => [...list].sort(list.every((n) => n.doc != null)
    ? (a, b) => a.doc - b.doc
    : (a, b) => a.y - b.y || a.x - b.x);

  // Lane x positions. A lane with no links and many cards becomes a grid.
  let x = ox;
  const plan = order.map(([group, members]) => {
    const headers = members.filter((n) => n.header === true).sort((a, b) => a.y - b.y);
    const body = reading(members.filter((n) => n.header !== true));
    const grid = body.length > gridRows && body.every((n) => !nbrs.get(n.id).length);
    const cols = grid ? Math.ceil(body.length / gridRows) : 1;
    const colW = Math.max(...body.map((n) => n.w), 0);
    const w = Math.max(...headers.map((n) => n.w), grid ? cols * colW + (cols - 1) * gridGap : colW, 0);
    const lane = { group, headers, body, grid, cols, colW, x, w };
    x += w + gapX;
    return lane;
  });

  // Headers first, then the body of each lane under them.
  const bodyTop = new Map();
  for (const lane of plan) {
    let y = top;
    for (const h of lane.headers) { out.set(h.id, { x: lane.x, y }); y += h.h + gapY; }
    bodyTop.set(lane.group, y);
  }
  const start = Math.max(...bodyTop.values());

  // Grid lanes: rows of cards in reading order.
  for (const lane of plan.filter((l) => l.grid)) {
    let y = start;
    for (let i = 0; i < lane.body.length; i += lane.cols) {
      const row = lane.body.slice(i, i + lane.cols);
      row.forEach((n, c) => out.set(n.id, { x: lane.x + c * (lane.colW + gridGap), y }));
      y += Math.max(...row.map((n) => n.h)) + gridGap;
    }
  }

  // Stacked lanes. The busiest lane is the spine: packed in reading order.
  // Each other lane then lines its cards up with linked cards in lanes already placed.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const laneOf = new Map();
  for (const lane of plan) for (const n of lane.body) laneOf.set(n.id, lane);
  const stacked = plan.filter((l) => !l.grid && l.body.length);
  const linkCount = (lane, placed) => lane.body.reduce((s, n) => s + nbrs.get(n.id).filter((m) => placed(laneOf.get(m))).length, 0);
  const done = new Set();
  const centre = (id) => out.get(id).y + byId.get(id).h / 2;
  while (done.size < stacked.length) {
    const rest = stacked.filter((l) => !done.has(l));
    const lane = done.size
      ? rest.reduce((best, l) => (linkCount(l, (o) => done.has(o)) > linkCount(best, (o) => done.has(o)) ? l : best))
      : rest.reduce((best, l) => (linkCount(l, (o) => o && o !== l) > linkCount(best, (o) => o && o !== best) ? l : best));
    let floor = start;
    if (!done.size) {
      for (const n of lane.body) { out.set(n.id, { x: lane.x, y: floor }); floor += n.h + gapY; }
    } else {
      // Wanted centre: the mean centre of linked cards already placed, else just under the card before.
      const want = new Map();
      let last = start;
      for (const n of lane.body) {
        const ns = nbrs.get(n.id).filter((m) => done.has(laneOf.get(m)));
        const w = ns.length ? ns.reduce((s, m) => s + centre(m), 0) / ns.length : last + n.h / 2;
        want.set(n.id, w);
        last = w + n.h / 2 + gapY;
      }
      for (const n of [...lane.body].sort((a, b) => want.get(a.id) - want.get(b.id))) {
        const y = Math.max(floor, want.get(n.id) - n.h / 2);
        out.set(n.id, { x: lane.x, y });
        floor = y + n.h + gapY;
      }
    }
    done.add(lane);
  }
  return out;
}

const mean = (list, k) => list.reduce((s, n) => s + n[k], 0) / list.length;

// Flow layout: arrows run left to right through columns (a simple layered graph layout).
// nodes: [{ id, x, y, w, h }], links: [{ from, to }]. Returns Map id -> { x, y }.
export function structuredLayout(nodes, links, { gapX = 140, gapY = 40, groupGap = 180 } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  const ox = Math.min(...nodes.map((n) => n.x)), oy = Math.min(...nodes.map((n) => n.y));

  // Connected groups (ignoring arrow direction).
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
  const seen = new Set(), groups = [], singles = [];
  for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(n.id)) continue;
    const group = [], stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      group.push(id);
      for (const m of adj.get(id)) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    (group.length > 1 ? groups : singles).push(...(group.length > 1 ? [group] : group));
  }
  groups.sort((a, b) => b.length - a.length);

  const out = new Map();
  let y0 = oy, right = ox;
  for (const g of groups) {
    const { pos, w, h } = layerGroup(g, edges, byId, gapX, gapY);
    for (const [id, p] of pos) out.set(id, { x: ox + p.x, y: y0 + p.y });
    y0 += h + groupGap;
    right = Math.max(right, ox + w);
  }

  // Cards with no links: a grid beside the linked groups, in their current reading order.
  if (singles.length) {
    const sx = groups.length ? right + gapX * 1.5 : ox;
    const cols = Math.max(1, Math.round(Math.sqrt(singles.length / 2)));
    const perCol = Math.ceil(singles.length / cols);
    let x = sx;
    for (let c = 0; c < cols; c++) {
      const col = singles.slice(c * perCol, (c + 1) * perCol).map((id) => byId.get(id));
      if (!col.length) break;
      let y = oy;
      for (const n of col) { out.set(n.id, { x, y }); y += n.h + gapY / 1.5; }
      x += Math.max(...col.map((n) => n.w)) + gapX / 2;
    }
  }
  return out;
}

function layerGroup(ids, edges, byId, gapX, gapY) {
  const set = new Set(ids);
  const es = edges.filter((e) => set.has(e.from) && set.has(e.to));
  const outAll = new Map(ids.map((id) => [id, []]));
  for (const e of es) outAll.get(e.from).push(e);
  const hasIn = new Set(es.map((e) => e.to));
  const start = [...ids].sort((a, b) => (hasIn.has(a) - hasIn.has(b)) || byId.get(a).x - byId.get(b).x || byId.get(a).y - byId.get(b).y);

  // Drop the arrows that close a loop, so every remaining arrow points forward.
  const state = new Map(), dag = [];
  const visit = (id) => {
    state.set(id, 1);
    for (const e of outAll.get(id)) {
      const s = state.get(e.to);
      if (s === 1) continue;
      dag.push(e);
      if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of start) if (!state.has(id)) visit(id);

  const out = new Map(ids.map((id) => [id, []])), inn = new Map(ids.map((id) => [id, []]));
  for (const e of dag) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); }

  // Column = length of the longest arrow path that reaches the card.
  const indeg = new Map(ids.map((id) => [id, inn.get(id).length]));
  const layer = new Map(), queue = ids.filter((id) => !indeg.get(id));
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const t of out.get(id)) {
      layer.set(t, Math.max(layer.get(t) || 0, layer.get(id) + 1));
      indeg.set(t, indeg.get(t) - 1);
      if (!indeg.get(t)) queue.push(t);
    }
  }
  const count = Math.max(...layer.values()) + 1;
  const layers = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layer.get(id)].push(id);
  for (const l of layers) l.sort((a, b) => byId.get(a).y - byId.get(b).y);

  // Order each column by the average position of its neighbours, to cut crossings.
  const idx = new Map();
  layers.forEach((l) => l.forEach((id, i) => idx.set(id, i)));
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    for (let k = 1; k < count; k++) {
      const li = down ? k : count - 1 - k;
      const l = layers[li];
      const score = new Map(l.map((id) => {
        const ns = down ? inn.get(id) : out.get(id);
        return [id, ns.length ? ns.reduce((s, n) => s + idx.get(n), 0) / ns.length : idx.get(id)];
      }));
      l.sort((a, b) => score.get(a) - score.get(b));
      l.forEach((id, i) => idx.set(id, i));
    }
  }

  // Place columns left to right, each centred on the tallest one.
  const colH = layers.map((l) => l.reduce((s, id) => s + byId.get(id).h, 0) + gapY * (l.length - 1));
  const maxH = Math.max(...colH);
  const pos = new Map();
  let x = 0;
  layers.forEach((l, li) => {
    const w = Math.max(...l.map((id) => byId.get(id).w));
    let y = (maxH - colH[li]) / 2;
    for (const id of l) {
      const n = byId.get(id);
      pos.set(id, { x: x + (w - n.w) / 2, y });
      y += n.h + gapY;
    }
    x += w + gapX;
  });
  return { pos, w: x - gapX, h: maxH };
}
