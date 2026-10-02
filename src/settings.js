// Player settings, persisted in localStorage. Every storage access is wrapped: private windows,
// blocked site data or sandboxed frames can throw, and the game must still run with the defaults.

const KEY = 'offroad.settings.v1';
const INTRO_KEY = 'offroad.introSeen.v1';

export const DEFAULTS = {
  gearbox: 'auto',          // 'auto' | 'manual'
  autoClutch: true,
  handbrake: 'hold',        // 'hold' (while pressed) | 'toggle' | 'auto' (sets itself at a stop)
  camera: 'chase',
  time: 'day',
  muted: false,
  volume: 1,                // 0..1 (1 = the original mix level)
  speedUnit: 'kmh',         // 'kmh' | 'mph'
  pressureUnit: 'psi',      // 'psi' | 'bar'
  cluster: 'auto',          // 'auto' (compact in cockpit / small windows) | 'full' | 'compact'
  hudScale: 1,              // multiplier on the automatic window-size scale
  hints: true,              // key hints in the top-left corner
  suspension: false,        // wheel load / travel panel
  telemetry: false,
  fps: false,
  autoPause: true,          // open the menu when the window loses focus
  quality: 'auto',          // graphics preset: 'auto' | 'low' | 'medium' | 'high' | 'ultra'
  renderScale: 1,           // resolution scale on top of the preset's pixel-ratio cap (0.5..1)
};

const CHOICES = {
  gearbox: ['auto', 'manual'],
  handbrake: ['hold', 'toggle', 'auto'],
  camera: ['chase', 'cockpit', 'hood', 'wheel', 'orbit'],
  time: ['day', 'dusk', 'night'],
  speedUnit: ['kmh', 'mph'],
  pressureUnit: ['psi', 'bar'],
  cluster: ['auto', 'full', 'compact'],
  quality: ['auto', 'low', 'medium', 'high', 'ultra'],
};
const RANGES = { volume: [0, 1], hudScale: [0.7, 1.5], renderScale: [0.5, 1] };

export const storage = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch { return false; } },
  remove(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
};

function valid(k, v) {
  if (!(k in DEFAULTS) || typeof v !== typeof DEFAULTS[k]) return false;
  if (CHOICES[k]) return CHOICES[k].includes(v);
  if (RANGES[k]) return Number.isFinite(v) && v >= RANGES[k][0] && v <= RANGES[k][1];
  return true;
}

export class Settings {
  constructor() {
    this.v = { ...DEFAULTS };
    try {
      const saved = JSON.parse(storage.get(KEY) || '{}');
      for (const k in saved) if (valid(k, saved[k])) this.v[k] = saved[k];
    } catch { /* corrupt entry: keep defaults */ }
    this.subs = [];
  }

  get(k) { return this.v[k]; }
  get all() { return this.v; }

  // opts.silent: apply without player feedback (startup)
  set(k, value, opts = {}) {
    if (!valid(k, value)) return false;
    if (this.v[k] === value && !opts.force) return false;
    this.v[k] = value;
    this.save();
    for (const f of this.subs) f(k, value, opts);
    return true;
  }

  onChange(f) { this.subs.push(f); }
  applyAll(opts = {}) { for (const k in this.v) for (const f of this.subs) f(k, this.v[k], { silent: true, ...opts }); }
  save() { storage.set(KEY, JSON.stringify(this.v)); }
  reset() { for (const k in DEFAULTS) this.set(k, DEFAULTS[k], { silent: true }); }

  get introSeen() { return storage.get(INTRO_KEY) === '1'; }
  set introSeen(v) { if (v) storage.set(INTRO_KEY, '1'); else storage.remove(INTRO_KEY); }
}
