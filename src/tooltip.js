// One floating tooltip for the whole UI (side panel, tuning, HUD buttons). It is overlaid (position: fixed),
// so opening it never moves anything under it.
//
// A trigger is an element with data-tip="text" (a name: rail icons, icon buttons), or an (i) button
// (data-info) whose row keeps its description in a hidden .pr-n / .tn-info, read when it opens (so a
// description that changes, like the quality note, is always current).
//   mouse   opens on hover after a short delay, and stays open while the pointer is on the trigger, inside
//           the tooltip, or crossing the triangle between where it left the trigger and the tooltip's near
//           edge (a "safe triangle": a diagonal move into the tooltip doesn't close it). A pointer resting
//           in the triangle closes it after a moment.
//   click   on an (i), or a tap: pins it open until a press anywhere else.
// data-tip-pos="right" / "left" puts it beside the trigger (the panel's rail); default below, or above when
// there is no room. Either way it flips when the window edge is in the way.

let el, bodyEl, arrowEl;
let cur = null, pinned = false, side = 'below';
let pend = null, openT = 0, closeT = 0, exit = null, last = null;

const textOf = t => t.dataset.tip || t.closest('.pr, .tn-row')?.querySelector('.pr-n, .tn-info')?.textContent.trim() || '';
const triggerOf = n => n?.closest?.('[data-tip], [data-info]') || null;
const isInfo = t => t.dataset.info !== undefined;
const inRect = (r, x, y, pad = 2) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
function inTriangle(p, a, b, c) {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

export function installTooltips() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'tipop';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  el.innerHTML = '<div class="tipop-b"></div><i class="tipop-a"></i>';
  document.body.append(el);
  bodyEl = el.firstChild; arrowEl = el.lastChild;
  document.addEventListener('pointerover', onOver);
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('click', onClick);
  document.addEventListener('scroll', () => hideTip(), true);   // whatever scrolled may have moved the trigger
  window.addEventListener('blur', () => hideTip());
  window.addEventListener('resize', () => hideTip());
}

const stopClose = () => { clearTimeout(closeT); closeT = 0; };

export function hideTip() {
  clearTimeout(openT); stopClose();
  pend = null; exit = null;
  if (!cur) return;
  cur.classList.remove('tip-on');
  cur = null; pinned = false;
  el.hidden = true;
}

function show(t) {
  clearTimeout(openT); stopClose();
  pend = null;
  const txt = textOf(t);
  if (!txt) { hideTip(); return; }
  if (cur && cur !== t) cur.classList.remove('tip-on');
  cur = t;
  t.classList.add('tip-on');
  el.className = 'tipop ' + (isInfo(t) ? 'info' : 'label');
  bodyEl.textContent = txt;
  el.hidden = false;
  // position: one layout read on open
  el.style.left = '0px'; el.style.top = '0px';
  const r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight, gap = 9;
  let x, y;
  side = t.dataset.tipPos === 'left' || t.dataset.tipPos === 'right' ? t.dataset.tipPos : 'below';
  if (side !== 'below') {
    x = side === 'left' ? r.left - gap - w : r.right + gap;
    if (side === 'left' && x < 8) { side = 'right'; x = r.right + gap; }
    else if (side === 'right' && x + w > W - 8) { side = 'left'; x = r.left - gap - w; }
    y = Math.max(8, Math.min(H - h - 8, r.top + r.height / 2 - h / 2));
    arrowEl.style.left = ''; arrowEl.style.top = `${Math.max(10, Math.min(h - 10, r.top + r.height / 2 - y))}px`;
  } else {
    y = r.bottom + gap;
    if (y + h > H - 8) { side = 'above'; y = r.top - gap - h; }
    x = Math.max(8, Math.min(W - w - 8, r.left + r.width / 2 - w / 2));
    arrowEl.style.top = ''; arrowEl.style.left = `${Math.max(10, Math.min(w - 10, r.left + r.width / 2 - x))}px`;
  }
  el.dataset.side = side;
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
  exit = last && inRect(r, last[0], last[1]) ? last : null;
}

function onOver(e) {
  if (e.pointerType !== 'mouse') return;
  const t = triggerOf(e.target);
  if (!t || t === cur || t === pend || t.disabled) return;
  if (pinned) return;                                    // a pinned tooltip waits for a press elsewhere
  if (cur) { show(t); return; }                          // moving from one trigger to the next: no delay
  clearTimeout(openT);
  pend = t;
  openT = setTimeout(() => show(t), isInfo(t) ? 160 : 380);
}

function onMove(e) {
  if (e.pointerType !== 'mouse') return;
  const x = e.clientX, y = e.clientY;
  last = [x, y];
  if (pend && !inRect(pend.getBoundingClientRect(), x, y, 0)) { clearTimeout(openT); pend = null; }
  if (!cur || pinned) return;
  const tr = cur.getBoundingClientRect();
  if (inRect(tr, x, y)) { exit = [x, y]; stopClose(); return; }
  // a name tooltip (rail, icon buttons) goes as soon as the pointer leaves its trigger
  if (!isInfo(cur)) { hideTip(); return; }
  const br = el.getBoundingClientRect();
  if (inRect(br, x, y)) { stopClose(); return; }
  if (exit) {
    const near = side === 'below' ? [[br.left, br.top], [br.right, br.top]]
      : side === 'above' ? [[br.left, br.bottom], [br.right, br.bottom]]
        : side === 'left' ? [[br.right, br.top], [br.right, br.bottom]] : [[br.left, br.top], [br.left, br.bottom]];
    if (inTriangle([x, y], exit, near[0], near[1])) {
      stopClose();
      closeT = setTimeout(hideTip, 450);                  // still on its way: wait, but not for ever
      return;
    }
  }
  if (!closeT) closeT = setTimeout(hideTip, 90);
}

function onDown(e) {
  if (!cur) return;
  const t = triggerOf(e.target);
  if (t === cur || el.contains(e.target)) return;
  hideTip();
}

function onClick(e) {
  const t = triggerOf(e.target);
  if (!t) return;
  if (!isInfo(t)) { if (t === cur) hideTip(); return; }  // a named button does its job; its name goes
  if (cur === t && pinned) { hideTip(); return; }
  show(t);
  pinned = true;
}
