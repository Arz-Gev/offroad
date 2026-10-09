// Graphics presets. `dpr` caps the device pixel ratio before the player's resolution scale.
// Frame times on an M1 Pro (headless Chrome, 1920x1080, dpr 2, trail drive): low 5.1 ms, medium 8.7,
// high 13, ultra 22 (DEVNOTES, "World and rendering").

export const QUALITY_ORDER = ['mobile', 'low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  // Anti-aliasing is off in every preset (turning it on under Graphics makes the preset Custom).
  // mobile (phones and tablets): no shadows, AO, grass or bushes. dynamicDpr: pixel density moves
  // between 1 and `dpr` to hold 45-60 fps (main.js).
  mobile: {
    label: 'Mobile', dpr: 1.5, dynamicDpr: true, msaa: 0, fxaa: false, shadows: 'off', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.7, bloom: true, vegetation: false,
    grass: 0.05, grassHeight: 2.25, grassWidth: 2, grassRadius: 149, grassNear: 53,
    grassFarWidth: 1.85, grassFarSpacing: 1.3, grassFarGrow: 0,
    bushes: 0.1, bushHeight: 2.15, bushDist: 1.5,
  },
  low: {
    label: 'Low', dpr: 1.0, msaa: 0, fxaa: false, shadows: 'low', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 0, lodScale: 0.7, bloom: true,
    grass: 0.05, grassHeight: 2.25, grassWidth: 2, grassRadius: 149, grassNear: 53,
    grassFarWidth: 1.85, grassFarSpacing: 1.3, grassFarGrow: 0,
    bushes: 0.1, bushHeight: 2.15, bushDist: 1.5,
  },
  medium: {
    label: 'Medium', dpr: 1.25, msaa: 0, fxaa: false, shadows: 'medium', ssao: 'off',
    treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.85, bloom: true,
    grass: 0.1, grassHeight: 3.25, grassWidth: 1.3, grassRadius: 239, grassNear: 58,
    grassFarWidth: 2.4, grassFarSpacing: 1.3, grassFarGrow: 0,
    bushes: 0.2, bushHeight: 2.1, bushDist: 1.25,
  },
  high: {
    label: 'High', dpr: 1.5, msaa: 0, fxaa: false, shadows: 'high', ssao: 'low',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.0, bloom: true,
    grass: 0.15, grassHeight: 3.25, grassWidth: 2, grassRadius: 239, grassNear: 60,
    grassFarWidth: 1.65, grassFarSpacing: 1.1, grassFarGrow: 0,
    bushes: 0.65, bushHeight: 1.6, bushDist: 1.55,
  },
  ultra: {
    label: 'Ultra', dpr: 2.0, msaa: 0, fxaa: false, shadows: 'ultra', ssao: 'high',
    impostorShadows: true,
    terrainDetail: 2, lodScale: 1.3, bloom: true,
    grass: 0.8, grassHeight: 2.35, grassWidth: 1.05, grassRadius: 239, grassNear: 60,
    grassFarWidth: 3, grassFarSpacing: 1.1, grassFarGrow: 0,
    bushes: 1.8, bushHeight: 1.4, bushDist: 1.85,
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
    gGrass: q.grass, gGrassHeight: q.grassHeight, gGrassWidth: q.grassWidth, gGrassNear: q.grassNear, gGrassDist: q.grassRadius,
    gGrassFarWidth: q.grassFarWidth, gGrassFarSpacing: q.grassFarSpacing, gGrassFarGrow: q.grassFarGrow,
    gBushes: q.bushes, gBushHeight: q.bushHeight, gBushDist: q.bushDist,
  };
}
export function gfxToQuality(g) {
  return {
    label: 'Custom', dpr: g.gDpr, msaa: g.gAA === 'msaa4' ? 4 : g.gAA === 'msaa2' ? 2 : 0, fxaa: g.gAA === 'fxaa',
    shadows: g.gShadows, ssao: g.gSSAO, bloom: g.gBloom,
    grass: g.gGrass, grassHeight: g.gGrassHeight, grassWidth: g.gGrassWidth, grassNear: g.gGrassNear, grassFarWidth: g.gGrassFarWidth, grassFarSpacing: g.gGrassFarSpacing, grassFarGrow: g.gGrassFarGrow, grassRadius: g.gGrassDist, impostorShadows: g.gTreeShadows,
    terrainDetail: g.gTerrain, lodScale: g.gViewDist, bushes: g.gBushes, bushDist: g.gBushDist, bushHeight: g.gBushHeight,
  };
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
