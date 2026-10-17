// Minimal Google Drive v3 client (fetch-based, with retry/backoff).
import { getToken, expireToken, AuthError } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Older link-shared items need their resource key sent along.
const resourceKeys = new Map();
export function addResourceKey(id, key) { if (id && key) resourceKeys.set(id, key); }

export function parseFolderLink(input) {
  const s = (input || '').trim();
  if (!s) return null;
  let id = null;
  let resourceKey = null;
  try {
    const u = new URL(s);
    if (!/google\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/folders\/([\w-]+)/) || u.pathname.match(/\/d\/([\w-]+)/);
    id = m ? m[1] : u.searchParams.get('id');
    resourceKey = u.searchParams.get('resourcekey');
  } catch {
    if (/^[\w-]{10,}$/.test(s)) id = s;
  }
  return id ? { id, resourceKey } : null;
}

async function api(path, { method = 'GET', params = {}, body, ids = [] } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const keyed = ids.filter((i) => resourceKeys.has(i)).map((i) => `${i}/${resourceKeys.get(i)}`);

  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: 'Bearer ' + (await getToken()) };
    if (body) headers['Content-Type'] = 'application/json';
    if (keyed.length) headers['X-Goog-Drive-Resource-Keys'] = keyed.join(',');

    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (attempt < 4) { await sleep(800 * 2 ** attempt); continue; }
      throw new Error('Network error talking to Google Drive.');
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    let info = {};
    try { info = await res.json(); } catch { /* no body */ }
    const reason = info?.error?.errors?.[0]?.reason || '';
    const message = info?.error?.message || res.statusText;
    if (res.status === 401) { expireToken(); throw new AuthError('Your Google session expired. Reconnect to continue.'); }
    const retryable = res.status === 429 || res.status >= 500 ||
      (res.status === 403 && /rateLimit|RateLimit|backendError/.test(reason));
    if (retryable && attempt < 6) {
      await sleep(Math.min(20_000, 600 * 2 ** attempt) + Math.random() * 500);
      continue;
    }
    const err = new Error(message);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
}

export async function getFolder(id) {
  return api(`/files/${id}`, {
    params: { fields: 'id,name,mimeType,resourceKey', supportsAllDrives: true },
    ids: [id],
  });
}

const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,thumbnailLink,resourceKey,createdTime,' +
  'imageMediaMetadata(width,height,time,rotation))';

// Lists all images in a folder, including subfolders (flattened, with a path).
export async function listImages(rootId, onProgress) {
  const out = [];
  const queue = [{ id: rootId, path: '' }];
  const seen = new Set();
  while (queue.length) {
    const { id, path } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let pageToken;
    do {
      const r = await api('/files', {
        params: {
          q: `'${id}' in parents and trashed = false and (mimeType contains 'image/' or mimeType = '${FOLDER}')`,
          fields: LIST_FIELDS,
          pageSize: 1000,
          pageToken,
          orderBy: 'name',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        ids: [id],
      });
      for (const f of r.files || []) {
        addResourceKey(f.id, f.resourceKey);
        if (f.mimeType === FOLDER) queue.push({ id: f.id, path: `${path}${f.name}/` });
        else out.push({ ...f, path });
      }
      pageToken = r.nextPageToken;
      onProgress?.(out.length);
    } while (pageToken);
  }
  return out;
}

export async function getThumbLink(id) {
  const r = await api(`/files/${id}`, { params: { fields: 'thumbnailLink', supportsAllDrives: true }, ids: [id] });
  return r.thumbnailLink || '';
}

export function sizedThumb(link, size) {
  if (!link) return '';
  return /=s\d+(-c)?$/.test(link) ? link.replace(/=s\d+(-c)?$/, `=s${size}`) : `${link}=s${size}`;
}

export async function createFolder(name) {
  return api('/files', {
    method: 'POST',
    params: { fields: 'id,name,webViewLink', supportsAllDrives: true },
    body: { name, mimeType: FOLDER },
  });
}

// Returns the folder if it still exists and isn't trashed, otherwise null.
export async function findOwnFolder(id) {
  try {
    const r = await api(`/files/${id}`, { params: { fields: 'id,name,trashed,webViewLink', supportsAllDrives: true } });
    return r.trashed ? null : r;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function rename(id, name) {
  return api(`/files/${id}`, { method: 'PATCH', params: { supportsAllDrives: true }, body: { name } });
}

export async function copyFile(id, name, parentId) {
  return api(`/files/${id}/copy`, {
    method: 'POST',
    params: { fields: 'id', supportsAllDrives: true },
    body: { name, parents: [parentId] },
    ids: [id],
  });
}

export async function trashFile(id) {
  try {
    await api(`/files/${id}`, { method: 'PATCH', params: { supportsAllDrives: true }, body: { trashed: true } });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

export async function shareWithAnyone(id) {
  return api(`/files/${id}/permissions`, {
    method: 'POST', params: { supportsAllDrives: true }, body: { role: 'reader', type: 'anyone' },
  });
}

export async function shareWithEmail(id, email) {
  return api(`/files/${id}/permissions`, {
    method: 'POST',
    params: { supportsAllDrives: true, sendNotificationEmail: true },
    body: { role: 'reader', type: 'user', emailAddress: email },
  });
}
