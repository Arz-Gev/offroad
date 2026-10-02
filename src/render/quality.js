// Graphics presets. `dpr` caps the device pixel ratio before the player's resolution scale is applied.
// Frame times measured on an M1 Pro (headless Chrome, 1920x1080 window, devicePixelRatio 2, trail drive):
// low 5.1 ms, medium 8.7 ms, high 13 ms, ultra 22 ms. See DEVNOTES "World and rendering".

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    label: 'Low', dpr: 1.0, msaa: 0, fxaa: true, shadows: 'low', ssao: 'off',
    grass: 0.0, grassRadius: 30, treeNear: 40, impostorShadows: false,
    terrainDetail: 0, lodScale: 0.7, bloom: true, bushes: 1, bushDist: 0.5,
  },
  medium: {
    label: 'Medium', dpr: 1.25, msaa: 0, fxaa: true, shadows: 'medium', ssao: 'off',
    grass: 0.55, grassRadius: 34, treeNear: 40, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.85, bloom: true, bushes: 1, bushDist: 0.8,
  },
  high: {
    label: 'High', dpr: 1.5, msaa: 2, fxaa: false, shadows: 'high', ssao: 'low',
    grass: 1.6, grassRadius: 75, impostorShadows: true,
    terrainDetail: 2, lodScale: 1.0, bloom: true, bushes: 1.5, bushDist: 1.25,
  },
  ultra: {
    label: 'Ultra', dpr: 2.0, msaa: 4, fxaa: false, shadows: 'ultra', ssao: 'high',
    grass: 2.6, grassRadius: 125, impostorShadows: true,
    terrainDetail: 2, lodScale: 1.3, bloom: true, bushes: 2.2, bushDist: 1.6,
  },
};

// sun shadow map size / distance / softness per level ('off': the sun casts no shadows)
export const SHADOWS = {
  off: null,
  low: { map: 1024, far: 90, radius: 1.2 },
  medium: { map: 2048, far: 130, radius: 1.4 },
  high: { map: 2048, far: 170, radius: 1.6 },
  ultra: { map: 3072, far: 220, radius: 1.8 },
};

// Settings → Graphics: every option has its own setting (prefix g). Choosing a preset writes the preset's
// values into them; changing any of them switches the preset to 'custom', which reads them back.
export function presetToGfx(q) {
  return {
    gDpr: q.dpr, gAA: q.msaa ? 'msaa' + q.msaa : q.fxaa ? 'fxaa' : 'off', gShadows: q.shadows, gSSAO: q.ssao, gBloom: q.bloom !== false,
    gViewDist: q.lodScale, gTerrain: q.terrainDetail, gTreeShadows: !!q.impostorShadows,
    gGrass: q.grass, gGrassHeight: q.grassHeight ?? 1.5, gGrassWidth: 1, gGrassNear: q.grassNear ?? 0, gGrassDist: q.grassRadius,
    gBushes: q.bushes, gBushHeight: 1, gBushDist: q.bushDist ?? 1,
  };
}
export function gfxToQuality(g) {
  return {
    label: 'Custom', dpr: g.gDpr, msaa: g.gAA === 'msaa4' ? 4 : g.gAA === 'msaa2' ? 2 : 0, fxaa: g.gAA === 'fxaa',
    shadows: g.gShadows, ssao: g.gSSAO, bloom: g.gBloom,
    grass: g.gGrass, grassHeight: g.gGrassHeight, grassWidth: g.gGrassWidth, grassNear: g.gGrassNear, grassRadius: g.gGrassDist, impostorShadows: g.gTreeShadows,
    terrainDetail: g.gTerrain, lodScale: g.gViewDist, bushes: g.gBushes, bushDist: g.gBushDist, bushHeight: g.gBushHeight,
  };
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
  if (/mobile|android|iphone|ipad/i.test(navigator.userAgent)) q = 'low';
  return { preset: q, gpu: name };
}
