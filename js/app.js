import { CONFIG } from './config.js';
import * as auth from './auth.js';
import * as drive from './drive.js';
import { Session, getRecent, touchRecent, forgetRecent, prefs } from './store.js';
import { computeHash, groupPhotos } from './similarity.js';
import { makeDemoPhotos } from './demo.js';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const bucket = (px, sizes) => sizes.find((s) => s >= px) || sizes[sizes.length - 1];
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const DEMO_ID = 'demo';
const STACK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="1" y="4" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 2h7a2 2 0 0 1 2 2v7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

const state = {
  run: 0,
  mode: null,            // 'drive' | 'demo'
  folder: null,          // { id, name }
  resourceKey: null,
  photos: [],
  byId: new Map(),
  session: null,
  groups: [],
  visible: [],           // [{ group, items }] after filter
  visIndex: new Map(),   // photo id -> visible index
  focusId: null,
  filter: 'all',
  round: 1,              // selection round being viewed (1 = all photos)
  pendingRound: 1,       // round requested by the URL before the folder loads
  threshold: prefs.get('threshold', 12),
  tile: prefs.get('tile', 210),
  viewer: null,
  dirtyGrid: false,
  sharing: false,
};

function clientId() {
  try { return CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('photosort:clientId') || ''; }
  catch { return CONFIG.GOOGLE_CLIENT_ID || ''; }
}
// Mark of a photo in the round being viewed: 'p' | 'r' | null.
const dec = (p) => (state.session ? state.session.markIn(p.id, state.round) : null);
const roundPool = (round = state.round) => state.photos.filter((p) => state.session.inPool(p.id, round));
const isStacked = (round = state.round) => prefs.get(round === 1 ? 'stack1' : 'stackN', round === 1);
const roundName = (r) => (r === 1 ? 'Round 1' : `Round ${r}`);

function routeHash(round = state.round) {
  const base = state.mode === 'demo' ? '#/demo' : `#/f/${state.folder.id}`;
  const r = round > 1 ? `/r${round}` : '';
  const rk = state.mode !== 'demo' && state.resourceKey ? `?rk=${encodeURIComponent(state.resourceKey)}` : '';
  return base + r + rk;
}
function syncRoute() {
  try { if (location.hash !== routeHash()) history.replaceState(null, '', routeHash()); } catch { /* sandboxed frame */ }
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function showAuthBanner(show = true) { $('#auth-banner').hidden = !show; }
function handleError(e, context) {
  if (e instanceof auth.AuthError) { showAuthBanner(); return; }
  console.error(context, e);
  toast(`${context}: ${e.message}`, 5000);
}

/* ---------- screens ---------- */
function showScreen(name) {
  for (const s of ['start', 'loading', 'grid']) $('#screen-' + s).hidden = s !== name;
  $('#topbar').hidden = name !== 'grid';
  if (name !== 'grid') $('#status-strip').hidden = true;
}
function setLoading(text) { $('#loading-text').textContent = text; }

function renderStart(msg, kind) {
  state.run++;
  closeOverlays();
  showScreen('start');
  const m = $('#start-msg');
  m.hidden = !msg;
  m.textContent = msg || '';
  m.className = 'msg' + (kind === 'info' ? ' info' : '');
  $('#setup').hidden = !!clientId();
  const recent = getRecent().filter((r) => r.id !== DEMO_ID);
  $('#recent').hidden = !recent.length;
  $('#recent ul').innerHTML = recent.map((r) => `
    <li data-id="${esc(r.id)}" data-rk="${esc(r.rk || '')}" tabindex="0">
      <span class="r-title">${esc(r.name)}</span>
      <span class="muted small">${plural(r.count || 0, 'photo')}</span>
      <button class="icon-btn forget" data-forget="${esc(r.id)}" title="Remove from list" aria-label="Remove">✕</button>
    </li>`).join('');
}

function closeOverlays() {
  if (state.viewer) closeViewer(true);
  $('#review').hidden = true;
  $('#help').hidden = true;
}

/* ---------- opening a folder ---------- */
function parseExifTime(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : Date.parse(s);
  return Number.isFinite(t) && new Date(t).getFullYear() > 1980 ? t : null;
}

async function openDrive({ id, resourceKey }) {
  const cid = clientId();
  if (!cid) { renderStart('Add a Google Client ID first — see the setup box below.'); $('#cid').focus(); return; }
  try {
    if (!auth.hasToken()) await auth.signIn(cid);
  } catch (e) { renderStart(e.message); return; }
  showAuthBanner(false);

  const run = ++state.run;
  drive.addResourceKey(id, resourceKey);
  showScreen('loading');
  setLoading('Opening folder…');
  try {
    const folder = await drive.getFolder(id);
    if (run !== state.run) return;
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('That link points to a single file, not a folder. Ask for the folder link instead.');
    }
    setLoading('Finding photos…');
    const files = await drive.listImages(id, (n) => { if (run === state.run) setLoading(`Finding photos… ${n.toLocaleString()}`); });
    if (run !== state.run) return;
    const photos = files.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path || '',
      time: parseExifTime(f.imageMediaMetadata?.time),
      link: f.thumbnailLink || '',
      thumb(size) { return drive.sizedThumb(this.link, size); },
    }));
    start({ id: folder.id, name: folder.name }, photos, 'drive', resourceKey, state.pendingRound);
  } catch (e) {
    if (run !== state.run) return;
    let msg = e.message;
    if (e.status === 404) msg = 'Couldn’t open that folder. Check that it’s shared with your Google account, or set to “Anyone with the link”.';
    else if (e.status === 403) msg = `Google Drive refused access: ${e.message}`;
    renderStart(msg);
  }
}

async function openDemo() {
  const run = ++state.run;
  showScreen('loading');
  setLoading('Generating demo photos…');
  const photos = await makeDemoPhotos();
  if (run !== state.run) return;
  start({ id: DEMO_ID, name: 'Demo shoot — a day in the park' }, photos, 'demo', null, state.pendingRound);
}

function start(folder, photos, mode, resourceKey = null, round = 1) {
  state.mode = mode;
  state.folder = folder;
  state.resourceKey = resourceKey;
  const timed = photos.filter((p) => p.time != null).length;
  const byPath = (a, b) => collator.compare(a.path + a.name, b.path + b.name);
  photos.sort(photos.length && timed >= photos.length * 0.9 ? (a, b) => ((a.time ?? 0) - (b.time ?? 0)) || byPath(a, b) : byPath);
  state.photos = photos;
  state.byId = new Map(photos.map((p) => [p.id, p]));
  state.session = new Session(folder.id);
  state.filter = 'all';
  state.focusId = null;
  state.round = Math.max(1, Math.min(round || 1, state.session.maxLevel() + 1));
  state.pendingRound = 1;
  touchRecent({ id: folder.id, name: folder.name, count: photos.length, rk: resourceKey });
  syncRoute();

  $('#folder-name').textContent = folder.name;
  $('#folder-name').title = folder.name;
  $('#sim').value = state.threshold;
  $('#tile-size').value = state.tile;
  $$('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === 'all'));
  applyTileSize();
  showScreen('grid');
  regroup();
  renderGrid();
  updateCounts();
  window.scrollTo(0, 0);
  hashAll(state.run);
}

/* ---------- rounds ---------- */
function switchRound(r) {
  const last = Math.max(state.round, state.session.maxLevel() + 1);
  r = Math.max(1, Math.min(r, last));
  if (r === state.round) return;
  if (state.viewer) closeViewer(true);
  state.round = r;
  state.filter = 'all';
  state.focusId = null;
  $$('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === 'all'));
  syncRoute();
  regroup();
  renderGrid();
  updateCounts();
  window.scrollTo(0, 0);
}

function renderRounds() {
  const s = state.session;
  const last = Math.max(state.round, s.maxLevel() + 1);
  const box = $('#rounds');
  box.hidden = last < 2;
  if (last < 2) return;
  let html = '';
  for (let r = 1; r <= last; r++) {
    const n = r === 1 ? state.photos.length : state.photos.filter((p) => s.inPool(p.id, r)).length;
    html += `<button data-round="${r}" class="${r === state.round ? 'on' : ''}" role="tab" aria-selected="${r === state.round}"
      title="${r === 1 ? 'Every photo' : `The ${plural(n, 'photo')} you picked in round ${r - 1}`}">${roundName(r)} <b>${n.toLocaleString()}</b></button>`;
  }
  box.innerHTML = html;
}

function renderRoundTools() {
  const stacked = isStacked();
  const b = $('#btn-stack');
  b.setAttribute('aria-pressed', String(stacked));
  b.innerHTML = `${STACK_ICON} ${stacked ? 'Stacked' : 'Unstacked'}`;
  b.title = stacked ? 'Similar shots are stacked. Click to show every photo separately (S)' : 'Every photo is shown separately. Click to stack similar shots (S)';
  $('#sim-wrap').hidden = !stacked;
  const picks = state.photos.filter((p) => dec(p) === 'p').length;
  const nw = $('#btn-newwin');
  nw.hidden = picks === 0;
  nw.textContent = `${roundName(state.round + 1)} in new window ↗`;
}

function toggleStack() {
  prefs.set(state.round === 1 ? 'stack1' : 'stackN', !isStacked());
  regroup();
  renderGrid();
  renderRoundTools();
}

function openRoundWindow() {
  const r = state.round + 1;
  state.session.save();
  const url = location.pathname + location.search + routeHash(r);
  let w = null;
  try { w = window.open(url, `photosort-${state.folder.id}-r${r}`); } catch { /* blocked */ }
  if (w) { toast(`${roundName(r)} opened in a new window. Changes in either window show up in the other.`, 4000); return; }
  switchRound(r);
  toast(`Couldn’t open a new window here, so switched to ${roundName(r)}. Use the round tabs to go back.`, 4500);
}

// Another window changed the selection: pull it in and refresh.
function onExternalChange() {
  if (!state.session) return;
  state.session.reload();
  regroup();
  renderGrid();
  updateCounts();
  if (state.viewer) updateViewer();
  if (!$('#review').hidden && !state.sharing) renderReview();
}

/* ---------- grouping ---------- */
function regroup() {
  state.groups = groupPhotos(roundPool(), state.session.hashes, { threshold: isStacked() ? state.threshold : 0 });
}

async function hashAll(run) {
  const s = state.session;
  const total = state.photos.length;
  const todo = state.photos.filter((p) => !s.hashes[p.id] && p.thumb(128));
  if (!todo.length) { setStatus(null); return; }
  let done = total - todo.length, ok = 0, failed = 0, corsBlocked = false, i = 0;
  let lastSave = Date.now();
  setStatus(`Finding similar shots… ${done}/${total}`, done / total);

  const worker = async () => {
    while (i < todo.length) {
      if (run !== state.run) return;
      const p = todo[i++];
      try {
        s.hashes[p.id] = await computeHash(p.thumb(128));
        ok++;
      } catch (e) {
        failed++;
        if (e.cors && ok === 0 && failed >= 12) { corsBlocked = true; i = todo.length; }
      }
      done++;
      if (run === state.run) setStatus(`Finding similar shots… ${done.toLocaleString()}/${total.toLocaleString()}`, done / total);
      if (Date.now() - lastSave > 5000) { s.saveHashes(); lastSave = Date.now(); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (run !== state.run) return;
  s.saveHashes();
  setStatus(null);
  regroup();
  renderGrid();
  const stacks = state.groups.filter((g) => g.items.length > 1).length;
  if (corsBlocked) toast('Couldn’t analyse the thumbnails, so stacks are based on capture time only.', 5000);
  else if (stacks) toast(`Grouped similar shots into ${plural(stacks, 'stack')}`);
}

function setStatus(text, frac = 0) {
  const strip = $('#status-strip');
  strip.hidden = !text || $('#screen-grid').hidden;
  if (!text) return;
  $('#status-text').textContent = text;
  $('#status-bar').style.width = `${Math.round(frac * 100)}%`;
}

/* ---------- grid ---------- */
function gridThumbSize() { return bucket(state.tile * dpr() * 1.1, [220, 320, 480, 640, 800]); }
function applyTileSize() { document.documentElement.style.setProperty('--tile', state.tile + 'px'); }

function matches(p) {
  if (state.filter === 'all') return true;
  const d = dec(p);
  return state.filter === 'todo' ? !d : d === state.filter;
}

function renderGrid() {
  if (state.viewer) { state.dirtyGrid = true; return; }
  const prevIndex = state.visIndex.get(state.focusId);
  state.visible = state.groups.map((g) => ({ group: g, items: g.items.filter(matches) })).filter((v) => v.items.length);
  state.visIndex = new Map();
  state.visible.forEach((v, i) => v.group.items.forEach((p) => state.visIndex.set(p.id, i)));

  const frag = document.createDocumentFragment();
  state.visible.forEach((v, i) => {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.i = i;
    el.setAttribute('role', 'gridcell');
    fillTile(el, v);
    frag.appendChild(el);
  });
  $('#grid').replaceChildren(frag);

  if (state.focusId && !state.visIndex.has(state.focusId)) {
    const v = state.visible[Math.min(prevIndex ?? 0, state.visible.length - 1)];
    state.focusId = v ? v.items[0].id : null;
  }
  const fi = state.visIndex.get(state.focusId);
  if (fi != null) $('#grid').children[fi].classList.add('focus');

  const empty = $('#grid-empty');
  empty.hidden = state.visible.length > 0;
  empty.textContent = !state.photos.length ? 'No photos found in this folder (or its subfolders).'
    : state.round > 1 && !state.groups.length ? `Nothing here yet. Photos you pick in round ${state.round - 1} appear in ${roundName(state.round)}.`
    : state.filter === 'todo' ? 'All done — every photo has been picked or rejected. 🎉'
    : state.filter === 'p' ? 'Nothing picked yet.'
    : state.filter === 'r' ? 'Nothing rejected.' : '';
  const stacks = state.groups.filter((g) => g.items.length > 1);
  const n = state.groups.reduce((a, g) => a + g.items.length, 0);
  $('#folder-meta').textContent = (state.round > 1 ? `${roundName(state.round)} · ${plural(n, 'pick')} from round ${state.round - 1}` : plural(n, 'photo')) +
    (stacks.length ? ` · ${plural(stacks.length, 'stack')} of similar shots` : '');
}

function fillTile(el, v) {
  const all = v.group.items;
  const multi = all.length > 1;
  const picks = all.filter((p) => dec(p) === 'p').length;
  const rejects = all.filter((p) => dec(p) === 'r').length;
  const cover = v.items.find((p) => dec(p) === 'p') || v.items.find((p) => dec(p) !== 'r') || v.items[0];
  const d = dec(cover);
  el.classList.toggle('stack', multi);
  el.classList.toggle('picked', picks > 0);
  el.classList.toggle('rejected', rejects === all.length);
  const size = gridThumbSize();
  let badges = '';
  if (multi) badges += `<span class="badge" title="${all.length} similar shots">${STACK_ICON} ${all.length}</span>`;
  if (multi && picks) badges += `<span class="badge picks">✓ ${picks}</span>`;
  else if (!multi && d === 'p') badges += '<span class="badge picks">✓</span>';
  const quick = multi ? '' : `<div class="quick">
      <button class="qbtn r ${d === 'r' ? 'on' : ''}" data-act="r" title="Reject (X)" aria-label="Reject">✕</button>
      <button class="qbtn p ${d === 'p' ? 'on' : ''}" data-act="p" title="Pick (P)" aria-label="Pick">✓</button></div>`;
  const label = multi ? `${cover.name} + ${all.length - 1} similar` : cover.path + cover.name;
  el.title = label;
  el.innerHTML = `<div class="frame"><img loading="lazy" decoding="async" alt="${esc(cover.name)}" data-pid="${esc(cover.id)}" data-size="${size}" src="${esc(cover.thumb(size))}"></div>
    <div class="badges">${badges}</div>${quick}<div class="name">${esc(label)}</div>`;
}

function updateTile(p) {
  const i = state.visIndex.get(p.id);
  if (i == null) return;
  const el = $('#grid').children[i];
  if (el) fillTile(el, state.visible[i]);
}

function setFocus(i, scroll = true) {
  const grid = $('#grid');
  const old = state.visIndex.get(state.focusId);
  if (old != null) grid.children[old]?.classList.remove('focus');
  const v = state.visible[i];
  if (!v) return;
  state.focusId = v.items[0].id;
  const el = grid.children[i];
  el.classList.add('focus');
  if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateCounts() {
  let p = 0, r = 0, n = 0;
  for (const ph of state.photos) {
    const d = dec(ph);
    if (d === undefined) continue;
    n++;
    if (d === 'p') p++; else if (d === 'r') r++;
  }
  const set = (f, v) => { $(`#filters [data-filter="${f}"] b`).textContent = v.toLocaleString(); };
  set('all', n); set('todo', n - p - r); set('p', p); set('r', r);
  $('#pick-count').textContent = p;
  renderRounds();
  renderRoundTools();
}

/* ---------- marking ---------- */
function setMark(p, value) {
  state.session.setIn(p.id, state.round, value);
  if (state.viewer) state.dirtyGrid = true; else updateTile(p);
  updateCounts();
}
function toggleMark(p, value) {
  const next = dec(p) === value ? null : value;
  setMark(p, next);
  return next;
}

/* ---------- viewer ---------- */
function openViewer(i, pid) {
  const v = state.visible[i];
  if (!v) return;
  const groups = state.visible.map((x) => ({ group: x.group, items: x.items.slice() }));
  const pos = new Map();
  groups.forEach((g, gi) => g.items.forEach((p, k) => pos.set(p.id, [gi, k])));
  const pref = prefs.get('viewMode', 'compare');
  state.viewer = { groups, pos, pid: pid || v.items[0].id, pref, mode: v.items.length > 1 ? pref : 'single', key: null, zoom: false };
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  updateViewer();
}

function closeViewer(silent) {
  const V = state.viewer;
  if (!V) return;
  state.viewer = null;
  $('#viewer').hidden = true;
  $('#v-stage').innerHTML = '';
  document.body.style.overflow = '';
  if (silent) return;
  if (state.dirtyGrid || state.filter !== 'all') { state.dirtyGrid = false; state.focusId = V.pid; renderGrid(); }
  const i = state.visIndex.get(V.pid);
  if (i != null) setFocus(i);
}

function current() {
  const V = state.viewer;
  const [gi, k] = V.pos.get(V.pid);
  const g = V.groups[gi];
  return { V, gi, k, g, items: g.items, p: g.items[k], multi: g.items.length > 1 };
}

function updateViewer() {
  const { V, gi, k, items, p, multi } = current();
  if (!multi) V.mode = 'single';
  const key = V.mode === 'single' ? 'S' + p.id : 'C' + gi;
  if (key !== V.key) {
    V.key = key;
    V.zoom = false;
    if (V.mode === 'single') renderSingle(p); else renderCompare(items);
    renderStrip(V.mode === 'single' && multi ? items : []);
  }

  const d = dec(p);
  const groupPicks = items.filter((q) => dec(q) === 'p').length;
  $('#v-name').textContent = p.path + p.name;
  $('#v-pos').textContent = `${gi + 1} of ${V.groups.length}` +
    (multi ? ` · stack of ${items.length} similar · photo ${k + 1}` : '') +
    (multi && groupPicks ? ` · ${groupPicks} picked` : '');
  $('#v-mode').hidden = !multi;
  $$('#v-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === V.mode));
  $('#v-pick').classList.toggle('on', d === 'p');
  $('#v-reject').classList.toggle('on', d === 'r');
  $('#v-only').hidden = !multi;
  $('#v-prev-set').disabled = gi === 0;
  $('#v-next-set').disabled = gi === V.groups.length - 1;

  if (V.mode === 'single') {
    const mk = $('#v-mark');
    mk.hidden = !d;
    mk.className = 'mark ' + (d || '');
    mk.textContent = d === 'p' ? '✓ Picked' : d === 'r' ? '✕ Rejected' : '';
  } else {
    for (const cell of $$('#v-stage .cell')) {
      const q = state.byId.get(cell.dataset.pid);
      const dq = dec(q);
      cell.classList.toggle('p', dq === 'p');
      cell.classList.toggle('r', dq === 'r');
      cell.classList.toggle('focus', q.id === p.id);
      $('.qbtn.p', cell).classList.toggle('on', dq === 'p');
      $('.qbtn.r', cell).classList.toggle('on', dq === 'r');
      if (q.id === p.id && !$('#v-stage .compare').classList.contains('fit')) cell.scrollIntoView({ block: 'nearest' });
    }
  }
  for (const t of $$('#v-strip .thumb')) {
    const q = state.byId.get(t.dataset.pid);
    const dq = dec(q);
    t.classList.toggle('p', dq === 'p');
    t.classList.toggle('r', dq === 'r');
    t.classList.toggle('cur', q.id === p.id);
    if (q.id === p.id) t.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

function bigSize() { return bucket(Math.max(innerWidth, innerHeight) * dpr(), [1200, 1600, 2048, 2560]); }

function renderSingle(p) {
  const lowSize = gridThumbSize();
  const low = p.thumb(lowSize);
  const hiSize = bigSize();
  const hi = p.thumb(hiSize);
  $('#v-stage').innerHTML = `
    <div class="single" id="single"><img id="v-img" alt="${esc(p.name)}" draggable="false" data-pid="${esc(p.id)}" data-size="${lowSize}" src="${esc(low)}"></div>
    <div class="mark" id="v-mark" hidden></div>
    <button class="nav-zone prev" data-nav="-1" aria-label="Previous photo">‹</button>
    <button class="nav-zone next" data-nav="1" aria-label="Next photo">›</button>`;
  if (hi && hi !== low) {
    const pre = new Image();
    pre.onload = () => {
      const img = $('#v-img');
      if (img && state.viewer?.pid === p.id && !state.viewer.zoom) { img.src = hi; img.dataset.size = hiSize; }
    };
    pre.src = hi;
  }
  // warm up neighbours
  const V = state.viewer;
  const flat = (delta) => { const n = neighbour(delta); return n && state.byId.get(n.pid); };
  for (const q of [flat(1), flat(-1)]) if (q) { const im = new Image(); im.src = q.thumb(V ? hiSize : lowSize); }
}

function renderCompare(items) {
  const stage = $('#v-stage');
  const W = stage.clientWidth - 24, H = stage.clientHeight - 24, gap = 10, n = items.length;
  let best = { cols: 1, rows: n, area: 0, cw: W };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - (cols - 1) * gap) / cols;
    const ch = (H - (rows - 1) * gap) / rows;
    const iw = Math.min(cw, ch * 1.5);
    const area = iw * (iw / 1.5);
    if (area > best.area) best = { cols, rows, area, cw, ch };
  }
  let fit = best.ch >= 140 && best.cw >= 180;
  let cols = best.cols;
  let cellW = best.cw;
  if (!fit) {
    cols = Math.max(1, Math.floor((W + gap) / (260 + gap)));
    cellW = (W - (cols - 1) * gap) / cols;
  }
  const size = bucket(cellW * dpr(), [320, 480, 640, 800, 1024, 1600]);
  stage.innerHTML = `<div class="compare ${fit ? 'fit' : ''}" style="grid-template-columns:repeat(${cols},minmax(0,1fr));${fit ? `grid-template-rows:repeat(${best.rows},minmax(0,1fr))` : ''}">
    ${items.map((q, j) => `
      <div class="cell" data-pid="${esc(q.id)}" title="${esc(q.name)} — double-click to view large">
        <img alt="${esc(q.name)}" draggable="false" data-pid="${esc(q.id)}" data-size="${size}" src="${esc(q.thumb(size))}">
        <span class="badge cnum">${j + 1}</span>
        <div class="cbtns">
          <button class="qbtn r" data-act="r" title="Reject" aria-label="Reject">✕</button>
          <button class="qbtn p" data-act="p" title="Pick" aria-label="Pick">✓</button>
        </div>
        <span class="cname">${esc(q.name)}</span>
      </div>`).join('')}
  </div>`;
}

function renderStrip(items) {
  $('#v-strip').innerHTML = items.map((q) => `
    <button class="thumb" data-pid="${esc(q.id)}" title="${esc(q.name)}">
      <img alt="" data-pid="${esc(q.id)}" data-size="220" src="${esc(q.thumb(220))}"><span class="dot"></span>
    </button>`).join('');
}

function neighbour(delta) {
  const V = state.viewer;
  const [gi, k] = V.pos.get(V.pid);
  let g = gi, j = k + delta;
  if (j < 0) { g--; if (g < 0) return null; j = V.groups[g].items.length - 1; }
  else if (j >= V.groups[gi].items.length) { g++; if (g >= V.groups.length) return null; j = 0; }
  return { pid: V.groups[g].items[j].id, g, changed: g !== gi };
}

function vStep(delta) {
  const V = state.viewer;
  const n = neighbour(delta);
  if (!n) { toast(delta > 0 ? 'That’s the last photo' : 'That’s the first photo'); return; }
  V.pid = n.pid;
  if (n.changed) V.mode = V.groups[n.g].items.length > 1 ? V.pref : 'single';
  updateViewer();
}

function vSet(delta) {
  const V = state.viewer;
  const [gi] = V.pos.get(V.pid);
  const g = gi + delta;
  if (g < 0 || g >= V.groups.length) { toast(delta > 0 ? 'That’s the last stack' : 'That’s the first stack'); return; }
  const items = V.groups[g].items;
  V.pid = (items.find((q) => !dec(q)) || items[0]).id;
  V.mode = items.length > 1 ? V.pref : 'single';
  updateViewer();
}

// remember=false for a quick peek (Enter / double-click) that shouldn't change the default view.
function setMode(mode, remember = true) {
  const V = state.viewer;
  if (!current().multi) return;
  V.mode = mode;
  if (remember) { V.pref = mode; prefs.set('viewMode', mode); }
  updateViewer();
}

function vMark(value, { auto = true } = {}) {
  const { V, p } = current();
  const next = toggleMark(p, value);
  updateViewer();
  if (next && auto && $('#v-auto').checked) advance(V);
}

function advance(V) {
  const { gi, k, items } = current();
  if (V.mode === 'single') { vStep(1); return; }
  const rest = items.slice(k + 1).concat(items.slice(0, k));
  const nextOpen = rest.find((q) => !dec(q));
  if (nextOpen) { V.pid = nextOpen.id; updateViewer(); return; }
  setTimeout(() => { if (state.viewer === V && V.pos.get(V.pid)[0] === gi) vSet(1); }, 300);
}

function keepOnly() {
  const { V, p, g, multi } = current();
  if (!multi) { vMark('p'); return; }
  const all = g.group.items;
  for (const q of all) setMark(q, q.id === p.id ? 'p' : 'r');
  updateViewer();
  toast(`Kept ${p.name}, rejected ${plural(all.length - 1, 'other')}`);
  if ($('#v-auto').checked) {
    const gi = V.pos.get(V.pid)[0];
    setTimeout(() => { if (state.viewer === V && V.pos.get(V.pid)[0] === gi) vSet(1); }, 350);
  }
}

function toggleZoom(e) {
  const V = state.viewer;
  const box = $('#single');
  const img = $('#v-img');
  if (!V || !box || !img) return;
  V.zoom = !V.zoom;
  if (!V.zoom) { box.classList.remove('zoomed'); return; }
  const r = img.getBoundingClientRect();
  const ar = (img.naturalWidth / img.naturalHeight) || 1.5;
  let w = r.width, h = r.height;
  if (w / h > ar) w = h * ar; else h = w / ar;
  const fx = e ? clamp((e.clientX - (r.left + (r.width - w) / 2)) / w, 0, 1) : 0.5;
  const fy = e ? clamp((e.clientY - (r.top + (r.height - h) / 2)) / h, 0, 1) : 0.5;
  box.classList.add('zoomed');
  const apply = () => {
    box.scrollLeft = fx * img.offsetWidth - box.clientWidth / 2;
    box.scrollTop = fy * img.offsetHeight - box.clientHeight / 2;
  };
  requestAnimationFrame(apply);
  const p = state.byId.get(V.pid);
  const hi = p.thumb(4096);
  if (hi && img.src !== hi) {
    const pre = new Image();
    pre.onload = () => {
      if (state.viewer !== V || !V.zoom || V.pid !== p.id) return;
      img.src = hi;
      requestAnimationFrame(apply);
    };
    pre.src = hi;
  }
}

/* ---------- review & share ---------- */
// Photos picked in a given round (what gets shared).
const pickedPhotos = (round = state.reviewRound || state.round) => state.photos.filter((p) => state.session.level(p.id) >= round);
const defaultExportName = () => `${state.folder.name} – Print selection`;

function openReview() {
  if (state.viewer) closeViewer();
  $('#r-progress').hidden = true;
  $('#r-result').hidden = true;
  const ex = state.session.exportInfo;
  $('#r-name').value = ex?.name || defaultExportName();
  const hasHere = pickedPhotos(state.round).length > 0;
  state.reviewRound = hasHere ? state.round : Math.max(1, state.session.maxLevel());
  renderReview();
  $('#review').hidden = false;
}

function renderReview() {
  const maxL = state.session.maxLevel();
  if (state.reviewRound > Math.max(1, maxL)) state.reviewRound = Math.max(1, maxL);
  const wrap = $('#r-round-wrap');
  wrap.hidden = maxL < 2;
  if (maxL >= 2) {
    let opts = '';
    for (let r = 1; r <= maxL; r++) {
      const n = pickedPhotos(r).length;
      opts += `<option value="${r}" ${r === state.reviewRound ? 'selected' : ''}>${roundName(r)} — ${plural(n, 'photo')}${r === maxL ? ' (final round)' : ''}</option>`;
    }
    $('#r-round').innerHTML = opts;
  }
  const ps = pickedPhotos();
  $('#r-count').textContent = ps.length;
  $('#r-empty').hidden = ps.length > 0;
  $('#r-grid').hidden = !ps.length;
  $('#r-grid').innerHTML = ps.map((p) => `
    <div class="r-item" title="${esc(p.path + p.name)}">
      <img loading="lazy" alt="${esc(p.name)}" data-pid="${esc(p.id)}" data-size="220" src="${esc(p.thumb(220))}">
      <button data-unpick="${esc(p.id)}" title="Remove from selection" aria-label="Remove">✕</button>
    </div>`).join('');
  const ex = state.session.exportInfo;
  const prev = $('#r-prev');
  prev.hidden = !ex?.link;
  if (ex?.link) {
    prev.innerHTML = `Last shared ${plural(ex.count || 0, 'photo')} to <a href="${esc(ex.link)}" target="_blank" rel="noopener">${esc(ex.name)}</a>` +
      `${ex.at ? ` on ${new Date(ex.at).toLocaleString()}` : ''}. Sharing again updates that same folder.`;
  }
  const btn = $('#r-share');
  btn.textContent = ex?.link ? 'Update Drive folder' : 'Create Drive folder';
  btn.disabled = state.sharing || !ps.length;
}

function setProgress(done, total, text) {
  const box = $('#r-progress');
  box.hidden = false;
  $('i', box).style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
  $('span', box).textContent = text;
}

function showResult(html, warn = false) {
  const box = $('#r-result');
  box.hidden = false;
  box.className = 'r-result' + (warn ? ' warn' : '');
  box.innerHTML = html;
  box.scrollIntoView({ block: 'nearest' });
}

async function pool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

function copyName(p, picks) {
  if (!p.path) return p.name;
  const dupes = picks.filter((q) => q.name === p.name).length > 1;
  return dupes ? `${p.path.replace(/\/$/, '').replaceAll('/', ' – ')} – ${p.name}` : p.name;
}

async function share() {
  if (state.sharing) return;
  const ps = pickedPhotos();
  if (!ps.length) return;
  const name = $('#r-name').value.trim() || defaultExportName();
  const anyone = $('#r-anyone').checked;
  const emails = [...new Set($('#r-emails').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length) { showResult(`Please check ${bad.length > 1 ? 'these addresses' : 'this address'}: ${esc(bad.join(', '))}`, true); return; }
  $('#r-result').hidden = true;

  if (state.mode === 'demo') { await demoShare(ps, name); return; }
  if (!auth.hasToken()) {
    try { await auth.signIn(clientId()); showAuthBanner(false); } catch (e) { showResult(esc(e.message), true); return; }
  }

  state.sharing = true;
  renderReview();
  const s = state.session;
  const failures = [];
  try {
    let ex = s.exportInfo;
    let folder = ex?.folderId ? await drive.findOwnFolder(ex.folderId) : null;
    if (!folder) {
      setProgress(0, 0, 'Creating folder…');
      folder = await drive.createFolder(name);
      ex = s.exportInfo = { folderId: folder.id, link: folder.webViewLink, name, copied: {}, anyone: false, emails: [] };
      s.save();
    } else if (folder.name !== name) {
      await drive.rename(folder.id, name);
    }
    ex.name = name;
    ex.link = folder.webViewLink || ex.link;

    const keep = new Set(ps.map((p) => p.id));
    const toCopy = ps.filter((p) => !ex.copied[p.id]);
    const toTrash = Object.keys(ex.copied).filter((id) => !keep.has(id));
    const total = toCopy.length + toTrash.length;
    let done = 0;
    const tick = () => setProgress(done, total, `Copying photos… ${done} of ${total}`);
    tick();
    await pool([
      ...toCopy.map((p) => async () => {
        try {
          const r = await drive.copyFile(p.id, copyName(p, ps), ex.folderId);
          ex.copied[p.id] = r.id;
          s.saveSoon();
        } catch (e) {
          if (e instanceof auth.AuthError) throw e;
          failures.push({ name: p.name, msg: e.reason === 'cannotCopyFile' ? 'the owner has disabled copying' : e.message });
        }
        done++; tick();
      }),
      ...toTrash.map((id) => async () => {
        try {
          await drive.trashFile(ex.copied[id]);
          delete ex.copied[id];
          s.saveSoon();
        } catch (e) {
          if (e instanceof auth.AuthError) throw e;
          failures.push({ name: state.byId.get(id)?.name || id, msg: `couldn’t remove: ${e.message}` });
        }
        done++; tick();
      }),
    ], 3);

    if (anyone && !ex.anyone) {
      setProgress(1, 1, 'Turning on link sharing…');
      await drive.shareWithAnyone(ex.folderId);
      ex.anyone = true;
    }
    for (const em of emails) {
      if (ex.emails.includes(em)) continue;
      setProgress(1, 1, `Sharing with ${em}…`);
      try { await drive.shareWithEmail(ex.folderId, em); ex.emails.push(em); }
      catch (e) { failures.push({ name: em, msg: e.message }); }
    }
    ex.count = Object.keys(ex.copied).length;
    ex.at = Date.now();
    s.save();
    $('#r-progress').hidden = true;
    showShareResult(ex, failures);
  } catch (e) {
    s.save();
    $('#r-progress').hidden = true;
    if (e instanceof auth.AuthError) {
      showAuthBanner();
      showResult('Your Google session expired part-way through. Reconnect, then press the button again — it will pick up where it left off.', true);
    } else {
      showResult(`Something went wrong: ${esc(e.message)}. Your progress is saved — press the button again to continue.`, true);
    }
  } finally {
    state.sharing = false;
    renderReview();
  }
}

function showShareResult(ex, failures) {
  const who = ex.anyone ? 'Anyone with this link can view the photos.' : 'Only you' +
    (ex.emails?.length ? ` and ${esc(ex.emails.join(', '))}` : '') + ' can open this link.';
  showResult(`
    <b>✓ ${plural(ex.count, 'photo')} in “${esc(ex.name)}”</b>
    <div class="row">
      <input readonly value="${esc(ex.link)}" aria-label="Folder link" id="r-link">
      <button class="ghost" id="r-copy">Copy link</button>
      <a class="primary" href="${esc(ex.link)}" target="_blank" rel="noopener">Open in Drive</a>
    </div>
    <p class="muted small">${who}</p>
    ${failures.length ? `<p><b>${plural(failures.length, 'item')} had problems</b> (press the button again to retry):</p>
      <ul>${failures.map((f) => `<li>${esc(f.name)} — ${esc(f.msg)}</li>`).join('')}</ul>` : ''}`, failures.length > 0);
}

async function demoShare(ps, name) {
  state.sharing = true;
  renderReview();
  for (let i = 0; i <= ps.length; i++) {
    setProgress(i, ps.length, `Copying photos… ${i} of ${ps.length}`);
    await new Promise((r) => setTimeout(r, 60));
  }
  $('#r-progress').hidden = true;
  state.sharing = false;
  renderReview();
  showResult(`<b>✓ Demo complete</b><p>With a real Drive folder, this creates “${esc(name)}” in your Google Drive, copies these
    ${plural(ps.length, 'photo')} into it, and gives you a link to send to the print shop.</p>`);
}

function downloadList() {
  const ps = pickedPhotos();
  const lines = [`${state.folder.name} — ${plural(ps.length, 'photo')} selected for print`, '', ...ps.map((p) => p.path + p.name), ''];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  a.download = `${state.folder.name} - selected.txt`.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- keyboard ---------- */
function gridKey(e) {
  if (e.key === '?') { openHelp(); e.preventDefault(); return; }
  if (e.key === 's' || e.key === 'S') { toggleStack(); e.preventDefault(); return; }
  if (e.key === '[') { switchRound(state.round - 1); e.preventDefault(); return; }
  if (e.key === ']') { switchRound(state.round + 1); e.preventDefault(); return; }
  const n = state.visible.length;
  if (!n) return;
  let i = state.visIndex.get(state.focusId) ?? -1;
  const cols = () => getComputedStyle($('#grid')).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  switch (e.key) {
    case 'ArrowRight': i = Math.min(n - 1, i + 1); break;
    case 'ArrowLeft': i = Math.max(0, i - 1); break;
    case 'ArrowDown': i = i < 0 ? 0 : Math.min(n - 1, i + cols()); break;
    case 'ArrowUp': i = Math.max(0, i - cols()); break;
    case 'Home': i = 0; break;
    case 'End': i = n - 1; break;
    case 'Enter': if (i >= 0) openViewer(i); e.preventDefault(); return;
    case 'p': case 'P': case ' ': case 'x': case 'X': case 'u': case 'U': {
      if (i < 0) return;
      e.preventDefault();
      const v = state.visible[i];
      if (v.group.items.length > 1) { openViewer(i); return; }
      const k = e.key.toLowerCase();
      if (k === 'u') setMark(v.items[0], null);
      else toggleMark(v.items[0], k === 'x' ? 'r' : 'p');
      return;
    }
    default: return;
  }
  e.preventDefault();
  setFocus(i);
}

function viewerKey(e) {
  const V = state.viewer;
  switch (e.key) {
    case 'Escape': if (V.zoom) toggleZoom(); else closeViewer(); break;
    case 'ArrowRight': vStep(1); break;
    case 'ArrowLeft': vStep(-1); break;
    case 'ArrowDown': vSet(1); break;
    case 'ArrowUp': vSet(-1); break;
    case 'p': vMark('p'); break;
    case 'P': if (e.shiftKey) keepOnly(); else vMark('p'); break;
    case ' ': vMark('p'); break;
    case 'x': case 'X': vMark('r'); break;
    case 'u': case 'U': setMark(current().p, null); updateViewer(); break;
    case 'Enter': setMode(V.mode === 'single' ? 'compare' : 'single', false); break;
    case 'c': case 'C': setMode(V.mode === 'single' ? 'compare' : 'single'); break;
    case 'z': case 'Z': if (V.mode === 'single') toggleZoom(); break;
    case '?': openHelp(); break;
    default: return;
  }
  e.preventDefault();
}

function openHelp() { $('#help').hidden = false; }

/* ---------- events ---------- */
function bind() {
  $('#open-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = drive.parseFolderLink($('#link').value);
    if (!parsed) { renderStart('That doesn’t look like a Google Drive folder link.'); return; }
    openDrive(parsed);
  });
  $('#save-cid').addEventListener('click', () => {
    const v = $('#cid').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('That doesn’t look like an OAuth Client ID (…apps.googleusercontent.com)'); return; }
    localStorage.setItem('photosort:clientId', v);
    auth.loadGis().catch(() => {});
    renderStart('Saved. Now paste a folder link above.', 'info');
  });
  $('#btn-demo').addEventListener('click', openDemo);
  $('#recent ul').addEventListener('click', (e) => {
    const f = e.target.closest('[data-forget]');
    if (f) { forgetRecent(f.dataset.forget); renderStart(); return; }
    const li = e.target.closest('li');
    if (li) openDrive({ id: li.dataset.id, resourceKey: li.dataset.rk || null });
  });
  $('#recent ul').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('li')) e.target.click(); });

  $('#btn-home').addEventListener('click', () => {
    state.session?.save();
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed frame */ }
    renderStart();
  });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.filter;
    $$('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    renderGrid();
    window.scrollTo(0, 0);
  });
  let simT;
  $('#sim').addEventListener('input', (e) => {
    state.threshold = +e.target.value;
    prefs.set('threshold', state.threshold);
    clearTimeout(simT);
    simT = setTimeout(() => { regroup(); renderGrid(); }, 120);
  });
  let sizeT;
  $('#tile-size').addEventListener('input', (e) => {
    const before = gridThumbSize();
    state.tile = +e.target.value;
    prefs.set('tile', state.tile);
    applyTileSize();
    clearTimeout(sizeT);
    if (gridThumbSize() !== before) sizeT = setTimeout(renderGrid, 200);
  });
  $('#btn-help').addEventListener('click', openHelp);
  $('#h-close').addEventListener('click', () => { $('#help').hidden = true; });
  $('#btn-review').addEventListener('click', openReview);
  $('#btn-reconnect').addEventListener('click', async () => {
    try { await auth.signIn(clientId()); showAuthBanner(false); toast('Reconnected'); } catch (e) { toast(e.message); }
  });

  $('#grid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const i = +t.dataset.i;
    const v = state.visible[i];
    const act = e.target.closest('[data-act]');
    setFocus(i, false);
    if (act) { toggleMark(v.items[0], act.dataset.act); return; }
    openViewer(i);
  });

  // viewer
  $('#v-close').addEventListener('click', () => closeViewer());
  $('#v-pick').addEventListener('click', () => vMark('p'));
  $('#v-reject').addEventListener('click', () => vMark('r'));
  $('#v-only').addEventListener('click', keepOnly);
  $('#v-prev-set').addEventListener('click', () => vSet(-1));
  $('#v-next-set').addEventListener('click', () => vSet(1));
  $('#v-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  $('#v-auto').checked = prefs.get('auto', true);
  $('#v-auto').addEventListener('change', (e) => prefs.set('auto', e.target.checked));
  $('#v-strip').addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (!t || !state.viewer) return;
    state.viewer.pid = t.dataset.pid;
    updateViewer();
  });

  const stage = $('#v-stage');
  stage.addEventListener('click', (e) => {
    const V = state.viewer;
    if (!V) return;
    const nav = e.target.closest('[data-nav]');
    if (nav) { vStep(+nav.dataset.nav); return; }
    const cell = e.target.closest('.cell');
    if (!cell) return;
    V.pid = cell.dataset.pid;
    const act = e.target.closest('[data-act]');
    if (act) { vMark(act.dataset.act, { auto: false }); return; }
    updateViewer();
  });
  stage.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || e.target.closest('[data-act]') || !state.viewer) return;
    state.viewer.pid = cell.dataset.pid;
    setMode('single', false);
  });

  // single view: click to zoom, drag to pan when zoomed, swipe to navigate
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const V = state.viewer;
    const box = $('#single');
    if (!V || V.mode !== 'single' || !box || e.target.closest('button') || e.button > 0) return;
    drag = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, moved: false };
    box.setPointerCapture?.(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (state.viewer?.zoom) { const box = $('#single'); box.scrollLeft = drag.sl - dx; box.scrollTop = drag.st - dy; }
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const V = state.viewer;
    if (!V) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) { if (e.target.id === 'v-img' || V.zoom) toggleZoom(e); }
    else if (!V.zoom && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) vStep(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', () => { drag = null; });

  // review
  $('#r-close').addEventListener('click', () => { $('#review').hidden = true; });
  $('#r-share').addEventListener('click', share);
  $('#r-list').addEventListener('click', downloadList);
  $('#r-round').addEventListener('change', (e) => { state.reviewRound = +e.target.value; renderReview(); });

  // rounds
  $('#rounds').addEventListener('click', (e) => { const b = e.target.closest('[data-round]'); if (b) switchRound(+b.dataset.round); });
  $('#btn-stack').addEventListener('click', toggleStack);
  $('#btn-newwin').addEventListener('click', openRoundWindow);
  window.addEventListener('storage', (e) => {
    if (state.session && e.key === state.session.storageKey) onExternalChange();
  });
  $('#r-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpick]');
    if (!b) return;
    // Remove from the round being shared (and therefore from later rounds).
    state.session.setIn(b.dataset.unpick, state.reviewRound, null);
    regroup();
    renderGrid();
    updateCounts();
    renderReview();
  });
  $('#r-result').addEventListener('click', async (e) => {
    if (e.target.id !== 'r-copy') return;
    const link = $('#r-link').value;
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch { $('#r-link').select(); toast('Press Ctrl/⌘+C to copy'); }
  });
  for (const id of ['#review', '#help']) {
    $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget && !state.sharing) e.currentTarget.hidden = true; });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') { $('#help').hidden = true; e.preventDefault(); } return; }
    if (!$('#review').hidden) { if (e.key === 'Escape' && !state.sharing) $('#review').hidden = true; return; }
    if (state.viewer) { viewerKey(e); return; }
    if (!$('#screen-grid').hidden) gridKey(e);
  });

  // Drive thumbnail links expire after a while: refresh once on error.
  document.addEventListener('error', async (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.pid || img.dataset.retried || state.mode !== 'drive') return;
    img.dataset.retried = '1';
    const p = state.byId.get(img.dataset.pid);
    if (!p) return;
    try {
      if (!p._refresh) p._refresh = drive.getThumbLink(p.id).then((l) => { if (l) p.link = l; });
      await p._refresh;
      img.src = p.thumb(+img.dataset.size || 320);
    } catch (err) { if (err instanceof auth.AuthError) showAuthBanner(); }
  }, true);

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.viewer?.mode === 'compare') { state.viewer.key = null; updateViewer(); } }, 150);
  });
  window.addEventListener('beforeunload', () => { state.session?.save(); state.session?.saveHashes(); });
}

/* ---------- boot ---------- */
function boot() {
  bind();
  if (clientId()) auth.loadGis().catch(() => {});
  const h = location.hash;
  const rm = h.match(/\/r(\d+)(?:\?|$)/);
  state.pendingRound = rm ? +rm[1] : 1;
  if (h.startsWith('#/demo') || h === '#demo' || window.PHOTOSORT_DEMO) { openDemo(); return; }
  const m = h.match(/^#\/f\/([\w-]+)(?:\/r\d+)?(?:\?rk=([^&]+))?/);
  if (m) {
    const parsed = { id: m[1], resourceKey: m[2] ? decodeURIComponent(m[2]) : null };
    $('#link').value = `https://drive.google.com/drive/folders/${parsed.id}${parsed.resourceKey ? `?resourcekey=${parsed.resourceKey}` : ''}`;
    if (auth.hasToken() && clientId()) { openDrive(parsed); return; }
    renderStart('Press “Open photos” to sign in and continue where you left off.', 'info');
    return;
  }
  renderStart();
}

boot();
