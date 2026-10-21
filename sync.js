// Web sync with app.makewebsmart.com — port of sync_service.dart + core_backup's
// SyncClient. Pull web edits, then push a full snapshot. Media never moves.
// ponytail: pull-then-push with a basedOn guard — a web edit landing between
// the two is delayed one sync, never lost. Full-snapshot push, no delta.
import * as db from './db.js';
import { isClip, descriptionFor } from './clip.js';

export const BASE_URL = 'https://app.makewebsmart.com';
const APP = 'youtube_personal';
const MIN_INTERVAL = 2 * 60 * 1000;
const KEYS = ['syncToken', 'syncEmail', 'syncSince', 'syncSeen', 'syncLastHash', 'syncLastAt', 'syncLastError'];

/** Set by a pull that brought playlists whose videos aren't downloaded here. */
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
    await db.setSetting('syncLastAt', new Date().toISOString());
    await db.deleteSetting('syncLastError');
  } catch (e) {
    await db.setSetting('syncLastError', e.message ?? String(e));
  } finally {
    running = false;
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
  if (!applied.length) return;

  if (fetchMeta) await fillMissingMeta(applied, fetchMeta);
  const missing = new Set();
  for (const id of applied) {
    for (const v of await db.playlistVideos(id)) {
      if (!(await db.doneDownload(v.id, 'audio')) && !(await db.doneDownload(v.id, 'video'))) missing.add(v.id);
    }
  }
  if (missing.size) prompts.dispatchEvent(new CustomEvent('prompt', { detail: { playlistIds: applied, missing: missing.size } }));
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
