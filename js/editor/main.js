// Photo editor UI.
import { CONFIG } from '../config.js';
import * as auth from '../auth.js';
import * as drive from '../drive.js';
import { ADJUSTMENTS, ADJ_KEYS, PRESETS, ASPECTS, defaultState, clone, History, isEdited } from './state.js';
import { frameSize, imageToOutput, clampCrop, cropForAspect, cropFits, renderGeometry, makeCanvas } from './geometry.js';
import { Pipeline } from './pipeline.js';
import { ColorRenderer } from './gl.js';
import { FONTS, textBox } from './overlays.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DPR = () => window.devicePixelRatio || 1;

const COLORS = ['#ffffff', '#111111', '#f0c35a', '#e5534b', '#ff8a3d', '#2fbf71', '#3aa6ff', '#9b6bff', '#ff6fb5'];
const BG_COLORS = ['#ffffff', '#111111', '#f4efe6', '#dfe8f2', '#e9f5e6', '#f7e1e1', '#3aa6ff', '#2a2a2a'];

const E = {
  pipe: null,
  state: defaultState(),
  hist: null,
  tool: 'adjust',
  file: null,      // { name, source: 'local'|'drive'|'sample', id?, parents?, mime }
  folder: null,    // { id, name, items, index, resourceKey }
  view: { z: 1, ox: 0, oy: 0, user: false, rw: 0, rh: 0 },
  before: false,
  sel: null,       // selected text id
  retouchMode: 'heal', brush: 36,
  drawMode: 'pen', drawColor: '#ffffff', drawSize: 8,
  op: null,        // current pointer operation
  pointer: null,   // last hover position in stage px
  saved: true,
  format: 'jpeg',
};

/* ---------- utilities ---------- */

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function clientId() {
  try { return CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('photosort:clientId') || ''; }
  catch { return CONFIG.GOOGLE_CLIENT_ID || ''; }
}

function show(screen) {
  for (const id of ['screen-open', 'screen-loading', 'screen-folder', 'screen-edit']) $('#' + id).hidden = id !== screen;
  $('#e-top').hidden = screen !== 'screen-edit';
}

function setLoading(text) { $('#loading-text').textContent = text; show('screen-loading'); }

function openMsg(text, kind) {
  const m = $('#open-msg');
  m.hidden = !text;
  m.className = 'msg' + (kind === 'info' ? ' info' : '');
  m.innerHTML = text || '';
}

function busy(text) {
  $('#busy').hidden = !text;
  $('#busy-text').textContent = text || '';
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ---------- opening photos ---------- */

async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function confirmDiscard() {
  if (!E.pipe || E.saved || !isEdited(E.state)) return true;
  return confirm('You have unsaved edits. Discard them and open another photo?');
}

async function openBlob(blob, file) {
  setLoading('Opening photo…');
  let img;
  try {
    img = await decode(blob);
  } catch {
    const heic = /hei[cf]/i.test(blob.type) || /\.hei[cf]$/i.test(file.name || '');
    throw new Error(heic
      ? 'This browser can’t open HEIC photos. Open it in Safari, or convert it to JPEG first.'
      : 'Couldn’t read this file as an image.');
  }
  startEditing(img, file);
}

function startEditing(img, file) {
  try {
    E.pipe = new Pipeline(img);
  } catch (e) {
    show('screen-open');
    openMsg(esc(e.message));
    return;
  }
  E.file = file;
  E.state = defaultState();
  E.hist = new History(E.state);
  E.sel = null;
  E.saved = true;
  E.view.user = false;
  E.thumbKey = null;
  $('#e-name').textContent = file.name || 'Photo';
  updateMeta();
  $('#e-nav').hidden = !E.folder || file.source !== 'drive';
  updateFolderNav();
  show('screen-edit');
  setTool(E.tool === 'crop' ? 'adjust' : E.tool);
  syncPanel();
  updateHistButtons();
  requestRender();
}

function updateMeta() {
  if (!E.pipe) return;
  const { fw, fh } = frameSize(E.pipe.full.width, E.pipe.full.height, E.state);
  const w = Math.round(E.state.crop.w * fw), h = Math.round(E.state.crop.h * fh);
  const src = E.file.source === 'drive' ? 'Google Drive' : E.file.source === 'sample' ? 'Sample' : 'This device';
  $('#e-meta').textContent = `${w} × ${h}px · ${src}`;
}

async function openLocal(file) {
  if (!file) return;
  if (!confirmDiscard()) return;
  if (!/^image\//.test(file.type) && !/\.(hei[cf]|jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)) {
    openMsg('That doesn’t look like an image file.');
    return;
  }
  E.folder = null;
  setRoute('');
  try {
    await openBlob(file, { name: file.name, source: 'local', mime: file.type });
  } catch (e) {
    show('screen-open');
    openMsg(esc(e.message));
  }
}

async function ensureSignedIn() {
  const cid = clientId();
  if (!cid) { $('#setup').hidden = false; throw new Error('Add a Google OAuth Client ID first (see below).'); }
  if (!auth.hasToken()) await auth.signIn(cid);
}

function driveError(e) {
  if (e instanceof auth.AuthError) return e.message;
  if (e.status === 404) return 'Couldn’t find that file. Check the link, and that it’s shared with the Google account you signed in with.';
  if (e.status === 403) return 'You don’t have access to that file with this Google account.';
  return e.message || 'Something went wrong talking to Google Drive.';
}

async function openDriveLink(input) {
  const parsed = drive.parseFolderLink(input);
  if (!parsed) { openMsg('That doesn’t look like a Google Drive link.'); return; }
  if (!confirmDiscard()) return;
  openMsg('');
  try {
    await ensureSignedIn(); // must run inside the click
  } catch (e) {
    openMsg(esc(e.message));
    return;
  }
  await openDriveId(parsed.id, parsed.resourceKey);
}

async function openDriveId(id, resourceKey) {
  drive.addResourceKey(id, resourceKey);
  setLoading('Opening from Google Drive…');
  try {
    const f = await drive.getFile(id);
    drive.addResourceKey(f.id, f.resourceKey);
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await openFolder(f, resourceKey);
    } else if (/^image\//.test(f.mimeType)) {
      E.folder = null;
      await openDriveFile(f);
    } else {
      throw Object.assign(new Error('That link isn’t a photo or a folder.'), { status: 0 });
    }
  } catch (e) {
    show('screen-open');
    openMsg(esc(driveError(e)));
    if (e instanceof auth.AuthError) $('#auth-banner').hidden = true;
  }
}

async function openDriveFile(f) {
  setLoading(`Downloading ${f.name}…`);
  if (!f.parents) f = { ...f, ...(await drive.getFile(f.id).catch(() => ({}))) };
  let blob;
  try {
    blob = await drive.downloadFile(f.id);
  } catch (e) {
    if (e.status === 403 && f.thumbnailLink) blob = await thumbFallback(f);
    else throw e;
  }
  const file = { name: f.name, source: 'drive', id: f.id, parents: f.parents || [], mime: f.mimeType };
  setRoute(E.folder ? `#/folder/${E.folder.id}/${f.id}` : `#/file/${f.id}`, E.folder ? E.folder.resourceKey : f.resourceKey);
  try {
    await openBlob(blob, file);
  } catch (e) {
    // HEIC/RAW: fall back to Drive's own large preview.
    if (f.thumbnailLink) {
      const t = await thumbFallback(f).catch(() => null);
      if (t) { await openBlob(t, file); toast('Opened Drive’s preview of this file (the original format isn’t supported here).', 4500); return; }
    }
    throw e;
  }
}

async function thumbFallback(f) {
  const r = await fetch(drive.sizedThumb(f.thumbnailLink, 4096));
  if (!r.ok) throw new Error('Couldn’t download this photo.');
  return r.blob();
}

async function openFolder(f, resourceKey) {
  setLoading(`Listing ${f.name}…`);
  const items = await drive.listImages(f.id, (n) => setLoading(`Listing ${f.name}… ${n} photos`));
  if (!items.length) throw Object.assign(new Error('There are no photos in that folder.'), { status: 0 });
  E.folder = { id: f.id, name: f.name, items, index: -1, resourceKey };
  setRoute(`#/folder/${f.id}`, resourceKey);
  renderFolder();
}

function renderFolder() {
  const F = E.folder;
  $('#f-name').textContent = F.name;
  $('#f-meta').textContent = `${F.items.length} photo${F.items.length === 1 ? '' : 's'} · choose one to edit`;
  const grid = $('#f-grid');
  grid.innerHTML = '';
  F.items.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'f-item';
    b.title = p.path + p.name;
    b.innerHTML = `<img loading="lazy" alt="" referrerpolicy="no-referrer"><span>${esc(p.name)}</span>`;
    if (p.thumbnailLink) $('img', b).src = drive.sizedThumb(p.thumbnailLink, 400);
    b.addEventListener('click', () => openFolderItem(i));
    grid.appendChild(b);
  });
  show('screen-folder');
}

async function openFolderItem(i) {
  const F = E.folder;
  if (!F || !F.items[i]) return;
  if (E.pipe && F.index !== i && !confirmDiscard()) return;
  F.index = i;
  try {
    await openDriveFile(F.items[i]);
  } catch (e) {
    toast(driveError(e), 4000);
    if (E.pipe && E.file) show('screen-edit'); else renderFolder();
  }
}

function updateFolderNav() {
  const F = E.folder;
  if (!F) return;
  $('#e-prev').disabled = F.index <= 0;
  $('#e-next').disabled = F.index >= F.items.length - 1;
}

function setRoute(hash, rk) {
  const h = hash ? hash + (rk ? `?rk=${encodeURIComponent(rk)}` : '') : '';
  try { history.replaceState(null, '', location.pathname + location.search + h); } catch { /* sandboxed */ }
}

function sampleImage() {
  // A generated landscape so the editor can be tried without a photo.
  const w = 1800, h = 1200;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#5f87b8'); sky.addColorStop(0.6, '#e9b58a'); sky.addColorStop(1, '#f3d2a2');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff3d6'; g.beginPath(); g.arc(w * 0.68, h * 0.5, 70, 0, Math.PI * 2); g.fill();
  const hill = (y, amp, col, seed) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 10) g.lineTo(x, y + Math.sin(x / 210 + seed) * amp + Math.sin(x / 67 + seed * 2) * amp * 0.25);
    g.lineTo(w, h); g.fill();
  };
  hill(h * 0.6, 40, '#6d6a7a', 1); hill(h * 0.68, 34, '#4c5a4d', 2); hill(h * 0.8, 26, '#2f3d2c', 3);
  g.fillStyle = 'rgba(70,110,150,.55)'; g.fillRect(0, h * 0.88, w, h * 0.12);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const id = g.getImageData(0, 0, w, h);
  for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * 14; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
  g.putImageData(id, 0, 0);
  // a few "dust spots" to try healing on
  g.fillStyle = 'rgba(30,25,20,.75)';
  for (const [x, y, r] of [[420, 260, 9], [1220, 180, 7], [900, 330, 6]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  return c;
}

/* ---------- rendering ---------- */

let raf = 0;
function requestRender() { if (!raf) raf = requestAnimationFrame(doRender); }

function doRender() {
  raf = 0;
  if (!E.pipe) return;
  const crop = E.tool === 'crop';
  let c;
  try {
    c = E.before ? beforeImage() : E.pipe.render(E.state, { fullFrame: crop, skip: null });
  } catch (e) {
    console.error(e);
    toast('Rendering failed: ' + e.message);
    return;
  }
  const view = $('#view');
  if (view.width !== c.width || view.height !== c.height) {
    view.width = c.width; view.height = c.height;
  }
  const ctx = view.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(c, 0, 0);
  if (E.view.rw !== c.width || E.view.rh !== c.height) {
    E.view.rw = c.width; E.view.rh = c.height;
    E.view.user = false;
  }
  layoutView();
}

function beforeImage() {
  return E.pipe.work;
}

function stageSize() {
  const r = $('#stage').getBoundingClientRect();
  return { sw: r.width, sh: r.height };
}

function fitScale() {
  const { sw, sh } = stageSize();
  const pad = E.tool === 'crop' ? 36 : 20;
  return Math.min((sw - pad * 2) / E.view.rw, (sh - pad * 2) / E.view.rh);
}

function layoutView() {
  const V = E.view;
  if (!V.rw) return;
  const { sw, sh } = stageSize();
  if (!V.user) {
    V.z = fitScale();
    V.ox = (sw - V.rw * V.z) / 2;
    V.oy = (sh - V.rh * V.z) / 2;
  } else {
    // keep the image reachable
    const w = V.rw * V.z, h = V.rh * V.z;
    V.ox = w <= sw ? (sw - w) / 2 : Math.min(40, Math.max(sw - w - 40, V.ox));
    V.oy = h <= sh ? (sh - h) / 2 : Math.min(40, Math.max(sh - h - 40, V.oy));
  }
  const view = $('#view');
  view.style.width = V.rw * V.z + 'px';
  view.style.height = V.rh * V.z + 'px';
  view.style.transform = `translate(${V.ox}px, ${V.oy}px)`;
  const pct = Math.round(V.z * 100 * (E.pipe ? E.pipe.full.width / E.pipe.work.width : 1));
  $('#z-fit').textContent = V.user ? pct + '%' : 'Fit';
  drawOverlay();
}

function zoomAt(factor, px, py) {
  const V = E.view;
  const fit = fitScale();
  const z = Math.min(Math.max(fit * 0.5, V.z * factor), Math.max(fit, 8));
  if (z === V.z) return;
  const { sw, sh } = stageSize();
  px ??= sw / 2; py ??= sh / 2;
  V.ox = px - (px - V.ox) * (z / V.z);
  V.oy = py - (py - V.oy) * (z / V.z);
  V.z = z;
  V.user = Math.abs(z - fit) > 1e-3;
  layoutView();
}

// Stage px → rendered image px.
function toImg(px, py) {
  const V = E.view;
  return [(px - V.ox) / V.z, (py - V.oy) / V.z];
}
function toScreen(x, y) {
  const V = E.view;
  return [V.ox + x * V.z, V.oy + y * V.z];
}

/* ---------- overlay (crop frame, selection, brush) ---------- */

function drawOverlay() {
  const cv = $('#overlay');
  const { sw, sh } = stageSize();
  const d = DPR();
  if (cv.width !== Math.round(sw * d) || cv.height !== Math.round(sh * d)) {
    cv.width = Math.round(sw * d); cv.height = Math.round(sh * d);
  }
  const g = cv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, sw, sh);
  if (!E.pipe || E.before) return;

  if (E.tool === 'crop') {
    const r = cropScreenRect();
    g.fillStyle = 'rgba(0,0,0,.6)';
    g.beginPath();
    g.rect(0, 0, sw, sh);
    g.rect(r.x, r.y, r.w, r.h);
    g.fill('evenodd');
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1;
    g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      g.moveTo(r.x + (r.w * i) / 3, r.y); g.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      g.moveTo(r.x, r.y + (r.h * i) / 3); g.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 3.5; g.lineCap = 'round';
    const L = Math.min(22, r.w / 3, r.h / 3);
    g.beginPath();
    for (const [cx, cy, sx, sy] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1]]) {
      g.moveTo(cx, cy + sy * L); g.lineTo(cx, cy); g.lineTo(cx + sx * L, cy);
    }
    for (const [mx, my, horiz] of [[r.x + r.w / 2, r.y, 1], [r.x + r.w / 2, r.y + r.h, 1], [r.x, r.y + r.h / 2, 0], [r.x + r.w, r.y + r.h / 2, 0]]) {
      if (horiz) { g.moveTo(mx - 10, my); g.lineTo(mx + 10, my); } else { g.moveTo(mx, my - 10); g.lineTo(mx, my + 10); }
    }
    g.stroke();
    return;
  }

  if (E.tool === 'text' && E.sel) {
    const t = E.state.texts.find((x) => x.id === E.sel);
    if (t) {
      const b = textBox(measureCtx(), t, E.view.rw, E.view.rh);
      const [x0, y0] = toScreen(b.x, b.y);
      g.setLineDash([5, 4]);
      g.strokeStyle = '#f0c35a'; g.lineWidth = 1.5;
      g.strokeRect(x0 - 4, y0 - 4, b.w * E.view.z + 8, b.h * E.view.z + 8);
      g.setLineDash([]);
    }
  }

  if (E.op?.kind === 'retouch') {
    g.strokeStyle = E.retouchMode === 'heal' ? 'rgba(240,195,90,.45)' : 'rgba(110,168,254,.45)';
    g.lineWidth = E.brush; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    E.op.screen.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (E.op.screen.length === 1) g.lineTo(E.op.screen[0][0] + 0.1, E.op.screen[0][1]);
    g.stroke();
  }

  if (E.pointer && (E.tool === 'retouch' || E.tool === 'draw')) {
    const size = E.tool === 'retouch' ? E.brush : E.drawMode === 'eraser' ? Math.max(16, E.drawSize * 2) : E.drawSize;
    const [x, y] = E.pointer;
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.beginPath(); g.arc(x, y, size / 2 + 1, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.beginPath(); g.arc(x, y, size / 2, 0, Math.PI * 2); g.stroke();
  }
}

let mctx;
function measureCtx() {
  mctx ??= makeCanvas(4, 4).getContext('2d');
  return mctx;
}

/* ---------- crop ---------- */

function frame() {
  return frameSize(E.pipe.work.width, E.pipe.work.height, E.state);
}

function cropScreenRect() {
  const { fw, fh } = frame();
  const c = E.state.crop;
  const [x, y] = toScreen(c.x * fw, c.y * fh);
  return { x, y, w: c.w * fw * E.view.z, h: c.h * fh * E.view.z };
}

function aspectRatio() {
  const a = ASPECTS.find((x) => x.id === E.state.aspect) || ASPECTS[0];
  if (!a.ratio) return null;
  const { fw, fh } = frame();
  let r = a.ratio === 'orig' ? fw / fh : a.ratio;
  if (a.ratio !== 'orig' && r !== 1) r = fw >= fh ? Math.max(r, 1 / r) : Math.min(r, 1 / r);
  if (E.state.aspectPortrait) r = 1 / r;
  return r;
}

function hitCrop(px, py) {
  const r = cropScreenRect();
  const T = 18;
  const nearL = Math.abs(px - r.x) < T, nearR = Math.abs(px - (r.x + r.w)) < T;
  const nearT = Math.abs(py - r.y) < T, nearB = Math.abs(py - (r.y + r.h)) < T;
  const inX = px > r.x - T && px < r.x + r.w + T, inY = py > r.y - T && py < r.y + r.h + T;
  let h = '';
  if (nearT && inX) h += 'n'; else if (nearB && inX) h += 's';
  if (nearL && inY) h += 'w'; else if (nearR && inY) h += 'e';
  if (h) return h;
  if (px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h) return 'move';
  return null;
}

function dragCrop(op, px, py) {
  const { fw, fh } = frame();
  const deg = E.state.straighten;
  const s = op.start; // px rect in frame space
  const [ix, iy] = toImg(px, py);
  const [sx, sy] = toImg(op.sx, op.sy);
  const dx = ix - sx, dy = iy - sy;
  const ratio = aspectRatio();
  let { x, y, w, h } = s;
  const MIN = 24 / E.view.z;
  const tryRect = (r) => {
    const n = { x: r.x / fw, y: r.y / fh, w: r.w / fw, h: r.h / fh };
    if (n.w <= 0 || n.h <= 0) return false;
    if (n.x < -1e-6 || n.y < -1e-6 || n.x + n.w > 1 + 1e-6 || n.y + n.h > 1 + 1e-6) return false;
    if (!cropFits(n, fw, fh, deg)) return false;
    E.state.crop = { x: Math.max(0, n.x), y: Math.max(0, n.y), w: Math.min(1, n.w), h: Math.min(1, n.h) };
    return true;
  };

  if (op.handle === 'move') {
    let nx = Math.min(fw - w, Math.max(0, x + dx)), ny = Math.min(fh - h, Math.max(0, y + dy));
    if (!tryRect({ x: nx, y: ny, w, h })) {
      if (!tryRect({ x: nx, y, w, h })) tryRect({ x, y: ny, w, h });
    }
    return;
  }
  const H = op.handle;
  let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  if (H.includes('w')) x0 = Math.min(x1 - MIN, x + dx);
  if (H.includes('e')) x1 = Math.max(x0 + MIN, x + w + dx);
  if (H.includes('n')) y0 = Math.min(y1 - MIN, y + dy);
  if (H.includes('s')) y1 = Math.max(y0 + MIN, y + h + dy);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(fw, x1); y1 = Math.min(fh, y1);
  let nw = x1 - x0, nh = y1 - y0;
  if (ratio) {
    if (H.length === 2) {
      if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
      if (H.includes('w')) x0 = x1 - nw; else x1 = x0 + nw;
      if (H.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
    } else if (H === 'e' || H === 'w') {
      nh = nw / ratio; const cy = y + h / 2; y0 = cy - nh / 2; y1 = cy + nh / 2;
    } else {
      nw = nh * ratio; const cx = x + w / 2; x0 = cx - nw / 2; x1 = cx + nw / 2;
    }
  }
  // If the new rect doesn't fit (straightened corners or frame edge), shrink toward the anchor.
  const target = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (tryRect(target)) return;
  const ax = H.includes('w') ? s.x + s.w : H.includes('e') ? s.x : s.x + s.w / 2;
  const ay = H.includes('n') ? s.y + s.h : H.includes('s') ? s.y : s.y + s.h / 2;
  let lo = 0, hi = 1;
  const lerp = (t) => {
    const r = {
      x: ax + (target.x - ax) * t, y: ay + (target.y - ay) * t,
      w: 0, h: 0,
    };
    const ex = ax + (target.x + target.w - ax) * t, ey = ay + (target.y + target.h - ay) * t;
    r.w = ex - r.x; r.h = ey - r.y;
    if (!H.includes('w') && !H.includes('e') && !ratio) { r.x = s.x; r.w = s.w; }
    if (!H.includes('n') && !H.includes('s') && !ratio) { r.y = s.y; r.h = s.h; }
    return r;
  };
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const r = lerp(t);
    const n = { x: r.x / fw, y: r.y / fh, w: r.w / fw, h: r.h / fh };
    if (r.w > MIN && r.h > MIN && n.x >= -1e-6 && n.y >= -1e-6 && n.x + n.w <= 1 + 1e-6 && n.y + n.h <= 1 + 1e-6 && cropFits(n, fw, fh, deg)) lo = t; else hi = t;
  }
  if (lo > 0) tryRect(lerp(lo));
}

function rotate(dir) {
  const s = E.state;
  const c = s.crop;
  if (dir > 0) s.crop = { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w };
  else s.crop = { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
  s.rot = (s.rot + (dir > 0 ? 1 : 3)) % 4;
  if (s.flipH !== s.flipV) { s.flipH = !s.flipH; s.flipV = !s.flipV; }
  // Text/drawings follow the frame.
  commitGeometry();
}

function flip(horizontal) {
  const s = E.state;
  const c = s.crop;
  if (horizontal) { s.flipH = !s.flipH; s.crop = { ...c, x: 1 - (c.x + c.w) }; }
  else { s.flipV = !s.flipV; s.crop = { ...c, y: 1 - (c.y + c.h) }; }
  s.straighten = -s.straighten;
  commitGeometry();
}

function commitGeometry() {
  const { fw, fh } = frame();
  E.state.crop = clampCrop(E.state.crop, fw, fh, E.state.straighten);
  commit();
  syncPanel();
  requestRender();
}

function setAspect(id) {
  const s = E.state;
  if (s.aspect === id && id !== 'free') { s.aspectPortrait = !s.aspectPortrait; }
  else { s.aspect = id; s.aspectPortrait = false; }
  const { fw, fh } = frame();
  s.crop = cropForAspect(id === 'free' ? s.crop : { x: 0, y: 0, w: 1, h: 1 }, fw, fh, aspectRatio(), s.straighten);
  commit();
  syncPanel();
  requestRender();
}

/* ---------- auto enhance ---------- */

function autoEnhance() {
  const base = renderGeometry(E.pipe.retouchedWork(E.state), E.state, Math.min(1, 256 / Math.max(E.pipe.work.width, E.pipe.work.height)));
  const d = base.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, base.width, base.height).data;
  const hist = new Uint32Array(256);
  let n = 0, satSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    hist[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    satSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    n++;
  }
  if (!n) return;
  const pct = (p) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * p) return i / 255; } return 1; };
  const lo = pct(0.005), hi = pct(0.995), med = pct(0.5);
  const sat = satSum / n;
  const a = {};
  for (const k of ADJ_KEYS) a[k] = 0;
  a.blacks = -Math.round(Math.min(60, Math.max(0, (lo - 0.01) / 0.12 * 100)));
  a.whites = Math.round(Math.min(60, Math.max(0, (0.99 - hi) / 0.16 * 100)));
  const bp = -(a.blacks / 100) * 0.12;
  const wp = 1 - (a.whites / 100) * 0.16;
  const m2 = Math.min(0.95, Math.max(0.02, (med - bp) / (wp - bp)));
  a.exposure = Math.round(Math.max(-45, Math.min(45, (Math.log2(Math.pow(0.46 / m2, 2.2)) / 1.6) * 100 * 0.6)));
  a.shadows = med < 0.35 ? 18 : 6;
  a.highlights = hi > 0.97 ? -18 : -6;
  a.contrast = hi - lo < 0.75 ? 12 : 4;
  a.vibrance = sat < 0.25 ? 22 : 10;
  E.state.adj = a;
  commit();
  syncPanel();
  requestRender();
  toast('Auto enhance applied — fine-tune with the sliders.');
}

/* ---------- history ---------- */

function commit() {
  if (E.hist.push(E.state)) { E.saved = false; updateHistButtons(); }
  updateMeta();
}

function updateHistButtons() {
  $('#e-undo').disabled = !E.hist?.canUndo;
  $('#e-redo').disabled = !E.hist?.canRedo;
}

function undo() {
  if (!E.hist?.canUndo) return;
  E.state = E.hist.undo();
  afterHistory();
}
function redo() {
  if (!E.hist?.canRedo) return;
  E.state = E.hist.redo();
  afterHistory();
}
function afterHistory() {
  if (E.sel && !E.state.texts.some((t) => t.id === E.sel)) E.sel = null;
  E.saved = false;
  updateHistButtons();
  updateMeta();
  syncPanel();
  requestRender();
}

/* ---------- panel ---------- */

function buildPanel() {
  // Adjust sliders
  const wrap = $('#a-sliders');
  for (const g of ADJUSTMENTS) {
    const t = document.createElement('div');
    t.className = 'group-title';
    t.textContent = g.group;
    wrap.appendChild(t);
    for (const it of g.items) {
      const d = document.createElement('div');
      d.className = 'sl' + (it.min < 0 ? ' center' : '');
      d.innerHTML = `<label><span title="Double-click to reset">${it.label}</span><output>0</output></label>
        <input type="range" min="${it.min}" max="${it.max}" step="1" value="0" data-adj="${it.key}" aria-label="${it.label}">`;
      const input = $('input', d);
      input.addEventListener('input', () => { E.state.adj[it.key] = +input.value; syncSlider(d, +input.value); requestRender(); });
      input.addEventListener('change', commit);
      $('span', d).addEventListener('dblclick', () => { E.state.adj[it.key] = 0; commit(); syncPanel(); requestRender(); });
      wrap.appendChild(d);
    }
  }
  $('#a-auto').addEventListener('click', autoEnhance);
  $('#a-reset').addEventListener('click', () => {
    for (const k of ADJ_KEYS) E.state.adj[k] = 0;
    commit(); syncPanel(); requestRender();
  });

  // Crop
  const asp = $('#c-aspects');
  for (const a of ASPECTS) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.dataset.aspect = a.id;
    b.addEventListener('click', () => setAspect(a.id));
    asp.appendChild(b);
  }
  $('#c-orient').addEventListener('click', () => {
    if (E.state.aspect === 'free' || E.state.aspect === '1:1') return;
    setAspect(E.state.aspect);
  });
  $('#c-rotl').addEventListener('click', () => rotate(-1));
  $('#c-rotr').addEventListener('click', () => rotate(1));
  $('#c-fliph').addEventListener('click', () => flip(true));
  $('#c-flipv').addEventListener('click', () => flip(false));
  let strBase = null;
  const str = $('#c-str');
  str.addEventListener('input', () => {
    strBase ??= { ...E.state.crop, deg: E.state.straighten };
    E.state.straighten = +str.value;
    const { fw, fh } = frame();
    E.state.crop = clampCrop(strBase, fw, fh, E.state.straighten);
    $('#c-str-v').textContent = (+str.value).toFixed(1) + '°';
    requestRender();
  });
  str.addEventListener('change', () => { strBase = null; commit(); });
  $('#c-str-v').closest('label').querySelector('span').addEventListener('dblclick', () => {
    E.state.straighten = 0; commitGeometry();
  });
  $('#c-reset').addEventListener('click', () => {
    Object.assign(E.state, { rot: 0, flipH: false, flipV: false, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free', aspectPortrait: false });
    commit(); syncPanel(); requestRender();
  });

  // Filters
  const pg = $('#p-grid');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.preset = p.id;
    b.innerHTML = `<canvas width="120" height="120"></canvas><span>${p.name}</span>`;
    b.addEventListener('click', () => {
      E.state.preset = p.id;
      if (p.id !== 'none' && !E.state.presetStrength) E.state.presetStrength = 100;
      commit(); syncPanel(); requestRender();
    });
    pg.appendChild(b);
  }
  const ps = $('#p-str');
  ps.addEventListener('input', () => { E.state.presetStrength = +ps.value; $('#p-str-v').textContent = ps.value; requestRender(); });
  ps.addEventListener('change', commit);

  // Retouch
  seg('#r-mode', (m) => { E.retouchMode = m; });
  const rs = $('#r-size');
  rs.addEventListener('input', () => { E.brush = +rs.value; $('#r-size-v').textContent = rs.value + 'px'; drawOverlay(); });
  $('#r-size-v').textContent = rs.value + 'px';
  $('#r-clear').addEventListener('click', () => { E.state.retouch = []; commit(); requestRender(); });

  // Draw
  seg('#d-mode', (m) => { E.drawMode = m; });
  const ds = $('#d-size');
  ds.addEventListener('input', () => { E.drawSize = +ds.value; $('#d-size-v').textContent = ds.value + 'px'; drawOverlay(); });
  $('#d-size-v').textContent = ds.value + 'px';
  swatches('#d-colors', COLORS, () => E.drawColor, (c) => { E.drawColor = c; if (E.drawMode === 'eraser') { E.drawMode = 'pen'; syncSeg('#d-mode', 'pen'); } });
  $('#d-clear').addEventListener('click', () => { E.state.strokes = []; commit(); requestRender(); });

  // Text
  const fs = $('#t-font');
  for (const f of FONTS) fs.add(new Option(f.label, f.id));
  $('#t-add').addEventListener('click', addText);
  const upd = (fn, doCommit = true) => {
    const t = selText();
    if (!t) return;
    fn(t);
    if (doCommit) commit();
    syncText();
    requestRender();
  };
  let textTimer;
  $('#t-text').addEventListener('input', (e) => {
    upd((t) => { t.text = e.target.value; }, false);
    clearTimeout(textTimer);
    textTimer = setTimeout(commit, 700);
  });
  fs.addEventListener('change', () => upd((t) => { t.font = fs.value; }));
  const tsz = $('#t-size');
  tsz.addEventListener('input', () => upd((t) => { t.size = +tsz.value / 100; }, false));
  tsz.addEventListener('change', commit);
  $$('#t-style button').forEach((b) => b.addEventListener('click', () => upd((t) => {
    if (b.dataset.k === 'weight') t.weight = (t.weight || 700) >= 600 ? 400 : 700;
    else t.italic = !t.italic;
  })));
  $$('#t-align button').forEach((b) => b.addEventListener('click', () => upd((t) => { t.align = b.dataset.a; })));
  swatches('#t-colors', COLORS, () => selText()?.color, (c) => upd((t) => { t.color = c; }));
  $('#t-shadow').addEventListener('change', (e) => upd((t) => { t.shadow = e.target.checked; }));
  $('#t-outline').addEventListener('change', (e) => upd((t) => { t.outline = e.target.checked ? (isLight(t.color) ? '#111111' : '#ffffff') : null; }));
  $('#t-bg').addEventListener('change', (e) => upd((t) => { t.bg = e.target.checked ? (isLight(t.color) ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.85)') : null; }));
  $('#t-del').addEventListener('click', deleteText);

  // Background
  $('#b-detect').addEventListener('click', detectBackground);
  $('#b-on').addEventListener('change', (e) => { E.state.bg.on = e.target.checked; commit(); syncPanel(); requestRender(); });
  seg('#b-mode', (m) => { E.state.bg.mode = m; commit(); syncPanel(); requestRender(); });
  swatches('#b-colors', BG_COLORS, () => E.state.bg.color, (c) => { E.state.bg.color = c; E.state.bg.mode = 'color'; commit(); syncPanel(); requestRender(); });
  const bb = $('#b-blur');
  bb.addEventListener('input', () => { E.state.bg.blur = +bb.value; $('#b-blur-v').textContent = bb.value; requestRender(); });
  bb.addEventListener('change', commit);

  // Tabs
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
}

function seg(sel, onPick) {
  $$(sel + ' button').forEach((b) => b.addEventListener('click', () => {
    syncSeg(sel, b.dataset.mode);
    onPick(b.dataset.mode);
    drawOverlay();
  }));
}
function syncSeg(sel, mode) {
  $$(sel + ' button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
}

function swatches(sel, colors, get, set) {
  const w = $(sel);
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.style.background = c;
    b.dataset.c = c;
    b.title = c;
    b.addEventListener('click', () => { set(c); syncSwatches(sel, get()); });
    w.appendChild(b);
  }
  const custom = document.createElement('label');
  custom.className = 'sw sw-custom';
  custom.title = 'Custom color';
  custom.innerHTML = '<input type="color">';
  const inp = $('input', custom);
  inp.addEventListener('input', () => { set(inp.value); syncSwatches(sel, get()); });
  w.appendChild(custom);
  w._get = get;
}
function syncSwatches(sel, cur) {
  let found = false;
  $$(sel + ' .sw[data-c]').forEach((b) => { const on = b.dataset.c === cur; b.classList.toggle('on', on); found ||= on; });
  const custom = $(sel + ' .sw-custom');
  if (custom) custom.classList.toggle('on', !found && !!cur);
}

function isLight(c) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(c || '');
  if (!m) return true;
  return 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) > 150;
}

function syncSlider(d, v) {
  const o = $('output', d);
  o.textContent = v > 0 && $('input', d).min < 0 ? '+' + v : String(v);
  o.classList.toggle('changed', v !== 0);
}

function syncPanel() {
  const s = E.state;
  for (const input of $$('#a-sliders input')) {
    const v = Math.round(s.adj[input.dataset.adj] || 0);
    input.value = v;
    syncSlider(input.closest('.sl'), v);
  }
  $('#c-str').value = s.straighten;
  $('#c-str-v').textContent = (+s.straighten).toFixed(1) + '°';
  $$('#c-aspects button').forEach((b) => b.classList.toggle('on', b.dataset.aspect === s.aspect));
  $$('#p-grid .preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === s.preset));
  $('#p-str').value = s.presetStrength;
  $('#p-str-v').textContent = s.presetStrength;
  $('#p-str').closest('.sl').hidden = s.preset === 'none';
  // background
  const hasMask = !!E.pipe?.mask;
  $('#b-opts').hidden = !hasMask;
  $('#b-detect').hidden = hasMask;
  $('#b-on').checked = s.bg.on;
  syncSeg('#b-mode', s.bg.mode);
  $('#b-color-wrap').hidden = s.bg.mode !== 'color';
  $('#b-blur-wrap').hidden = s.bg.mode !== 'blur';
  $('#b-blur').value = s.bg.blur;
  $('#b-blur-v').textContent = s.bg.blur;
  syncSwatches('#b-colors', s.bg.color);
  syncSwatches('#d-colors', E.drawColor);
  syncText();
  if (E.tool === 'filters') renderPresetThumbs();
}

/* ---------- filters ---------- */

let thumbGl = null;
function renderPresetThumbs() {
  if (!E.pipe) return;
  const key = JSON.stringify([E.state.rot, E.state.flipH, E.state.flipV, E.state.straighten, E.state.crop, E.state.adj, E.state.retouch.length, E.file?.name]);
  if (key === E.thumbKey) return;
  E.thumbKey = key;
  try {
    thumbGl ??= new ColorRenderer();
  } catch { return; }
  const src = E.pipe.retouchedWork(E.state);
  const { fw, fh } = frame();
  const c = E.state.crop;
  const long = Math.max(c.w * fw, c.h * fh);
  const geo = renderGeometry(src, E.state, 180 / long);
  // centre-square crop for the tile
  const side = Math.min(geo.width, geo.height);
  const sq = makeCanvas(side, side);
  sq.getContext('2d').drawImage(geo, (geo.width - side) / 2, (geo.height - side) / 2, side, side, 0, 0, side, side);
  thumbGl.setSource(sq);
  for (const b of $$('#p-grid .preset')) {
    const st = { ...E.state, preset: b.dataset.preset, presetStrength: 100 };
    const out = thumbGl.render(st);
    const cv = $('canvas', b);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(out, 0, 0, cv.width, cv.height);
  }
}

/* ---------- text ---------- */

const selText = () => E.state.texts.find((t) => t.id === E.sel) || null;

function addText() {
  const t = {
    id: 't' + Date.now().toString(36),
    text: 'Your text', x: 0.5, y: 0.5, size: 0.07, color: '#ffffff', font: 'sans',
    weight: 700, italic: false, align: 'center', bg: null, shadow: true, outline: null,
  };
  E.state.texts.push(t);
  E.sel = t.id;
  commit();
  syncText();
  requestRender();
  const ta = $('#t-text');
  ta.focus();
  ta.select();
}

function deleteText() {
  if (!E.sel) return;
  E.state.texts = E.state.texts.filter((t) => t.id !== E.sel);
  E.sel = null;
  commit();
  syncText();
  requestRender();
}

function syncText() {
  const t = selText();
  $('#t-edit').hidden = !t;
  if (!t) { drawOverlay(); return; }
  if (document.activeElement !== $('#t-text')) $('#t-text').value = t.text;
  $('#t-font').value = t.font;
  $('#t-size').value = (t.size * 100).toFixed(1);
  $('#t-size-v').textContent = (t.size * 100).toFixed(0);
  $('#t-style [data-k=weight]').classList.toggle('on', (t.weight || 700) >= 600);
  $('#t-style [data-k=italic]').classList.toggle('on', !!t.italic);
  $$('#t-align button').forEach((b) => b.classList.toggle('on', b.dataset.a === (t.align || 'center')));
  $('#t-shadow').checked = !!t.shadow;
  $('#t-outline').checked = !!t.outline;
  $('#t-bg').checked = !!t.bg;
  syncSwatches('#t-colors', t.color);
  drawOverlay();
}

function hitText(px, py) {
  const [ix, iy] = toImg(px, py);
  const m = measureCtx();
  const pad = 8 / E.view.z;
  for (let i = E.state.texts.length - 1; i >= 0; i--) {
    const t = E.state.texts[i];
    const b = textBox(m, t, E.view.rw, E.view.rh);
    if (ix >= b.x - pad && ix <= b.x + b.w + pad && iy >= b.y - pad && iy <= b.y + b.h + pad) return t;
  }
  return null;
}

/* ---------- background ---------- */

async function detectBackground() {
  if (!E.pipe) return;
  busy('Finding the subject…');
  try {
    const { personMask } = await import('./segment.js');
    E.pipe.mask = await personMask(E.pipe.retouchedWork(E.state));
    E.state.bg.on = true;
    commit();
    syncPanel();
    requestRender();
  } catch (e) {
    console.error(e);
    toast(/person/i.test(e.message) ? e.message : 'Background removal failed: ' + (e.message || 'could not load the model'), 5000);
  } finally {
    busy('');
  }
}

/* ---------- tools ---------- */

function setTool(t) {
  const was = E.tool;
  E.tool = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t !== 'text') E.sel = null;
  $('#stage').style.cursor = t === 'retouch' || t === 'draw' ? 'none' : '';
  if (was === 'crop' || t === 'crop') E.view.user = false;
  if (t === 'filters') renderPresetThumbs();
  syncText();
  requestRender();
}

/* ---------- pointer input on the stage ---------- */

const pointers = new Map();

function stagePt(e) {
  const r = $('#stage').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function outNorm(px, py) {
  const [ix, iy] = toImg(px, py);
  return [ix / E.view.rw, iy / E.view.rh];
}

// Stage point → normalised ORIGINAL-image coordinates (for retouching).
function srcNorm(px, py) {
  const [ix, iy] = toImg(px, py);
  const w = E.pipe.work.width, h = E.pipe.work.height;
  const m = imageToOutput(w, h, E.state, 1).inverse();
  const p = m.transformPoint(new DOMPoint(ix, iy));
  return [p.x / w, p.y / h];
}

let spaceDown = false;

function onPointerDown(e) {
  if (!E.pipe || E.before) return;
  const ov = $('#overlay');
  ov.setPointerCapture(e.pointerId);
  const [px, py] = stagePt(e);
  pointers.set(e.pointerId, [px, py]);

  if (pointers.size === 2) {
    // Second finger: switch to pinch, abandon any stroke in progress.
    if (E.op && (E.op.kind === 'draw')) { E.state.strokes.pop(); requestRender(); }
    const [a, b] = [...pointers.values()];
    E.op = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: E.view.z, ox0: E.view.ox, oy0: E.view.oy, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (pointers.size > 2) return;

  if (e.button === 1 || spaceDown) { E.op = { kind: 'pan', sx: px, sy: py, ox: E.view.ox, oy: E.view.oy }; return; }
  if (e.button === 2) return;

  if (E.tool === 'crop') {
    const h = hitCrop(px, py);
    if (h) {
      const { fw, fh } = frame();
      const c = E.state.crop;
      E.op = { kind: 'crop', handle: h, sx: px, sy: py, start: { x: c.x * fw, y: c.y * fh, w: c.w * fw, h: c.h * fh } };
      return;
    }
  } else if (E.tool === 'retouch') {
    E.op = { kind: 'retouch', pts: [srcNorm(px, py)], screen: [[px, py]] };
    drawOverlay();
    return;
  } else if (E.tool === 'draw') {
    if (E.drawMode === 'eraser') {
      E.op = { kind: 'erase', removed: false };
      eraseAt(px, py);
    } else {
      const long = Math.max(E.view.rw, E.view.rh);
      const marker = E.drawMode === 'marker';
      const s = { color: E.drawColor, size: (E.drawSize * (marker ? 2 : 1)) / E.view.z / long, alpha: marker ? 0.4 : 1, pts: [outNorm(px, py)] };
      E.state.strokes.push(s);
      E.op = { kind: 'draw', stroke: s };
      requestRender();
    }
    return;
  } else if (E.tool === 'text') {
    const t = hitText(px, py);
    if (t) {
      E.sel = t.id;
      E.op = { kind: 'text', t, sx: px, sy: py, x0: t.x, y0: t.y, moved: false };
      syncText();
      return;
    }
    if (E.sel) { E.sel = null; syncText(); }
  }
  // Default: pan when zoomed in.
  if (E.view.user) E.op = { kind: 'pan', sx: px, sy: py, ox: E.view.ox, oy: E.view.oy };
}

function onPointerMove(e) {
  const [px, py] = stagePt(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [px, py]);
  E.pointer = e.pointerType === 'touch' && !pointers.size ? null : [px, py];
  const op = E.op;
  if (!op) {
    if (E.tool === 'crop' && E.pipe) {
      const h = hitCrop(px, py);
      const cur = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };
      $('#overlay').style.cursor = cur[h] || (E.view.user ? 'grab' : '');
    } else if (E.tool === 'text' && E.pipe) {
      $('#overlay').style.cursor = hitText(px, py) ? 'move' : '';
    } else {
      $('#overlay').style.cursor = E.view.user && E.tool !== 'retouch' && E.tool !== 'draw' ? 'grab' : '';
    }
    if (E.tool === 'retouch' || E.tool === 'draw') drawOverlay();
    return;
  }
  switch (op.kind) {
    case 'pinch': {
      const [a, b] = [...pointers.values()];
      if (!b) return;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const fit = fitScale();
      const z = Math.min(Math.max(fit * 0.5, op.z0 * (d / op.d0)), Math.max(fit, 8));
      E.view.ox = m[0] - (op.m0[0] - op.ox0) * (z / op.z0);
      E.view.oy = m[1] - (op.m0[1] - op.oy0) * (z / op.z0);
      E.view.z = z;
      E.view.user = true;
      layoutView();
      break;
    }
    case 'pan':
      E.view.ox = op.ox + (px - op.sx);
      E.view.oy = op.oy + (py - op.sy);
      E.view.user = true;
      layoutView();
      break;
    case 'crop':
      dragCrop(op, px, py);
      drawOverlay();
      break;
    case 'retouch': {
      const last = op.screen.at(-1);
      if (Math.hypot(px - last[0], py - last[1]) < 2) break;
      op.screen.push([px, py]);
      op.pts.push(srcNorm(px, py));
      drawOverlay();
      break;
    }
    case 'draw': {
      const n = outNorm(px, py);
      const l = op.stroke.pts.at(-1);
      if (Math.hypot((n[0] - l[0]) * E.view.rw, (n[1] - l[1]) * E.view.rh) * E.view.z < 1.5) break;
      op.stroke.pts.push(n);
      requestRender();
      break;
    }
    case 'erase':
      eraseAt(px, py);
      drawOverlay();
      break;
    case 'text': {
      const dx = (px - op.sx) / E.view.z / E.view.rw, dy = (py - op.sy) / E.view.z / E.view.rh;
      if (Math.abs(px - op.sx) + Math.abs(py - op.sy) > 2) op.moved = true;
      op.t.x = Math.min(1, Math.max(0, op.x0 + dx));
      op.t.y = Math.min(1, Math.max(0, op.y0 + dy));
      requestRender();
      break;
    }
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  const op = E.op;
  if (!op) return;
  if (op.kind === 'pinch') { if (pointers.size === 0) E.op = null; return; }
  E.op = null;
  switch (op.kind) {
    case 'crop': commit(); requestRender(); break;
    case 'retouch': {
      const long = Math.max(E.pipe.work.width, E.pipe.work.height);
      // brush px on screen → image px; the work image is the render at scale 1 (ignoring crop scale)
      const r = (E.brush / 2) / E.view.z / long;
      E.state.retouch.push({ kind: E.retouchMode, r, pts: op.pts.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]) });
      busy(E.retouchMode === 'heal' ? 'Healing…' : '');
      setTimeout(() => { commit(); doRender(); busy(''); drawOverlay(); }, 16);
      break;
    }
    case 'draw':
      op.stroke.pts = op.stroke.pts.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
      commit();
      break;
    case 'erase': if (op.removed) commit(); break;
    case 'text': if (op.moved) commit(); syncText(); break;
  }
}

function eraseAt(px, py) {
  const [ix, iy] = toImg(px, py);
  const rr = Math.max(16, E.drawSize * 2) / 2 / E.view.z;
  const long = Math.max(E.view.rw, E.view.rh);
  const before = E.state.strokes.length;
  E.state.strokes = E.state.strokes.filter((s) => !s.pts.some(([x, y]) =>
    Math.hypot(x * E.view.rw - ix, y * E.view.rh - iy) < rr + (s.size * long) / 2));
  if (E.state.strokes.length !== before) { E.op.removed = true; requestRender(); }
}

/* ---------- export ---------- */

function fullOutputSize() {
  const { fw, fh } = frameSize(E.pipe.full.width, E.pipe.full.height, E.state);
  return { w: Math.round(E.state.crop.w * fw), h: Math.round(E.state.crop.h * fh) };
}

function baseName() {
  const n = (E.file?.name || 'photo').replace(/\.[^.]+$/, '');
  return `${n}-edited`;
}

function openExport() {
  if (!E.pipe) return;
  const transparent = E.state.bg.on && E.pipe.mask && E.state.bg.mode === 'transparent';
  if (transparent && E.format === 'jpeg') E.format = 'png';
  if (!$('#x-name').value || $('#x-name').dataset.for !== E.file.name) {
    $('#x-name').value = baseName();
    $('#x-name').dataset.for = E.file.name;
  }
  const { w, h } = fullOutputSize();
  const long = Math.max(w, h);
  const sel = $('#x-size');
  const prev = sel.value;
  sel.innerHTML = '';
  const opt = (v, label) => sel.add(new Option(label, v));
  opt('1', `Original · ${w} × ${h}`);
  for (const L of [4096, 3000, 2048, 1600, 1080]) {
    if (L < long) { const k = L / long; opt(String(k), `${L}px · ${Math.round(w * k)} × ${Math.round(h * k)}`); }
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  syncExport();
  const fromDrive = E.file.source === 'drive' && E.file.parents?.length;
  $('#x-dest-wrap').hidden = !fromDrive;
  $('#x-dest-root').hidden = !!fromDrive;
  $('#x-result').hidden = true;
  $('#export').hidden = false;
}

function syncExport() {
  $$('#x-format button').forEach((b) => b.classList.toggle('on', b.dataset.f === E.format));
  $('#x-q-wrap').hidden = E.format === 'png';
  $('#x-q-v').textContent = $('#x-q').value;
  const transparent = E.state.bg.on && E.pipe?.mask && E.state.bg.mode === 'transparent';
  const note = $('#x-note');
  note.hidden = !(transparent && E.format === 'jpeg');
  note.textContent = 'JPEG can’t store transparency — the removed background will be white. Choose PNG or WebP to keep it transparent.';
}

async function renderExportBlob() {
  const scale = +$('#x-size').value || 1;
  const canvas = await E.pipe.renderFull(E.state, scale);
  let out = canvas;
  if (E.format === 'jpeg') {
    // flatten any transparency onto white
    out = makeCanvas(canvas.width, canvas.height);
    const g = out.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
  }
  const mime = `image/${E.format}`;
  const q = +$('#x-q').value / 100;
  const blob = await new Promise((res) => out.toBlob(res, mime, q));
  requestRender();
  if (!blob) throw new Error('Your browser couldn’t create the image file.');
  if (blob.type !== mime) E.format = blob.type.split('/')[1] || 'png'; // e.g. Safari without WebP encoding
  return blob;
}

function fileName(blob) {
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp' }[blob.type.split('/')[1]] || 'jpg';
  const n = ($('#x-name').value.trim() || baseName()).replace(/[\\/:*?"<>|]+/g, '-').replace(/\.(jpe?g|png|webp)$/i, '');
  return `${n}.${ext}`;
}

async function doDownload() {
  const btn = $('#x-download');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const blob = await renderExportBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    E.saved = true;
    showResult(`Downloaded <b>${esc(a.download)}</b>.`);
  } catch (e) {
    showResult(esc(e.message), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download';
  }
}

async function doDriveSave() {
  const btn = $('#x-drive');
  try {
    await ensureSignedIn();
    $('#auth-banner').hidden = true;
  } catch (e) {
    showResult(esc(e.message), true);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const blob = await renderExportBlob();
    let parent = null, where = 'My Drive';
    const sameFolder = !$('#x-dest-wrap').hidden && $('input[name=x-dest]:checked').value === 'same';
    if (sameFolder) {
      const p = await drive.canAddTo(E.file.parents[0]);
      if (p) { parent = p.id; where = p.name; }
      else toast('You can’t add files to the original folder, so it was saved to My Drive.', 4500);
    }
    const r = await drive.uploadFile(blob, fileName(blob), parent);
    E.saved = true;
    showResult(`Saved <b>${esc(r.name)}</b> to <b>${esc(where)}</b>. <a href="${esc(r.webViewLink || `https://drive.google.com/file/d/${r.id}/view`)}" target="_blank" rel="noopener">Open in Drive</a>`);
  } catch (e) {
    if (e instanceof auth.AuthError) $('#auth-banner').hidden = false;
    showResult(esc(driveError(e)), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save to Google Drive';
  }
}

function showResult(html, warn) {
  const r = $('#x-result');
  r.hidden = false;
  r.className = 'r-result' + (warn ? ' warn' : '');
  r.innerHTML = html;
}

/* ---------- binding ---------- */

function bind() {
  buildPanel();

  // Open screen
  $('#file').addEventListener('change', (e) => { openLocal(e.target.files[0]); e.target.value = ''; });
  const drop = $('#drop');
  for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type) || /\.hei[cf]$/i.test(x.name));
    if (f) openLocal(f);
  });
  window.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (item) { e.preventDefault(); openLocal(item.getAsFile()); }
  });
  $('#drive-form').addEventListener('submit', (e) => { e.preventDefault(); openDriveLink($('#link').value); });
  $('#save-cid').addEventListener('click', () => {
    const v = $('#cid').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) { openMsg('That doesn’t look like an OAuth Client ID (it ends in .apps.googleusercontent.com).'); return; }
    try { localStorage.setItem('photosort:clientId', v); } catch { /* ignore */ }
    $('#setup').hidden = true;
    openMsg('Saved. Paste a Drive link and press Open.', 'info');
    auth.loadGis().catch(() => {});
  });
  $('#btn-sample').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    E.folder = null;
    setRoute('');
    startEditing(sampleImage(), { name: 'sample.jpg', source: 'sample', mime: 'image/jpeg' });
  });
  $('#f-back').addEventListener('click', () => { E.folder = null; setRoute(''); show('screen-open'); });

  // Top bar
  $('#e-open').addEventListener('click', () => { if (confirmDiscard()) { E.saved = true; setRoute(''); show('screen-open'); } });
  $('#e-folder').addEventListener('click', () => { if (E.folder && confirmDiscard()) { E.saved = true; setRoute(`#/folder/${E.folder.id}`, E.folder.resourceKey); renderFolder(); } });
  $('#e-prev').addEventListener('click', () => E.folder && openFolderItem(E.folder.index - 1));
  $('#e-next').addEventListener('click', () => E.folder && openFolderItem(E.folder.index + 1));
  $('#e-undo').addEventListener('click', undo);
  $('#e-redo').addEventListener('click', redo);
  $('#e-reset').addEventListener('click', () => {
    if (!isEdited(E.state)) return;
    E.state = defaultState();
    E.sel = null;
    commit(); syncPanel(); requestRender();
    toast('All edits reset — Undo brings them back.');
  });
  const before = $('#e-before');
  const setBefore = (on) => { if (E.before === on) return; E.before = on; before.classList.toggle('on', on); requestRender(); };
  before.addEventListener('pointerdown', (e) => { e.preventDefault(); setBefore(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) before.addEventListener(ev, () => setBefore(false));
  $('#e-export').addEventListener('click', openExport);
  $('#btn-reconnect').addEventListener('click', async () => {
    try { await auth.signIn(clientId()); $('#auth-banner').hidden = true; toast('Reconnected'); } catch (e) { toast(e.message); }
  });

  // Export dialog
  $('#x-close').addEventListener('click', () => { $('#export').hidden = true; });
  $('#export').addEventListener('click', (e) => { if (e.target.id === 'export') $('#export').hidden = true; });
  $$('#x-format button').forEach((b) => b.addEventListener('click', () => { E.format = b.dataset.f; syncExport(); }));
  $('#x-q').addEventListener('input', syncExport);
  $('#x-download').addEventListener('click', doDownload);
  $('#x-drive').addEventListener('click', doDriveSave);

  // Stage
  const ov = $('#overlay');
  ov.addEventListener('pointerdown', onPointerDown);
  ov.addEventListener('pointermove', onPointerMove);
  ov.addEventListener('pointerup', onPointerUp);
  ov.addEventListener('pointercancel', onPointerUp);
  ov.addEventListener('pointerleave', () => { if (!E.op) { E.pointer = null; drawOverlay(); } });
  ov.addEventListener('contextmenu', (e) => e.preventDefault());
  ov.addEventListener('dblclick', (e) => {
    if (E.tool === 'text') {
      const [px, py] = stagePt(e);
      if (!hitText(px, py)) {
        addText();
        const t = selText();
        [t.x, t.y] = outNorm(px, py);
        commit();
        requestRender();
      }
      return;
    }
    if (E.tool === 'adjust' || E.tool === 'filters' || E.tool === 'bg') {
      if (E.view.user) { E.view.user = false; layoutView(); } else { const [px, py] = stagePt(e); zoomAt(2.5 / (E.view.z / fitScale()) , px, py); }
    }
  });
  $('#stage').addEventListener('wheel', (e) => {
    if (!E.pipe) return;
    e.preventDefault();
    const [px, py] = stagePt(e);
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), px, py);
    }
  }, { passive: false });
  $('#z-in').addEventListener('click', () => zoomAt(1.4));
  $('#z-out').addEventListener('click', () => zoomAt(1 / 1.4));
  $('#z-fit').addEventListener('click', () => { E.view.user = false; layoutView(); });
  new ResizeObserver(() => { if (E.pipe) layoutView(); }).observe($('#stage'));

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if ($('#screen-edit').hidden) return;
    const typing = e.target.closest?.('input[type=text], input:not([type]), textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing && e.target.id === 't-text') return; e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openExport(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (!$('#export').hidden) { $('#export').hidden = true; return; }
      if (E.sel) { E.sel = null; syncText(); }
      return;
    }
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
    if (e.key === '\\') { setBefore(true); return; }
    if (e.key === '0') { E.view.user = false; layoutView(); return; }
    if (e.key === '+' || e.key === '=') { zoomAt(1.4); return; }
    if (e.key === '-') { zoomAt(1 / 1.4); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel) { e.preventDefault(); deleteText(); return; }
    if (e.key === '[' || e.key === ']') {
      const d = e.key === ']' ? 1.2 : 1 / 1.2;
      if (E.tool === 'retouch') { E.brush = Math.round(Math.min(160, Math.max(4, E.brush * d))); $('#r-size').value = E.brush; $('#r-size-v').textContent = E.brush + 'px'; }
      if (E.tool === 'draw') { E.drawSize = Math.round(Math.min(80, Math.max(1, E.drawSize * d))); $('#d-size').value = E.drawSize; $('#d-size-v').textContent = E.drawSize + 'px'; }
      drawOverlay();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') spaceDown = false;
    if (e.key === '\\') setBefore(false);
  });
  window.addEventListener('beforeunload', (e) => {
    if (E.pipe && !E.saved && isEdited(E.state)) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---------- boot ---------- */

function boot() {
  bind();
  $('#setup').hidden = true;
  if (clientId()) auth.loadGis().catch(() => {});
  const h = location.hash;
  const m = h.match(/^#\/(file|folder)\/([\w-]+)(?:\/([\w-]+))?(?:\?rk=([^&]+))?/);
  if (m) {
    const [, kind, id, child, rk] = m;
    const resourceKey = rk ? decodeURIComponent(rk) : null;
    $('#link').value = kind === 'folder'
      ? `https://drive.google.com/drive/folders/${id}${resourceKey ? `?resourcekey=${resourceKey}` : ''}`
      : `https://drive.google.com/file/d/${id}/view${resourceKey ? `?resourcekey=${resourceKey}` : ''}`;
    if (auth.hasToken() && clientId()) {
      openDriveId(id, resourceKey).then(() => {
        if (child && E.folder) {
          const i = E.folder.items.findIndex((p) => p.id === child);
          if (i >= 0) openFolderItem(i);
        }
      });
      return;
    }
    openMsg('Press <b>Open</b> to sign in with Google and load this photo.', 'info');
  }
  show('screen-open');
}

boot();
