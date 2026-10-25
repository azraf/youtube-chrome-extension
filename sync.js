// Web sync with app.makewebsmart.com — port of sync_service.dart + core_backup's
// SyncClient. Pull web edits, then push a full snapshot. Plain downloads never
// move; files the editor cut (Save, Save as) upload after the push and reach
// the other devices through each video's `files` in the library.
// ponytail: pull-then-push with a basedOn guard — a web edit landing between
// the two is delayed one sync, never lost. Full-snapshot push, no delta.
import * as db from './db.js';
import * as dl from './downloads.js';
import { isClip, descriptionFor, remoteFiles, planFiles } from './clip.js';

export const BASE_URL = 'https://app.makewebsmart.com';
const APP = 'youtube_personal';
const MIN_INTERVAL = 2 * 60 * 1000;
const KEYS = ['syncToken', 'syncEmail', 'syncSince', 'syncSeen', 'syncLastHash', 'syncLastAt', 'syncLastError'];

/** Set by a pull that brought playlists whose videos aren't downloaded here, or files edited elsewhere. */
export const prompts = new EventTarget();

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  if (token && res.status === 401) throw new Error('Token rejected — connect again in Settings');
  let json;
  try { json = await res.json(); } catch { json = { message: `Unexpected reply from server (${res.status})` }; }
  if (!res.ok) throw Object.assign(new Error(json.message ?? `Server error ${res.status}`), { code: json.code });
  return json;
}

export const device = () => `Chrome · ${navigator.userAgentData?.platform || navigator.platform || 'desktop'}`;

/** email + 8-digit PIN from the web's Settings › Devices → stored token. */
export async function pair(email, pin, { fetchMeta = null } = {}) {
  const r = await call('POST', '/api/v1/pair', { body: { email: email.trim(), pin: pin.trim(), app: APP, device: device() } });
  await db.setSetting('syncToken', r.token);
  await db.setSetting('syncEmail', r.email);
  await sync({ manual: true, fetchMeta });
}

export async function disconnect() {
  for (const k of KEYS) await db.deleteSetting(k);
}

let running = false;
export async function sync({ manual = false, fetchMeta = null } = {}) {
  if (running) return;
  const token = await db.getSetting('syncToken');
  if (!token) return;
  if (!manual) {
    const last = await db.getSetting('syncLastAt');
    if (last && Date.now() - Date.parse(last) < MIN_INTERVAL) return;
  }
  running = true;
  try {
    await pull(token, fetchMeta);
    await push(token);
    uploadDue(token); // background: a big file must not hold up the next sync
    await db.setSetting('syncLastAt', new Date().toISOString());
    await db.deleteSetting('syncLastError');
  } catch (e) {
    await db.setSetting('syncLastError', e.message ?? String(e));
  } finally {
    running = false;
  }
}

/** "Delete here and on the server": remove the server copy of d's cut; already gone (404) is fine. */
export async function deleteServerFile(d) {
  const token = await db.getSetting('syncToken');
  if (!token) throw new Error('Not connected to web sync');
  const res = await fetch(`${BASE_URL}/api/v1/youtube/files/${encodeURIComponent(d.videoId)}/${d.kind}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('Token rejected — connect again in Settings');
  if (!res.ok && res.status !== 404) throw new Error(`Server error ${res.status}`);
}

/** "Sync with server" on a finished file the server doesn't have (a plain download, or one kept local). */
export async function syncFile(d) {
  const token = await db.getSetting('syncToken');
  if (!token) return 'Connect web sync in Settings first';
  await db.updateDownload(d.id, { shared: true, localOnly: false });
  uploadDue(token);
  return null;
}

/** The server's synced files for a video, as of the last pull. */
export async function serverFilesOf(videoId) {
  const all = JSON.parse((await db.getSetting('serverFiles')) ?? '{}');
  return remoteFiles(videoId, all[videoId]);
}

/** Queue other devices' files from YouTube, cut to the same parts. */
export async function fetchFromYoutube(files) {
  for (const f of files) {
    await (f.kind === 'audio' ? dl.enqueueAudio : dl.enqueueVideo)(f.videoId, { force: true, replace: true, cutTo: f.segments });
  }
}

/** The prompt's "download them": queue the chosen server files.
export async function fetchFiles(files) {
  const token = await db.getSetting('syncToken');
  if (!token) return;
  for (const f of files) await dl.enqueueServerFile(f, { baseUrl: BASE_URL, token });
}

// ponytail: one upload at a time, whole file, no resume; a failed one goes again next sync.
let uploading = false;
async function uploadDue(token) {
  if (uploading) return;
  uploading = true;
  try {
    for (const d of await db.dueUploads()) {
      try { await dl.uploadFile(d, { baseUrl: BASE_URL, token }); } catch (e) { console.info(e.message ?? e); }
    }
  } finally {
    uploading = false;
  }
}

// ---- pull ----

async function pull(token, fetchMeta) {
  const since = await db.getSetting('syncSince');
  const sinceT = since ? Date.parse(since) : null;
  const lib = await call('GET', '/api/v1/youtube/library', { token });
  const videos = new Map(lib.videos.map((v) => [v.id, v]));

  // Union on EVERY pull, not just a fresh device: the server replaces the tag
  // list of every video a push carries, so a device that never pulled
  // another's tags would wipe them. Only what's new on the server since our
  // last pull is added — what we saw then and no longer have was removed here,
  // and must not come back. Local rows win.
  // ponytail: removals still don't propagate to other devices.
  const seen = JSON.parse((await db.getSetting('syncSeen')) ?? '{}');
  const pairKey = ([v, n]) => `${v}\t${n}`;
  const fresh = (k, items, key = (x) => x) => {
    const was = new Set(seen[k] ?? []);
    return items.filter((x) => !was.has(key(x)));
  };
  for (const c of fresh('categories', lib.categories)) await db.createOrGetCategory(c);
  for (const t of fresh('tags', lib.tags)) await db.createOrGetTag(t);
  for (const v of videos.values()) await upsertVideo(v);
  const files = await serverFilesToFetch(videos.values(), sinceT);
  await db.setSetting('serverFiles', JSON.stringify(Object.fromEntries([...videos.values()]
    .filter((v) => Array.isArray(v.files) && v.files.length).map((v) => [v.id, v.files]))));
  const deleted = await deletedOnServer(videos.values());
  for (const [vid, name] of fresh('videoTags', lib.videoTags, pairKey)) await db.tagVideo(vid, await db.createOrGetTag(name));
  for (const [vid, name] of fresh('videoCategories', lib.videoCategories, pairKey)) {
    await db.categorizeVideo(vid, await db.createOrGetCategory(name));
  }

  const applied = [];
  for (const p of lib.playlists) {
    if (sinceT != null && !(Date.parse(p.updatedAt) > sinceT)) continue;
    const id = await applyPlaylist(p, videos);
    if (id != null) applied.push(id);
  }
  await db.setSetting('syncSince', lib.now);
  await db.setSetting('syncSeen', JSON.stringify({
    categories: lib.categories, tags: lib.tags,
    videoTags: lib.videoTags.map(pairKey), videoCategories: lib.videoCategories.map(pairKey),
  }));
  const missing = new Set();
  if (applied.length) {
    if (fetchMeta) await fillMissingMeta(applied, fetchMeta);
    for (const id of applied) {
      for (const v of await db.playlistVideos(id)) {
        if (!(await db.doneDownload(v.id, 'audio')) && !(await db.doneDownload(v.id, 'video'))) missing.add(v.id);
      }
    }
  }
  if (missing.size || files.length || deleted.length) {
    prompts.dispatchEvent(new CustomEvent('prompt', { detail: { playlistIds: missing.size ? applied : [], missing: missing.size, files, deleted } }));
  }
}

/** Synced files here whose server copy was deleted after they synced — asked until answered. */
async function deletedOnServer(videos) {
  const out = [];
  for (const v of videos) {
    if (!Array.isArray(v.deletedFiles) || !v.deletedFiles.length) continue;
    for (const d of await db.downloadsOf(v.id)) {
      if (d.status !== 'done' || d.syncedAt == null || d.localOnly) continue;
      if (v.deletedFiles.some((g) => g.kind === d.kind && Date.parse(g.deletedAt) > d.syncedAt)) out.push({ d, title: v.title || v.id });
    }
  }
  return out;
}

/** Server files (edited on another device) changed since the last pull that this device should offer — see planFiles. */
async function serverFilesToFetch(videos, since) {
  const out = [];
  for (const v of videos) {
    const remote = remoteFiles(v.id, v.files);
    if (!remote.length) continue;
    let rows = await db.downloadsOf(v.id);
    const clipSegs = isClip(v.id) ? (await db.videoById(v.id))?.segments ?? null : null;
    // A local file already holding the server's cut of its kind is on the server: mark it (no re-upload).
    let marked = false;
    for (const d of rows) {
      if (d.status !== 'done' || d.syncedAt != null) continue;
      const segs = JSON.stringify(d.segments ?? clipSegs ?? null);
      if (remote.some((f) => f.kind === d.kind && JSON.stringify(f.segments ?? null) === segs)) { await db.markSynced(d.id, d.segments ?? null); marked = true; }
    }
    if (marked) rows = await db.downloadsOf(v.id);
    if (since != null && !remote.some((f) => f.updatedAt > since)) continue; // offer only what changed since the last pull
    const local = rows.filter((d) => d.status === 'done')
      .map((d) => ({ kind: d.kind, segs: d.segments ?? clipSegs, pending: d.syncedAt == null && !d.localOnly && db.syncable(d) }));
    for (const f of planFiles(local, remote)) {
      if (!rows.some((d) => d.kind === f.kind && ['queued', 'running', 'muxing'].includes(d.status))) out.push(f); // not already on its way
    }
  }
  return out;
}

/** Local playlist id, or null when the server row is a tombstone. */
async function applyPlaylist(p, videos) {
  const local = await db.playlistByRemoteId(p.id);
  if (p.deletedAt) {
    if (local) await db.deletePlaylist(local.id); // rows only, files stay
    return null;
  }
  let id;
  if (!local) {
    id = await db.createOrGetPlaylist(p.name);
    await db.setPlaylistRemoteId(id, p.id);
  } else {
    id = local.id;
    if (local.name !== p.name) {
      // ponytail: name clash with another local playlist — keep ours; the next push renames the server copy back.
      await db.renamePlaylist(id, p.name).catch(() => {});
    }
  }
  await db.setPlaylistCategory(id, p.category ? await db.createOrGetCategory(p.category) : null);
  const tagIds = [];
  for (const t of p.tags) tagIds.push(await db.createOrGetTag(t));
  await db.replacePlaylistTags(id, tagIds);
  for (const vid of p.videoIds) await upsertVideo(videos.get(vid) ?? { id: vid });
  await db.replacePlaylistEntries(id, p.videoIds);
  return id;
}

async function upsertVideo(v) {
  const extra = { description: typeof v.description === 'string' ? v.description : null, segments: Array.isArray(v.segments) ? v.segments : null };
  await db.upsertVideo({
    id: v.id,
    title: v.title || v.id,
    channel: v.channel ?? '',
    durationMs: +v.durationMs || 0,
    thumbnailUrl: v.thumbnailUrl ?? '',
    addedAt: Date.parse(v.addedAt ?? '') || Date.now(),
    uploadedAt: Date.parse(v.uploadedAt ?? '') || null,
    ...extra,
  });
  await db.applyRemoteVideo(v.id, extra); // an existing row takes web edits too
}

/** Web-added videos come with oEmbed data (no duration) or as bare ids. Best effort. */
async function fillMissingMeta(playlistIds, fetchMeta) {
  const seen = new Set();
  for (const id of playlistIds) {
    for (const v of await db.playlistVideos(id)) {
      if (v.durationMs > 0 || isClip(v.id) || seen.has(v.id)) continue;
      seen.add(v.id);
      try {
        const m = await fetchMeta(v.id);
        await db.updateVideoMeta(v.id, m);
        await db.fillDescription(v.id, descriptionFor(v.id, m.description));
      } catch { /* next sync tries again */ }
    }
  }
}

// ---- push ----

async function push(token) {
  const dirty = await db.dirtyVideos();
  const snapshot = await db.exportLibrary();
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hash === (await db.getSetting('syncLastHash'))) return db.clearDirty(dirty); // the server has it already
  const res = await call('PUT', '/api/v1/youtube/library', { token, body: { ...snapshot, basedOn: await db.getSetting('syncSince') } });
  const ids = res.playlistIds ?? {};
  for (const p of await db.playlists()) {
    const rid = ids[p.name];
    if (rid != null && rid !== p.remoteId) await db.setPlaylistRemoteId(p.id, rid);
  }
  await db.setSetting('syncSince', res.now);
  await db.setSetting('syncLastHash', hash);
  await db.clearDirty(dirty);
}
