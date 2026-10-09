// Graphics presets. `dpr` caps the device pixel ratio before the player's resolution scale is applied.
// Frame times measured on an M1 Pro (headless Chrome, 1920x1080 window, devicePixelRatio 2, trail drive):
// low 5.1 ms, medium 8.7 ms, high 13 ms, ultra 22 ms. See DEVNOTES "World and rendering".

// The grass of the Grass and bushes levels: density (blades per m²), height and width (cm) as curves over the
// distance in m (grass.js evalCurve), tuned on the ?vegtune meadow (Oct 9). Medium and Low start from High.
const GRASS_ULTRA = {
  end: 300, smooth: true,
  density: [[0, 117], [3.2, 82], [14, 28], [26, 18], [56, 9.4], [102, 10], [150, 8.3], [300, 5.8]],
  height: [[0, 132], [23, 102], [39, 79], [62, 96], [86, 115], [151, 105], [297, 106]],
  width: [[0, 5.6], [28, 15], [47, 19], [84, 27], [121, 39], [160, 64], [207, 96], [246, 136], [300, 200]],
};
const GRASS_HIGH = {
  end: 215, smooth: true,
  density: [[0, 48], [3.2, 33], [14, 12], [26, 7.3], [49, 5.4], [98, 4.3], [150, 3.3], [300, 2.3]],
  height: [[0, 53], [9, 103], [23, 92], [46, 102], [71, 136], [91, 150], [136, 107], [196, 174], [285, 400]],
  width: [[0, 9.8], [25, 19], [55, 32], [91, 45], [129, 61], [173, 90], [210, 125], [252, 169], [278, 200]],
};
const grass = c => JSON.parse(JSON.stringify(c));

export const QUALITY_ORDER = ['mobile', 'low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  // Anti-aliasing is off in every preset (the player turns it on under Graphics, which makes the preset Custom).
  // phones and tablets (Auto picks it there): no shadows, no AO,
  // no grass or bushes (veg 'off'). dynamicDpr: the pixel density moves between 1 and `dpr` on its own to hold
  // 45-60 fps (main.js, "dynamic resolution").
  mobile: {
    label: 'Mobile', dpr: 1.5, dynamicDpr: true, msaa: 0, fxaa: false, shadows: 'off', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.7, bloom: true, veg: 'off',
    grass: 0.2, grassHeight: 1.6, grassWidth: 1.8, grassFar: 0.02, grassHeightFar: 2.2, grassWidthFar: 7, grassRadius: 100,
    bushes: 0.1, bushHeight: 2.15, bushDist: 1.5,
  },
  low: {
    label: 'Low', dpr: 1.0, msaa: 0, fxaa: false, shadows: 'low', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 0, lodScale: 0.7, bloom: true, veg: 'low',
    grass: 0.2, grassHeight: 1.6, grassWidth: 1.8, grassFar: 0.02, grassHeightFar: 2.2, grassWidthFar: 7, grassRadius: 100,
    grassCurve: grass(GRASS_HIGH), bushes: 0.45, bushHeight: 2, bushDist: 4,
  },
  medium: {
    label: 'Medium', dpr: 1.25, msaa: 0, fxaa: false, shadows: 'medium', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.85, bloom: true, veg: 'medium',
    grass: 0.22, grassHeight: 1.8, grassWidth: 1.5, grassFar: 0.03, grassHeightFar: 2.4, grassWidthFar: 6.5, grassRadius: 130,
    grassCurve: grass(GRASS_HIGH), bushes: 0.45, bushHeight: 2, bushDist: 4,
  },
  high: {
    label: 'High', dpr: 1.5, msaa: 0, fxaa: false, shadows: 'high', ssao: 'low',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.0, bloom: true, veg: 'high',
    grass: 0.4, grassHeight: 1.8, grassWidth: 1.1, grassFar: 0.045, grassHeightFar: 2.6, grassWidthFar: 6, grassRadius: 150,
    grassCurve: grass(GRASS_HIGH), bushes: 0.45, bushHeight: 2, bushDist: 4,
  },
  ultra: {
    label: 'Ultra', dpr: 1.5, msaa: 0, fxaa: false, shadows: 'ultra', ssao: 'high',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.3, bloom: true, veg: 'ultra',
    grass: 0.8, grassHeight: 1.8, grassWidth: 1.05, grassFar: 0.08, grassHeightFar: 2.6, grassWidthFar: 5.5, grassRadius: 180,
    grassCurve: grass(GRASS_ULTRA), bushes: 0.45, bushHeight: 2, bushDist: 4,
  },
};

// Sun shadow per level ('off': the sun casts no shadows). map: texels per cascade (the atlas holds 2-4 tiles),
// far: shadow distance in m, cascades + splits: how many and where they hand over (m from the camera),
// soft: filter blur in metres. Texel size is about 2.4 * (cascade end distance) / map:
//   high  2560: 1.3 cm / 4.7 cm / 17 cm, three tiles (105 MB depth atlas)
//   ultra 4096: 0.6 cm / 1.8 cm / 5 cm / 15 cm, four tiles (268 MB depth atlas)
export const SHADOWS = {
  off: null,
  low: { map: 1024, far: 90, cascades: 2, splits: [25], soft: 0.08 },
  medium: { map: 2048, far: 130, cascades: 2, splits: [34], soft: 0.06 },
  high: { map: 2560, far: 180, cascades: 3, splits: [13, 48], soft: 0.045 },
  ultra: { map: 4096, far: 260, cascades: 4, splits: [10, 32, 85], soft: 0.04 },
};

// Settings → Graphics: every option has its own setting (prefix g). Choosing a preset writes the preset's
// values into them; changing any of them switches the preset to 'custom', which reads them back.
export function presetToGfx(q) {
  return {
    gDpr: q.dpr, gAA: q.msaa ? 'msaa' + q.msaa : q.fxaa ? 'fxaa' : 'off', gShadows: q.shadows, gSSAO: q.ssao, gBloom: q.bloom !== false,
    gViewDist: q.lodScale, gTerrain: q.terrainDetail, gTreeShadows: !!q.impostorShadows,
    gVeg: q.veg,
    gGrass: q.grass, gGrassHeight: q.grassHeight, gGrassWidth: q.grassWidth,
    gGrassFar: q.grassFar, gGrassHeightFar: q.grassHeightFar, gGrassWidthFar: q.grassWidthFar, gGrassDist: q.grassRadius,
    gBushes: q.bushes, gBushHeight: q.bushHeight, gBushDist: q.bushDist,
  };
}
export function gfxToQuality(g) {
  return {
    label: 'Custom', dpr: g.gDpr, msaa: g.gAA === 'msaa4' ? 4 : g.gAA === 'msaa2' ? 2 : 0, fxaa: g.gAA === 'fxaa',
    shadows: g.gShadows, ssao: g.gSSAO, bloom: g.gBloom,
    grass: g.gGrass, grassHeight: g.gGrassHeight, grassWidth: g.gGrassWidth, grassFar: g.gGrassFar, grassHeightFar: g.gGrassHeightFar, grassWidthFar: g.gGrassWidthFar, grassRadius: g.gGrassDist, impostorShadows: g.gTreeShadows,
    terrainDetail: g.gTerrain, lodScale: g.gViewDist, bushes: g.gBushes, bushDist: g.gBushDist, bushHeight: g.gBushHeight,
    veg: g.gVeg,
    grassCurve: QUALITY[g.gVeg]?.grassCurve,   // a level's grass; Custom: the near / far sliders (curveFromNearFar)
  };
}

// Grass and bushes have their own preset too (gVeg: 'off' | a quality level | 'custom'), like the shadows:
// a level writes that quality preset's grass and bush values into the sliders below it, moving a slider makes it 'custom'.
export const VEG_KEYS = ['gGrass', 'gGrassHeight', 'gGrassWidth', 'gGrassFar', 'gGrassHeightFar', 'gGrassWidthFar', 'gGrassDist', 'gBushes', 'gBushHeight', 'gBushDist'];
export function vegToGfx(level) {
  const g = presetToGfx(QUALITY[level]);
  return Object.fromEntries(VEG_KEYS.map(k => [k, g[k]]));
}

// 'auto': pick from the GPU name and the pixel count of the window
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
