// Playback — port of apps/youtube_personal/lib/services/audio_handler.dart (+ the
// video pane's options) onto one <video> element driven by shaka-player.
// Source: a downloaded file (video first when the picture is shown), else a
// stream — a DASH manifest built from YouTube's formats (H.264 video + the
// chosen audio track as byte-range segments: full speed, seekable), else the
// muxed/audio URL. Video/Audio, live stream, audio track and quality reload
// the current item in place.
import * as db from './db.js';
import * as yt from './yt.js';
import * as dl from './downloads.js';
import { sourceOf, nextJump } from './clip.js';

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
export const SLEEP_PRESETS = [15, 30, 45, 60, 90];

/** queue items: { id, title, channel, durationMs, thumbnailUrl } */
export const state = {
  queue: [], index: -1, repeat: 'none', sleepEnd: null, error: null, loading: false,
  local: false, // playing a downloaded file
  hasLocal: false, // a download exists for the current item
  showVideo: true, // Video (true) or Audio (false)
  liveStream: false, // stream even though a download exists
  tracks: [], trackId: null, // audio tracks of the current stream
  quality: 'standard', // streaming cap: standard 360p, high 1080p (setting videoQualityMode, as the app)
  speed: 1,
};
export const events = new EventTarget();
const emit = () => events.dispatchEvent(new Event('change'));

let el;
let shakaP = null;
let urls = []; // object URLs of the current source (file / manifest)
let retried = false;
let loadSeq = 0; // only the latest load() may set the source
let itemId = null; // per-item options reset when this changes
let sleepTimer = null;
// A clip played from its source's stream: its ranges (source ms), gaps skipped.
// ponytail: the seek bar shows the whole source; a downloaded clip is exact.
let clipSegs = null;
const current = () => state.queue[state.index] ?? null;

export function init(videoEl) {
  el = videoEl;
  el.addEventListener('ended', onEnded);
  el.addEventListener('timeupdate', () => {
    if (!clipSegs || state.loading) return;
    const j = nextJump(clipSegs, el.currentTime * 1000);
    if (j === 'end') { el.pause(); onEnded(); } else if (j) el.currentTime = j.seek / 1000;
  });
  el.addEventListener('pause', persist);
  for (const ev of ['play', 'pause', 'ratechange', 'loadedmetadata', 'waiting', 'playing']) el.addEventListener(ev, () => { positionState(); emit(); });
  setInterval(() => { if (!el.paused) persist(); }, 5000);
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => el.play());
  ms.setActionHandler('pause', () => el.pause());
  ms.setActionHandler('previoustrack', previous);
  ms.setActionHandler('nexttrack', next);
  ms.setActionHandler('seekto', (d) => seek(d.seekTime));
  ms.setActionHandler('seekbackward', (d) => seek(el.currentTime - (d.seekOffset || 10)));
  ms.setActionHandler('seekforward', (d) => seek(el.currentTime + (d.seekOffset || 10)));
}

export const element = () => el;
export const playing = () => !!el && !el.paused;

function shakaPlayer() {
  return (shakaP ??= (async () => {
    if (!window.shaka) {
      await new Promise((ok, no) => {
        const s = Object.assign(document.createElement('script'), { src: 'vendor/shaka/shaka-player.compiled.js' });
        s.onload = ok;
        s.onerror = () => no(new Error('Could not load the video player'));
        document.head.append(s);
      });
    }
    shaka.polyfill.installAll();
    const p = new shaka.Player();
    await p.attach(el);
    p.configure({ streaming: { bufferingGoal: 60, rebufferingGoal: 2 } });
    p.addEventListener('error', (ev) => onError(ev.detail));
    return p;
  })());
}

/** Replace the queue and start at startIndex. */
export async function playItems(items, startIndex = 0) {
  state.queue = [...items];
  await load(startIndex);
}

const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'audio/webm' };

async function sourceFor(id, force) {
  const downloads = { video: await db.doneDownload(id, 'video'), audio: await db.doneDownload(id, 'audio') };
  state.hasLocal = !!(downloads.video || downloads.audio);
  if (!state.liveStream) {
    for (const kind of state.showVideo ? ['video', 'audio'] : ['audio', 'video']) {
      const d = downloads[kind];
      if (!d) continue;
      try {
        return { url: await dl.fileUrl(d), mime: MIME[d.fileName.split('.').pop()] ?? 'video/mp4', local: true, own: true };
      } catch { /* file gone: stream instead */ }
    }
  }
  const r = await yt.resolve(sourceOf(id), { force });
  state.tracks = r.audioTracks;
  if (!state.tracks.some((t) => t.id === state.trackId)) state.trackId = yt.trackFor(r, (await db.getSetting('audioLanguage')) ?? '');
  const mpd = yt.dashManifest(r, { trackId: state.trackId, maxHeight: state.quality === 'high' ? 1080 : 360, video: state.showVideo });
  if (mpd) return { url: URL.createObjectURL(new Blob([mpd], { type: 'application/dash+xml' })), mime: 'application/dash+xml', local: false, own: true };
  // No segment index: the muxed file (default track) or the track's audio URL.
  const a = yt.audioFor(r, state.trackId).audio;
  return state.showVideo && r.muxedUrl
    ? { url: r.muxedUrl, mime: 'video/mp4', local: false }
    : { url: a.url, mime: MIME[a.ext] ?? 'audio/mp4', local: false };
}

async function load(i, at = null, play = true) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  state.error = null;
  state.loading = true;
  retried = false;
  const item = current();
  if (item.id !== itemId) {
    // New item: the app's default view — audio when only the audio is downloaded.
    itemId = item.id;
    state.liveStream = false;
    state.trackId = null;
    state.tracks = [];
    state.quality = (await db.getSetting('videoQualityMode')) ?? 'standard';
    state.showVideo = !((await db.doneDownload(item.id, 'audio')) && !(await db.doneDownload(item.id, 'video')));
  }
  const mine = ++loadSeq;
  emit();
  try {
    const v = await db.videoById(item.id);
    const src = await sourceFor(item.id, false);
    if (mine !== loadSeq) { if (src.own) URL.revokeObjectURL(src.url); return; } // superseded
    clipSegs = !src.local && v?.segments?.length ? v.segments : null;
    const resume = at ?? (clipSegs ? clipSegs[0][0] / 1000 : (v?.resumePositionMs ?? 0) > 5000 ? v.resumePositionMs / 1000 : 0);
    await setSource(item, src, resume, mine, play);
    db.markPlayed(item.id);
  } catch (e) {
    if (mine === loadSeq) await onError(e);
  }
}

async function setSource(item, src, at, mine, play = true) {
  const p = await shakaPlayer();
  state.local = src.local;
  el.poster = (await dl.thumbUrl(item.id)) ?? item.thumbnailUrl ?? '';
  metadata(item);
  const old = urls;
  urls = src.own ? [src.url] : [];
  try {
    await p.load(src.url, at || null, src.mime);
  } finally {
    for (const u of old) URL.revokeObjectURL(u);
  }
  if (mine !== loadSeq) return;
  el.defaultPlaybackRate = el.playbackRate = state.speed;
  state.loading = false;
  emit();
  if (play) await el.play().catch(() => {}); // autoplay blocks etc. are not playback errors
}

/** Reload the current item at the current time (after an option change). */
const reload = () => (state.index >= 0 ? load(state.index, el.currentTime || 0) : null);
/** The editor replaced this video's files: drop the old one, cue the new one from the start (paused). */
export const reloadIfCurrent = (id) => (current()?.id === id ? load(state.index, 0, false) : null);

/** Stream URLs die (~6 h) or get revoked: re-resolve once, then surface. */
async function onError(e) {
  if (e?.code === 7000) return; // shaka LOAD_INTERRUPTED: a newer load replaced it
  const item = current();
  if (!item) return;
  if (!retried && !state.local) {
    retried = true;
    const mine = loadSeq;
    try {
      const at = el.currentTime || 0;
      const src = await sourceFor(item.id, true);
      if (mine !== loadSeq) { if (src.own) URL.revokeObjectURL(src.url); return; } // the user moved on
      await setSource(item, src, at, mine);
      return;
    } catch (e2) {
      e = e2;
    }
  }
  state.error = describe(e);
  state.loading = false;
  emit();
}

function describe(e) {
  if (e?.code && e?.category) {
    const status = e.code === 1001 ? ` (HTTP ${e.data?.[1]})` : '';
    return `Playback failed — player error ${e.code}${status}. Try Retry, 360p, or download it.`;
  }
  return e?.message ?? String(e);
}

function onEnded() {
  const item = current();
  if (item) db.saveResumePosition(item.id, 0);
  if (state.repeat === 'one') { el.currentTime = 0; el.play(); }
  else if (state.index + 1 < state.queue.length) load(state.index + 1, 0);
  else if (state.repeat === 'all' && state.queue.length) load(0, 0);
  else stop();
}

function persist() {
  const item = current();
  if (item && el.currentTime > 0 && !clipSegs) db.saveResumePosition(item.id, Math.round(el.currentTime * 1000)); // a streamed clip's time is the source's
}

export const toggle = () => (el.paused ? el.play() : el.pause());
export function seek(t) { el.currentTime = Math.max(0, Math.min(t, el.duration || t)); positionState(); }
export async function stop() {
  persist();
  loadSeq++;
  el.pause();
  await (await shakaP)?.unload().catch(() => {});
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  state.index = -1;
  state.queue = [];
  itemId = null;
  navigator.mediaSession.metadata = null;
  emit();
}
export function next() { if (state.index + 1 < state.queue.length) load(state.index + 1); }
export function previous() {
  if (el.currentTime > 5) seek(0);
  else if (state.index > 0) load(state.index - 1);
}
export const skipTo = (i) => load(i);
export const retry = () => load(state.index, el.currentTime || 0);

// ---- options (the app's Now Playing / video pane) ----

/** Video (true) or Audio (false). Streaming audio-only skips the video download entirely. */
export function setShowVideo(on) { state.showVideo = on; return reload(); }
/** For a downloaded item: play the stream instead of the file. */
export function setLiveStream(on) { state.liveStream = on; return reload(); }
/** Streaming audio track (a downloaded file has one track: switching streams instead). */
export function setTrack(id) {
  state.trackId = id;
  if (state.local) state.liveStream = true;
  return reload();
}
export function setQuality(q) {
  state.quality = q;
  db.setSetting('videoQualityMode', q);
  return state.local ? null : reload();
}

export function cycleSpeed() {
  state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
  el.defaultPlaybackRate = el.playbackRate = state.speed;
}
export function cycleRepeat() {
  state.repeat = { none: 'all', all: 'one', one: 'none' }[state.repeat];
  emit();
}

/** Shuffle the rest of the queue, keeping the current track first. */
export function shuffle() {
  const q = [...state.queue];
  if (q.length < 3) return;
  const cur = state.index >= 0 ? q.splice(state.index, 1)[0] : null;
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  if (cur) { q.unshift(cur); state.index = 0; }
  state.queue = q;
  emit();
}

/** Reorder the queue without touching playback. */
export function moveQueueItem(from, to) {
  const q = state.queue;
  if (from < 0 || from >= q.length || to < 0 || to >= q.length) return;
  q.splice(to, 0, q.splice(from, 1)[0]);
  if (state.index === from) state.index = to;
  else if (from < state.index && to >= state.index) state.index--;
  else if (from > state.index && to <= state.index) state.index++;
  emit();
}

/** Pause after `minutes`; null cancels. */
export function setSleepTimer(minutes) {
  clearTimeout(sleepTimer);
  state.sleepEnd = minutes ? Date.now() + minutes * 60000 : null;
  if (minutes) sleepTimer = setTimeout(() => { state.sleepEnd = null; el.pause(); emit(); }, minutes * 60000);
  emit();
}

function metadata(item) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title, artist: item.channel,
    artwork: item.thumbnailUrl ? [{ src: item.thumbnailUrl, sizes: '320x180', type: 'image/jpeg' }] : [],
  });
}

function positionState() {
  if (!Number.isFinite(el.duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: el.duration, playbackRate: el.playbackRate, position: Math.min(el.currentTime, el.duration) });
  } catch { /* transient invalid state while loading */ }
}
