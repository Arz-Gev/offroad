import { CAR_IDS, DEFAULT_CAR } from './cars/index.js';

// Player settings, persisted in localStorage. Every storage access is wrapped: private windows,
// blocked site data or sandboxed frames can throw, and the game must still run with the defaults.

const KEY = 'offroad.settings.v1';

export const DEFAULTS = {
  car: DEFAULT_CAR,         // src/cars/; changing it reloads the game
  gearbox: 'auto',          // 'auto' | 'manual'
  autoClutch: true,
  arcadeAuto: true,         // automatic gearbox: hold S at a stop to reverse (off: select R like a real car)
  handbrake: 'auto',        // 'hold' (while pressed) | 'toggle' | 'auto' (tap toggles, long press holds)
  steerAssist: 'strong',    // keyboard steering at speed: 'strong' (~0.75 g) | 'light' (gamepad curve) | 'off' (full lock)
  camera: 'chase',
  fov: 62,                  // vertical field of view in degrees (hood and wheel cameras use 2 less)
  time: 13,                 // time of day in hours, 0..24 (13 = day, 19.5 = dusk, 23 = night)
  muted: false,
  volume: 0.3,              // 0..1 (1 = the original mix level); 30% on a first start so it isn't loud (player, Oct 7)
  speedUnit: 'kmh',         // 'kmh' | 'mph'
  pressureUnit: 'psi',      // 'psi' | 'bar'
  cluster: 'auto',          // 'auto' (compact in cockpit / small windows) | 'full' | 'compact'
  hudScale: 1,              // multiplier on the automatic window-size scale
  hints: true,              // key hints in the top-left corner
  suspension: false,        // wheel load / travel panel
  telemetry: false,
  fps: true,
  autoPause: true,          // open the menu when the window loses focus
  touchControls: 'auto',    // on-screen controls (touch.js): 'auto' (while you use the touch screen) | 'on' | 'off'
  touchSteer: 'stick',      // touch steering: 'stick' (left thumb slides) | 'tilt' (turn the device like a wheel)
  quality: 'auto',          // graphics preset: 'auto' | 'mobile' | 'low' | 'medium' | 'high' | 'ultra' | 'custom'
  renderScale: 1,           // resolution scale on top of the pixel-ratio cap (0.5..1)
  // graphics options (render/quality.js presetToGfx); a preset overwrites them, editing one makes it 'custom'
  gDpr: 1.5,                // device pixel ratio cap
  gAA: 'off',               // 'off' | 'fxaa' | 'msaa2' | 'msaa4'
  gShadows: 'high',         // 'off' | 'low' | 'medium' | 'high' | 'ultra'
  gSSAO: 'low',             // screen-space ambient occlusion: 'off' | 'low' | 'high'
  gBloom: true,
  gViewDist: 1,             // terrain LOD distance scale
  gTerrain: 2,              // terrain shading detail 0..2
  gTreeShadows: true,       // distant (impostor) trees cast shadows
  gVeg: 'high',             // grass and bushes preset: 'off' | 'low' | 'medium' | 'high' | 'ultra' (render/quality.js)
  dust: true,               // dust, mud and water splashes from the tyres (Graphics; not part of the presets)
  name: '',                 // multiplayer name over the truck ('' = pick one on the first join)
  solidTrucks: false,       // multiplayer: friends' trucks are solid (off: ghosts)
};

// the time of day used to be one of three presets; saved games still hold those names
const OLD_TIMES = { day: 13, dusk: 19.5, night: 23 };

const CHOICES = {
  car: CAR_IDS,
  gearbox: ['auto', 'manual'],
  handbrake: ['hold', 'toggle', 'auto'],
  steerAssist: ['strong', 'light', 'off'],
  camera: ['chase', 'cockpit', 'hood', 'wheel', 'orbit', 'gunner'],   // gunner: turret vehicles only (main.js falls back to chase)
  speedUnit: ['kmh', 'mph'],
  pressureUnit: ['psi', 'bar'],
  cluster: ['auto', 'full', 'compact'],
  touchControls: ['auto', 'on', 'off'],
  touchSteer: ['stick', 'tilt'],
  quality: ['auto', 'mobile', 'low', 'medium', 'high', 'ultra', 'custom'],
  gAA: ['off', 'fxaa', 'msaa2', 'msaa4'],
  gShadows: ['off', 'low', 'medium', 'high', 'ultra'],
  gSSAO: ['off', 'low', 'high'],
  gVeg: ['off', 'low', 'medium', 'high', 'ultra'],
  gTerrain: [0, 1, 2],
};
const RANGES = {
  time: [0, 24], fov: [45, 110], volume: [0, 1], hudScale: [0.7, 1.5], renderScale: [0.5, 1],
  gDpr: [1, 2], gViewDist: [0.6, 1.5],
};

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
      if (typeof saved.time === 'string') saved.time = OLD_TIMES[saved.time];
      // the Grass and bushes switch (`vegetation`, outside the presets) became the gVeg preset (Oct 8)
      if (saved.vegetation === false && !('gVeg' in saved)) {
        saved.gVeg = 'off';
        if (saved.quality !== 'mobile') saved.quality = 'custom';     // keep it off: a preset would turn it on
      }
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
  reset() { for (const k in DEFAULTS) this.set(k, DEFAULTS[k], { silent: true, reset: true }); }
}
