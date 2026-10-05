// Middle-button autoscroll, as in a web browser. Press the middle button on something that scrolls: an anchor
// shows, and the content moves in the direction of the pointer, faster the further the pointer is from the anchor.
//   - Click (press and release in place): it keeps going until the next click, Esc, or a turn of the wheel.
//   - Hold and move: it stops when the button comes up.
// The board pans with a middle-button drag already. There, a middle click in place starts the same autoscroll,
// through opts.board (isTarget(el), panBy(dx, dy), done()).
const DEAD = 12; // px around the anchor where nothing moves
const speed = (d) => { const a = Math.abs(d) - DEAD; return a <= 0 ? 0 : Math.sign(d) * (a * 6 + a * a * 0.05); }; // px per second

function scrollerOf(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const y = /auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const x = /auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (x || y) return n;
  }
  return null;
}

export function initAutoscroll({ board } = {}) {
  let run = null; // { by, done, ax, ay, x, y, held, moved, raf, last, fx, fy, anchor }
  let press = null; // a middle press on the board, to see if it is a click in place

  const stop = () => {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    run.anchor.remove();
    document.documentElement.classList.remove('autoscrolling');
    run.done?.();
    run = null;
  };
  const start = (x, y, by, done, held) => {
    stop();
    const anchor = Object.assign(document.createElement('div'), { className: 'autoscroll-anchor' });
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    document.body.append(anchor);
    document.documentElement.classList.add('autoscrolling');
    run = { by, done, ax: x, ay: y, x, y, held, moved: false, last: performance.now(), fx: 0, fy: 0, anchor };
    const tick = (now) => {
      if (!run) return;
      const dt = Math.min(0.05, (now - run.last) / 1000);
      run.last = now;
      // Whole pixels only: keep the rest for the next frame, so slow speeds still move.
      run.fx += speed(run.x - run.ax) * dt;
      run.fy += speed(run.y - run.ay) * dt;
      const dx = Math.trunc(run.fx), dy = Math.trunc(run.fy);
      if (dx || dy) { run.fx -= dx; run.fy -= dy; run.by(dx, dy); }
      run.raf = requestAnimationFrame(tick);
    };
    run.raf = requestAnimationFrame(tick);
  };

  document.addEventListener('pointerdown', (e) => {
    if (run) { e.preventDefault(); e.stopPropagation(); stop(); return; } // any click ends it
    if (e.button !== 1) return;
    if (e.target.closest?.('a[href], .pdf-tabs')) return;
    if (board?.isTarget(e.target)) { press = { x: e.clientX, y: e.clientY }; return; } // the board pans on a drag
    const s = scrollerOf(e.target);
    if (!s) return;
    e.preventDefault();
    start(e.clientX, e.clientY, (dx, dy) => { s.scrollLeft += dx; s.scrollTop += dy; }, null, true);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!run) return;
    run.x = e.clientX; run.y = e.clientY;
    if (Math.hypot(run.x - run.ax, run.y - run.ay) > DEAD) run.moved = true;
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (e.button !== 1) return;
    if (run?.held) { if (run.moved) stop(); else run.held = false; return; }
    if (press && board && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) {
      start(e.clientX, e.clientY, (dx, dy) => board.panBy(-dx, -dy), () => board.done?.(), false);
    }
    press = null;
  }, true);
  // Stop the page from pasting or opening things on a middle click while this is on.
  document.addEventListener('auxclick', (e) => { if (e.button === 1 && (run || scrollerOf(e.target)) && !e.target.closest?.('a[href]')) e.preventDefault(); }, true);
  document.addEventListener('keydown', (e) => { if (run && e.key === 'Escape') { e.stopPropagation(); stop(); } }, true);
  document.addEventListener('wheel', () => stop(), { capture: true, passive: true });
  window.addEventListener('blur', stop);
}
