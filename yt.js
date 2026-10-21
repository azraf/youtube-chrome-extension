// YouTube innertube access — port of apps/youtube_personal/lib/services/yt_gateway.dart.
// Every request carries Chrome's own User-Agent (no UA faking) and never the
// user's YouTube cookies (credentials:'omit').
// ponytail: anonymous only — no sign-in/TV client; if YouTube bot-checks all
// three clients from this IP there is no fallback.

const YT = 'https://www.youtube.com';
const PLAYER = `${YT}/youtubei/v1/player?prettyPrint=false`;

/** Headers for every googlevideo request. googlevideo throttles a plain or
 *  open-ended request to about playback speed; downloads.js replaces Range
 *  with sequential 10 MB ranges, which are served at full speed. */
export const STREAM_HEADERS = { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Range: 'bytes=0-' };

const LOCALE = { hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 };
// The in-body userAgent is part of the visionOS client identity, not an HTTP header.
const VISION_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const CLIENTS = [
  { header: '101', visitor: true, client: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1', userAgent: VISION_UA, osName: 'visionOS', osVersion: '26.5.23O471' } },
  { header: 'ANDROID_VR', client: { clientName: 'ANDROID_VR', clientVersion: '1.56.21', deviceModel: 'Quest 3',
    osVersion: '12', osName: 'Android', androidSdkVersion: '32' } },
  { header: 'ANDROID', client: { clientName: 'ANDROID', clientVersion: '20.10.38',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', osName: 'Android', osVersion: '11' } },
];
const WEB = { clientName: 'WEB', clientVersion: '2.20220921.00.00', ...LOCALE };

// ---------------------------------------------------------------- pure parsing

const text = (t) => t?.simpleText ?? t?.content ?? (t?.runs ?? []).map((r) => r.text).join('') ?? '';
const clock = (s) => (s ?? '').split(':').reduce((a, n) => a * 60 + (+n || 0), 0) * 1000;
const extOf = (mime) => ({ 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm' })[mime.split(';')[0]] ?? 'bin';
const byBitrate = (a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0);
const stream = (f) => f && { url: f.url, ext: extOf(f.mimeType), size: +f.contentLength || 0 };

export const thumbOf = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/** Metadata from a player response (videoDetails + microformat). */
export function metaOf(pr, id = pr?.videoDetails?.videoId) {
  const d = pr?.videoDetails ?? {};
  const mf = pr?.microformat?.playerMicroformatRenderer ?? {};
  const up = mf.uploadDate ?? mf.publishDate;
  return {
    id, title: d.title ?? '', channel: d.author ?? '', durationMs: (+d.lengthSeconds || 0) * 1000,
    thumbnailUrl: id ? thumbOf(id) : '', uploadedAt: up ? Date.parse(up) || null : null,
    description: d.shortDescription ?? '',
  };
}

const trackId = (f) => f.audioTrack?.id ?? '';

/** Pick the streams from a player response; throws when unplayable. */
const BOT_CHECK = "YouTube is asking this network to prove it isn't a bot, so it won't play or download anonymously right now. " +
  'This usually clears by itself after a few hours of lighter use; another network (e.g. a phone hotspot) works meanwhile.';

export function pickStreams(pr, id) {
  const ps = pr?.playabilityStatus ?? {};
  if (/not a bot/i.test(ps.reason ?? '')) throw Object.assign(new Error(BOT_CHECK), { expected: true });
  if (ps.status !== 'OK') throw Object.assign(new Error(ps.reason || `Unplayable (${ps.status ?? 'no status'})`), { expected: true });
  const sd = pr.streamingData ?? {};
  // Only plain (un-ciphered) URLs are usable without the js solver.
  const muxed = (sd.formats ?? []).filter((f) => f.url).sort(byBitrate);
  const adaptive = (sd.adaptiveFormats ?? []).filter((f) => f.url && +f.contentLength > 0);
  // Every audio track (original + dubs), in YouTube's order.
  const audioFormats = adaptive.filter((f) => f.mimeType.startsWith('audio/')).sort(byBitrate);
  const audioTracks = [];
  for (const f of adaptive) {
    if (!f.mimeType.startsWith('audio/') || audioTracks.some((t) => t.id === trackId(f))) continue;
    audioTracks.push({ id: trackId(f), name: f.audioTrack?.displayName ?? 'Default', isDefault: f.audioTrack ? f.audioTrack.audioIsDefault !== false : true });
  }
  if (!audioTracks.length) audioTracks.push({ id: '', name: 'Default', isDefault: true });
  const defaultTrack = (audioTracks.find((t) => t.isDefault) ?? audioTracks[0]).id;
  if (!audioFormats.length && !muxed.length) throw new Error('No audio stream');
  // ponytail: H.264 ≤1080p only (as the app); >1080p mp4 is AV1.
  const mp4 = adaptive.filter((f) => f.mimeType.startsWith('video/mp4'));
  const avc = mp4.filter((f) => /codecs="avc1/.test(f.mimeType));
  const videoFormats = (avc.length ? avc : mp4).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const videoVariants = videoFormats.map((f) => ({ height: f.height ?? 0, url: f.url, size: +f.contentLength || 0 }));
  const video = videoVariants.find((v) => v.height <= 1080) ?? videoVariants.at(-1) ?? null;
  const r = {
    ...metaOf(pr, id),
    audioTracks, defaultTrack, audioFormats, videoFormats, muxedFormat: muxed[0] ?? null,
    videoUrl: video?.url ?? null,
    videoSize: video?.size ?? 0,
    videoVariants,
    muxedUrl: muxed[0]?.url ?? null,
  };
  const { audio, muxAudio } = audioFor(r);
  const expire = +new URL(audio.url).searchParams.get('expire');
  return { ...r, audio, muxAudio, expiresAt: expire ? expire * 1000 - 5 * 60 * 1000 : Date.now() + 5 * 3600 * 1000 };
}

/** Best audio of one track (unknown/omitted → default): any codec, and AAC for muxing into .mp4. */
export function audioFor(r, id = r.defaultTrack) {
  const track = r.audioTracks.find((t) => t.id === id) ?? r.audioTracks.find((t) => t.id === r.defaultTrack);
  const fs = r.audioFormats.filter((f) => trackId(f) === track.id);
  const best = fs[0] ?? r.muxedFormat;
  // High mux wants AAC so `-c copy` into .mp4 stays valid; opus only if no AAC exists.
  return { track, audio: stream(best), muxAudio: stream(fs.find((f) => f.mimeType.startsWith('audio/mp4')) ?? best) };
}

/** Track id for a preferred language code ('en'); '' or no match → the default track. */
export function trackFor(r, lang) {
  const t = lang && r.audioTracks.find((x) => x.id.split(/[.-]/)[0].toLowerCase() === lang.toLowerCase());
  return t ? t.id : r.defaultTrack;
}

/** Tallest mp4 video ≤ maxHeight whose size + audioBytes fits maxBytes; none fits → the smallest. */
export function videoFor(r, { maxHeight = 1080, maxBytes = Infinity, audioBytes = 0 } = {}) {
  return r.videoVariants.find((v) => v.height <= maxHeight && v.size + audioBytes <= maxBytes) ?? r.videoVariants.at(-1) ?? null;
}

/** Best mp4 video-only stream ≤ maxHeight; all taller → smallest; none → muxed. */
export function videoUrlUpTo(r, maxHeight) {
  if (!r.videoVariants.length) return r.muxedUrl;
  return (r.videoVariants.find((v) => v.height <= maxHeight) ?? r.videoVariants.at(-1)).url;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const codecsOf = (f) => f.mimeType.match(/codecs="([^"]+)"/)?.[1] ?? '';
const hasRanges = (f) => f.initRange && f.indexRange;
function representation(f, rid, extra) {
  return `<Representation id="${rid}" codecs="${xml(codecsOf(f))}" bandwidth="${f.bitrate ?? 1}"${extra}>` +
    `<BaseURL>${xml(f.url)}</BaseURL><SegmentBase indexRange="${f.indexRange.start}-${f.indexRange.end}">` +
    `<Initialization range="${f.initRange.start}-${f.initRange.end}"/></SegmentBase></Representation>`;
}

/**
 * A DASH manifest for streaming: H.264 video ≤ maxHeight (unless video:false)
 * and the chosen track's AAC audio, both as byte-range segments — so a
 * player fetches small ranges (full speed) and can seek. null when YouTube
 * gave no segment index (then play the muxed/audio URL directly).
 */
export function dashManifest(r, { trackId: tid = r.defaultTrack, maxHeight = 1080, video = true }) {
  const { track } = audioFor(r, tid);
  const audios = r.audioFormats.filter((f) => trackId(f) === track.id && f.mimeType.startsWith('audio/mp4') && hasRanges(f));
  const videos = video ? r.videoFormats.filter((f) => (f.height ?? 0) <= maxHeight && hasRanges(f) && /avc1/.test(f.mimeType)) : [];
  if (!audios.length || (video && !videos.length)) return null;
  const secs = (r.durationMs || +audios[0].approxDurationMs || 0) / 1000;
  const lang = track.id.split(/[.-]/)[0] || 'und';
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" minBufferTime="PT2S" mediaPresentationDuration="PT${secs.toFixed(3)}S"><Period>${
  videos.length ? `<AdaptationSet contentType="video" mimeType="video/mp4" subsegmentAlignment="true">${
    videos.map((f) => representation(f, f.itag, ` width="${f.width ?? 0}" height="${f.height ?? 0}"${f.fps ? ` frameRate="${f.fps}"` : ''}`)).join('')}</AdaptationSet>` : ''
}<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="${xml(lang)}" subsegmentAlignment="true">${
    audios.map((f) => representation(f, `a${f.itag}`, f.audioSampleRate ? ` audioSamplingRate="${f.audioSampleRate}"` : '')).join('')
}</AdaptationSet></Period></MPD>`;
}

const continuationToken = (item) =>
  item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ??
  item?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand?.commands
    ?.map((c) => c.continuationCommand?.token).find(Boolean) ??
  item?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token ??
  item?.continuationItemViewModel?.continuationCommand?.token ??
  null;

function playlistItem(item) {
  const r = item.playlistVideoRenderer ?? item.richItemRenderer?.content?.playlistVideoRenderer ?? item.playlistPanelVideoRenderer;
  if (r?.videoId) {
    return { id: r.videoId, title: text(r.title), channel: text(r.shortBylineText), durationMs: r.lengthSeconds ? +r.lengthSeconds * 1000 : clock(text(r.lengthText)) };
  }
  const l = item.lockupViewModel;
  if (l?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !l.contentId) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  return {
    id: l.contentId, title: text(meta?.title),
    channel: text(meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text),
    durationMs: 0,
  };
}

const isListItem = (i) => i.playlistVideoRenderer || i.richItemRenderer?.content?.playlistVideoRenderer ||
  i.lockupViewModel || i.continuationItemRenderer || i.continuationItemViewModel;

/** One browse page (initial or continuation) → { title, items, token }. */
export function playlistPage(root) {
  let items = null;
  for (const a of root.onResponseReceivedActions ?? root.onResponseReceivedCommands ?? []) {
    items = a.appendContinuationItemsAction?.continuationItems ?? a.reloadContinuationItemsCommand?.continuationItems;
    if (items) break;
  }
  if (!items) {
    outer: for (const tab of root.contents?.twoColumnBrowseResultsRenderer?.tabs ?? []) {
      for (const sec of tab.tabRenderer?.content?.sectionListRenderer?.contents ?? []) {
        const ic = sec.itemSectionRenderer?.contents;
        if (!ic) continue;
        if (ic.some(isListItem)) { items = ic; break outer; }
        const nested = ic.find((i) => i.playlistVideoListRenderer)?.playlistVideoListRenderer?.contents;
        if (nested) { items = nested; break outer; }
      }
    }
  }
  items ??= [];
  return {
    title: root.metadata?.playlistMetadataRenderer?.title || text(root.header?.playlistHeaderRenderer?.title) ||
      root.header?.pageHeaderRenderer?.pageTitle || null,
    items: items.map(playlistItem).filter(Boolean),
    token: items.map(continuationToken).find(Boolean) ?? null,
  };
}

/** One search page → { items, token }. */
export function searchPage(root) {
  const sections = root.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ??
    root.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems ?? [];
  const items = [];
  for (const sec of sections) {
    for (const i of sec.itemSectionRenderer?.contents ?? []) {
      const v = i.videoRenderer;
      if (v?.videoId) items.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText), durationMs: clock(text(v.lengthText)) });
    }
  }
  return { items, token: sections.map(continuationToken).find(Boolean) ?? null };
}

// ---------------------------------------------------------------- network

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} HTTP ${res.status}`);
  return res.json();
}

let visitor = null;
/** Anonymous visitor id; without it YouTube bot-checks the app clients. */
async function visitorId() {
  if (visitor) return visitor;
  const res = await fetch(`${YT}/sw.js_data`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`sw.js_data HTTP ${res.status}`);
  return (visitor = JSON.parse((await res.text()).replace(/^\)\]\}'/, ''))[0][2][0][0][13]);
}

async function player(videoId, c) {
  const vd = c.visitor ? await visitorId() : null;
  return postJson(PLAYER,
    { context: { client: { ...c.client, ...LOCALE, ...(vd && { visitorData: vd }) } }, videoId, contentCheckOk: true, racyCheckOk: true },
    { 'X-Youtube-Client-Name': c.header, 'X-Youtube-Client-Version': c.client.clientVersion, ...(vd && { 'X-Goog-Visitor-Id': vd }) });
}

/** Without a PO token YouTube serves only ~3 MB then 403s; a 1-byte probe 4 MB in tells us. */
async function previewLimited(url, total) {
  const last = Math.min(4 << 20, total - 1);
  if (last <= 0) return false;
  const res = await fetch(url, { headers: { ...STREAM_HEADERS, Range: `bytes=${last}-${last}` }, credentials: 'omit' });
  res.body?.cancel();
  return res.status === 403;
}

const cache = new Map();

/** Stream URLs for a video, trying each client; cached until near-expiry. */
export async function resolve(videoId, { force = false } = {}) {
  const hit = cache.get(videoId);
  if (!force && hit && hit.expiresAt > Date.now()) return hit;
  let last;
  for (const c of CLIENTS) {
    try {
      const r = pickStreams(await player(videoId, c), videoId);
      if (await previewLimited(r.audio.url, r.audio.size)) {
        last = new Error(`${c.client.clientName} is preview-limited`);
        continue;
      }
      r.client = c.client.clientName;
      cache.set(videoId, r);
      return r;
    } catch (e) {
      last = e;
      if (c.visitor) visitor = null; // a bot-checked visitor stays bot-checked
    }
  }
  if (last?.message === BOT_CHECK) throw last;
  throw Object.assign(new Error(`Could not resolve streams for ${videoId} (all clients failed): ${last?.message ?? last}`), { expected: true });
}

/** Title/channel/duration/upload date; no stream probe. */
export async function fetchMeta(videoId) {
  let last;
  for (const c of CLIENTS) {
    try {
      const pr = await player(videoId, c);
      if (pr?.videoDetails?.title) return metaOf(pr, videoId);
      last = new Error(pr?.playabilityStatus?.reason ?? 'No video details');
    } catch (e) {
      last = e;
      if (c.visitor) visitor = null;
    }
  }
  throw last;
}

const webPost = (endpoint, body) => postJson(`${YT}/youtubei/v1/${endpoint}?prettyPrint=false`,
  { context: { client: WEB }, ...body }, { 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': WEB.clientVersion });

/** A YouTube playlist: { title, items:[{id,title,channel,durationMs}] }, all pages. */
export async function playlist(id, onPage = () => {}) {
  if (id.startsWith('RD')) {
    // Mixes aren't browsable; the watch-next panel lists them.
    const r = await webPost('next', { playlistId: id, ...(id.length === 13 && { videoId: id.slice(2) }) });
    const pl = r.contents?.twoColumnWatchNextResults?.playlist?.playlist;
    const items = (pl?.contents ?? []).map(playlistItem).filter(Boolean);
    if (!items.length) throw new Error('Playlist layout changed');
    return { title: pl.title ?? 'Mix', items };
  }
  let page = playlistPage(await webPost('browse', { browseId: `VL${id}` }));
  const title = page.title ?? id;
  const seen = new Set();
  const items = [];
  for (;;) {
    for (const v of page.items) if (!seen.has(v.id)) { seen.add(v.id); items.push(v); }
    onPage(items.length);
    const token = page.token;
    if (!token) break;
    page = playlistPage(await webPost('browse', { continuation: token }));
    if (page.token === token) break; // stuck token guard
  }
  if (!items.length) throw new Error('Playlist layout changed (no videos found)');
  return { title, items };
}

/** Video search; pass the previous page's token for more. */
export async function search(query, token = null) {
  return searchPage(await webPost('search', token ? { continuation: token } : { query, params: 'EgIQAQ%3D%3D' }));
}
