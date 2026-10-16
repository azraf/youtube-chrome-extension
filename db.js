// IndexedDB 'yt' — mirrors AppDb in apps/youtube_personal/lib/data/db.dart
// (same names). Dates are epoch ms. Every write fires `changed` so the open
// view re-renders; names are unique, so a clash rejects with ConstraintError.
// ponytail: every transaction spans every store and lists use getAll+sort —
// fine for a personal library; add indexes/cursors past ~50k rows.

const STORES = ['videos', 'playlists', 'playlistEntries', 'categories', 'tags', 'videoTags', 'videoCategories',
  'playlistTags', 'downloads', 'settings'];

export const changed = new EventTarget();

let dbp = null;
function open() {
  return (dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open('yt', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('videos', { keyPath: 'id' });
      const p = d.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
      p.createIndex('name', 'name', { unique: true });
      p.createIndex('remoteId', 'remoteId'); // null remoteIds simply aren't indexed
      for (const n of ['categories', 'tags']) {
        d.createObjectStore(n, { keyPath: 'id', autoIncrement: true }).createIndex('name', 'name', { unique: true });
      }
      for (const [n, a, b] of [['playlistEntries', 'playlistId', 'videoId'], ['videoTags', 'videoId', 'tagId'],
        ['videoCategories', 'videoId', 'categoryId'], ['playlistTags', 'playlistId', 'tagId']]) {
        const s = d.createObjectStore(n, { keyPath: [a, b] });
        s.createIndex(a, a);
        s.createIndex(b, b);
      }
      d.createObjectStore('downloads', { keyPath: 'id', autoIncrement: true }).createIndex('videoId', 'videoId');
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  }));
}

const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

/** Run fn(stores) in one transaction. fn must only await IDB requests. */
async function tx(mode, fn, { silent = false } = {}) {
  const t = (await open()).transaction(STORES, mode);
  const done = new Promise((ok, no) => { t.oncomplete = ok; t.onabort = () => no(t.error); });
  let out;
  try {
    out = await fn(Object.fromEntries(STORES.map((n) => [n, t.objectStore(n)])));
  } catch (e) {
    try { t.abort(); } catch { /* already aborting */ }
    await done.catch(() => {});
    throw e;
  }
  await done;
  if (mode === 'readwrite' && !silent) changed.dispatchEvent(new Event('change'));
  return out;
}
const rd = (fn) => tx('readonly', fn);
const wr = (fn, o) => tx('readwrite', fn, o);
const all = (store, index, key) => req((index ? store.index(index) : store).getAll(key));
const delIdx = async (store, index, key) => {
  for (const k of await req(store.index(index).getAllKeys(key))) await req(store.delete(k));
};
const patch = async (store, key, p) => {
  const row = await req(store.get(key));
  if (row) await req(store.put({ ...row, ...p }));
  return row;
};
const byName = (a, b) => a.name.localeCompare(b.name);
const byTitle = (a, b) => a.title.localeCompare(b.title);
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const getOrAdd = async (store, name, row) => (await req(store.index('name').getKey(name))) ?? req(store.add({ name, ...row }));

// ---- videos ----

/** Insert if new, otherwise keep the existing row (duplicate URL detection). */
export const upsertVideo = (v) => wr(async (s) => {
  if (await req(s.videos.getKey(v.id))) return;
  await req(s.videos.add({ title: v.id, channel: '', durationMs: 0, thumbnailUrl: '', addedAt: Date.now(),
    lastPlayedAt: null, resumePositionMs: 0, uploadedAt: null, ...defined(v) }));
});
export const videoById = (id) => rd((s) => req(s.videos.get(id)));
export const markPlayed = (id) => wr((s) => patch(s.videos, id, { lastPlayedAt: Date.now() }));
// Silent: fires every 5 s while playing; nothing on screen shows it.
export const saveResumePosition = (id, ms) => wr((s) => patch(s.videos, id, { resumePositionMs: ms }), { silent: true });
export const updateVideoMeta = (id, { title, channel, durationMs, thumbnailUrl, uploadedAt }) =>
  wr((s) => patch(s.videos, id, defined({ title, channel, durationMs, thumbnailUrl, uploadedAt })));

const recent = (key, limit) => rd((s) => all(s.videos)).then((vs) =>
  vs.filter((v) => v[key]).sort((a, b) => b[key] - a[key]).slice(0, limit));
export const recentlyAdded = (limit = 5) => recent('addedAt', limit);
export const recentlyPlayed = (limit = 5) => recent('lastPlayedAt', limit);

// ---- playlists ----

export const playlists = () => rd((s) => all(s.playlists)).then((ps) => ps.sort(byName));
export const playlistById = (id) => rd((s) => req(s.playlists.get(id)));

/** Library list: name search + category/tag filter. */
export const playlistsFiltered = ({ search = '', categoryId = null, tagId = null } = {}) => rd(async (s) => {
  let ps = await all(s.playlists);
  const q = search.trim().toLowerCase();
  if (q) ps = ps.filter((p) => p.name.toLowerCase().includes(q));
  if (categoryId) ps = ps.filter((p) => p.categoryId === categoryId);
  if (tagId) {
    const ids = new Set((await all(s.playlistTags, 'tagId', tagId)).map((x) => x.playlistId));
    ps = ps.filter((p) => ids.has(p.id));
  }
  return ps.sort(byName);
});

/** playlistId → number of entries. */
export const playlistCounts = () => rd(async (s) => {
  const m = new Map();
  for (const e of await all(s.playlistEntries)) m.set(e.playlistId, (m.get(e.playlistId) ?? 0) + 1);
  return m;
});

export const createOrGetPlaylist = (name) =>
  wr((s) => getOrAdd(s.playlists, name, { categoryId: null, createdAt: Date.now(), remoteId: null }));

async function addEntry(s, playlistId, videoId) {
  if (await req(s.playlistEntries.getKey([playlistId, videoId]))) return;
  const es = await all(s.playlistEntries, 'playlistId', playlistId);
  const position = es.reduce((m, e) => Math.max(m, e.position), -1) + 1;
  await req(s.playlistEntries.add({ playlistId, videoId, position }));
}
export const addVideoToPlaylist = (playlistId, videoId) => wr((s) => addEntry(s, playlistId, videoId));
export const removeVideoFromPlaylist = (playlistId, videoId) =>
  wr((s) => req(s.playlistEntries.delete([playlistId, videoId])));
/** Add to toId (appended) and drop from fromId, atomically. */
export const moveVideoToPlaylist = (fromId, toId, videoId) => wr(async (s) => {
  await addEntry(s, toId, videoId);
  await req(s.playlistEntries.delete([fromId, videoId]));
});
export const reorderPlaylist = (playlistId, videoIds) => wr(async (s) => {
  for (const [i, videoId] of videoIds.entries()) await patch(s.playlistEntries, [playlistId, videoId], { position: i });
});
export const deletePlaylist = (id) => wr(async (s) => {
  await req(s.playlists.delete(id));
  await delIdx(s.playlistEntries, 'playlistId', id);
  await delIdx(s.playlistTags, 'playlistId', id);
});
export const setPlaylistCategory = (id, categoryId) => wr((s) => patch(s.playlists, id, { categoryId }));
/** Rejects (ConstraintError) on a name clash; callers surface that. */
export const renamePlaylist = (id, name) => wr((s) => patch(s.playlists, id, { name }));
export const setPlaylistRemoteId = (id, remoteId) => wr((s) => patch(s.playlists, id, { remoteId }));
export const playlistByRemoteId = (remoteId) => rd((s) => req(s.playlists.index('remoteId').get(remoteId)));

/** Server order wins: the playlist becomes exactly videoIds. */
export const replacePlaylistEntries = (playlistId, videoIds) => wr(async (s) => {
  await delIdx(s.playlistEntries, 'playlistId', playlistId);
  for (const [position, videoId] of [...new Set(videoIds)].entries()) {
    await req(s.playlistEntries.add({ playlistId, videoId, position }));
  }
});
export const replacePlaylistTags = (playlistId, tagIds) => wr(async (s) => {
  await delIdx(s.playlistTags, 'playlistId', playlistId);
  for (const tagId of new Set(tagIds)) await req(s.playlistTags.add({ playlistId, tagId }));
});

export const playlistVideos = (playlistId) => rd(async (s) => {
  const es = (await all(s.playlistEntries, 'playlistId', playlistId)).sort((a, b) => a.position - b.position);
  return (await Promise.all(es.map((e) => req(s.videos.get(e.videoId))))).filter(Boolean);
});
export const playlistTags = (playlistId) => rd(async (s) =>
  (await Promise.all((await all(s.playlistTags, 'playlistId', playlistId)).map((x) => req(s.tags.get(x.tagId)))))
    .filter(Boolean).sort(byName));

// ---- categories & tags ----

export const categories = () => rd((s) => all(s.categories)).then((cs) => cs.sort(byName));
export const createOrGetCategory = (name) => wr((s) => getOrAdd(s.categories, name));
export const deleteCategory = (id) => wr(async (s) => {
  await req(s.categories.delete(id));
  await delIdx(s.videoCategories, 'categoryId', id);
  for (const p of await all(s.playlists)) if (p.categoryId === id) await req(s.playlists.put({ ...p, categoryId: null }));
});
export const categorizeVideo = (videoId, categoryId) => wr((s) => req(s.videoCategories.put({ videoId, categoryId })));
export const uncategorizeVideo = (videoId, categoryId) => wr((s) => req(s.videoCategories.delete([videoId, categoryId])));

export const tags = () => rd((s) => all(s.tags)).then((ts) => ts.sort(byName));
export const createOrGetTag = (name) => wr((s) => getOrAdd(s.tags, name));
export const deleteTag = (id) => wr(async (s) => {
  await req(s.tags.delete(id));
  await delIdx(s.videoTags, 'tagId', id);
  await delIdx(s.playlistTags, 'tagId', id);
});
export const tagVideo = (videoId, tagId) => wr((s) => req(s.videoTags.put({ videoId, tagId })));
export const untagVideo = (videoId, tagId) => wr((s) => req(s.videoTags.delete([videoId, tagId])));
export const tagPlaylist = (playlistId, tagId) => wr((s) => req(s.playlistTags.put({ playlistId, tagId })));
export const untagPlaylist = (playlistId, tagId) => wr((s) => req(s.playlistTags.delete([playlistId, tagId])));

const videosVia = (store, index, key) => rd(async (s) =>
  (await Promise.all((await all(s[store], index, key)).map((x) => req(s.videos.get(x.videoId))))).filter(Boolean).sort(byTitle));
export const videosByTag = (tagId) => videosVia('videoTags', 'tagId', tagId);
export const videosByCategory = (categoryId) => videosVia('videoCategories', 'categoryId', categoryId);
export const playlistsByTag = (tagId) => rd(async (s) =>
  (await Promise.all((await all(s.playlistTags, 'tagId', tagId)).map((x) => req(s.playlists.get(x.playlistId)))))
    .filter(Boolean).sort(byName));

/** Playlists / categories / tags that EVERY one of videoIds already has — what the add dialog pre-checks. */
export const sharedMembership = (videoIds) => rd(async (s) => {
  const shared = async (store, col) => {
    let acc = null;
    for (const v of videoIds) {
      const ids = new Set((await all(s[store], 'videoId', v)).map((r) => r[col]));
      acc = acc ? new Set([...acc].filter((x) => ids.has(x))) : ids;
    }
    return acc ?? new Set();
  };
  return {
    playlists: await shared('playlistEntries', 'playlistId'),
    categories: await shared('videoCategories', 'categoryId'),
    tags: await shared('videoTags', 'tagId'),
  };
});

// ---- downloads ----

/** Completed download of kind for a video, if any. */
export const doneDownload = (videoId, kind) => rd((s) => all(s.downloads, 'videoId', videoId))
  .then((ds) => ds.find((d) => d.kind === kind && d.status === 'done') ?? null);
export const downloadsOf = (videoId) => rd((s) => all(s.downloads, 'videoId', videoId));
export const insertDownload = (d) => wr((s) => req(s.downloads.add({ fileName: null, fileSize: null, completedAt: null,
  expiresAt: null, error: null, ...d })));
export const updateDownload = (id, p) => wr((s) => patch(s.downloads, id, p));
export const downloadById = (id) => rd((s) => req(s.downloads.get(id)));
export const setDownloadExpiry = (id, expiresAt) => updateDownload(id, { expiresAt });
export const deleteDownloadRow = (id) => wr((s) => req(s.downloads.delete(id)));
export const downloadsInStatus = (statuses) => rd((s) => all(s.downloads)).then((ds) => ds.filter((d) => statuses.includes(d.status)));
/** Newest first, each with its video. */
export const downloadsWithVideo = () => rd(async (s) => {
  const ds = (await all(s.downloads)).sort((a, b) => b.createdAt - a.createdAt);
  return Promise.all(ds.map(async (d) => ({ ...d, video: (await req(s.videos.get(d.videoId))) ?? { id: d.videoId, title: d.videoId, channel: '' } })));
});
export const storageUsed = () => downloadsInStatus(['done']).then((ds) =>
  ({ count: ds.length, bytes: ds.reduce((n, d) => n + (d.fileSize ?? 0), 0) }));

// ---- sync snapshot ----

/** The library minus downloads/settings in the web API's JSON shape (db.dart exportLibrary). */
export const exportLibrary = () => rd(async (s) => {
  const [vids, cats, tgs, pls, entries, plTags, vTags, vCats] = await Promise.all(
    ['videos', 'categories', 'tags', 'playlists', 'playlistEntries', 'playlistTags', 'videoTags', 'videoCategories'].map((n) => all(s[n])));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const tagName = new Map(tgs.map((t) => [t.id, t.name]));
  const group = (rows, key, val) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), val(r)]), new Map());
  const entriesByPl = group(entries.sort((a, b) => a.position - b.position), 'playlistId', (e) => e.videoId);
  const tagsByPl = group(plTags, 'playlistId', (t) => tagName.get(t.tagId));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    videos: vids.sort((a, b) => a.addedAt - b.addedAt).map((v) => ({
      id: v.id, title: v.title, channel: v.channel, durationMs: v.durationMs, thumbnailUrl: v.thumbnailUrl,
      uploadedAt: iso(v.uploadedAt), addedAt: iso(v.addedAt),
    })),
    categories: cats.map((c) => c.name),
    tags: tgs.map((t) => t.name),
    playlists: pls.sort((a, b) => a.id - b.id).map((p) => ({
      name: p.name, remoteId: p.remoteId ?? null, category: catName.get(p.categoryId) ?? null,
      tags: tagsByPl.get(p.id) ?? [], videoIds: entriesByPl.get(p.id) ?? [],
    })),
    videoTags: vTags.map((x) => [x.videoId, tagName.get(x.tagId)]),
    videoCategories: vCats.map((x) => [x.videoId, catName.get(x.categoryId)]),
  };
});

// ---- settings (KvSettings) ----

export const getSetting = (key) => rd((s) => req(s.settings.get(key))).then((r) => r?.value ?? null);
export const setSetting = (key, value) => wr((s) => req(s.settings.put({ key, value: String(value) })));
export const deleteSetting = (key) => wr((s) => req(s.settings.delete(key)));
