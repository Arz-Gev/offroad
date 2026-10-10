// One-off texture bakes on a throwaway WebGL 2 context: the procedural ground layers and the water ripples
// are long GLSL recipes (periodic noise, voronoi, pebbles, blades) that run once at startup. Running them
// here and uploading the result keeps those recipes as they are, for both renderer backends.
//
// bakeLayers({ size, layers, frag, uniforms, source }) -> Uint8Array per layer (RGBA8, row 0 at the bottom)
//   frag: GLSL ES 1/3 style fragment code using vUv, gl_FragColor, texture2D (mapped to GLSL 3)
//   uniforms: { name: number | [x, y] | ... } set per layer by a callback (layer index) -> object
//   source: optional RGBA8 layers bound as `sampler2DArray tSrc` (linear, repeat, no mips)

let ctx = null;
function gl2() {
  if (ctx && !ctx.isContextLost()) return ctx;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
  ctx = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!ctx) throw new Error('WebGL 2 is needed to bake the ground textures');
  return ctx;
}

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAG_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
#define varying in
#define texture2D texture
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
`;

function program(gl, frag) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('bake shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG_HEAD + frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('bake program: ' + gl.getProgramInfoLog(p));
  return p;
}

export function bakeLayers({ size, layers = 1, frag, uniforms = () => ({}), source = null }) {
  const gl = gl2();
  const prog = program(gl, frag);
  gl.useProgram(prog);
  const fb = gl.createFramebuffer();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let src = null;
  if (source) {
    src = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, src);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, size, size, source.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    source.forEach((d, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, d));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(gl.getUniformLocation(prog, 'tSrc'), 0);
  }
  gl.viewport(0, 0, size, size);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  const out = [];
  for (let l = 0; l < layers; l++) {
    const u = uniforms(l);
    for (const k in u) {
      const loc = gl.getUniformLocation(prog, k);
      if (!loc) continue;
      const v = u[k];
      if (typeof v === 'number') (Number.isInteger(v) && /^uLayer$|^i/.test(k) ? gl.uniform1i : gl.uniform1f).call(gl, loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push(px);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb); gl.deleteTexture(tex); if (src) gl.deleteTexture(src);
  gl.deleteProgram(prog);
  return out;
}

// release the context once all bakes are done
export function bakeDone() {
  if (ctx) { ctx.getExtension('WEBGL_lose_context')?.loseContext(); ctx = null; }
}
