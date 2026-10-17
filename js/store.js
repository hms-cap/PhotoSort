// Local persistence: selections, similarity hashes, export info and preferences.
//
// Selection rounds: round 1 shows every photo, round N shows the photos picked
// in round N-1. Each photo stores one value:
//   "<L>"   picked through L rounds (shown in rounds 1..L+1, picked in 1..L)
//   "<L>r"  picked through L rounds, then rejected in round L+1
// No entry = never picked, not rejected. Legacy 'p'/'r' map to "1"/"0r".
const PFX = 'photosort:';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(PFX + key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(PFX + key, JSON.stringify(value)); } catch { /* quota or disabled */ }
}

export function parseVal(v) {
  if (v == null) return { L: 0, rej: false };
  if (v === 'p') return { L: 1, rej: false };
  if (v === 'r') return { L: 0, rej: true };
  const m = /^(\d+)(r?)$/.exec(String(v));
  return m ? { L: +m[1], rej: !!m[2] } : { L: 0, rej: false };
}
function encVal(L, rej) {
  return L === 0 && !rej ? null : `${L}${rej ? 'r' : ''}`;
}

export class Session {
  constructor(folderId) {
    this.folderId = folderId;
    this.key = 'sel:' + folderId;
    this.storageKey = PFX + this.key;
    const saved = read(this.key, {});
    this.decisions = new Map(Object.entries(saved.d || {}));
    this.exportInfo = saved.export || null;
    this.hashes = read('hash:' + folderId, {});
    this.dirty = new Set(); // ids changed here but not yet written
    this._t = null;
  }

  level(id) { return parseVal(this.decisions.get(id)).L; }
  inPool(id, round) { return this.level(id) >= round - 1; }

  // 'p' | 'r' | null for a photo in that round's pool; undefined if not in the pool.
  markIn(id, round) {
    const { L, rej } = parseVal(this.decisions.get(id));
    if (L < round - 1) return undefined;
    if (L >= round) return 'p';
    return rej ? 'r' : null;
  }

  // value: 'p' | 'r' | null, applied in the given round.
  setIn(id, round, value) {
    const { L } = parseVal(this.decisions.get(id));
    let next;
    if (value === 'p') next = L >= round ? encVal(L, false) : encVal(round, false);
    else next = encVal(round - 1, value === 'r');
    if (next) this.decisions.set(id, next); else this.decisions.delete(id);
    this.dirty.add(id);
    this.saveSoon();
  }

  maxLevel() {
    let m = 0;
    for (const v of this.decisions.values()) m = Math.max(m, parseVal(v).L);
    return m;
  }

  saveSoon() { clearTimeout(this._t); this._t = setTimeout(() => this.save(), 200); }

  // Merges with what other windows wrote, so two windows can work at once.
  save() {
    clearTimeout(this._t);
    const fresh = read(this.key, {});
    const d = fresh.d || {};
    for (const id of this.dirty) {
      const v = this.decisions.get(id);
      if (v) d[id] = v; else delete d[id];
    }
    this.dirty.clear();
    this.decisions = new Map(Object.entries(d));
    const exportInfo = this.exportInfo || fresh.export || null;
    this.exportInfo = exportInfo;
    write(this.key, { d, export: exportInfo, at: Date.now() });
  }

  // Pick up changes from another window, keeping this window's unsaved edits.
  reload() {
    const fresh = read(this.key, {});
    const d = { ...(fresh.d || {}) };
    for (const id of this.dirty) {
      const v = this.decisions.get(id);
      if (v) d[id] = v; else delete d[id];
    }
    this.decisions = new Map(Object.entries(d));
    if (fresh.export) this.exportInfo = fresh.export;
  }

  saveHashes() { write('hash:' + this.folderId, { ...read('hash:' + this.folderId, {}), ...this.hashes }); }
}

export function getRecent() { return read('recent', []); }
export function touchRecent(entry) {
  const list = getRecent().filter((r) => r.id !== entry.id);
  list.unshift({ ...entry, at: Date.now() });
  write('recent', list.slice(0, 8));
}
export function forgetRecent(id) { write('recent', getRecent().filter((r) => r.id !== id)); }

export const prefs = {
  get: (k, d) => read('pref:' + k, d),
  set: (k, v) => write('pref:' + k, v),
};
