// One queue submit per frame (or per ~1 ms of encoding) instead of one per render pass.
//
// three's WebGPURenderer submits a command buffer after every render() and compute() call (~40 a frame here:
// shadow maps, scene, AO, shafts, every bloom mip, eye adaptation) and uploads uniforms with
// queue.writeBuffer while it encodes each pass (~850 small writes a frame). On Windows, Chrome's D3D12
// backend runs each write and each submit in its own small command list on the GPU process: a submit with
// writes before it costs ~0.1 ms there (Ryzen 5600X + RTX 3070), so the frame spent 5-7 ms in the GPU
// process and as much again in the page, while the GPU itself needed ~4 ms. Metal (the Mac) pays far less.
//
// The queue is wrapped so that order is kept exactly:
//   - writeBuffer / writeTexture: the data is appended to a CPU staging array and a copy from the GPU staging
//     buffer is recorded in a copy encoder; the copy encoder goes in front of the next command buffer
//   - submit: the command buffers wait in a list; flush() uploads the staging array with one writeBuffer and
//     submits the whole list at once
//   - flush() runs at the end of the frame (main.js), from a microtask (whatever submits outside a frame), when
//     work has waited `maxDelay` ms (so the GPU starts on the shadow maps and scene while the page encodes the
//     post passes), and before anything that must see the earlier work: image copies, onSubmittedWorkDone,
//     mapping a buffer, destroying a buffer or texture.
// Writes that are not 4-byte aligned or bigger than MAX_INLINE go straight to the queue (after a flush).
const MAX_INLINE = 1 << 20;

export function batchSubmits(device, { maxDelay = 1 } = {}) {
  const q = device.queue;
  const submit0 = q.submit.bind(q), write0 = q.writeBuffer.bind(q), writeTexture0 = q.writeTexture.bind(q);
  const copyImage0 = q.copyExternalImageToTexture.bind(q), done0 = q.onSubmittedWorkDone.bind(q);
  const createBuffer0 = device.createBuffer.bind(device), createTexture0 = device.createTexture.bind(device);
  const STAGING = GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  let cap = 1 << 20, stage = new Uint8Array(cap), stageBuf = createBuffer0({ size: cap, usage: STAGING, label: 'batch staging' });
  let used = 0, grow = 0, copies = null, pending = [], since = 0, scheduled = false;
  const stats = { submits: 0, flushes: 0, copies: 0, direct: 0 };
  const api = { flush: null, stats, maxDelay };

  const flush = () => {
    if (copies) { pending.push(copies.finish()); copies = null; }
    if (pending.length) {
      if (used) write0(stageBuf, 0, stage, 0, used);
      const list = pending;
      pending = [];
      submit0(list);
      stats.flushes++;
    }
    used = 0;
    if (grow) {   // the staging buffer overflowed: a bigger one (the old one may still be read by the GPU: destroy after submit is fine)
      while (cap < grow) cap *= 2;
      grow = 0;
      stageBuf.destroy();
      stage = new Uint8Array(cap); stageBuf = createBuffer0({ size: cap, usage: STAGING, label: 'batch staging' });
    }
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; flush(); }); }
  };

  q.submit = (buffers) => {
    if (copies) { pending.push(copies.finish()); copies = null; }
    if (!pending.length) since = performance.now();
    for (const b of buffers) pending.push(b);
    stats.submits++;
    if (performance.now() - since > api.maxDelay) flush();
    else schedule();
  };

  q.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
    const view = ArrayBuffer.isView(data);
    const el = view ? data.BYTES_PER_ELEMENT || 1 : 1;
    const start = (view ? data.byteOffset : 0) + dataOffset * el;
    const bytes = size !== undefined ? size * el : data.byteLength - dataOffset * el;
    if ((bytes & 3) || (offset & 3) || bytes > MAX_INLINE) {
      flush(); stats.direct++;
      return write0(buffer, offset, data, dataOffset, size);
    }
    if (used + bytes > cap) { grow = Math.max(cap * 2, bytes); flush(); }
    stage.set(new Uint8Array(view ? data.buffer : data, start, bytes), used);
    if (!copies) copies = device.createCommandEncoder({ label: 'batched writes' });
    copies.copyBufferToBuffer(stageBuf, used, buffer, offset, bytes);
    used += bytes;
    stats.copies++;
    schedule();
  };

  // texture uploads the same way (BatchedMesh writes its matrix and index textures every frame): rows staged
  // 256-byte aligned and copied with copyBufferToTexture. 3D / array uploads, block-compressed formats and big
  // uploads go straight to the queue.
  q.writeTexture = (dst, data, layout, size) => {
    const w = size.width ?? size[0], h = size.height ?? size[1] ?? 1, d = size.depthOrArrayLayers ?? size[2] ?? 1;
    const bpr = layout.bytesPerRow, fmt = dst.texture.format;
    const stride = (bpr + 255) & ~255;
    if (d !== 1 || !bpr || !w || /^(bc|etc|eac|astc)|depth|stencil/.test(fmt) || stride * h > MAX_INLINE) {
      flush(); stats.direct++;
      return writeTexture0(dst, data, layout, size);
    }
    let at = (used + 255) & ~255;
    if (at + stride * h > cap) { grow = Math.max(cap * 2, stride * h); flush(); at = 0; }
    const view = ArrayBuffer.isView(data);
    const src = new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + (layout.offset || 0), data.byteLength - (layout.offset || 0));
    for (let r = 0; r < h; r++) stage.set(src.subarray(r * bpr, Math.min(src.length, r * bpr + bpr)), at + r * stride);
    if (!copies) copies = device.createCommandEncoder({ label: 'batched writes' });
    copies.copyBufferToTexture({ buffer: stageBuf, offset: at, bytesPerRow: stride, rowsPerImage: h }, dst, size);
    used = at + stride * h;
    stats.copies++;
    schedule();
  };
  q.copyExternalImageToTexture = (...a) => { flush(); return copyImage0(...a); };
  q.onSubmittedWorkDone = () => { flush(); return done0(); };
  // a mapped or destroyed resource must not be in a command buffer that is submitted later
  device.createBuffer = (desc) => {
    const b = createBuffer0(desc);
    const destroy = b.destroy.bind(b);
    b.destroy = () => { flush(); destroy(); };
    if (desc.usage & (GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE)) {
      const map = b.mapAsync.bind(b);
      b.mapAsync = (...a) => { flush(); return map(...a); };
    }
    return b;
  };
  device.createTexture = (desc) => {
    const t = createTexture0(desc);
    const destroy = t.destroy.bind(t);
    t.destroy = () => { flush(); destroy(); };
    return t;
  };

  api.flush = flush;
  return api;
}
