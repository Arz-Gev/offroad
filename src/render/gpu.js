import * as THREE from 'three/webgpu';
import { installLamps } from './lamps.js';
import { batchSubmits } from './batch.js';

// The renderer: three's WebGPURenderer on a WebGPU device when the browser has one, otherwise the same
// renderer on its WebGL 2 backend (every shader is written in TSL, which compiles to WGSL or GLSL).
//
// We create the WebGPU device ourselves so we can read the adapter (GPU name for the Auto preset) and ask for
// the adapter's real limits: the grass and undergrowth keep a few million candidate blades in storage
// buffers, more than the WebGPU default of 128 MB per binding allows on some presets.
//
// caps (what the rest of the game may use):
//   webgpu   - WebGPU backend (else WebGL 2)
//   compute  - compute shaders that write storage buffers with atomics + indirect draws (WebGPU only):
//              GPU-culled vegetation and GPU particles. Without it those systems use their vertex-culled
//              fallback paths.
//   gpu      - the adapter's description for the Auto preset, e.g. "apple m1 pro"
//   floatFilter - linear filtering of 32-bit float textures (heights read with one fetch)

export async function createRenderer(canvas, { forceWebGL = false } = {}) {
  let device = null, gpu = '', batch = null;
  if (!forceWebGL && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const info = adapter.info || {};
        gpu = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
        const features = [...adapter.features];
        const L = adapter.limits, want = {};
        for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxColorAttachmentBytesPerSample', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxTextureArrayLayers'])
          if (L[k] !== undefined) want[k] = L[k];
        device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: want });
        if (!/[?&]batch=0\b/.test(location.search)) batch = batchSubmits(device);   // ?batch=0: three's own submits
      }
    } catch (e) {
      console.warn('WebGPU device creation failed, using WebGL 2', e);
      device = null; batch = null;
    }
  }
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: false, powerPreference: 'high-performance',
    forceWebGL: forceWebGL || !device, device: device || undefined,
    // the scene renders into the post pipeline's own targets; the canvas only gets the final picture
    outputBufferType: THREE.HalfFloatType,
  });
  await renderer.init();
  const webgpu = !!renderer.backend.isWebGPUBackend;
  // WebGPU adapters usually hide the model ("apple metal-3"); WebGL's renderer string names it
  if (!/\bm\d|rtx|gtx|geforce|radeon|iris|uhd|adreno|mali|\barc\b/i.test(gpu)) gpu = (gpu + ' ' + webglName(webgpu ? null : renderer.backend.gl)).trim();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;     // tone mapping happens in the post pipeline's composite
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const caps = {
    webgpu,
    compute: webgpu,
    gpu: gpu.toLowerCase(),
    floatFilter: webgpu ? renderer.backend.hasFeature('float32-filterable') : !!renderer.backend.extensions?.has?.('OES_texture_float_linear'),
  };
  renderer.caps = caps;
  // the frame's submits go to the GPU together (render/batch.js); main.js flushes at the end of each frame
  renderer.batch = webgpu ? batch : null;
  if (webgpu) oneWritePerUniformBlock(renderer);
  installLamps(renderer);
  return renderer;
}

// three uploads every changed range of a uniform block with its own queue.writeBuffer (~1700 a frame while
// driving, each a copy plus barriers in Chrome's D3D12 backend). It keeps the whole block on the CPU
// (binding.buffer), so one write from the first changed value to the last uploads the same data; ~460 a frame.
// Spans that would be mostly unchanged bytes (a big uniform array touched at both ends) keep three's writes.
function oneWritePerUniformBlock(renderer) {
  const utils = renderer.backend.bindingUtils;
  const perRange = utils?.updateBinding;
  if (typeof perRange !== 'function') return;
  utils.updateBinding = function (binding) {
    const array = binding.buffer, ranges = binding.updateRanges;
    if (ranges.length < 2 || !ArrayBuffer.isView(array)) return perRange.call(this, binding);
    let lo = Infinity, hi = 0, n = 0;
    for (const r of ranges) { if (r.start < lo) lo = r.start; if (r.start + r.count > hi) hi = r.start + r.count; n += r.count; }
    if ((hi - lo) * array.BYTES_PER_ELEMENT > 4096 && hi - lo > 4 * n) return perRange.call(this, binding);
    this.backend.device.queue.writeBuffer(this.backend.get(binding).buffer, lo * array.BYTES_PER_ELEMENT, array, lo, hi - lo);
  };
}

function webglName(gl) {
  try {
    gl = gl || document.createElement('canvas').getContext('webgl2');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ''; }
}
