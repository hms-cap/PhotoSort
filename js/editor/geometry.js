// Geometry: quarter-turn rotation, flips, straighten and crop.
//
// The "frame" is the image after quarter turns + flips (so it has the rotated
// image's size). Straightening rotates the image inside that frame about its
// centre; the crop rectangle is axis-aligned in the frame, normalised 0..1.

export function frameSize(w, h, s) {
  return s.rot % 2 ? { fw: h, fh: w } : { fw: w, fh: h };
}

// Maps image pixels (of an image w×h) to frame pixels.
export function imageToFrame(w, h, s) {
  const { fw, fh } = frameSize(w, h, s);
  return new DOMMatrix()
    .translateSelf(fw / 2, fh / 2)
    .rotateSelf(s.straighten || 0)
    .scaleSelf(s.flipH ? -1 : 1, s.flipV ? -1 : 1)
    .rotateSelf(s.rot * 90)
    .translateSelf(-w / 2, -h / 2);
}

// Output (cropped) size in pixels for an image w×h at the given scale.
export function outputSize(w, h, s, scale = 1) {
  const { fw, fh } = frameSize(w, h, s);
  return {
    ow: Math.max(1, Math.round(s.crop.w * fw * scale)),
    oh: Math.max(1, Math.round(s.crop.h * fh * scale)),
  };
}

// Maps image pixels to output pixels.
export function imageToOutput(w, h, s, scale = 1, crop = s.crop) {
  const { fw, fh } = frameSize(w, h, s);
  return new DOMMatrix()
    .scaleSelf(scale, scale)
    .translateSelf(-crop.x * fw, -crop.y * fh)
    .multiplySelf(imageToFrame(w, h, s));
}

// Draws img (any size) with the geometry applied into a new canvas.
// fullFrame: ignore the crop and draw the whole straightened frame (crop tool).
export function renderGeometry(img, s, scale = 1, { fullFrame = false, smoothing = 'high' } = {}) {
  const w = img.width, h = img.height;
  const crop = fullFrame ? { x: 0, y: 0, w: 1, h: 1 } : s.crop;
  const { fw, fh } = frameSize(w, h, s);
  const ow = Math.max(1, Math.round(crop.w * fw * scale));
  const oh = Math.max(1, Math.round(crop.h * fh * scale));
  const c = makeCanvas(ow, oh);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = smoothing;
  ctx.setTransform(imageToOutput(w, h, s, scale, crop));
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ---------- crop constraints ---------- */

// Is frame point (px) inside the straightened image?
function inside(x, y, fw, fh, deg) {
  const a = (-deg * Math.PI) / 180;
  const dx = x - fw / 2, dy = y - fh / 2;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  const e = 0.5;
  return Math.abs(rx) <= fw / 2 + e && Math.abs(ry) <= fh / 2 + e;
}

export function cropFits(r, fw, fh, deg) {
  return rectFits(r, fw, fh, deg);
}

function rectFits(r, fw, fh, deg) {
  const x0 = r.x * fw, y0 = r.y * fh, x1 = (r.x + r.w) * fw, y1 = (r.y + r.h) * fh;
  return inside(x0, y0, fw, fh, deg) && inside(x1, y0, fw, fh, deg) &&
    inside(x0, y1, fw, fh, deg) && inside(x1, y1, fw, fh, deg);
}

// Keeps a crop inside the frame and inside the straightened image, shrinking it
// about its centre (keeping its aspect) only when necessary.
export function clampCrop(crop, fw, fh, deg) {
  let r = { ...crop };
  r.w = Math.min(1, Math.max(0.02, r.w));
  r.h = Math.min(1, Math.max(0.02, r.h));
  r.x = Math.min(1 - r.w, Math.max(0, r.x));
  r.y = Math.min(1 - r.h, Math.max(0, r.y));
  if (!deg || rectFits(r, fw, fh, deg)) return r;

  // Pull the centre toward the middle until it is safely inside, then scale.
  let cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  for (let i = 0; i < 30 && !rectFits({ x: cx - 0.01, y: cy - 0.01, w: 0.02, h: 0.02 }, fw, fh, deg); i++) {
    cx = 0.5 + (cx - 0.5) * 0.8; cy = 0.5 + (cy - 0.5) * 0.8;
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2;
    const t = { x: cx - (r.w * k) / 2, y: cy - (r.h * k) / 2, w: r.w * k, h: r.h * k };
    if (rectFits(t, fw, fh, deg)) lo = k; else hi = k;
  }
  return { x: cx - (r.w * lo) / 2, y: cy - (r.h * lo) / 2, w: r.w * lo, h: r.h * lo };
}

// Largest crop with the given pixel aspect (w/h) centred on the current crop.
export function cropForAspect(crop, fw, fh, ratio, deg) {
  if (!ratio) return clampCrop(crop, fw, fh, deg);
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  let wpx = fw, hpx = wpx / ratio;
  if (hpx > fh) { hpx = fh; wpx = hpx * ratio; }
  const w = wpx / fw, h = hpx / fh;
  const r = { x: cx - w / 2, y: cy - h / 2, w, h };
  r.x = Math.min(1 - w, Math.max(0, r.x));
  r.y = Math.min(1 - h, Math.max(0, r.y));
  return clampCrop(r, fw, fh, deg);
}
