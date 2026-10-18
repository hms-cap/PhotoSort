// Background removal for photos of people, using MediaPipe's image segmenter
// (runs in the browser; the model is downloaded once, ~16 MB, on first use).
import { makeCanvas } from './geometry.js';

const VERSION = '0.10.14';
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

let segPromise = null;

async function getSegmenter() {
  if (!segPromise) {
    segPromise = (async () => {
      const vision = await import(`${LIB}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
      return vision.ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    })().catch((e) => { segPromise = null; throw e; });
  }
  return segPromise;
}

// Returns a canvas (same aspect as img) whose alpha is the subject mask.
export async function personMask(img) {
  const seg = await getSegmenter();
  const long = Math.max(img.width, img.height);
  const k = Math.min(1, 1024 / long);
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const small = makeCanvas(w, h);
  small.getContext('2d').drawImage(img, 0, 0, w, h);

  const result = seg.segment(small);
  try {
    const masks = result.confidenceMasks;
    if (!masks?.length) throw new Error('No mask returned');
    const bgConf = masks[0].getAsFloat32Array(); // category 0 = background
    const mw = masks[0].width, mh = masks[0].height;
    const out = makeCanvas(mw, mh);
    const ctx = out.getContext('2d');
    const id = ctx.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) {
      // Sharpen the soft edge a little.
      let a = 1 - bgConf[i];
      a = Math.min(1, Math.max(0, (a - 0.25) / 0.5));
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255;
      id.data[i * 4 + 3] = Math.round(a * 255);
    }
    ctx.putImageData(id, 0, 0);
    let any = false;
    for (let i = 3; i < id.data.length; i += 4 * 97) if (id.data[i] > 128) { any = true; break; }
    if (!any) throw new Error('No person found in this photo. Background removal works on photos of people.');
    return out;
  } finally {
    result.close?.();
  }
}
