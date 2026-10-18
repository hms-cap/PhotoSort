// WebGL2 colour pipeline: light, colour, detail, looks, vignette and grain in one pass.
import { presetById, ADJ_KEYS } from './state.js';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_texel, u_size;
uniform float u_lod, u_sharpR, u_grainScale;
uniform float u_exposure, u_brightness, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_sat, u_vib, u_hue;
uniform float u_clarity, u_sharp, u_fade, u_vignette, u_grain;
uniform float u_mono, u_sepia, u_split;
uniform vec3 u_splitS, u_splitH;
in vec2 v_uv;
out vec4 o;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec4 src = texture(u_src, v_uv);
  float a = src.a;
  vec3 c = a > 0.0 ? src.rgb / a : src.rgb;

  if (u_sharp > 0.0) {
    vec2 d = u_texel * u_sharpR;
    vec3 b = (texture(u_src, v_uv + vec2(d.x, 0.0)).rgb + texture(u_src, v_uv - vec2(d.x, 0.0)).rgb +
              texture(u_src, v_uv + vec2(0.0, d.y)).rgb + texture(u_src, v_uv - vec2(0.0, d.y)).rgb) * 0.25;
    c += (c - b) * u_sharp * 1.8;
  }
  if (u_clarity != 0.0) {
    vec2 d = u_texel * exp2(u_lod) * 0.6;
    vec3 m = (textureLod(u_src, v_uv + vec2(d.x, d.y), u_lod).rgb + textureLod(u_src, v_uv + vec2(-d.x, d.y), u_lod).rgb +
              textureLod(u_src, v_uv + vec2(d.x, -d.y), u_lod).rgb + textureLod(u_src, v_uv - d, u_lod).rgb) * 0.25;
    float lc = luma(c), lm = luma(m);
    float w = 1.0 - pow(abs(lc * 2.0 - 1.0), 2.0);
    c += (lc - lm) * u_clarity * 1.1 * w;
  }
  c = clamp(c, 0.0, 1.0);

  // Exposure and white balance in linear light.
  vec3 lin = pow(c, vec3(2.2));
  lin *= exp2(u_exposure * 1.6);
  vec3 wb = vec3(1.0 + u_temp * 0.22 + u_tint * 0.07, 1.0 + u_temp * 0.02 - u_tint * 0.16, 1.0 - u_temp * 0.24 + u_tint * 0.07);
  lin *= wb / luma(wb);
  c = pow(max(lin, 0.0), vec3(1.0 / 2.2));

  // Highlights recover anything pushed over 1.
  float L = luma(c);
  float hMask = smoothstep(0.45, 1.0, L);
  float sMask = 1.0 - smoothstep(0.0, 0.55, L);
  c += (u_highlights * 0.32 * hMask) + (u_shadows * 0.3 * sMask);
  c = max(c, 0.0);

  // Levels: whites / blacks.
  float bp = -u_blacks * 0.12;
  float wp = 1.0 - u_whites * 0.16;
  c = (c - bp) / (wp - bp);
  c = clamp(c, 0.0, 1.0);

  // Brightness: midtone gamma.
  c = pow(c, vec3(exp2(-u_brightness * 0.75)));

  // Contrast: S-curve.
  float k = u_contrast;
  if (k > 0.0) { c = mix(c, c * c * (3.0 - 2.0 * c), k); c = (c - 0.5) * (1.0 + 0.3 * k) + 0.5; }
  else if (k < 0.0) { c = mix(c, 0.5 + (c - 0.5) * 0.5, -k); }
  c = clamp(c, 0.0, 1.0);

  if (u_hue != 0.0) c = clamp(hueRotate(c, u_hue * 3.14159265), 0.0, 1.0);

  // Saturation & vibrance.
  L = luma(c);
  float s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float sat = 1.0 + u_sat + u_vib * (1.0 - s) * 0.9;
  c = clamp(mix(vec3(L), c, max(sat, 0.0)), 0.0, 1.0);

  // Split toning.
  if (u_split > 0.0) {
    L = luma(c);
    c += (u_splitS - luma(u_splitS)) * u_split * (1.0 - L) * 0.7 + (u_splitH - luma(u_splitH)) * u_split * L * 0.7;
  }
  L = luma(c);
  c = mix(c, vec3(L), u_mono);
  vec3 sep = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  c = mix(c, sep, u_sepia);

  // Fade (matte blacks).
  c = c * (1.0 - u_fade * 0.2) + u_fade * 0.11;

  // Vignette.
  if (u_vignette != 0.0) {
    float m = max(u_size.x, u_size.y);
    vec2 p = (v_uv - 0.5) * 2.0 * u_size / m;
    float v = smoothstep(0.3, 1.3, length(p) * 1.15);
    if (u_vignette > 0.0) c *= 1.0 - u_vignette * v * 0.85;
    else c = mix(c, vec3(1.0), -u_vignette * v * 0.8);
  }
  if (u_grain > 0.0) {
    vec2 gp = floor(v_uv * u_size / u_grainScale);
    float n = hash(gp) + hash(gp + 17.0) - 1.0;
    L = luma(c);
    c += n * u_grain * 0.11 * (1.0 - abs(L * 2.0 - 1.0) * 0.6);
  }
  c = clamp(c, 0.0, 1.0);
  o = vec4(c * a, a);
}`;

const UNIFORMS = ['u_src', 'u_texel', 'u_size', 'u_lod', 'u_sharpR', 'u_grainScale', 'u_exposure', 'u_brightness',
  'u_contrast', 'u_highlights', 'u_shadows', 'u_whites', 'u_blacks', 'u_temp', 'u_tint', 'u_sat', 'u_vib', 'u_hue',
  'u_clarity', 'u_sharp', 'u_fade', 'u_vignette', 'u_grain', 'u_mono', 'u_sepia', 'u_split', 'u_splitS', 'u_splitH'];

// Combined effect of the user's sliders and the chosen look (scaled by its strength).
export function effective(state) {
  const p = presetById(state.preset);
  const k = (state.presetStrength ?? 100) / 100;
  const adj = {};
  for (const key of ADJ_KEYS) adj[key] = (state.adj[key] || 0) + (p.adj[key] || 0) * k;
  return {
    adj,
    mono: (p.mono || 0) * k,
    sepia: (p.sepia || 0) * k,
    split: p.split ? [p.split[0], p.split[1], p.split[2] * k] : [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0],
  };
}

export function isIdentity(state) {
  const e = effective(state);
  return Object.values(e.adj).every((v) => Math.abs(v) < 1e-6) && !e.mono && !e.sepia && !e.split[2];
}

export class ColorRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('This browser does not support WebGL2, which the editor needs.');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of UNIFORMS) this.u[n] = gl.getUniformLocation(prog, n);
    this.tex = gl.createTexture();
    this.srcW = 0; this.srcH = 0;
  }

  setSource(img) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcW = img.width; this.srcH = img.height;
  }

  // Renders the current source with the state's colour settings at the source's size.
  render(state) {
    const gl = this.gl, u = this.u;
    const w = this.srcW, h = this.srcH;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const e = effective(state);
    const A = e.adj;
    const long = Math.max(w, h);
    gl.uniform1i(u.u_src, 0);
    gl.uniform2f(u.u_texel, 1 / w, 1 / h);
    gl.uniform2f(u.u_size, w, h);
    gl.uniform1f(u.u_lod, Math.max(0, Math.log2(long * 0.012)));
    gl.uniform1f(u.u_sharpR, Math.max(1, long / 2200));
    gl.uniform1f(u.u_grainScale, Math.max(1, long / 1400));
    const f = (n, v) => gl.uniform1f(u[n], v);
    f('u_exposure', A.exposure / 100); f('u_brightness', A.brightness / 100); f('u_contrast', A.contrast / 100);
    f('u_highlights', A.highlights / 100); f('u_shadows', A.shadows / 100); f('u_whites', A.whites / 100);
    f('u_blacks', A.blacks / 100); f('u_temp', A.temperature / 100); f('u_tint', A.tint / 100);
    f('u_sat', A.saturation / 100); f('u_vib', A.vibrance / 100); f('u_hue', A.hue / 100);
    f('u_clarity', A.clarity / 100); f('u_sharp', A.sharpness / 100); f('u_fade', A.fade / 100);
    f('u_vignette', A.vignette / 100); f('u_grain', A.grain / 100);
    f('u_mono', Math.min(1, e.mono)); f('u_sepia', Math.min(1, e.sepia)); f('u_split', e.split[2]);
    gl.uniform3fv(u.u_splitS, e.split[0]);
    gl.uniform3fv(u.u_splitH, e.split[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
