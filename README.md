# PhotoSort

Visually select photos from a Google Drive link — built for going through a photographer's shoot,
picking the keepers among many near-identical shots, and sending the selection off for printing.

**Live app:** https://hms-cap.github.io/PhotoSort/ (after the one-time setup below)

The home page has two tools:

- **Edit a photo** (`edit.html`) — a photo editor for one picture, opened from your device or a Drive link.
- **Sort a shoot** (`sort.html`) — the selection tool described below.

Old links that went straight to a folder (`…/PhotoSort/#/f/<folder>`) still open the sorter.

## Photo editor

Open a photo by choosing a file, dropping it on the page, pasting it, or pasting a Google Drive link
— either to a single photo or to a folder (you then pick a photo from the folder and can step through
it with ‹ ›). In the sorter's viewer, **Edit** opens the current photo in the editor in a new tab.

| Tool | What you can do |
| --- | --- |
| **Crop** | Free or fixed aspect ratios (square, 4:5/8×10, 5×7, 2:3/4×6, 3:4, 16:9, 9:16), rotate 90°, flip, straighten ±45° |
| **Adjust** | Exposure, brightness, contrast, highlights, shadows, whites, blacks, warmth, tint, saturation, vibrance, hue, clarity, sharpness, fade, vignette, grain — plus **Auto enhance** |
| **Filters** | 15 looks (Vivid, Warm, Golden, Teal & Orange, Film, Matte, Vintage, Mono, Noir, Sepia, …) with a strength slider |
| **Retouch** | Heal brush (paints away spots and small objects) and blur brush |
| **Text** | Several fonts, size, color, bold/italic, alignment, shadow, outline, label background; drag to place |
| **Draw** | Pen, marker and eraser in any color |
| **Background** | Removes the background behind people (MediaPipe, in the browser); replace with transparency, a color, or a blur |

Edits are non-destructive: undo/redo everything, hold **Before** (or `\`) to compare with the original,
**Reset** to start over. **Save** downloads a JPEG, PNG or WebP (original size or smaller), or saves a
copy to Google Drive — into the original's folder when you're allowed to add files there, otherwise
to My Drive. The original is never modified.

Shortcuts: `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` redo, `Ctrl/⌘+S` save, `+`/`−`/`0` zoom, scroll or pinch
to zoom, `Space`+drag to pan, `[` `]` brush size, `Delete` removes the selected text.

Notes: adjustments are rendered with WebGL2 (all current browsers). Interactive editing works on a
copy of up to 2560px; saving at original size re-renders from the full-resolution original. HEIC
files open in Safari; elsewhere, Drive photos fall back to Drive's own large preview. Background
removal downloads a ~16 MB model from Google the first time and is designed for photos of people.

## Photo sorter

1. **Paste a Drive folder link** from your photographer and sign in with Google. Subfolders are included.
2. **Similar shots are stacked.** Photos are ordered by capture time, and shots taken moments apart
   that look alike (perceptual hash of each thumbnail, computed in your browser) are grouped into a
   stack. The **Stacking** slider makes stacks looser or tighter; all the way left turns it off.
3. **Compare and cull.** Open a stack to see every shot side by side, then pick or reject. Switch to
   *Single* view for a big image, and click (or press `Z`) to zoom in and check focus and closed eyes.
4. **Narrow it down in rounds.** Everything you pick moves on to **Round 2**, which shows only those
   photos — unstacked by default (toggle **Stacked / Unstacked** any time, or press `S`). Pick again
   and those go on to Round 3, and so on. Switch rounds with the tabs at the top (or `[` / `]`), or
   click **Round N in new window** to work on the next round in a separate window: both windows stay
   in sync, so you can go back to an earlier round, add or drop a photo, and see the later round update.
5. **Review & share.** Choose which round's picks to share (the latest round is the default). See everything you picked, then create a new folder in your Google Drive with
   copies of those photos, optionally shared via link and/or with specific emails (e.g. the print shop).
   Running it again later only adds new picks and removes un-picked ones — same folder, same link.

Your picks are autosaved in the browser per folder, so you can close the tab and come back later.
There's also a **demo mode** (link on the start screen) that works without any Google setup.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `P` / `Space` | Pick (press again to undo) |
| `X` | Reject (press again to undo) |
| `Shift`+`P` | Keep only this one, reject the rest of the stack |
| `U` | Clear mark |
| `←` `→` | Previous / next photo |
| `↑` `↓` | Previous / next stack |
| `Enter` / `C` | Peek at one photo large / switch Single ↔ Compare |
| `Z` | Zoom (single view) |
| `S` | Stack / unstack similar shots (grid) |
| `[` `]` | Previous / next round (grid) |
| `Esc` | Back |

On phones: swipe between photos and use the buttons along the bottom.

## Google Cloud setup

The app runs entirely in the browser; it needs an OAuth Client ID so it can call the Google Drive
API on your behalf. This is free and takes about 10 minutes.

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "PhotoSort").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (a.k.a. *Google Auth Platform*):
   - User type **External**, app name "PhotoSort", your email as support/developer contact.
   - **Data access / Scopes:** add `https://www.googleapis.com/auth/drive`.
   - **Audience / Test users:** add the Google accounts that will use the app (yours, family, etc. — up to 100).
   - Leave the app in **Testing**. (Publishing it for anyone to use would require Google's verification
     for the Drive scope; for personal use, Testing is the right choice.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized JavaScript origins:** `https://hms-cap.github.io` and, for local testing,
     `http://localhost:8000`.
   - No redirect URIs needed. Copy the **Client ID** (`…apps.googleusercontent.com`).
5. In this GitHub repo: **Settings → Secrets and variables → Actions → Variables → New repository
   variable** named `GOOGLE_CLIENT_ID` with the Client ID as its value.
6. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Then re-run the
   *Deploy to GitHub Pages* workflow (Actions tab) or push any commit.

When you first sign in, Google shows *"Google hasn't verified this app"* — that's expected for an
app in Testing. Choose **Continue**.

> GitHub Pages on a **private** repository requires a paid GitHub plan (Pro, Team or Enterprise).
> On a free plan, either make the repo public (the Client ID is not a secret) or host the files
> elsewhere — any static host works (Netlify, Cloudflare Pages, Firebase Hosting); just add that
> origin to the OAuth client's authorized JavaScript origins.

### Why the full `drive` scope?

The app has to read a folder *someone else* shared with you, copy those files into a new folder
in *your* Drive, and (in the editor) save edited copies next to the originals. Narrower scopes (`drive.file`) can't see files the app didn't create or that weren't
opened through Google's file picker, so pasting a link wouldn't work. Everything happens in your
browser — there's no server, and the access token is kept only in the tab's session storage.

## Run locally

No build step or dependencies — it's plain HTML, CSS and ES modules.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Put your Client ID in `js/config.js`, or paste it into the box on the start screen (stored in that
browser only).

## Project layout

```
index.html          home page (Edit a photo / Sort a shoot)
sort.html           sorter page structure
edit.html           editor page structure
styles.css          shared styles
editor.css          editor styles
js/app.js           sorter UI: start screen, stacked grid, viewer/compare, review & share
js/drive.js         Google Drive v3 calls (list, copy, share) with retry/backoff
js/auth.js          Google Identity Services sign-in (token model)
js/similarity.js    perceptual hashing + grouping of similar shots
js/store.js         localStorage autosave (picks, hashes, last export, preferences)
js/demo.js          synthetic demo shoot
js/config.js        Google OAuth Client ID (written by the deploy workflow)
js/editor/main.js       editor UI: open, tools, pointer/zoom, export
js/editor/state.js      edit state, sliders, filter looks, undo history
js/editor/geometry.js   rotate/flip/straighten/crop maths
js/editor/gl.js         WebGL2 colour pipeline (light, colour, detail, looks)
js/editor/pipeline.js   retouch → geometry → colour → background → text/drawings
js/editor/retouch.js    heal (pyramid fill) and blur brushes
js/editor/overlays.js   text and drawing rendering
js/editor/segment.js    background removal (MediaPipe image segmenter)
.github/workflows/pages.yml   GitHub Pages deployment
```

## Notes and limits

- Images are shown from Drive's thumbnail service (up to ~2560px in the viewer, larger when zoomed),
  so browsing a 2,000-photo folder doesn't download full-size originals. The copies made for printing
  are the original, full-resolution files.
- Copies count toward your own Drive storage.
- If the photographer disabled "viewers can download/copy" on the files, Drive won't allow copying;
  those files are listed with an error, and **Download file list** gives you the filenames to send
  instead.
- RAW files (`.CR3`, `.NEF`, …) appear only if Drive can generate thumbnails for them.
