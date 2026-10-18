// Rendering pipeline: retouch → geometry → colour (WebGL) → background → drawings/text.
import { renderGeometry, makeCanvas, frameSize } from './geometry.js';
import { applyRetouch, boxBlur3 } from './retouch.js';
import { drawStrokes, drawTexts } from './overlays.js';
import { ColorRenderer, isIdentity } from './gl.js';

const WORK_MAX = 2560;

export class Pipeline {
  constructor(full) {
    this.full = full; // ImageBitmap or canvas, original resolution
    this.gl = new ColorRenderer();
    const lim = Math.min(WORK_MAX, this.gl.maxSize);
    const k = Math.min(1, lim / Math.max(full.width, full.height));
    if (k < 1) {
      this.work = makeCanvas(Math.round(full.width * k), Math.round(full.height * k));
      const ctx = this.work.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, 0, 0, this.work.width, this.work.height);
    } else {
      this.work = full;
    }
    this.retouchKey = null; this.retouched = this.work;
    this.geoKey = null; this.geo = null;
    this.mask = null;
  }

  get workScale() { return this.work.width / this.full.width; }

  retouchedWork(state) {
    const key = JSON.stringify(state.retouch);
    if (key !== this.retouchKey) {
      this.retouched = state.retouch.length ? applyRetouch(this.work, state.retouch) : this.work;
      this.retouchKey = key;
      this.geoKey = null;
    }
    return this.retouched;
  }

  // Preview render at working resolution.
  render(state, { fullFrame = false, overlays = true, skip = null } = {}) {
    const src = this.retouchedWork(state);
    const gk = JSON.stringify([state.rot, state.flipH, state.flipV, state.straighten, fullFrame ? null : state.crop, this.retouchKey]);
    if (gk !== this.geoKey) {
      this.geo = renderGeometry(src, state, 1, { fullFrame });
      this.gl.setSource(this.geo);
      this.geoKey = gk;
    }
    return this.compose(state, this.geo, src, 1, { fullFrame, overlays, skip });
  }

  compose(state, geo, src, scale, { fullFrame, overlays, skip }) {
    const colored = isIdentity(state) ? geo : this.gl.render(state);
    const out = makeCanvas(geo.width, geo.height);
    const ctx = out.getContext('2d');
    if (state.bg.on && this.mask && !fullFrame) {
      const ms = scale * (src.width / this.mask.width);
      const m = renderGeometry(this.mask, state, ms);
      if (state.bg.mode === 'color') { ctx.fillStyle = state.bg.color; ctx.fillRect(0, 0, out.width, out.height); }
      else if (state.bg.mode === 'blur') ctx.drawImage(blurred(colored, state.bg.blur), 0, 0, out.width, out.height);
      const fg = makeCanvas(out.width, out.height);
      const fctx = fg.getContext('2d');
      fctx.drawImage(colored, 0, 0);
      fctx.globalCompositeOperation = 'destination-in';
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(m, 0, 0, out.width, out.height);
      ctx.drawImage(fg, 0, 0);
    } else {
      ctx.drawImage(colored, 0, 0);
    }
    if (overlays && !fullFrame) {
      drawStrokes(ctx, state.strokes, out.width, out.height);
      drawTexts(ctx, skip ? state.texts.filter((t) => t.id !== skip) : state.texts, out.width, out.height);
    }
    return out;
  }

  // Full-quality render for export. scale is relative to the ORIGINAL resolution.
  async renderFull(state, scale = 1) {
    const { fw, fh } = frameSize(this.full.width, this.full.height, state);
    const maxOut = this.gl.maxSize;
    const ow = state.crop.w * fw * scale, oh = state.crop.h * fh * scale;
    if (Math.max(ow, oh) > maxOut) scale *= maxOut / Math.max(ow, oh);
    // Work from the original only when it's actually needed for the requested size.
    const useFull = scale > this.workScale * 1.01;
    const base = useFull ? this.full : this.work;
    const s = useFull ? scale : scale / this.workScale;
    await nextFrame();
    const src = state.retouch.length ? (useFull ? applyRetouch(base, state.retouch) : this.retouchedWork(state)) : base;
    await nextFrame();
    const geo = renderGeometry(src, state, s);
    this.gl.setSource(geo);
    this.geoKey = null; // preview must re-upload next time
    return this.compose(state, geo, src, s, { fullFrame: false, overlays: true });
  }
}

function blurred(c, amount) {
  const k = 0.12;
  const w = Math.max(8, Math.round(c.width * k)), h = Math.max(8, Math.round(c.height * k));
  const small = makeCanvas(w, h);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(c, 0, 0, w, h);
  const id = sctx.getImageData(0, 0, w, h);
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { buf[i * 3] = id.data[i * 4]; buf[i * 3 + 1] = id.data[i * 4 + 1]; buf[i * 3 + 2] = id.data[i * 4 + 2]; }
  const r = Math.max(1, Math.round((amount / 100) * Math.max(w, h) * 0.03));
  const b = boxBlur3(buf, w, h, r);
  for (let i = 0; i < w * h; i++) { id.data[i * 4] = b[i * 3]; id.data[i * 4 + 1] = b[i * 3 + 1]; id.data[i * 4 + 2] = b[i * 3 + 2]; id.data[i * 4 + 3] = 255; }
  sctx.putImageData(id, 0, 0);
  return small;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
