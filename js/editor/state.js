// Edit state: everything needed to re-render a photo from its original.
// Edits are non-destructive — the original is never changed.

export const ADJUSTMENTS = [
  { group: 'Light', items: [
    { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
    { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
    { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
    { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
    { key: 'whites', label: 'Whites', min: -100, max: 100 },
    { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  ] },
  { group: 'Color', items: [
    { key: 'temperature', label: 'Warmth', min: -100, max: 100 },
    { key: 'tint', label: 'Tint', min: -100, max: 100 },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
    { key: 'hue', label: 'Hue shift', min: -100, max: 100 },
  ] },
  { group: 'Detail & effects', items: [
    { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
    { key: 'sharpness', label: 'Sharpness', min: 0, max: 100 },
    { key: 'fade', label: 'Fade', min: 0, max: 100 },
    { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
    { key: 'grain', label: 'Grain', min: 0, max: 100 },
  ] },
];
export const ADJ_KEYS = ADJUSTMENTS.flatMap((g) => g.items.map((i) => i.key));

// Filter looks: offsets added on top of the user's own adjustments, scaled by strength.
// mono: 0..1 black & white; sepia: 0..1; split: [shadowRGB, highlightRGB, amount].
export const PRESETS = [
  { id: 'none', name: 'Original', adj: {} },
  { id: 'vivid', name: 'Vivid', adj: { contrast: 18, saturation: 22, vibrance: 25, clarity: 12 } },
  { id: 'bright', name: 'Bright', adj: { exposure: 18, shadows: 25, highlights: -15, vibrance: 10 } },
  { id: 'warm', name: 'Warm', adj: { temperature: 35, tint: 6, vibrance: 8 } },
  { id: 'cool', name: 'Cool', adj: { temperature: -32, tint: -4, contrast: 6 } },
  { id: 'golden', name: 'Golden', adj: { temperature: 28, highlights: -10, shadows: 10, saturation: 8 },
    split: [[0.45, 0.32, 0.2], [1.0, 0.82, 0.5], 0.22] },
  { id: 'teal', name: 'Teal & Orange', adj: { contrast: 14, saturation: 8, clarity: 8 },
    split: [[0.1, 0.42, 0.48], [1.0, 0.65, 0.35], 0.32] },
  { id: 'film', name: 'Film', adj: { fade: 22, contrast: -6, saturation: -10, temperature: 8, grain: 22 },
    split: [[0.2, 0.3, 0.35], [1.0, 0.92, 0.78], 0.18] },
  { id: 'matte', name: 'Matte', adj: { fade: 35, contrast: -12, saturation: -8, shadows: 10 } },
  { id: 'vintage', name: 'Vintage', adj: { fade: 25, saturation: -25, temperature: 22, vignette: 30, grain: 18 },
    sepia: 0.25 },
  { id: 'soft', name: 'Soft', adj: { contrast: -18, highlights: -18, clarity: -25, exposure: 6, saturation: -5 } },
  { id: 'dramatic', name: 'Dramatic', adj: { contrast: 35, clarity: 40, highlights: -30, shadows: -10, saturation: -12, vignette: 30 } },
  { id: 'mono', name: 'Mono', adj: { contrast: 10 }, mono: 1 },
  { id: 'noir', name: 'Noir', adj: { contrast: 45, clarity: 25, blacks: -25, vignette: 35, grain: 12 }, mono: 1 },
  { id: 'silver', name: 'Silver', adj: { contrast: -10, fade: 18, highlights: -20 }, mono: 1 },
  { id: 'sepia', name: 'Sepia', adj: { contrast: 6, fade: 10 }, mono: 1, sepia: 0.9 },
];
export const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

export const ASPECTS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'orig', label: 'Original', ratio: 'orig' },
  { id: '1:1', label: 'Square', ratio: 1 },
  { id: '4:5', label: '4:5 · 8×10', ratio: 4 / 5 },
  { id: '5:7', label: '5×7', ratio: 5 / 7 },
  { id: '2:3', label: '2:3 · 4×6', ratio: 2 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
];

export function defaultState() {
  const adj = {};
  for (const k of ADJ_KEYS) adj[k] = 0;
  return {
    // Geometry. rot: quarter turns clockwise; straighten: degrees.
    // crop is normalised (0..1) in the straightened frame, which has the size of the rotated image.
    rot: 0, flipH: false, flipV: false, straighten: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    aspect: 'free', aspectPortrait: null,
    adj,
    preset: 'none', presetStrength: 100,
    // Retouch strokes, in normalised ORIGINAL-image coordinates: { kind: 'heal'|'blur', r, pts: [[x,y]...] }.
    retouch: [],
    // Drawings, normalised to the final (cropped) frame: { color, size, alpha, pts: [[x,y]...] }.
    strokes: [],
    // Text boxes, normalised to the final frame: { id, text, x, y, size, color, font, weight, align, bg, shadow }.
    texts: [],
    // Background removal.
    bg: { on: false, mode: 'transparent', color: '#ffffff', blur: 60 },
  };
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// Undo/redo of whole-state snapshots (states are small; strokes are point lists).
export class History {
  constructor(initial, limit = 80) {
    this.stack = [JSON.stringify(initial)];
    this.i = 0;
    this.limit = limit;
  }
  push(state) {
    const s = JSON.stringify(state);
    if (s === this.stack[this.i]) return false;
    this.stack.length = this.i + 1;
    this.stack.push(s);
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
    return true;
  }
  get canUndo() { return this.i > 0; }
  get canRedo() { return this.i < this.stack.length - 1; }
  undo() { if (this.canUndo) this.i--; return JSON.parse(this.stack[this.i]); }
  redo() { if (this.canRedo) this.i++; return JSON.parse(this.stack[this.i]); }
  current() { return JSON.parse(this.stack[this.i]); }
}

export function isEdited(s) {
  return JSON.stringify(s) !== JSON.stringify(defaultState());
}
