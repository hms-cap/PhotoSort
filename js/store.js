// Local persistence: selections, similarity hashes, export info and preferences.
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

export class Session {
  constructor(folderId) {
    this.folderId = folderId;
    const saved = read('sel:' + folderId, {});
    this.decisions = new Map(Object.entries(saved.d || {})); // id -> 'p' | 'r'
    this.exportInfo = saved.export || null;
    this.hashes = read('hash:' + folderId, {});
    this._t = null;
  }
  get(id) { return this.decisions.get(id) || null; }
  set(id, value) {
    if (value) this.decisions.set(id, value); else this.decisions.delete(id);
    this.saveSoon();
  }
  saveSoon() { clearTimeout(this._t); this._t = setTimeout(() => this.save(), 250); }
  save() {
    clearTimeout(this._t);
    write('sel:' + this.folderId, { d: Object.fromEntries(this.decisions), export: this.exportInfo, at: Date.now() });
  }
  saveHashes() { write('hash:' + this.folderId, this.hashes); }
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
