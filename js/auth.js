// Google sign-in using Google Identity Services (token model).
// The access token lives in memory + sessionStorage only (cleared when the tab closes).

export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

// Full Drive scope: needed to read a folder shared with you by link AND copy
// those files into a new folder in your own Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive';
const KEY = 'photosort:token';

let token = null;
let expiresAt = 0;
let tokenClient = null;
let tokenClientId = null;
let pending = null;
let gisPromise = null;

try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  if (saved && saved.expiresAt > Date.now() + 60_000) {
    token = saved.token;
    expiresAt = saved.expiresAt;
  }
} catch { /* storage unavailable */ }

export function hasToken() {
  return !!token && Date.now() < expiresAt - 30_000;
}

export async function getToken() {
  if (hasToken()) return token;
  throw new AuthError('Your Google session expired. Reconnect to continue.');
}

export function expireToken() {
  token = null;
  expiresAt = 0;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

// Must be called from a click handler (opens Google's consent popup).
export async function signIn(clientId) {
  await loadGis();
  if (!tokenClient || tokenClientId !== clientId) {
    tokenClientId = clientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp.error) { p.reject(new Error(resp.error_description || resp.error)); return; }
        token = resp.access_token;
        expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem(KEY, JSON.stringify({ token, expiresAt })); } catch { /* ignore */ }
        p.resolve(token);
      },
      error_callback: (err) => {
        const p = pending; pending = null;
        if (!p) return;
        const msg = err?.type === 'popup_closed' ? 'Sign-in was cancelled.'
          : err?.type === 'popup_failed_to_open' ? 'The sign-in popup was blocked. Allow popups for this site and try again.'
          : (err?.message || 'Google sign-in failed.');
        p.reject(new Error(msg));
      },
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: token ? '' : undefined });
  });
}
