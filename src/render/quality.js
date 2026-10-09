// Graphics presets. `dpr` caps the device pixel ratio before the player's resolution scale.
// Rough frame times on an M1 Pro (headless Chrome, 1920x1080, dpr 2, trail drive, AA on): low 5 ms, medium 9,
// high 13, ultra 22.

// The grass of the Grass and bushes levels: density (blades per m²), height and width (cm) as curves over the
// distance in m (grass.js evalCurve), each level tuned by eye by the player on a flat test meadow.
const GRASS_ULTRA = {
  end: 300, smooth: false,
  density: [[0, 0.3], [0.5, 15], [1.6, 43], [3.6, 46], [11, 15], [28, 8.9], [57, 12], [108, 13], [172, 5.4], [299, 1.3]],
  height: [[0, 141], [3.4, 123], [8.4, 150], [28, 135], [297, 124]],
  width: [[0, 8.5], [12, 12], [87, 38], [130, 63], [189, 97], [300, 200]],
};
const GRASS_LOW = {
  end: 124, smooth: true,
  density: [[0, 13], [3.1, 8], [14, 3], [24, 1.9], [50, 1.6], [99, 1.3], [150, 1.2], [300, 0.8]],
  height: [[0, 133], [8.9, 129], [23, 127], [46, 150], [69, 180], [95, 213], [146, 148], [201, 349], [295, 333]],
  width: [[0, 13], [25, 26], [55, 43], [90, 59], [128, 71], [173, 120], [207, 140], [247, 143], [288, 127]],
};
const GRASS_MEDIUM = {
  end: 148, smooth: true,
  density: [[0, 0.6], [0.5, 7.1], [1.6, 21], [3.6, 21], [11, 7.1], [28, 4.2], [53, 2.5], [112, 1.8], [172, 1.2], [299, 0.6]],
  height: [[0, 100], [5, 109], [44, 119], [120, 142]],
  width: [[0, 8.2], [37, 21], [77, 40], [156, 131], [189, 76], [289, 55]],
};
const GRASS_HIGH = {
  end: 196, smooth: false,
  density: [[0, 0.82], [0.5, 9.6], [1.6, 28], [3.6, 29], [11, 9.6], [28, 5.7], [57, 7.7], [108, 5.6], [172, 1.7], [299, 0.82]],
  height: [[0, 144], [3.4, 125], [8.3, 141], [28, 136], [297, 126]],
  width: [[0, 8.2], [13, 14], [60, 25], [130, 63], [189, 97], [300, 200]],
};
const grass = c => JSON.parse(JSON.stringify(c));

export const QUALITY = {
  // Anti-aliasing is off in every preset (turning it on under Graphics makes the preset Custom).
  // mobile (phones and tablets): no shadows, AO, grass or bushes (veg 'off'). dynamicDpr: pixel density moves
  // between 1 and `dpr` to hold 45-60 fps (graphics.js, "dynamic resolution").
  mobile: {
    label: 'Mobile', dpr: 1.5, dynamicDpr: true, msaa: 0, fxaa: false, shadows: 'off', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.7, bloom: true, veg: 'off',
    bushes: 0.1, bushHeight: 2.15, bushDist: 1.5,
  },
  low: {
    label: 'Low', dpr: 1.0, msaa: 0, fxaa: false, shadows: 'low', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 0, lodScale: 0.7, bloom: true, veg: 'low',
    grassCurve: grass(GRASS_LOW), bushes: 0.31, bushHeight: 2.6, bushDist: 3.5,
  },
  medium: {
    label: 'Medium', dpr: 1.25, msaa: 0, fxaa: false, shadows: 'medium', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.85, bloom: true, veg: 'medium',
    grassCurve: grass(GRASS_MEDIUM), bushes: 0.45, bushHeight: 1.6, bushDist: 2.3,
  },
  high: {
    label: 'High', dpr: 1.5, msaa: 0, fxaa: false, shadows: 'high', ssao: 'low',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.0, bloom: true, veg: 'high',
    grassCurve: grass(GRASS_HIGH), bushes: 2, bushHeight: 1.5, bushDist: 3.2,
  },
  ultra: {
    label: 'Ultra', dpr: 1.5, msaa: 0, fxaa: false, shadows: 'ultra', ssao: 'high',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.3, bloom: true, veg: 'ultra',
    grassCurve: grass(GRASS_ULTRA), bushes: 0.92, bushHeight: 1.4, bushDist: 4,
  },
};

// Sun shadow per level. map: texels per cascade (the atlas holds 2-4 tiles), far: shadow distance (m),
// splits: where cascades hand over (m from the camera), soft: filter blur (m). Texel size is about
// 2.4 * (cascade end distance) / map:
//   high  2560: 1.3 cm / 4.7 cm / 17 cm, three tiles (105 MB depth atlas)
//   ultra 4096: 0.6 cm / 1.8 cm / 5 cm / 15 cm, four tiles (268 MB depth atlas)
export const SHADOWS = {
  off: null,
  low: { map: 1024, far: 90, cascades: 2, splits: [25], soft: 0.08 },
  medium: { map: 2048, far: 130, cascades: 2, splits: [34], soft: 0.06 },
  high: { map: 2560, far: 180, cascades: 3, splits: [13, 48], soft: 0.045 },
  ultra: { map: 4096, far: 260, cascades: 4, splits: [10, 32, 85], soft: 0.04 },
};

// Every Graphics option is its own setting (prefix g). A preset writes its values into them; changing
// one switches to 'custom', which reads them back.
export function presetToGfx(q) {
  return {
    gDpr: q.dpr, gAA: q.msaa ? 'msaa' + q.msaa : q.fxaa ? 'fxaa' : 'off', gShadows: q.shadows, gSSAO: q.ssao, gBloom: q.bloom !== false,
    gViewDist: q.lodScale, gTerrain: q.terrainDetail, gTreeShadows: !!q.impostorShadows,
    gVeg: q.veg,
  };
}
export function gfxToQuality(g) {
  return {
    label: 'Custom', dpr: g.gDpr, msaa: g.gAA === 'msaa4' ? 4 : g.gAA === 'msaa2' ? 2 : 0, fxaa: g.gAA === 'fxaa',
    shadows: g.gShadows, ssao: g.gSSAO, bloom: g.gBloom,
    impostorShadows: g.gTreeShadows, terrainDetail: g.gTerrain, lodScale: g.gViewDist,
    veg: g.gVeg, ...vegOf(g.gVeg),
  };
}

// Grass and bushes have their own preset (gVeg: 'off' | a quality level), like the shadows
function vegOf(level) {
  const q = QUALITY[level] || QUALITY.high;
  return { grassCurve: q.grassCurve, bushes: q.bushes, bushHeight: q.bushHeight, bushDist: q.bushDist };
}

// 'auto': from the GPU name and the window's pixel count
export function autoQuality(renderer) {
  let name = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* ignore */ }
  const n = name.toLowerCase();
  const px = window.innerWidth * window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) ** 2;
  let q = 'medium';
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(n)) q = 'low';
  else if (/apple m\d+ (pro|max|ultra)/.test(n)) q = 'high';
  else if (/apple m\d+/.test(n)) q = 'medium';
  else if (/nvidia|geforce|rtx|radeon rx|radeon pro/.test(n)) q = /rtx|rx [67]\d{3}|rx [6-9]\d00/.test(n) ? 'ultra' : 'high';
  else if (/intel|uhd|iris|adreno|mali|powervr/.test(n)) q = 'low';
  // very large windows on a mid GPU: one step down
  if (px > 9e6 && q === 'high' && !/max|ultra/.test(n)) q = 'medium';
  // phones and tablets (iPadOS reports a Mac: tell it by the touch screen)
  if (isMobileDevice()) q = 'mobile';
  return { preset: q, gpu: name };
}

export function isMobileDevice() {
  return /mobile|android|iphone|ipad/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
