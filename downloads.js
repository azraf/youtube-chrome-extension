// Download pipeline — port of apps/youtube_personal/lib/services/download_service.dart.
// enqueue → FIFO job → fetch into OPFS media/ → (High video) ffmpeg.wasm mux.
// Screens read db rows; live progress lives in `progress` (not in the db).
import * as db from './db.js';
import * as yt from './yt.js';
import { isClip, sourceOf, newClipId, compose, toLocal, totalMs, ffmpegPlan, copyIsExact, descriptionFor } from './clip.js';

/** downloadId → { got, total, bps } while downloading, { phase: 'merging', fraction } while muxing. */
export const progress = new Map();
export const ticks = new EventTarget();

// googlevideo throttles one long request to about playback speed (measured
// 0.03 MB/s audio, 0.85 MB/s video) but serves each 10 MB range at full speed
// (~2.4 MB/s) — yt-dlp's http_chunk_size.
const CHUNK = 10 << 20;

const MUX_LIMIT = 1 << 30;
const media = () => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('media', { create: true }));
const fileOf = async (name) => (await (await media()).getFileHandle(name)).getFile();
const removeFile = async (name) => { try { await (await media()).removeEntry(name); } catch { /* already gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Downloads that died with the tab can't resume: mark failed so the user gets Retry. */
export async function init() {
  for (const d of await db.downloadsInStatus(['queued', 'running', 'muxing'])) {
    await db.updateDownload(d.id, { status: 'failed', error: 'interrupted' });
  }
  const dir = await media();
  for await (const name of dir.keys()) if (/\.(video|audio)\.\w+$|\.edit$/.test(name)) await removeFile(name); // parts, unfinished editor saves
}

// ponytail: one download at a time (FIFO); the app runs 2 slots.
// jobs: id → { run(signal), ac, settled }. Deleting a download cancels its job
// (queued: dropped; running: fetch aborted / ffmpeg killed), so nothing keeps
// running hidden and the queue never waits behind a deleted row.
const jobs = new Map();
const waiting = [];
let current = null;
export const busy = () => current != null || waiting.length > 0;

function queue(id, run) {
  jobs.set(id, { run, ac: new AbortController(), settled: null });
  waiting.push(id);
  pump();
}

function pump() {
  if (current != null || !waiting.length) return;
  const id = (current = waiting.shift());
  const job = jobs.get(id);
  job.settled = (async () => {
    try {
      await db.updateDownload(id, { status: 'running' });
      await job.run(job.ac.signal);
    } catch (e) {
      if (!job.ac.signal.aborted) await fail(id, e.message ?? String(e)).catch(console.error);
    } finally {
      jobs.delete(id);
      progress.delete(id);
      current = null;
      ticks.dispatchEvent(new Event('tick'));
      pump();
    }
  })();
}

/** Stop a queued or running download's job; resolves once it has stopped. */
async function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.ac.abort();
  const i = waiting.indexOf(id);
  if (i >= 0) { waiting.splice(i, 1); jobs.delete(id); }
  if (job.ac.signal.aborted && ffUser === id && ff) { ff.terminate(); ff = null; } // a running merge can't be aborted otherwise
  await job.settled;
}

const fail = (id, reason) => db.updateDownload(id, { status: 'failed', error: reason.slice(0, 500) });

let lastTick = 0;
/** Merge into a download's live progress; speed is a smoothed bytes/s over ≥1 s windows. */
function report(id, patch) {
  const now = performance.now();
  const p = { t: now, g: 0, bps: 0, ...progress.get(id), ...patch };
  if (patch.got != null && now - p.t >= 1000) {
    const inst = ((p.got - p.g) * 1000) / (now - p.t);
    p.bps = p.bps ? p.bps * 0.7 + inst * 0.3 : inst;
    p.t = now;
    p.g = p.got;
  }
  progress.set(id, p);
  if (now - lastTick >= 250) {
    lastTick = now;
    ticks.dispatchEvent(new Event('tick'));
  }
}
/** onBytes for one part of a download: offset by `base`, out of `overall` when known. */
const bytesOf = (id, base = 0, overall = 0) => (got, total) => report(id, { phase: 'downloading', got: base + got, total: overall || total });

/** Resolve; on failure record a failed row carrying the reason (bot check, unplayable…). */
async function resolveOrFail(videoId, kind, force) {
  try {
    return await yt.resolve(videoId, { force });
  } catch (e) {
    const id = await db.insertDownload({ videoId, kind, status: 'queued', createdAt: Date.now() });
    await fail(id, e.message);
    return null;
  }
}

/** Explicit track id, else the preferred language from Settings, else YouTube's default. */
const chooseTrack = async (r, track) => track ?? yt.trackFor(r, (await db.getSetting('audioLanguage')) ?? '');
const trackLabel = (r, id) => (r.audioTracks.length > 1 ? yt.audioFor(r, id).track.name : null);

/** @returns 'queued' | 'skipped' | 'failed'. track: an audio track id (see yt.audioTracks). */
export async function enqueueAudio(videoId, { force = false, track } = {}) {
  if (isClip(videoId)) return enqueueClip(videoId, 'audio', { force, track });
  if (await db.doneDownload(videoId, 'audio')) return 'skipped';
  const r = await resolveOrFail(videoId, 'audio', force);
  if (!r) return 'failed';
  const tid = await chooseTrack(r, track);
  const { audio } = yt.audioFor(r, tid);
  // .m4a even for the muxed fallback, so it never collides with the video download's <id>.mp4
  const name = `${videoId}.${audio.ext === 'mp4' ? 'm4a' : audio.ext}`;
  const id = await db.insertDownload({ videoId, kind: 'audio', status: 'queued', createdAt: Date.now(), fileName: name, audioTrack: trackLabel(r, tid) });
  queue(id, async (signal) => {
    await fetchToOpfs(videoId, (s) => yt.audioFor(s, tid).audio.url, name, bytesOf(id), signal);
    await finalize(id, videoId, name);
  });
  return 'queued';
}

export async function enqueueVideo(videoId, { force = false, track } = {}) {
  if (isClip(videoId)) return enqueueClip(videoId, 'video', { force, track });
  if (await db.doneDownload(videoId, 'video')) return 'skipped';
  const r = await resolveOrFail(videoId, 'video', force);
  if (!r) return 'failed';
  const tid = await chooseTrack(r, track);
  const mode = (await db.getSetting('videoQualityMode')) ?? 'standard';
  const name = `${videoId}.mp4`;
  const row = { videoId, kind: 'video', status: 'queued', createdAt: Date.now(), fileName: name, audioTrack: trackLabel(r, tid) };
  const single = async () => {
    const id = await db.insertDownload({ ...row, quality: '360p' });
    queue(id, async (signal) => {
      await fetchToOpfs(videoId, (s) => s.muxedUrl, name, bytesOf(id), signal);
      await finalize(id, videoId, name);
    });
    return 'queued';
  };

  // YouTube's ready-made file only carries the default audio track.
  if (mode === 'standard' && r.muxedUrl && tid === r.defaultTrack) return single();
  if (!r.videoUrl) {
    if (r.muxedUrl) return single();
    const id = await db.insertDownload(row);
    await fail(id, 'No video stream available');
    return 'failed';
  }
  const a = yt.audioFor(r, tid).muxAudio;
  // Best resolution whose merge still fits the wasm memory ceiling.
  const v = yt.videoFor(r, { maxHeight: mode === 'standard' ? 480 : 1080, maxBytes: MUX_LIMIT, audioBytes: a.size });
  const vName = `${videoId}.video.mp4`;
  const aName = `${videoId}.audio.${a.ext}`;
  const id = await db.insertDownload({ ...row, quality: `${v.height}p`, parts: [vName, aName] });
  if (v.size + a.size > MUX_LIMIT) {
    await fail(id, `Too large to merge in the browser even at ${v.height}p — download the audio instead`);
    return 'failed';
  }
  queue(id, async (signal) => {
    const overall = v.size + a.size;
    await fetchToOpfs(videoId, (s) => (s.videoVariants.find((x) => x.height === v.height) ?? s.videoVariants.at(-1)).url, vName, bytesOf(id, 0, overall), signal);
    await fetchToOpfs(videoId, (s) => yt.audioFor(s, tid).muxAudio.url, aName, bytesOf(id, v.size, overall), signal);
    await mux(id, videoId, vName, aName, signal);
  });
  return 'queued';
}

/**
 * Download a stream in sequential CHUNK-sized ranges, appending via write().
 * A failed range resumes from the last byte written: two retries in a row,
 * a 403 re-resolves the URL with force, and a range that sends nothing for
 * idleMs is abandoned and retried. `signal` cancels at once. Returns the size.
 */
export async function fetchRanges({ url, write, onBytes, chunk = CHUNK, fetchFn = fetch, signal, idleMs = 30000 }) {
  let got = 0;
  let total = null;
  let force = false;
  let fails = 0;
  while (total == null || got < total) {
    signal?.throwIfAborted();
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', onAbort);
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error(`No data for ${idleMs / 1000} s`)), idleMs);
    };
    try {
      const u = await url(force);
      force = false;
      if (!u) throw new Error('Stream no longer offered');
      arm();
      const res = await fetchFn(u, { headers: { ...yt.STREAM_HEADERS, Range: `bytes=${got}-${got + chunk - 1}` }, credentials: 'omit', signal: ac.signal });
      // 200 = server ignored Range and sends the whole file; only usable from byte 0.
      if (res.status !== 206 && !(res.status === 200 && got === 0)) {
        res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      total ??= res.status === 206
        ? +(res.headers.get('content-range') ?? '').split('/')[1] || 0
        : +res.headers.get('content-length') || 0;
      const rd = res.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        arm();
        await write(value);
        got += value.byteLength;
        onBytes(got, total);
      }
      fails = 0;
      if (!total || res.status === 200) break; // unknown size / whole file in one go
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (++fails > 2) throw e;
      force = e.status === 403;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  if (total && got < total) throw new Error(`Incomplete download (${got}/${total} bytes)`);
  return total || got;
}

/** Stream url → OPFS file. */
async function fetchToOpfs(videoId, pick, name, onBytes, signal) {
  const out = await (await (await media()).getFileHandle(name, { create: true })).createWritable();
  try {
    await fetchRanges({
      url: async (force) => pick(await yt.resolve(videoId, { force })),
      write: (bytes) => out.write(bytes),
      onBytes,
      signal,
    });
    await out.close();
  } catch (e) {
    await out.abort().catch(() => {});
    throw e;
  }
}

let ff = null;
async function ffmpeg() {
  if (ff) return ff;
  const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
  const f = new FFmpeg();
  await f.load({
    coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
  });
  return (ff = f);
}

// One ffmpeg job at a time: merges, clip cuts and the editor share the worker
// (and its /in mount). ffUser = whose job runs, so cancelling a download never
// kills someone else's.
let ffChain = Promise.resolve();
let ffUser = null;
function withFF(user, fn) {
  const run = ffChain.then(async () => {
    ffUser = user;
    try { return await fn(await ffmpeg()); } finally { ffUser = null; }
  });
  ffChain = run.catch(() => {});
  return run;
}

/**
 * Run a plan's ffmpeg commands over OPFS files (mounted at /in, read in place)
 * and write /out to the OPFS file outName. A crashed or killed worker never
 * settles exec(), so every step races a time budget and the signal.
 * outMs: the output's length, for progress (0..1 via onFraction).
 */
async function ffRun(user, files, plan, outName, { budgetMs, outMs = 0, onFraction, signal }) {
  return withFF(user, async (f) => {
    signal?.throwIfAborted();
    let lastLog = '';
    let step = 0;
    const onLog = ({ message }) => { if (message.trim()) lastLog = message; };
    const onProgress = ({ progress: x, time }) => {
      const part = outMs && time > 0 ? time / 1000 / outMs : x || 0;
      onFraction?.(Math.min(1, Math.max(0, (step + Math.min(1, part)) / plan.runs.length)));
    };
    onFraction?.(0);
    f.on('log', onLog);
    f.on('progress', onProgress);
    let timer;
    const stop = new Promise((_, no) => {
      timer = setTimeout(() => no(new Error('ffmpeg timed out')), budgetMs);
      signal?.addEventListener('abort', () => no(signal.reason), { once: true });
    });
    stop.catch(() => {});
    try {
      await f.createDir('/in').catch(() => {});
      // WORKERFS keeps each File's own name.
      await f.mount('WORKERFS', { files }, '/in');
      if (plan.list) await f.writeFile(plan.listPath, plan.list);
      for (; step < plan.runs.length; step++) {
        const code = await Promise.race([f.exec(plan.runs[step]), stop]);
        if (code !== 0) throw new Error(`ffmpeg: ${lastLog || `exit ${code}`}`);
      }
      const data = await Promise.race([f.readFile('/out'), stop]);
      // createWritable writes a swap file and swaps it in on close: the old file survives a failure.
      const out = await (await (await media()).getFileHandle(outName, { create: true })).createWritable();
      await out.write(data);
      await out.close();
      await f.unmount('/in').catch(() => {});
      for (const t of ['/out', ...plan.temps]) await f.deleteFile(t).catch(() => {});
    } catch (e) {
      if (ff === f) { f.terminate(); ff = null; } // next job gets a fresh worker
      throw e;
    } finally {
      clearTimeout(timer);
      f.off('log', onLog);
      f.off('progress', onProgress);
    }
  });
}

/** Same command as the app: -c copy, no re-encode. Times out, and dies with its download. */
async function mux(id, videoId, vName, aName, signal) {
  await db.updateDownload(id, { status: 'muxing' });
  const [vf, af] = await Promise.all([fileOf(vName), fileOf(aName)]);
  if (vf.size + af.size > MUX_LIMIT) throw new Error('Too large to merge in the browser — download the audio instead');
  report(id, { phase: 'merging', fraction: 0 });
  // The muxer writes by extension, so /out gets an explicit format.
  const plan = { runs: [['-y', '-i', `/in/${vf.name}`, '-i', `/in/${af.name}`, '-c', 'copy', '-f', 'mp4', '/out']], list: null, temps: [] };
  // ponytail: 5 min + 0.2 s/MB budget, a guess — copying 1 GB takes well under a minute.
  await ffRun(id, [vf, af], plan, `${videoId}.mp4`, {
    budgetMs: 5 * 60000 + ((vf.size + af.size) / 1e6) * 200,
    onFraction: (fraction) => report(id, { phase: 'merging', fraction }),
    signal,
  });
  await removeFile(vName);
  await removeFile(aName);
  signal.throwIfAborted();
  await finalize(id, videoId, `${videoId}.mp4`);
}

// ---- the editor: cut a finished download ----
// Every file of one video (its audio and its video download) holds the same
// source ranges, so playing either — or the phone's audio + picture pair —
// shows the same moment. Saves re-cut all of them; a download landing later
// is cut to match (conform).

const extOf = (name) => name.split('.').pop();
const FORMAT = { mp4: 'mp4', m4a: 'mp4', webm: 'webm' }; // muxer per container (the temp names have no usable extension)
const WHOLE = [[0, Number.MAX_SAFE_INTEGER]]; // an untouched file: the whole source

/** The source ranges a finished file holds; null = all of it (untouched download). */
const fileSegments = async (d) => d.segments ?? (isClip(d.videoId) ? (await db.videoById(d.videoId))?.segments ?? null : null);

/** The ranges a video's files hold or must hold: its edited files', else a clip's own. */
async function timelineOf(videoId, exceptId = null) {
  for (const d of await db.downloadsOf(videoId)) {
    if (d.status === 'done' && d.id !== exceptId && (await fileSegments(d))) return fileSegments(d);
  }
  return isClip(videoId) ? (await db.videoById(videoId))?.segments ?? null : null;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Cut `keep` (ms, the file's own timeline) out of OPFS inName into outName, exactly (clip.js ffmpegPlan). */
async function cutFile(user, inName, outName, keep, { video, onFraction, signal }) {
  const file = await fileOf(inName);
  const ext = extOf(inName);
  const fmt = FORMAT[ext] ?? ext;
  const plan = ffmpegPlan(keep, { input: `/in/${file.name}`, output: '/out', ext, video, preset: 'ultrafast', tmp: (n) => `/cut${n}` });
  // Temps and /out have no media extension: name the muxer for every output.
  plan.runs = plan.runs.map((r) => [...r.slice(0, -1), '-f', fmt, r.at(-1)]);
  const outMs = totalMs(keep);
  await ffRun(user, [file], plan, outName, {
    // ponytail: budget guesses — copy 5 min + 0.2 s/MB; re-encode 10 min + 4× the output's length.
    budgetMs: copyIsExact(keep, video) ? 5 * 60000 + (file.size / 1e6) * 200 : 10 * 60000 + outMs * 4,
    outMs: plan.runs.length > 1 ? 0 : outMs,
    onFraction, signal,
  });
}

/** Re-cut a finished file in place so it holds exactly `target` (source ranges). */
async function conform(user, d, target, { onFraction, signal } = {}) {
  const have = await fileSegments(d);
  if (same(have, target)) return;
  const keep = toLocal(have ?? WHOLE, target);
  if (!keep.length) throw new Error(`The ${d.kind} file doesn't hold the edited part`);
  await cutFile(user, d.fileName, d.fileName, keep, { video: d.kind === 'video', onFraction, signal });
  await db.updateDownload(d.id, { fileSize: (await fileOf(d.fileName)).size, segments: target });
}

/** Does saving `keep` re-encode a video (slow) — this file or a sibling video? For the editor's note. */
export async function editReencodes(d, keep, fileMs) {
  const target = compose((await fileSegments(d)) ?? [[0, fileMs]], keep);
  for (const x of await db.downloadsOf(d.videoId)) {
    if (x.status === 'done' && x.kind === 'video' && !copyIsExact(toLocal((await fileSegments(x)) ?? WHOLE, target), true)) return true;
  }
  return false;
}

/**
 * Editor › Save: every file of this video (this one and its audio/video
 * sibling) is cut to the kept ranges. All are cut to temp files first and
 * swapped in only when every cut worked, so a cancel or failure leaves both
 * files as they were — never one cut and one not. fileMs = this file's length
 * (from the preview). A clip's row follows its files.
 */
export async function saveEdit(d, keep, fileMs, { onFraction, signal } = {}) {
  const target = compose((await fileSegments(d)) ?? [[0, fileMs]], keep);
  const files = (await db.downloadsOf(d.videoId)).filter((x) => x.status === 'done').sort((a, b) => (b.id === d.id) - (a.id === d.id)); // this file first
  const staged = [];
  try {
    for (const [i, x] of files.entries()) {
      const have = await fileSegments(x);
      if (same(have, target)) continue;
      const local = toLocal(have ?? WHOLE, target);
      if (!local.length) throw new Error(`The ${x.kind} file doesn't hold the edited part`);
      const tmp = `${x.fileName}.edit`;
      staged.push([x, tmp]);
      await cutFile('edit', x.fileName, tmp, local, { video: x.kind === 'video', signal, onFraction: (f) => onFraction?.((i + f) / files.length) });
    }
  } catch (e) {
    for (const [, tmp] of staged) await removeFile(tmp);
    throw e;
  }
  const dir = await media();
  for (const [x, tmp] of staged) {
    await removeFile(x.fileName);
    await (await dir.getFileHandle(tmp)).move(x.fileName);
    await db.updateDownload(x.id, { fileSize: (await fileOf(x.fileName)).size, segments: target });
  }
  if (isClip(d.videoId)) await db.setClipSegments(d.videoId, target);
  await db.saveResumePosition(d.videoId, 0);
}

/**
 * Editor › Save as: the kept ranges become a new clip (video row + finished
 * download), optionally added to playlistId. Returns the clip's id.
 */
export async function saveEditAs(d, keep, fileMs, { title, playlistId = null, onFraction, signal } = {}) {
  const v = await db.videoById(d.videoId);
  const segs = compose((await fileSegments(d)) ?? [[0, fileMs]], keep);
  const clipId = newClipId(d.videoId);
  const name = `${clipId}.${extOf(d.fileName)}`;
  try {
    await cutFile('edit', d.fileName, name, keep, { video: d.kind === 'video', onFraction, signal });
  } catch (e) {
    await removeFile(name);
    throw e;
  }
  await db.upsertVideo({
    id: clipId, title: title || `${v?.title ?? d.videoId} (clip)`, channel: v?.channel ?? '',
    durationMs: totalMs(segs), thumbnailUrl: v?.thumbnailUrl || yt.thumbOf(sourceOf(clipId)), uploadedAt: v?.uploadedAt ?? null,
    addedAt: Date.now(), description: v?.description ?? null, segments: segs, dirty: true,
  });
  const id = await db.insertDownload({
    videoId: clipId, kind: d.kind, status: 'queued', createdAt: Date.now(), fileName: name,
    quality: d.quality, audioTrack: d.audioTrack ?? null, segments: segs,
  });
  await finalize(id, clipId, name);
  if (playlistId) await db.addVideoToPlaylist(playlistId, clipId);
  return clipId;
}

/**
 * A clip's download: the source's file of that kind (downloaded first if
 * needed — the queue is FIFO, so the cut runs after it), then the clip's
 * ranges cut out of it — the same ranges as the clip's other file, if any.
 */
async function enqueueClip(clipId, kind, opts) {
  if (await db.doneDownload(clipId, kind)) return 'skipped';
  const failed = async (reason) => {
    await fail(await db.insertDownload({ videoId: clipId, kind, status: 'queued', createdAt: Date.now() }), reason);
    return 'failed';
  };
  const segments = await timelineOf(clipId);
  if (!segments?.length) return failed('This clip has no segments');
  const src = sourceOf(clipId);
  if (!(await db.videoById(src))) { // a clip synced from another device: its source isn't in this library
    try {
      const m = await yt.fetchMeta(src);
      await db.upsertVideo({ ...m, id: src, addedAt: Date.now(), description: descriptionFor(src, m.description) });
    } catch { /* the download shows the bare id */ }
  }
  const sourceActive = (await db.downloadsOf(src)).some((x) => x.kind === kind && ['queued', 'running', 'muxing'].includes(x.status));
  if (!(await db.doneDownload(src, kind)) && !sourceActive) {
    if ((await (kind === 'audio' ? enqueueAudio : enqueueVideo)(src, opts)) === 'failed') return failed('The source video could not be downloaded');
  }
  const id = await db.insertDownload({ videoId: clipId, kind, status: 'queued', createdAt: Date.now(), segments });
  queue(id, async (signal) => {
    const s = await db.doneDownload(src, kind);
    if (!s) throw new Error('The source download did not finish');
    const keep = toLocal((await fileSegments(s)) ?? WHOLE, segments);
    if (!keep.length) throw new Error("The source's downloaded file was edited and no longer holds this clip");
    const name = `${clipId}.${extOf(s.fileName)}`;
    await db.updateDownload(id, { fileName: name });
    report(id, { phase: 'cutting', fraction: 0 });
    await cutFile(id, s.fileName, name, keep, {
      video: kind === 'video', signal,
      onFraction: (fraction) => report(id, { phase: 'cutting', fraction }),
    });
    await finalize(id, clipId, name);
  });
  return 'queued';
}

async function finalize(id, videoId, name) {
  // A new download of a video whose other file was edited: cut it to match.
  const target = await timelineOf(videoId, id);
  const d = await db.downloadById(id);
  if (target && d && !same(await fileSegments({ ...d, fileName: name }), target)) {
    report(id, { phase: 'cutting', fraction: 0 });
    await conform(id, { ...d, fileName: name }, target, { onFraction: (fraction) => report(id, { phase: 'cutting', fraction }) });
  }
  const size = (await fileOf(name)).size;
  await saveThumb(videoId);
  await db.updateDownload(id, { status: 'done', fileName: name, fileSize: size, completedAt: Date.now() });
}

/** Thumbnail next to the media so the library looks right offline. Best effort. */
async function saveThumb(videoId) {
  try {
    const res = await fetch(yt.thumbOf(sourceOf(videoId)), { credentials: 'omit' });
    if (!res.ok) return;
    const out = await (await (await media()).getFileHandle(`${videoId}.jpg`, { create: true })).createWritable();
    await res.body.pipeTo(out);
    thumbUrls.delete(videoId); // drop a cached "not saved"
  } catch { /* offline thumbnails are a nicety */ }
}

const thumbUrls = new Map();
/** Object URL of the saved thumbnail, or null. Cached per page. */
export async function thumbUrl(videoId) {
  if (thumbUrls.has(videoId)) return thumbUrls.get(videoId);
  let url = null;
  try { url = URL.createObjectURL(await fileOf(`${videoId}.jpg`)); } catch { /* not saved */ }
  thumbUrls.set(videoId, url);
  return url;
}

/** Object URL for a finished download (caller revokes). */
export async function fileUrl(d) {
  return URL.createObjectURL(await fileOf(d.fileName));
}

/** Cancel (if queued/running) and remove the row and every file it made — nothing left behind. */
export async function deleteDownload(d) {
  await cancel(d.id);
  await db.deleteDownloadRow(d.id);
  const others = (await db.downloadsOf(d.videoId)).filter((x) => x.status === 'done');
  const inUse = new Set(others.map((x) => x.fileName));
  for (const name of [d.fileName, ...(d.parts ?? [])]) if (name && !inUse.has(name)) await removeFile(name);
  if (!others.length) {
    await removeFile(`${d.videoId}.jpg`);
    thumbUrls.delete(d.videoId);
  }
}

/**
 * PURE — media files nothing needs: not a finished download, its thumbnail,
 * or a file of a job that is still queued/running in this tab (activeIds).
 * Catches parts of failed/cancelled jobs, half-written files and orphans.
 */
export function unusedFiles(names, rows, activeIds) {
  const keep = new Set();
  for (const d of rows) {
    if (d.status === 'done') keep.add(d.fileName).add(`${d.videoId}.jpg`);
    else if (activeIds.has(d.id)) for (const n of [d.fileName, ...(d.parts ?? [])]) keep.add(n);
  }
  return names.filter((n) => !keep.has(n));
}

/**
 * Settings › Clear storage. Deletes unused files (see unusedFiles); with
 * removeDownloads, every finished download too (running ones carry on).
 * @returns {{ files: number, bytes: number }} what was freed
 */
export async function clearStorage({ removeDownloads = false } = {}) {
  let bytes = 0;
  let files = 0;
  if (removeDownloads) {
    for (const d of await db.downloadsInStatus(['done'])) {
      bytes += d.fileSize ?? 0;
      files++;
      await deleteDownload(d);
    }
  }
  const dir = await media();
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  const rows = await db.downloadsInStatus(['done', 'queued', 'running', 'muxing']);
  for (const name of unusedFiles(names, rows, new Set(jobs.keys()))) {
    try { bytes += (await (await dir.getFileHandle(name)).getFile()).size; } catch { /* a directory or gone */ }
    await removeFile(name);
    files++;
  }
  for (const u of thumbUrls.values()) if (u) URL.revokeObjectURL(u);
  thumbUrls.clear();
  return { files, bytes };
}

/** force: the cached stream URL may be what just failed — always re-resolve. */
export async function retry(d) {
  await deleteDownload(d);
  return d.kind === 'audio' ? enqueueAudio(d.videoId, { force: true }) : enqueueVideo(d.videoId, { force: true });
}

/** Bulk download; returns [queued, skipped, failed]. */
export async function downloadPlaylist(playlistId, kind) {
  const counts = [0, 0, 0];
  for (const v of await db.playlistVideos(playlistId)) {
    const r = await (kind === 'audio' ? enqueueAudio(v.id) : enqueueVideo(v.id));
    counts[['queued', 'skipped', 'failed'].indexOf(r)]++;
    // ponytail: fixed pacing; every resolve hits youtube.com and a burst trips its bot check.
    if (r === 'queued') await sleep(2000);
  }
  return counts;
}

export async function deletePlaylistDownloads(playlistId) {
  let removed = 0;
  for (const v of await db.playlistVideos(playlistId)) {
    for (const kind of ['audio', 'video']) {
      const d = await db.doneDownload(v.id, kind);
      if (d) { await deleteDownload(d); removed++; }
    }
  }
  return removed;
}

/** Auto-remove: a per-download expiry always wins; else the global setting. Runs on boot/visible. */
export async function sweep() {
  const enabled = (await db.getSetting('autoRemoveEnabled')) === 'true';
  const days = +(await db.getSetting('autoRemoveDays')) || 30;
  const now = Date.now();
  for (const d of await db.downloadsInStatus(['done'])) {
    const expired = d.expiresAt != null
      ? now > d.expiresAt
      : enabled && d.completedAt != null && now > d.completedAt + days * 86400000;
    if (expired) await deleteDownload(d);
  }
}

/** Save a finished download to the user's disk. */
export async function exportToDisk(d, title) {
  const url = await fileUrl(d);
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `${(title || d.videoId).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120)}.${d.fileName.split('.').pop()}`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
