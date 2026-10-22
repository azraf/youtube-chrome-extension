// The app tab: hash routes, views, dialogs, player bar. Ports the screens of
// apps/youtube_personal (home, playlists, tags, downloads, search, settings).
// Views re-render whole on every db change (debounced); fine at this scale.
import * as db from './db.js';
import * as yt from './yt.js';
import * as dl from './downloads.js';
import * as player from './player.js';
import * as sync from './sync.js';
import { extractVideoId, extractPlaylistId, isPlaylistUrl, parseInput, extractUrls } from './parse.js';
import { isClip, sourceOf, descriptionFor } from './clip.js';
import { openEditor } from './editor.js';
import * as upd from './update.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (ms) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
};
const fmtBytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB`
  : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const fmtEta = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
/** Live progress of a download: bar value 0..1 and its one-line description. */
const progressFraction = (p) => (p?.phase === 'merging' || p?.phase === 'cutting' ? p.fraction : p?.total ? p.got / p.total : 0);
function progressText(p, status) {
  if (status === 'queued') return 'waiting in queue';
  if (!p) return status === 'muxing' ? 'merging video + audio…' : 'starting…';
  if (p.phase === 'merging') return `merging video + audio… ${Math.round(p.fraction * 100)}%`;
  if (p.phase === 'cutting') return `cutting to the edited part… ${Math.round(p.fraction * 100)}%`;
  return [
    p.total ? `${Math.floor((p.got / p.total) * 100)}%` : null,
    p.total ? `${fmtBytes(p.got)} / ${fmtBytes(p.total)}` : fmtBytes(p.got),
    p.bps ? `${fmtBytes(p.bps)}/s` : null,
    p.bps && p.total ? `${fmtEta((p.total - p.got) / p.bps)} left` : null,
  ].filter(Boolean).join(' · ');
}
const fmtDate = (ms) => new Date(ms).toLocaleString();
const SYNC_ERRORS = {
  confirm_email: 'Confirm your email first — open the link we emailed you, then connect again.',
  bad_pin: 'Invalid or expired PIN.',
  not_approved: 'Your account is not approved yet.',
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 4000);
}

/** One <dialog>; resolves with the form's FormData on "ok", else null. */
function dialog(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => {
    d.onclose = () => resolve(d.returnValue === 'ok' ? new FormData(d.querySelector('form')) : null);
  });
}
const buttons = (ok = 'Save') =>
  `<menu><button value="cancel" class="secondary" formnovalidate>Cancel</button><button value="ok">${ok}</button></menu>`;

// ------------------------------------------------------------------ library ops

/** Ensure a videos row exists (fetching metadata if new). */
async function ensureVideo(id, meta = null) {
  if (await db.videoById(id)) return;
  meta ??= await yt.fetchMeta(id);
  // Search/playlist items carry no description: null, filled when first played.
  const description = meta.description != null ? descriptionFor(id, meta.description) : null;
  await db.upsertVideo({ ...meta, id, thumbnailUrl: meta.thumbnailUrl || yt.thumbOf(id), addedAt: Date.now(), description });
}

/** library_actions.dart addInput: videos, optional playlist, per-URL tags. */
async function addInput(text) {
  const parsed = parseInput(text);
  const urlToId = new Map();
  for (const u of parsed.urls) {
    const id = extractVideoId(u);
    if (id) urlToId.set(u, id);
  }
  if (!urlToId.size) throw new Error('No YouTube video links found.');
  const ids = [...new Set(urlToId.values())];
  const results = await Promise.allSettled(ids.map((id) => ensureVideo(id)));
  const ok = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'));
  if (!ok.size) throw new Error(`None of the links could be loaded: ${results[0].reason?.message ?? ''}`);
  let playlistId = null;
  if (parsed.playlistName) {
    playlistId = await db.createOrGetPlaylist(parsed.playlistName);
    for (const id of ids) if (ok.has(id)) await db.addVideoToPlaylist(playlistId, id);
  }
  const tagIds = new Set();
  for (const [url, labels] of Object.entries(parsed.tagsByUrl)) {
    const vid = urlToId.get(url);
    if (!vid || !ok.has(vid)) continue;
    for (const name of labels) {
      const t = await db.createOrGetTag(name);
      await db.tagVideo(vid, t);
      tagIds.add(t);
    }
  }
  return { videoIds: ids.filter((id) => ok.has(id)), playlistId, tagIds };
}

async function videosOf(ids) {
  return (await Promise.all(ids.map((id) => db.videoById(id)))).filter(Boolean);
}

const LANGUAGES = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ur', 'Urdu'], ['tr', 'Turkish'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['pl', 'Polish'], ['nl', 'Dutch']];
const langOf = (trackId) => trackId.split(/[.-]/)[0];

/**
 * Which audio track to download a single video with. Asks only when YouTube
 * offers several (dubs), preselecting the preferred language.
 * @returns a track id, undefined (one track — nothing to choose), or null (cancelled)
 */
async function pickTrack(videoId) {
  toast('Checking audio tracks…');
  const r = await yt.resolve(sourceOf(videoId)); // a clip downloads its source's track
  if (r.audioTracks.length < 2) return undefined;
  const sel = yt.trackFor(r, (await db.getSetting('audioLanguage')) ?? '');
  const fd = await dialog(`<form method="dialog"><h2>Audio track</h2>
    <p class="muted">${esc(r.title)} has ${r.audioTracks.length} audio tracks.</p>
    <fieldset><legend>Download with</legend>${r.audioTracks.map((t) => `<label><input type="radio" name="track" value="${esc(t.id)}" ${t.id === sel ? 'checked' : ''}>
      ${esc(t.name)}${t.isDefault ? ' <span class="muted">(original)</span>' : ''}</label>`).join('')}</fieldset>
    <label><input type="checkbox" name="remember"> Use this language by default (downloads and playback)</label>
    ${buttons('Download')}</form>`);
  if (!fd) return null;
  const id = fd.get('track');
  if (fd.get('remember')) await db.setSetting('audioLanguage', id === r.defaultTrack ? '' : langOf(id));
  return id;
}

/** Enqueue several; paced like the app's bulk download. One video: ask for its audio track
 *  (unless `track` is given); several: the preferred language from Settings. */
async function enqueueMany(kind, ids, track) {
  if (!ids.length || kind === 'none') return;
  if (ids.length === 1 && track === undefined) {
    track = await pickTrack(ids[0]);
    if (track === null) return;
  }
  toast(`Preparing ${ids.length > 1 ? `${ids.length} downloads` : 'download'}…`);
  const counts = { queued: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    const r = await (kind === 'audio' ? dl.enqueueAudio(id, { track }) : dl.enqueueVideo(id, { track }));
    counts[r]++;
    if (r === 'queued' && ids.length > 1) await sleep(2000);
  }
  toast(`${counts.queued} queued · ${counts.skipped} already downloaded · ${counts.failed} failed`);
}

/** Paste box / popup / context menu entry point. kind: 'audio'|'video'|null (null = ask). */
async function submitPaste(text, { play = false, kind = null } = {}) {
  const urls = extractUrls(text).length ? extractUrls(text) : [text.trim()];
  const plUrl = urls.find(isPlaylistUrl);
  const hasVideos = urls.some((u) => extractVideoId(u));
  if (plUrl) {
    await importDialog(extractPlaylistId(plUrl), kind ?? 'none');
    if (!hasVideos) return;
  }
  toast('Adding…');
  const r = await addInput(text);
  if (play) { location.hash = '#now'; return player.playItems(await videosOf(r.videoIds), 0); }
  if (kind) {
    toast(`Added ${r.videoIds.length} video${r.videoIds.length > 1 ? 's' : ''}`);
    return enqueueMany(kind, r.videoIds);
  }
  await addDialog(r.videoIds, r);
}

function checks(name, items, checked) {
  return items.map((x) => `<label><input type="checkbox" name="${name}" value="${x.id}" ${checked.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('');
}
const kindRadios = (selected) => ['video', 'audio', 'none'].map((k) =>
  `<label><input type="radio" name="kind" value="${k}" ${k === selected ? 'checked' : ''}> ${{ video: 'Video', audio: 'Audio', none: "Don't download" }[k]}</label>`).join('');

/** Add-to-library dialog: playlists / tags / categories pre-checked when every video has them. */
async function addDialog(videoIds, { playlistId = null, tagIds = new Set() } = {}) {
  const [pls, tags, cats, shared] = await Promise.all([db.playlists(), db.tags(), db.categories(), db.sharedMembership(videoIds)]);
  const pre = {
    pl: new Set([...shared.playlists, ...(playlistId ? [playlistId] : [])]),
    tag: new Set([...shared.tags, ...tagIds]),
    cat: shared.categories,
  };
  const n = videoIds.length;
  const fd = await dialog(`<form method="dialog">
    <h2>${n === 1 ? esc((await db.videoById(videoIds[0]))?.title) : `${n} videos`}</h2>
    <fieldset><legend>Playlists</legend>${checks('pl', pls, pre.pl)}<input name="newPl" placeholder="New playlist"></fieldset>
    <fieldset><legend>Tags</legend>${checks('tag', tags, pre.tag)}<input name="newTag" placeholder="New tag"></fieldset>
    <fieldset><legend>Categories</legend>${checks('cat', cats, pre.cat)}<input name="newCat" placeholder="New category"></fieldset>
    <fieldset><legend>Download</legend>${kindRadios('video')}</fieldset>
    ${buttons()}</form>`);
  if (!fd) return;
  const want = async (name, create) => {
    const s = new Set(fd.getAll(name).map(Number));
    const fresh = fd.get(`new${name[0].toUpperCase()}${name.slice(1)}`)?.trim();
    if (fresh) s.add(await create(fresh));
    return s;
  };
  const wantPl = await want('pl', db.createOrGetPlaylist);
  const wantTag = await want('tag', db.createOrGetTag);
  const wantCat = await want('cat', db.createOrGetCategory);
  for (const vid of videoIds) {
    for (const p of wantPl) if (!pre.pl.has(p)) await db.addVideoToPlaylist(p, vid);
    for (const p of pre.pl) if (!wantPl.has(p)) await db.removeVideoFromPlaylist(p, vid);
    for (const t of wantTag) if (!pre.tag.has(t)) await db.tagVideo(vid, t);
    for (const t of pre.tag) if (!wantTag.has(t)) await db.untagVideo(vid, t);
    for (const c of wantCat) if (!pre.cat.has(c)) await db.categorizeVideo(vid, c);
    for (const c of pre.cat) if (!wantCat.has(c)) await db.uncategorizeVideo(vid, c);
  }
  await enqueueMany(fd.get('kind'), videoIds);
}

/** Import a YouTube playlist: pick videos, name it, optionally download. */
async function importDialog(ytId, kind = 'none') {
  toast('Loading playlist…');
  const pl = await yt.playlist(ytId, (n) => toast(`Loading playlist… ${n} videos`));
  const fd = await dialog(`<form method="dialog">
    <h2>Import playlist</h2>
    <label>Name <input name="name" value="${esc(pl.title)}" required></label>
    <p><label><input type="checkbox" data-change="toggleAll" checked> All ${pl.items.length} videos</label></p>
    <ul class="checklist">${pl.items.map((v, i) => `<li><label><input type="checkbox" name="v" value="${i}" checked>
      <span>${esc(v.title)} <span class="muted">${esc(v.channel)} ${fmtDur(v.durationMs)}</span></span></label></li>`).join('')}</ul>
    <fieldset><legend>Download</legend>${kindRadios(kind)}</fieldset>
    ${buttons('Import')}</form>`);
  if (!fd) return;
  const chosen = fd.getAll('v').map((i) => pl.items[+i]);
  if (!chosen.length) return;
  const pid = await db.createOrGetPlaylist(fd.get('name').trim());
  for (const v of chosen) {
    await db.upsertVideo({ ...v, thumbnailUrl: yt.thumbOf(v.id), addedAt: Date.now() });
    await db.addVideoToPlaylist(pid, v.id);
  }
  toast(`Imported ${chosen.length} videos`);
  location.hash = `#playlist/${pid}`;
  const k = fd.get('kind');
  if (k !== 'none') {
    const [q, s, f] = await dl.downloadPlaylist(pid, k);
    toast(`${q} queued · ${s} already downloaded · ${f} failed`);
  }
}

// ------------------------------------------------------------------ views

/** Named video lists on the current page, for "play from here". */
const lists = {};
let doneKinds = new Map();
async function loadDone() {
  doneKinds = new Map();
  for (const d of await db.downloadsInStatus(['done'])) {
    doneKinds.set(d.videoId, [...(doneKinds.get(d.videoId) ?? []), d.kind]);
  }
}

function videoRows(listName, videos, extra = () => '') {
  lists[listName] = videos;
  if (!videos.length) return '<p class="muted">Nothing here yet.</p>';
  return `<ul class="vlist">${videos.map((v, i) => {
    const kinds = doneKinds.get(v.id) ?? [];
    return `<li class="vrow">
      <img class="thumb" alt="" data-thumb="${esc(v.id)}" data-src="${esc(v.thumbnailUrl)}">
      <div class="meta"><div class="title" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="muted">${esc(v.channel)} ${fmtDur(v.durationMs)}${isClip(v.id) ? '<span class="badge" title="Cut from a YouTube video">clip</span>' : ''}${kinds.map((k) => `<span class="badge ok">${k}</span>`).join('')}</div></div>
      <div class="acts">
        <button class="icon" data-act="play" data-list="${listName}" data-i="${i}" title="Play" aria-label="Play">▶</button>
        ${listName === 'search' ? '' : `<button class="icon" data-act="addDialog" data-id="${esc(v.id)}" title="Playlists, tags, categories…" aria-label="Organise">＋</button>`}
        <button class="icon" data-act="dlAudio" data-list="${listName}" data-i="${i}" title="Download audio" aria-label="Download audio">♪</button>
        <button class="icon" data-act="dlVideo" data-list="${listName}" data-i="${i}" title="Download video" aria-label="Download video">⬇</button>
        ${extra(v, i)}
      </div></li>`;
  }).join('')}</ul>`;
}

const options = (items, selected, none) =>
  `<option value="">${none}</option>${items.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;

const plFilter = { search: '', tagId: null, categoryId: null };

async function library() {
  const [added, played, pls, counts, tags, cats] = await Promise.all([
    db.recentlyAdded(), db.recentlyPlayed(), db.playlistsFiltered(plFilter), db.playlistCounts(), db.tags(), db.categories()]);
  if (!added.length) {
    return `<section class="card"><h2>Welcome</h2><p class="muted">Paste a YouTube video, shorts or playlist link above, or use the toolbar button on a YouTube page.</p>
      <p class="muted">Coming from version 0.2 or older? This version has a fixed ID, so it starts with an empty library once.
        <a href="#settings">Connect web sync</a> to bring your playlists back; downloads need downloading again.
        From now on, updates keep everything.</p></section>`;
  }
  return `
    <section class="card"><h2>Recently added</h2>${videoRows('added', added)}</section>
    ${played.length ? `<section class="card"><h2>Recently played</h2>${videoRows('played', played)}</section>` : ''}
    <section class="card"><h2>Playlists</h2>
      <div class="filters">
        <input id="pl-search" type="search" placeholder="Filter playlists" aria-label="Filter playlists" value="${esc(plFilter.search)}" data-input="plSearch">
        <select data-change="plTag" aria-label="Tag filter">${options(tags, plFilter.tagId, 'All tags')}</select>
        <select data-change="plCat" aria-label="Category filter">${options(cats, plFilter.categoryId, 'All categories')}</select>
      </div>
      ${pls.length ? `<ul class="plist">${pls.map((p) => `<li><a href="#playlist/${p.id}">${esc(p.name)}</a>
        <span class="muted">${counts.get(p.id) ?? 0} videos</span>
        <button class="icon" data-act="playPlaylist" data-id="${p.id}" title="Play" aria-label="Play ${esc(p.name)}">▶</button></li>`).join('')}</ul>`
        : '<p class="muted">No playlists match.</p>'}
    </section>
    <section class="card"><h2>Tags</h2><div class="chips">${tags.map((t) => `<a href="#tag/${t.id}">${esc(t.name)}</a>`).join('') || '<span class="muted">None yet.</span>'}</div></section>
    <section class="card"><h2>Categories</h2><div class="chips">${cats.map((c) => `<a href="#category/${c.id}">${esc(c.name)}</a>`).join('') || '<span class="muted">None yet.</span>'}</div></section>`;
}

async function playlistView(arg) {
  const id = +arg;
  const p = await db.playlistById(id);
  if (!p) return '<section class="card"><p>Playlist not found. <a href="#library">Back</a></p></section>';
  const [vs, ptags, cats] = await Promise.all([db.playlistVideos(id), db.playlistTags(id), db.categories()]);
  const last = vs.length - 1;
  return `<section class="card">
    <h2>${esc(p.name)} <span class="muted">${vs.length} videos${p.remoteId ? ' · synced' : ''}</span></h2>
    <div class="row">
      <button data-act="playPlaylist" data-id="${id}">Play all</button>
      <button class="secondary" data-act="shufflePlaylist" data-id="${id}">Shuffle play</button>
      <button class="secondary" data-act="dlPlaylist" data-id="${id}" data-kind="audio">Download all audio</button>
      <button class="secondary" data-act="dlPlaylist" data-id="${id}" data-kind="video">Download all video</button>
      <button class="secondary" data-act="renamePlaylist" data-id="${id}">Rename</button>
      <button class="danger" data-act="deletePlaylistDownloads" data-id="${id}">Delete downloads</button>
      <button class="danger" data-act="deletePlaylist" data-id="${id}">Delete playlist</button>
    </div>
    <div class="row">
      <label>Category <select data-change="plCategory" data-id="${id}">${options(cats, p.categoryId, 'None')}</select></label>
      <span class="chips">${ptags.map((t) => `<button class="chip" data-act="untagPlaylist" data-id="${id}" data-tag="${t.id}" title="Remove tag ${esc(t.name)}">${esc(t.name)} ×</button>`).join('')}</span>
      <form data-submit="tagPlaylist" data-id="${id}" class="row" style="margin:0"><input name="tag" placeholder="Add tag" aria-label="Add tag"></form>
    </div>
  </section>
  <section class="card">${videoRows('pl', vs, (v, i) => `
    <button class="icon" data-act="moveEntry" data-id="${id}" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">↑</button>
    <button class="icon" data-act="moveEntry" data-id="${id}" data-i="${i}" data-dir="1" ${i === last ? 'disabled' : ''} title="Move down" aria-label="Move down">↓</button>
    <button class="icon" data-act="moveToPlaylist" data-id="${id}" data-video="${esc(v.id)}" title="Move to another playlist" aria-label="Move to another playlist">⇄</button>
    <button class="icon" data-act="removeEntry" data-id="${id}" data-video="${esc(v.id)}" title="Remove from playlist" aria-label="Remove from playlist">✕</button>`)}
  </section>`;
}

async function tagView(arg) {
  const id = +arg;
  const t = (await db.tags()).find((x) => x.id === id);
  if (!t) return '<section class="card"><p>Tag not found. <a href="#library">Back</a></p></section>';
  const [vs, pls] = await Promise.all([db.videosByTag(id), db.playlistsByTag(id)]);
  return `<section class="card"><h2>Tag: ${esc(t.name)}</h2>
    <div class="chips">${pls.map((p) => `<a href="#playlist/${p.id}">${esc(p.name)}</a>`).join('')}</div>
    <div class="row"><button class="danger" data-act="deleteTag" data-id="${id}">Delete tag</button></div></section>
    <section class="card">${videoRows('tag', vs, (v) => `<button class="icon" data-act="untagVideo" data-id="${id}" data-video="${esc(v.id)}" title="Remove tag" aria-label="Remove tag">✕</button>`)}</section>`;
}

async function categoryView(arg) {
  const id = +arg;
  const c = (await db.categories()).find((x) => x.id === id);
  if (!c) return '<section class="card"><p>Category not found. <a href="#library">Back</a></p></section>';
  const [vs, pls] = await Promise.all([db.videosByCategory(id), db.playlists()]);
  return `<section class="card"><h2>Category: ${esc(c.name)}</h2>
    <div class="chips">${pls.filter((p) => p.categoryId === id).map((p) => `<a href="#playlist/${p.id}">${esc(p.name)}</a>`).join('')}</div>
    <div class="row"><button class="danger" data-act="deleteCategory" data-id="${id}">Delete category</button></div></section>
    <section class="card">${videoRows('cat', vs, (v) => `<button class="icon" data-act="uncategorizeVideo" data-id="${id}" data-video="${esc(v.id)}" title="Remove from category" aria-label="Remove from category">✕</button>`)}</section>`;
}

const EXPIRY = [['', 'Keep'], ['1', 'Remove after 1 day'], ['7', 'Remove after 7 days'], ['30', 'Remove after 30 days']];

async function downloadsView() {
  const ds = await db.downloadsWithVideo();
  lists.dl = ds.map((d) => d.video);
  if (!ds.length) return '<section class="card"><h2>Downloads</h2><p class="muted">No downloads yet.</p></section>';
  const failed = ds.filter((d) => d.status === 'failed').length;
  return `<section class="card"><h2>Downloads</h2>
    ${failed > 1 ? `<div class="row"><button class="secondary" data-act="retryFailed">Retry all failed (${failed})</button></div>` : ''}
    <ul class="vlist">${ds.map((d, i) => `
    <li class="vrow">
      <img class="thumb" alt="" data-thumb="${esc(d.videoId)}" data-src="${esc(d.video.thumbnailUrl)}">
      <div class="meta"><div class="title" title="${esc(d.video.title)}">${esc(d.video.title)}</div>
        <div class="muted"><span class="badge">${d.kind}${d.kind === 'video' && d.quality ? ` ${esc(d.quality)}` : ''}</span>
          ${d.audioTrack ? `<span class="badge" title="Audio track">${esc(d.audioTrack)}</span>` : ''}
          <span class="badge ${d.status === 'done' ? 'ok' : d.status === 'failed' ? 'bad' : ''}">${d.status}</span>
          ${d.fileSize ? fmtBytes(d.fileSize) : ''}
          ${d.status === 'done' && d.expiresAt ? `· removes ${fmtDate(d.expiresAt)}` : ''}</div>
        ${['queued', 'running', 'muxing'].includes(d.status) ? `<div class="prog">
          <progress id="p-${d.id}" max="1" value="${progressFraction(dl.progress.get(d.id))}"></progress>
          <span id="pt-${d.id}" class="muted">${progressText(dl.progress.get(d.id), d.status)}</span></div>` : ''}
        ${d.error ? `<div class="error">${esc(d.error)}</div>` : ''}</div>
      <div class="acts">
        ${d.status === 'done' ? `
          <button class="icon" data-act="play" data-list="dl" data-i="${i}" title="Play" aria-label="Play">▶</button>
          <button class="icon" data-act="editDownload" data-id="${d.id}" title="Edit: split, keep parts, save" aria-label="Edit">✂</button>
          <button class="icon" data-act="exportDownload" data-id="${d.id}" title="Save to disk" aria-label="Save to disk">💾</button>
          <select data-change="expiry" data-id="${d.id}" aria-label="Auto-remove">${EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>` : ''}
        ${d.status === 'failed' ? `<button class="secondary" data-act="retryDownload" data-id="${d.id}">Retry</button>` : ''}
        ${['queued', 'running', 'muxing'].includes(d.status)
          ? `<button class="secondary" data-act="deleteDownload" data-id="${d.id}" data-active="1" title="Stop and remove this download">Cancel</button>`
          : `<button class="icon" data-act="deleteDownload" data-id="${d.id}" title="Delete" aria-label="Delete download">🗑</button>`}
      </div></li>`).join('')}</ul></section>`;
}

const searchState = { q: '', items: [], token: null };

async function searchView() {
  return `<section class="card"><h2>Search YouTube</h2>
    <form data-submit="search" class="row" style="margin:0">
      <input id="search-q" name="q" type="search" value="${esc(searchState.q)}" placeholder="Search videos" aria-label="Search videos" style="flex:1">
      <button>Search</button></form></section>
    ${searchState.items.length ? `<section class="card">${videoRows('search', searchState.items, (v) =>
      `<button class="icon" data-act="addSearch" data-id="${esc(v.id)}" title="Add to library…" aria-label="Add to library">＋</button>`)}
      ${searchState.token ? '<div class="row"><button class="secondary" data-act="searchMore">More results</button></div>' : ''}</section>` : ''}`;
}

/** Settings › Updates: what's installed, what's on GitHub, and how to update safely. */
const updateState = { latest: null, checked: false, error: null };
function updatesCard() {
  const u = updateState;
  return `<section class="card" id="updates"><h2>Updates</h2>
    <p>Version ${esc(upd.currentVersion())}${u.latest ? ` · <strong>version ${esc(u.latest)} is available</strong>` : u.checked ? ' · you have the latest version' : ''}</p>
    ${u.error ? `<p class="error">${esc(u.error)}</p>` : ''}
    ${u.latest ? `<ol>
      <li><a href="${upd.ZIP_URL}" download>Download the ZIP</a> and unzip it.</li>
      <li>Copy its files over this extension's folder (replace them), or keep the new folder anywhere.</li>
      <li>In <a href="#" data-act="openExtensions">chrome://extensions</a>, <strong>don't click Remove</strong>: that deletes your library and downloads.
        Replaced the files? Press <b>Reload extension</b> below. New folder? Click <b>Load unpacked</b> and choose it.</li>
    </ol>` : ''}
    <div class="row"><button data-act="checkUpdate">Check for updates</button><button class="secondary" data-act="reloadExtension">Reload extension</button></div>
    <p class="muted">Your library, settings and downloads stay with every update. Installed with git? Run <code>git pull</code> in its folder, then Reload.</p>
  </section>`;
}

/** Once a day on start: a quiet check; a newer version gets a toast. */
async function autoCheckUpdate() {
  const last = +(await db.getSetting('updateCheckedAt')) || 0;
  if (Date.now() - last < 86400000) return;
  await db.setSetting('updateCheckedAt', Date.now());
  try {
    updateState.latest = await upd.check();
    updateState.checked = true;
  } catch { return; } // offline: Settings › Updates can try again
  if (updateState.latest) toast(`Version ${updateState.latest} is available — see Settings › Updates`);
}

async function settingsView() {
  const [lang, quality, autoOn, autoDays, used, est, token, email, lastAt, lastErr] = await Promise.all([
    db.getSetting('audioLanguage'), db.getSetting('videoQualityMode'), db.getSetting('autoRemoveEnabled'), db.getSetting('autoRemoveDays'), db.storageUsed(),
    navigator.storage.estimate(), db.getSetting('syncToken'), db.getSetting('syncEmail'), db.getSetting('syncLastAt'), db.getSetting('syncLastError')]);
  const q = quality ?? 'standard';
  return `<section class="card"><h2>Video quality</h2>
      <label><input type="radio" name="quality" value="standard" data-change="quality" ${q === 'standard' ? 'checked' : ''}> Standard — streams at 360p; downloads YouTube's ready-made ≤360p file, or up to 480p when it has none</label><br>
      <label><input type="radio" name="quality" value="high" data-change="quality" ${q === 'high' ? 'checked' : ''}> High — streams up to 1080p; downloads the best resolution that fits a 1 GB merge (long videos get less)</label>
    </section>
    <section class="card"><h2>Audio language</h2>
      <label>Preferred audio track
        <select data-change="audioLanguage" aria-label="Preferred audio language">
          <option value="">Original (as uploaded)</option>
          ${LANGUAGES.map(([c, n]) => `<option value="${c}" ${c === lang ? 'selected' : ''}>${n}</option>`).join('')}
        </select></label>
      <p class="muted">For videos with dubbed audio tracks: used when streaming and for playlist downloads. A single download still lets you pick.</p>
    </section>
    <section class="card"><h2>Auto-remove downloads</h2>
      <label><input type="checkbox" data-change="autoRemove" ${autoOn === 'true' ? 'checked' : ''}> Remove downloads after</label>
      <input type="number" min="1" max="365" value="${esc(autoDays ?? 30)}" data-change="autoDays" aria-label="Days" style="width:5rem"> days.
      <p class="muted">A per-download “Remove after…” on the Downloads page always wins.</p>
    </section>
    ${updatesCard()}
    <section class="card"><h2>Storage</h2>
      <p>${used.count} downloads · ${fmtBytes(used.bytes)} <span class="muted">(this extension uses ${fmtBytes(est.usage ?? 0)} in all; browser quota ${fmtBytes(est.quota ?? 0)})</span></p>
      <button class="secondary" data-act="clearStorage">Clear storage…</button>
    </section>
    <section class="card"><h2>Web sync</h2>${token ? `
      <p>Connected as <strong>${esc(email)}</strong> to ${esc(sync.BASE_URL)}.</p>
      <p class="muted">Last sync: ${lastAt ? fmtDate(Date.parse(lastAt)) : 'never'}</p>
      ${lastErr ? `<p class="error">${esc(lastErr)}</p>` : ''}
      <div class="row"><button data-act="syncNow">Sync now</button><button class="danger" data-act="disconnect">Disconnect</button></div>` : `
      <p class="muted">Keeps playlists, tags and categories in step with your phone through ${esc(sync.BASE_URL)}. Files stay on this computer.
        On the website: Settings › Devices › Generate PIN for Personal Youtube.</p>
      <form data-submit="pair" class="row">
        <input name="email" type="email" required placeholder="Email" aria-label="Email" autocomplete="email">
        <input name="pin" required pattern="\\d{8}" inputmode="numeric" placeholder="8-digit PIN" aria-label="PIN">
        <button>Connect</button></form>`}
    </section>`;
}

const VIEWS = { library, playlist: playlistView, tag: tagView, category: categoryView, downloads: downloadsView, search: searchView, settings: settingsView };

let seq = 0;
async function render() {
  const h = location.hash.slice(1) || 'library';
  if (h.startsWith('add=')) return handleAddHash(h);
  const [name, arg] = h.split('/');
  // Now playing is a persistent section (it holds the <video>), not a re-rendered view.
  const nowOpen = name === 'now';
  $('#now').hidden = !nowOpen;
  $('#view').hidden = nowOpen;
  renderPlayer();
  if (nowOpen) {
    $('#paste').hidden = true;
    for (const a of document.querySelectorAll('.top nav a')) a.classList.toggle('on', a.hash === '#now');
    return;
  }
  const view = VIEWS[name] ? name : 'library';
  $('#paste').hidden = view !== 'library';
  for (const a of document.querySelectorAll('.top nav a')) a.classList.toggle('on', a.hash === `#${view}`);
  const mine = ++seq;
  await loadDone();
  const html = await VIEWS[view](arg && decodeURIComponent(arg));
  if (mine !== seq) return; // a newer render started
  const a = document.activeElement;
  const keep = a?.id && $('#view').contains(a) ? [a.id, a.selectionStart, a.selectionEnd] : null;
  $('#view').innerHTML = html;
  if (keep) {
    const n = document.getElementById(keep[0]);
    n?.focus();
    try { n.setSelectionRange(keep[1], keep[2]); } catch { /* not a text input */ }
  }
  for (const img of document.querySelectorAll('img[data-thumb]')) {
    dl.thumbUrl(img.dataset.thumb).then((local) => { img.src = local ?? img.dataset.src ?? ''; });
  }
}
let renderTimer;
const rerender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); };

async function handleAddHash(h) {
  const p = new URLSearchParams(h);
  history.replaceState(null, '', '#library');
  await render();
  const kind = p.get('kind');
  await submitPaste(p.get('add') ?? '', { kind: kind === 'audio' || kind === 'video' ? kind : null }).catch((e) => toast(e.message));
}

// ------------------------------------------------------------------ events

const pickVideo = (d) => lists[d.list][+d.i];
async function playPlaylist(id, shuffle = false) {
  const vs = await db.playlistVideos(+id);
  if (!vs.length) return toast('Playlist is empty');
  location.hash = '#now';
  await player.playItems(vs, shuffle ? Math.floor(Math.random() * vs.length) : 0);
  if (shuffle) player.shuffle();
}

const ACT = {
  pastePlay: async () => { await submitPaste($('#add-input').value, { play: true }); $('#add-input').value = ''; },
  play: (d) => { location.hash = '#now'; return player.playItems(lists[d.list], +d.i); },
  addDialog: (d) => addDialog([d.id]),
  dlAudio: async (d) => { const v = pickVideo(d); await ensureVideo(v.id, v); await enqueueMany('audio', [v.id]); },
  dlVideo: async (d) => { const v = pickVideo(d); await ensureVideo(v.id, v); await enqueueMany('video', [v.id]); },
  addSearch: async (d) => { const v = searchState.items.find((x) => x.id === d.id); await ensureVideo(v.id, v); await addDialog([v.id]); },
  searchMore: async () => {
    const r = await yt.search(searchState.q, searchState.token);
    searchState.items.push(...r.items.map((v) => ({ ...v, thumbnailUrl: yt.thumbOf(v.id) })));
    searchState.token = r.token;
    render();
  },
  playPlaylist: (d) => playPlaylist(d.id),
  shufflePlaylist: (d) => playPlaylist(d.id, true),
  dlPlaylist: async (d) => {
    toast('Queuing playlist…');
    const [q, s, f] = await dl.downloadPlaylist(+d.id, d.kind);
    toast(`${q} queued · ${s} already downloaded · ${f} failed`);
  },
  renamePlaylist: async (d) => {
    const p = await db.playlistById(+d.id);
    const name = prompt('Rename playlist', p.name)?.trim();
    if (!name || name === p.name) return;
    await db.renamePlaylist(p.id, name).catch((e) => {
      throw e.name === 'ConstraintError' ? new Error('A playlist with that name already exists.') : e;
    });
  },
  deletePlaylistDownloads: async (d) => {
    if (!confirm('Delete the downloaded files of every video in this playlist?')) return;
    toast(`Deleted ${await dl.deletePlaylistDownloads(+d.id)} files`);
    render();
  },
  deletePlaylist: async (d) => {
    if (!confirm('Delete this playlist? Videos and downloaded files stay.')) return;
    await db.deletePlaylist(+d.id);
    location.hash = '#library';
  },
  untagPlaylist: (d) => db.untagPlaylist(+d.id, +d.tag),
  moveEntry: async (d) => {
    const ids = lists.pl.map((v) => v.id);
    const i = +d.i;
    const j = i + +d.dir;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await db.reorderPlaylist(+d.id, ids);
  },
  removeEntry: (d) => db.removeVideoFromPlaylist(+d.id, d.video),
  moveToPlaylist: async (d) => {
    const others = (await db.playlists()).filter((p) => p.id !== +d.id);
    if (!others.length) return toast('No other playlist to move to');
    const fd = await dialog(`<form method="dialog"><h2>Move to playlist</h2>
      <select name="to" aria-label="Playlist">${others.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>${buttons('Move')}</form>`);
    if (fd) await db.moveVideoToPlaylist(+d.id, +fd.get('to'), d.video);
  },
  deleteTag: async (d) => { if (confirm('Delete this tag everywhere?')) { await db.deleteTag(+d.id); location.hash = '#library'; } },
  untagVideo: (d) => db.untagVideo(d.video, +d.id),
  deleteCategory: async (d) => { if (confirm('Delete this category everywhere?')) { await db.deleteCategory(+d.id); location.hash = '#library'; } },
  uncategorizeVideo: (d) => db.uncategorizeVideo(d.video, +d.id),
  editDownload: async (d) => { player.element().pause(); await openEditor(await db.downloadById(+d.id), { toast, onSaved: player.reloadIfCurrent }); },
  exportDownload: async (d) => { const x = await db.downloadById(+d.id); await dl.exportToDisk(x, (await db.videoById(x.videoId))?.title); },
  retryFailed: async () => {
    const failed = (await db.downloadsInStatus(['failed'])).sort((a, b) => a.createdAt - b.createdAt);
    toast(`Retrying ${failed.length} downloads…`);
    for (const [i, d] of failed.entries()) {
      await dl.retry(d);
      if (i < failed.length - 1) await sleep(2000); // every retry asks youtube.com afresh; a burst trips its bot check
    }
  },
  retryDownload: async (d) => toast(`Retry: ${await dl.retry(await db.downloadById(+d.id))}`),
  deleteDownload: async (d) => {
    if (!confirm(d.active ? 'Stop this download and remove it?' : 'Delete this download?')) return;
    const row = await db.downloadById(+d.id);
    if (row) await dl.deleteDownload(row);
    render();
  },
  clearStorage: async () => {
    const fd = await dialog(`<form method="dialog"><h2>Clear storage</h2>
      <p class="muted">Removes leftover pieces of failed, cancelled or interrupted downloads, and files no download uses any more.
        Downloads in progress are not touched.</p>
      <fieldset><legend>Your downloads</legend>
        <label><input type="radio" name="mode" value="keep" checked> Keep downloaded videos and audio</label><br>
        <label><input type="radio" name="mode" value="remove"> Remove downloaded videos and audio too</label>
      </fieldset>${buttons('Clear')}</form>`);
    if (!fd) return;
    const removeDownloads = fd.get('mode') === 'remove';
    if (removeDownloads && !confirm('Delete every downloaded video and audio file? They will need downloading again.')) return;
    const { files, bytes } = await dl.clearStorage({ removeDownloads });
    toast(files ? `Freed ${fmtBytes(bytes)} (${files} file${files > 1 ? 's' : ''})` : 'Nothing to clear');
    render();
  },
  checkUpdate: async () => {
    updateState.error = null;
    try {
      updateState.latest = await upd.check();
      updateState.checked = true;
    } catch (e) {
      updateState.error = e.message;
    }
    render();
  },
  reloadExtension: () => chrome.runtime.reload(),
  openExtensions: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }),
  syncNow: async () => { toast('Syncing…'); await sync.sync({ manual: true, fetchMeta: yt.fetchMeta }); toast((await db.getSetting('syncLastError')) ?? 'Synced'); },
  disconnect: async () => { if (confirm('Disconnect web sync? Your library stays on this computer.')) await sync.disconnect(); },
  // player (mini player + Now playing)
  openNow: () => { location.hash = '#now'; },
  closeNow: () => (history.length > 1 ? history.back() : (location.hash = '#library')),
  pPrev: player.previous,
  pNext: player.next,
  pToggle: player.toggle,
  pBack: () => player.seek(player.element().currentTime - 10),
  pFwd: () => player.seek(player.element().currentTime + 10),
  pSpeed: player.cycleSpeed,
  pRepeat: player.cycleRepeat,
  pShuffle: player.shuffle,
  pQueue: () => { $('#queue').hidden = !$('#queue').hidden; renderPlayer(); },
  qPlay: (d) => player.skipTo(+d.i),
  qMove: (d) => player.moveQueueItem(+d.i, +d.i + +d.dir),
  nVideo: () => player.state.showVideo || player.setShowVideo(true),
  nAudio: () => !player.state.showVideo || player.setShowVideo(false),
  nLive: () => player.setLiveStream(!player.state.liveStream),
  nQuality: () => player.setQuality(player.state.quality === 'high' ? 'standard' : 'high'),
  nRetry: () => player.retry(),
  nTry360: () => player.setQuality('standard'),
  nFullscreen: () => player.element().requestFullscreen(),
  nAdd: async () => { const v = nowItem(); await ensureVideo(v.id, v); await addDialog([v.id]); },
  // The track chosen in Now playing is the one downloaded — no second question.
  nDlAudio: async () => { const v = nowItem(); await ensureVideo(v.id, v); await enqueueMany('audio', [v.id], player.state.trackId ?? undefined); },
  nDlVideo: async () => { const v = nowItem(); await ensureVideo(v.id, v); await enqueueMany('video', [v.id], player.state.trackId ?? undefined); },
  // The file being shown: video when the picture is on, else audio.
  // The file being shown: video when the picture is on, else audio. Not
  // downloaded yet? Offer the download; the editor opens when it lands.
  nEdit: async () => {
    const v = nowItem();
    const kinds = player.state.showVideo ? ['video', 'audio'] : ['audio', 'video'];
    const d = (await db.doneDownload(v.id, kinds[0])) ?? (await db.doneDownload(v.id, kinds[1]));
    if (d) {
      player.element().pause();
      return openEditor(d, { toast, onSaved: player.reloadIfCurrent });
    }
    const fd = await dialog(`<form method="dialog"><h2>Edit this video</h2>
      <p>The editor cuts a downloaded file. Download it first; the editor opens by itself when the download finishes.</p>
      <fieldset><legend>Download</legend>
        <label><input type="radio" name="kind" value="video" ${kinds[0] === 'video' ? 'checked' : ''}> Video</label>
        <label><input type="radio" name="kind" value="audio" ${kinds[0] === 'audio' ? 'checked' : ''}> Audio only</label>
      </fieldset>${buttons('Download')}</form>`);
    if (!fd) return;
    const kind = fd.get('kind');
    const since = Date.now();
    await ensureVideo(v.id, v);
    await enqueueMany(kind, [v.id], player.state.trackId ?? undefined);
    pendingEdit = { id: v.id, kind, since };
  },
};

const CHANGE = {
  plTag: (el) => { plFilter.tagId = +el.value || null; render(); },
  plCat: (el) => { plFilter.categoryId = +el.value || null; render(); },
  plCategory: (el) => db.setPlaylistCategory(+el.dataset.id, +el.value || null),
  toggleAll: (el) => { for (const c of el.form.querySelectorAll('input[name=v]')) c.checked = el.checked; },
  expiry: (el) => db.setDownloadExpiry(+el.dataset.id, el.value ? Date.now() + +el.value * 86400000 : null),
  quality: (el) => db.setSetting('videoQualityMode', el.value),
  audioLanguage: (el) => db.setSetting('audioLanguage', el.value),
  autoRemove: (el) => db.setSetting('autoRemoveEnabled', el.checked),
  autoDays: (el) => db.setSetting('autoRemoveDays', Math.max(1, +el.value || 30)),
  pSleep: (el) => player.setSleepTimer(+el.value || null),
  nTrack: (el) => player.setTrack(el.value),
  nDesc: (el) => db.setVideoDescription(el.dataset.id, el.value),
};

const SUBMIT = {
  paste: async (fd) => { await submitPaste(fd.get('text')); $('#add-input').value = ''; },
  tagPlaylist: async (fd, form) => {
    const name = fd.get('tag').trim();
    if (name) await db.tagPlaylist(+form.dataset.id, await db.createOrGetTag(name));
  },
  search: async (fd) => {
    searchState.q = fd.get('q').trim();
    if (!searchState.q) return;
    toast('Searching…');
    const r = await yt.search(searchState.q);
    searchState.items = r.items.map((v) => ({ ...v, thumbnailUrl: yt.thumbOf(v.id) }));
    searchState.token = r.token;
    render();
  },
  pair: async (fd) => {
    try {
      await sync.pair(fd.get('email'), fd.get('pin'), { fetchMeta: yt.fetchMeta });
      toast('Connected');
    } catch (e) {
      throw new Error(SYNC_ERRORS[e.code] ?? e.message);
    }
  },
};

// Failures the app expects (YouTube refusing, offline, server messages) are shown, not logged
// as errors — chrome://extensions › Errors then lists only real bugs.
const isBug = (e) => (e instanceof TypeError && e.message !== 'Failed to fetch') ||
  e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError;
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) {
    (isBug(e) && !e.expected ? console.error : console.info)(e);
    toast(e.message ?? String(e));
  }
};
document.addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  e.preventDefault();
  b.disabled = true;
  try { await ACT[b.dataset.act](b.dataset); } finally { b.disabled = false; }
}));
document.addEventListener('change', guard((e) => { const el = e.target.closest('[data-change]'); if (el) return CHANGE[el.dataset.change](el); }));
document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'plSearch') { plFilter.search = e.target.value; rerender(); }
});
document.addEventListener('submit', guard(async (e) => {
  const f = e.target.closest('form[data-submit]');
  if (!f) return;
  e.preventDefault();
  await SUBMIT[f.dataset.submit](new FormData(f), f);
}));
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);

// ------------------------------------------------------------------ player

const nowItem = () => player.state.queue[player.state.index];
const show = (sel, on) => { $(sel).hidden = !on; };

function renderPlayer() {
  const s = player.state;
  const item = nowItem();
  const nowOpen = location.hash === '#now';
  show('#mini', !!item && !nowOpen);
  $('#now').classList.toggle('empty', !item);
  if (!item) return;
  const el = player.element();
  const sub = `${item.channel}${s.loading ? ' · loading…' : ''}${s.local ? ' · offline file' : ''}${s.queue.length > 1 ? ` · ${s.index + 1}/${s.queue.length}` : ''}`;
  // mini player
  $('#m-title').textContent = item.title;
  $('#m-sub').textContent = sub;
  $('#m-toggle').textContent = el.paused ? '▶' : '⏸';
  dl.thumbUrl(item.id).then((u) => { $('#m-art').src = u ?? item.thumbnailUrl ?? ''; $('#n-art').src = $('#m-art').src; });
  // Now playing
  $('#n-title').textContent = item.title;
  $('#n-sub').textContent = sub;
  $('#n-toggle').textContent = el.paused ? '▶' : '⏸';
  $('#n-video').setAttribute('aria-pressed', s.showVideo);
  $('#n-audio').setAttribute('aria-pressed', !s.showVideo);
  $('#media').classList.toggle('hidden', !s.showVideo);
  show('#n-art', !s.showVideo);
  show('#n-live', s.hasLocal);
  $('#n-live').setAttribute('aria-pressed', s.liveStream);
  $('#n-live').textContent = s.liveStream ? 'Live stream ✓' : 'Play live stream';
  show('#n-quality', !s.local && s.showVideo);
  $('#n-quality').textContent = s.quality === 'high' ? 'HD' : '360p';
  const tracks = s.local ? [] : s.tracks;
  show('#n-track', tracks.length > 1);
  if (tracks.length > 1) {
    $('#n-track').innerHTML = tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === s.trackId ? 'selected' : ''}>🔊 ${esc(t.name)}</option>`).join('');
  }
  $('#n-speed').textContent = `${s.speed}×`;
  $('#n-repeat').textContent = `Repeat: ${{ none: 'off', all: 'all', one: 'one' }[s.repeat]}`;
  $('#n-sleep').value = '';
  $('#n-sleep').options[0].textContent = s.sleepEnd ? `Sleep: ${new Date(s.sleepEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Sleep: off';
  showDescription(item);
  show('#n-error', !!s.error);
  $('#n-error-text').textContent = s.error ?? '';
  const q = $('#queue');
  if (!q.hidden) {
    const last = s.queue.length - 1;
    q.innerHTML = s.queue.map((v, i) => `<li class="${i === s.index ? 'cur' : ''}">
      <span class="title">${esc(v.title)}</span>
      <button class="icon" data-act="qPlay" data-i="${i}" title="Play" aria-label="Play">▶</button>
      <button class="icon" data-act="qMove" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Up" aria-label="Move up">↑</button>
      <button class="icon" data-act="qMove" data-i="${i}" data-dir="1" ${i === last ? 'disabled' : ''} title="Down" aria-label="Move down">↓</button></li>`).join('');
  }
}

/**
 * Now playing › Description: loaded when the item changes (never while typing).
 * A row with none yet gets YouTube's text, prefixed with the link; an item
 * that isn't in the library (a search result) has no row and no field.
 */
async function showDescription(item) {
  const ta = $('#n-desc');
  if (ta.dataset.id === item.id) return;
  ta.dataset.id = item.id;
  const v = await db.videoById(item.id);
  if (ta.dataset.id !== item.id) return;
  show('#n-desc-wrap', !!v);
  ta.value = v?.description ?? '';
  if (!v || v.description != null || isClip(item.id)) return;
  try {
    const m = await yt.fetchMeta(item.id);
    await db.fillDescription(item.id, descriptionFor(item.id, m.description));
    const now = await db.videoById(item.id);
    if (ta.dataset.id === item.id && document.activeElement !== ta) ta.value = now?.description ?? '';
  } catch { /* offline or refused: next play tries again */ }
}

let seeking = false;
function tickTime() {
  const el = player.element();
  const f = Number.isFinite(el.duration) && el.duration ? el.currentTime / el.duration : 0;
  if (!seeking) $('#n-seek').value = Math.round(f * 1000);
  $('#m-fill').style.width = `${f * 100}%`;
  $('#n-pos').textContent = fmtDur(el.currentTime * 1000) || '0:00';
  $('#n-dur').textContent = fmtDur((el.duration || 0) * 1000) || '0:00';
}

// ------------------------------------------------------------------ boot

player.init($('#media'));
$('#n-sleep').innerHTML = `<option value="">Sleep: off</option><option value="0">Cancel timer</option>${player.SLEEP_PRESETS.map((m) => `<option value="${m}">${m} min</option>`).join('')}`;
player.events.addEventListener('change', renderPlayer);
$('#media').addEventListener('timeupdate', tickTime);
$('#n-seek').addEventListener('pointerdown', () => { seeking = true; });
$('#n-seek').addEventListener('change', () => {
  seeking = false;
  const el = player.element();
  if (Number.isFinite(el.duration)) player.seek(($('#n-seek').value / 1000) * el.duration);
});
// Native controls only in fullscreen (the page has its own).
document.addEventListener('fullscreenchange', () => { $('#media').controls = document.fullscreenElement === $('#media'); });

db.changed.addEventListener('change', rerender);
// ✂ on a video that wasn't downloaded: open the editor once its download lands.
let pendingEdit = null;
db.changed.addEventListener('change', guard(async () => {
  const p = pendingEdit;
  if (!p) return;
  const d = await db.doneDownload(p.id, p.kind);
  if (d) {
    pendingEdit = null;
    if ($('#dlg').open) return toast('Download finished: press ✂ to edit it');
    player.element().pause();
    await openEditor(d, { toast, onSaved: player.reloadIfCurrent });
  } else if ((await db.downloadsOf(p.id)).some((x) => x.kind === p.kind && x.status === 'failed' && x.createdAt >= p.since)) {
    pendingEdit = null; // the Downloads page shows why
  }
}));
dl.ticks.addEventListener('tick', () => {
  for (const [id, p] of dl.progress) {
    const bar = document.getElementById(`p-${id}`);
    if (bar) bar.value = progressFraction(p);
    const text = document.getElementById(`pt-${id}`);
    if (text) text.textContent = progressText(p, 'running');
  }
});
sync.prompts.addEventListener('prompt', guard(async (e) => {
  const { playlistIds, missing } = e.detail;
  const fd = await dialog(`<form method="dialog"><h2>Synced playlists</h2>
    <p>${missing} videos in ${playlistIds.length} synced playlist${playlistIds.length > 1 ? 's' : ''} aren't downloaded here.</p>
    <fieldset><legend>Download them as</legend>${kindRadios('audio').replace("Don't download", 'Later')}</fieldset>${buttons('OK')}</form>`);
  const kind = fd?.get('kind');
  if (kind && kind !== 'none') for (const id of playlistIds) await dl.downloadPlaylist(id, kind);
}));
window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => {
  if (player.playing() || dl.busy()) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  dl.sweep().catch(console.info);
  sync.sync({ fetchMeta: yt.fetchMeta });
});

// YouTube 403s its player API for `Origin: chrome-extension://…` (Risk 1); present
// this extension's own requests as youtube.com. The User-Agent is never touched.
await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }] },
    condition: { requestDomains: ['youtube.com', 'googlevideo.com'], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
  }],
});
navigator.storage.persist();
chrome.tabs.getCurrent((t) => t && chrome.tabs.update(t.id, { autoDiscardable: false }));
await dl.init();
await render();
dl.sweep().catch(console.info);
autoCheckUpdate().catch(console.info);
sync.sync({ fetchMeta: yt.fetchMeta });
