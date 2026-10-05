// Gravity: a live force layout for the board.
import { groupKey } from './layout.js';

// Linked cards pull toward each other, every pair of cards pushes apart, and cards of the
// same group (or colour) drift together. The card being dragged stays where the pointer puts it.
const K_SPRING = 0.02;   // pull along each link
const LINK_GAP = 120;     // preferred gap between linked cards (px, edge to edge)
const K_REPEL = 1600;    // push between all pairs, falls off with the square of the gap
const MARGIN = 40;       // gap that cards keep clear of each other
const K_CENTER = 0.0012; // pull toward the centre of the moving set
const K_GROUP = 0.004;   // pull toward the centre of the card's group
const DAMPING = 0.72;
const V_MAX = 30;
const COOLING = 0.985;    // forces fade each frame, so the layout always comes to rest
const ALPHA_MIN = 0.02;

// Distance from a card's centre to its edge along the unit vector (ux, uy).
const edge = (n, ux, uy) => Math.min(ux ? n.hw / Math.abs(ux) : Infinity, uy ? n.hh / Math.abs(uy) : Infinity);

export class Gravity {
  constructor(board) {
    this.b = board;
    this.vel = new Map();
    this.running = false;
    this.raf = null;
    this.alpha = 0;
  }
  start() { this.running = true; this.wake(1); }
  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.vel.clear();
  }
  // Add energy: 1 on start, less when the user nudges a card.
  wake(level = 0.4) {
    if (!this.running) return;
    this.alpha = Math.max(this.alpha, level);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.loop());
  }
  loop() {
    this.raf = null;
    if (!this.running) return;
    const moving = this.step();
    this.b.afterGravityTick();
    if (moving) this.raf = requestAnimationFrame(() => this.loop());
    else this.b.onGravitySettled();
  }

  step() {
    const b = this.b, active = b.gravityCards();
    if (active.length < 2) return false;
    const nodes = new Map();
    for (const c of active) {
      const h = b.els.get(c.id)?.offsetHeight || 120;
      nodes.set(c.id, { c, x: c.x + c.w / 2, y: c.y + h / 2, hw: c.w / 2, hh: h / 2, fx: 0, fy: 0, deg: 0, fixed: c.id === b.dragging });
    }
    const links = b.data.links.filter((l) => nodes.has(l.from) && nodes.has(l.to));
    for (const l of links) { nodes.get(l.from).deg++; nodes.get(l.to).deg++; }
    const list = [...nodes.values()];

    // Springs along links.
    for (const l of links) {
      const a = nodes.get(l.from), o = nodes.get(l.to);
      const dx = o.x - a.x, dy = o.y - a.y, d = Math.hypot(dx, dy) || 0.01, ux = dx / d, uy = dy / d;
      const gap = d - edge(a, ux, uy) - edge(o, ux, uy);
      const f = K_SPRING * (gap - LINK_GAP);
      a.fx += (ux * f) / Math.sqrt(a.deg); a.fy += (uy * f) / Math.sqrt(a.deg);
      o.fx -= (ux * f) / Math.sqrt(o.deg); o.fy -= (uy * f) / Math.sqrt(o.deg);
    }

    // Repulsion between every pair.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], o = list[j];
        const dx = o.x - a.x, dy = o.y - a.y, d = Math.hypot(dx, dy) || 0.01, ux = dx / d, uy = dy / d;
        const gap = d - edge(a, ux, uy) - edge(o, ux, uy);
        if (gap > 500) continue;
        const f = gap < MARGIN ? 0.25 * (MARGIN - gap) + K_REPEL / (MARGIN * MARGIN) : K_REPEL / (gap * gap);
        a.fx -= ux * f; a.fy -= uy * f;
        o.fx += ux * f; o.fy += uy * f;
      }
    }

    // Pull toward the centre of everything, and toward the centre of the card's colour group.
    const centre = { x: 0, y: 0 }, groups = new Map();
    for (const n of list) {
      centre.x += n.x / list.length; centre.y += n.y / list.length;
      const key = groupKey(n.c);
      if (key === 'none') continue;
      const g = groups.get(key) || { x: 0, y: 0, n: 0 };
      g.x += n.x; g.y += n.y; g.n++;
      groups.set(key, g);
    }
    for (const n of list) {
      n.fx += (centre.x - n.x) * K_CENTER; n.fy += (centre.y - n.y) * K_CENTER;
      const g = groups.get(groupKey(n.c));
      if (g && g.n > 1) { n.fx += (g.x / g.n - n.x) * K_GROUP; n.fy += (g.y / g.n - n.y) * K_GROUP; }
    }

    // Integrate, with forces scaled by the current energy.
    const a = this.alpha;
    for (const n of list) {
      if (n.fixed) { this.vel.set(n.c.id, [0, 0]); continue; }
      const [vx0, vy0] = this.vel.get(n.c.id) || [0, 0];
      let vx = (vx0 + n.fx * a) * DAMPING, vy = (vy0 + n.fy * a) * DAMPING;
      const sp = Math.hypot(vx, vy);
      if (sp > V_MAX) { vx *= V_MAX / sp; vy *= V_MAX / sp; }
      this.vel.set(n.c.id, [vx, vy]);
      n.x += vx; n.y += vy;
    }
    this.alpha *= COOLING;
    const settling = this.alpha >= ALPHA_MIN;

    // Hard separation: no two cards may overlap.
    for (let pass = 0; pass < (settling ? 3 : 12); pass++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], o = list[j];
          const ox = a.hw + o.hw + MARGIN / 2 - Math.abs(o.x - a.x);
          const oy = a.hh + o.hh + MARGIN / 2 - Math.abs(o.y - a.y);
          if (ox <= 0 || oy <= 0) continue;
          const share = a.fixed ? [0, 1] : o.fixed ? [1, 0] : [0.5, 0.5];
          if (ox < oy) {
            const s = Math.sign(o.x - a.x) || 1;
            a.x -= s * ox * share[0]; o.x += s * ox * share[1];
          } else {
            const s = Math.sign(o.y - a.y) || 1;
            a.y -= s * oy * share[0]; o.y += s * oy * share[1];
          }
        }
      }
    }

    for (const n of list) {
      if (n.fixed) continue;
      n.c.x = Math.round(n.x - n.hw);
      n.c.y = Math.round(n.y - n.hh);
    }
    return settling;
  }
}
