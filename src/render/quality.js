// Graphics presets. `dpr` caps the device pixel ratio before the player's resolution scale is applied.
// Frame times measured on an M1 Pro (headless Chrome, 1920x1080 window, devicePixelRatio 2, trail drive):
// low 5.1 ms, medium 8.7 ms, high 13 ms, ultra 22 ms. See DEVNOTES "World and rendering".

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    label: 'Low', dpr: 1.0, msaa: 0, fxaa: true, shadowMap: 1024, shadowFar: 90, shadowRadius: 1.2,
    grass: 0.0, grassRadius: 0, treeNear: 45, impostorShadows: false,
    terrainDetail: 0, lodScale: 0.7, bloom: true, bushes: 0.5,
  },
  medium: {
    label: 'Medium', dpr: 1.25, msaa: 0, fxaa: true, shadowMap: 2048, shadowFar: 130, shadowRadius: 1.4,
    grass: 0.55, grassRadius: 34, treeNear: 60, impostorShadows: false,
    terrainDetail: 1, lodScale: 0.85, bloom: true, bushes: 0.8,
  },
  high: {
    label: 'High', dpr: 1.5, msaa: 2, fxaa: false, shadowMap: 2048, shadowFar: 170, shadowRadius: 1.6,
    grass: 1.0, grassRadius: 46, treeNear: 80, impostorShadows: true,
    terrainDetail: 2, lodScale: 1.0, bloom: true, bushes: 1,
  },
  ultra: {
    label: 'Ultra', dpr: 2.0, msaa: 4, fxaa: false, shadowMap: 3072, shadowFar: 220, shadowRadius: 1.8,
    grass: 1.35, grassRadius: 64, treeNear: 110, impostorShadows: true,
    terrainDetail: 2, lodScale: 1.3, bloom: true, bushes: 1,
  },
};

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
