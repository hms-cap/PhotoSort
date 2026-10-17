// Perceptual "difference hash" + average colour, computed in the browser from
// small thumbnails, and a sequential grouping of similar shots.

const canvas = document.createElement('canvas');
canvas.width = 9;
canvas.height = 8;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

// Returns a 22-char hex string: 64-bit dHash + RGB average.
export async function computeHash(src) {
  const img = await loadImage(src);
  ctx.clearRect(0, 0, 9, 8);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, 9, 8);
  let data;
  try {
    data = ctx.getImageData(0, 0, 9, 8).data;
  } catch {
    const err = new Error('Image is not readable (CORS)');
    err.cors = true;
    throw err;
  }
  const gray = new Float32Array(72);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < 72; i++) {
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    gray[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    r += R; g += G; b += B;
  }
  let hi = 0, lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = gray[y * 9 + x] < gray[y * 9 + x + 1] ? 1 : 0;
      const n = y * 8 + x;
      if (n < 32) hi = (hi | (bit << n)) >>> 0; else lo = (lo | (bit << (n - 32))) >>> 0;
    }
  }
  return hex8(hi) + hex8(lo) + hex2(r / 72) + hex2(g / 72) + hex2(b / 72);
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Hamming distance of the dHash plus a small penalty for colour/exposure change.
export function distance(a, b) {
  const d = popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) +
            popcount((parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0);
  let c = 0;
  for (let i = 16; i < 22; i += 2) c += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
  return d + (c / (3 * 255)) * 24;
}

// Walks photos in shooting order; a photo joins the current stack when it looks
// like one of the stack's last few shots and wasn't taken long after.
// threshold 0 = no stacking. Returns [{ id, items: [photo...] }].
export function groupPhotos(photos, hashes, { threshold = 12, maxGapSec = 120, burstSec = 2 } = {}) {
  const groups = [];
  let cur = null;
  const belongs = (p, g) => {
    const last = g.items[g.items.length - 1];
    const timed = p.time != null && last.time != null;
    const dt = timed ? Math.abs(p.time - last.time) / 1000 : null;
    if (timed && dt > maxGapSec) return false;
    const hp = hashes[p.id];
    let best = Infinity;
    if (hp) {
      for (const m of g.items.slice(-3)) {
        const hm = hashes[m.id];
        if (hm) best = Math.min(best, distance(hp, hm));
      }
    }
    if (best !== Infinity) return best <= threshold;
    return timed && dt <= burstSec; // no visual data: fall back to burst timing
  };
  for (const p of photos) {
    if (cur && threshold > 0 && belongs(p, cur)) cur.items.push(p);
    else { cur = { id: p.id, items: [p] }; groups.push(cur); }
  }
  return groups;
}
