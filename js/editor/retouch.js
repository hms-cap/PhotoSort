// Brush retouching on the original image: heal (fill from surroundings) and blur.
// Strokes are normalised to the image (x/width, y/height); radius is relative to the long side.
import { makeCanvas } from './geometry.js';

export function applyRetouch(img, strokes) {
  const w = img.width, h = img.height;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  for (const s of strokes) {
    try { applyStroke(ctx, w, h, s); } catch (e) { console.warn('retouch stroke failed', e); }
  }
  return out;
}

function strokeBox(s, w, h) {
  const long = Math.max(w, h);
  const r = Math.max(1.5, s.r * long);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.pts) {
    x0 = Math.min(x0, x * w); y0 = Math.min(y0, y * h);
    x1 = Math.max(x1, x * w); y1 = Math.max(y1, y * h);
  }
  const pad = Math.ceil(r * 3 + 4);
  const bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
  const bw = Math.min(w, Math.ceil(x1 + pad)) - bx, bh = Math.min(h, Math.ceil(y1 + pad)) - by;
  return { r, bx, by, bw, bh };
}

function strokeMask(s, w, h, box, widthScale = 1) {
  const m = makeCanvas(box.bw, box.bh);
  const c = m.getContext('2d', { willReadFrequently: true });
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = '#fff'; c.fillStyle = '#fff';
  c.lineWidth = box.r * 2 * widthScale;
  const pts = s.pts.map(([x, y]) => [x * w - box.bx, y * h - box.by]);
  if (pts.length === 1) {
    c.beginPath(); c.arc(pts[0][0], pts[0][1], box.r * widthScale, 0, Math.PI * 2); c.fill();
  } else {
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke();
  }
  const d = c.getImageData(0, 0, box.bw, box.bh).data;
  const a = new Float32Array(box.bw * box.bh);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

function applyStroke(ctx, w, h, s) {
  if (!s.pts?.length) return;
  const box = strokeBox(s, w, h);
  if (box.bw < 2 || box.bh < 2) return;
  const img = ctx.getImageData(box.bx, box.by, box.bw, box.bh);
  const n = box.bw * box.bh;
  const src = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { src[i * 3] = img.data[i * 4]; src[i * 3 + 1] = img.data[i * 4 + 1]; src[i * 3 + 2] = img.data[i * 4 + 2]; }

  let result, blend;
  if (s.kind === 'blur') {
    result = boxBlur3(src, box.bw, box.bh, Math.max(2, Math.round(box.r * 0.7)));
    blend = boxBlurMask(strokeMask(s, w, h, box), box.bw, box.bh, Math.max(1, Math.round(box.r * 0.35)));
  } else {
    const hole = strokeMask(s, w, h, box, 1.15);
    const known = new Uint8Array(n);
    for (let i = 0; i < n; i++) known[i] = hole[i] < 0.02 ? 1 : 0;
    result = pushPullFill(src, known, box.bw, box.bh);
    addTexture(result, src, known, box.bw, box.bh);
    blend = boxBlurMask(strokeMask(s, w, h, box, 1.1), box.bw, box.bh, Math.max(1, Math.round(box.r * 0.15)));
    for (let i = 0; i < n; i++) if (!known[i]) blend[i] = Math.max(blend[i], 0.98);
  }
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, blend[i]);
    if (t <= 0) continue;
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = img.data[i * 4 + c] * (1 - t) + result[i * 3 + c] * t;
  }
  ctx.putImageData(img, box.bx, box.by);
}

// Smooth hole filling: average known pixels down a pyramid, then pull back up.
function pushPullFill(src, known, w, h) {
  const levels = [{ w, h, c: src.slice(), k: Float32Array.from(known) }];
  while (levels.at(-1).w > 2 && levels.at(-1).h > 2) {
    const p = levels.at(-1);
    const nw = Math.ceil(p.w / 2), nh = Math.ceil(p.h / 2);
    const c = new Float32Array(nw * nh * 3), k = new Float32Array(nw * nh);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x, j = (y >> 1) * nw + (x >> 1), wt = p.k[i];
      if (!wt) continue;
      k[j] += wt;
      c[j * 3] += p.c[i * 3] * wt; c[j * 3 + 1] += p.c[i * 3 + 1] * wt; c[j * 3 + 2] += p.c[i * 3 + 2] * wt;
    }
    for (let j = 0; j < nw * nh; j++) if (k[j]) { c[j * 3] /= k[j]; c[j * 3 + 1] /= k[j]; c[j * 3 + 2] /= k[j]; k[j] = Math.min(1, k[j]); }
    levels.push({ w: nw, h: nh, c, k });
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const p = levels[li], q = levels[li + 1];
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x;
      if (p.k[i] >= 1) continue;
      // bilinear sample from the coarser level
      const fx = Math.min(q.w - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(q.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(q.w - 1, x0 + 1), y1 = Math.min(q.h - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const t = p.k[i];
      for (let ch = 0; ch < 3; ch++) {
        const v = (q.c[(y0 * q.w + x0) * 3 + ch] * (1 - ax) + q.c[(y0 * q.w + x1) * 3 + ch] * ax) * (1 - ay) +
                  (q.c[(y1 * q.w + x0) * 3 + ch] * (1 - ax) + q.c[(y1 * q.w + x1) * 3 + ch] * ax) * ay;
        p.c[i * 3 + ch] = p.c[i * 3 + ch] * t + v * (1 - t);
      }
      p.k[i] = 1;
    }
  }
  return levels[0].c;
}

// Adds grain matching the surroundings so filled areas don't look plastic.
function addTexture(fill, src, known, w, h) {
  let n = 0, sum = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!known[i] || !known[i - 1] || !known[i + 1]) continue;
    const l = (k) => src[k * 3] * 0.3 + src[k * 3 + 1] * 0.59 + src[k * 3 + 2] * 0.11;
    const d = l(i) - (l(i - 1) + l(i + 1)) / 2;
    sum += d * d; n++;
  }
  const sd = n ? Math.min(12, Math.sqrt(sum / n) * 0.8) : 0;
  if (sd < 0.5) return;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < w * h; i++) {
    if (known[i]) continue;
    const g = (rnd() + rnd() + rnd() - 1.5) * sd * 1.4;
    fill[i * 3] += g; fill[i * 3 + 1] += g; fill[i * 3 + 2] += g;
  }
}

// Three box-blur passes ≈ gaussian, on an RGB float buffer.
export function boxBlur3(buf, w, h, r) {
  let a = buf.slice(), b = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    blurH(a, b, w, h, r, 3); blurV(b, a, w, h, r, 3);
  }
  return a;
}
function boxBlurMask(m, w, h, r) {
  const a = m.slice(), b = new Float32Array(m.length);
  blurH(a, b, w, h, r, 1); blurV(b, a, w, h, r, 1);
  return a;
}
function blurH(src, dst, w, h, r, ch) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) for (let c = 0; c < ch; c++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(row + Math.min(w - 1, Math.max(0, k))) * ch + c];
    for (let x = 0; x < w; x++) {
      dst[(row + x) * ch + c] = acc * norm;
      acc += src[(row + Math.min(w - 1, x + r + 1)) * ch + c] - src[(row + Math.max(0, x - r)) * ch + c];
    }
  }
}
function blurV(src, dst, w, h, r, ch) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(Math.min(h - 1, Math.max(0, k)) * w + x) * ch + c];
    for (let y = 0; y < h; y++) {
      dst[(y * w + x) * ch + c] = acc * norm;
      acc += src[(Math.min(h - 1, y + r + 1) * w + x) * ch + c] - src[(Math.max(0, y - r) * w + x) * ch + c];
    }
  }
}
