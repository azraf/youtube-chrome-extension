// node apps/youtube_extension/test.mjs — pure checks, no browser needed.
import assert from 'node:assert/strict';
import { extractVideoId, extractPlaylistId, isPlaylistUrl, parseInput } from './parse.js';
import * as clip from './clip.js';
import { isNewer } from './update.js';
import { pickStreams, videoUrlUpTo, playlistPage, searchPage, audioFor, trackFor, videoFor, dashManifest } from './yt.js';

// ---- extractVideoId ----
const ID = 'dQw4w9WgXcQ';
for (const u of [
  `https://www.youtube.com/watch?v=${ID}`,
  `https://m.youtube.com/watch?feature=share&v=${ID}&t=10`,
  `https://youtu.be/${ID}?si=abc123`,
  `https://www.youtube.com/shorts/${ID}?si=xyz`,
  `https://www.youtube.com/shorts/${ID}/`,
  `https://www.youtube.com/embed/${ID}?start=3`,
  `https://www.youtube.com/live/${ID}?feature=share`,
  ` ${ID} `,
]) assert.equal(extractVideoId(u), ID, u);
assert.equal(extractVideoId('https://example.com/watch?v=nope'), null);
assert.equal(extractVideoId('garbage'), null);

// ---- extractPlaylistId ----
const PL = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
assert.equal(extractPlaylistId(`https://www.youtube.com/playlist?list=${PL}`), PL);
assert.equal(extractPlaylistId(`https://www.youtube.com/watch?v=${ID}&list=${PL}&index=2`), PL);
assert.equal(extractPlaylistId('WL'), 'WL');
assert.equal(extractPlaylistId('RDMM'), 'RDMM');
assert.equal(extractPlaylistId('https://www.youtube.com/playlist?list=a!'), null);
// watch?v=X&list=Y is a video, not a playlist import
assert.equal(isPlaylistUrl(`https://www.youtube.com/watch?v=${ID}&list=${PL}`), false);
assert.equal(isPlaylistUrl(`https://www.youtube.com/playlist?list=${PL}`), true);
assert.equal(isPlaylistUrl(`https://youtu.be/${ID}`), false);

// ---- parseInput (input_parser.dart) ----
let p = parseInput(`Road trip:\nChill: https://youtu.be/${ID}\n\nhttps://www.youtube.com/watch?v=aaaaaaaaaaa\nnot a url line`);
assert.equal(p.playlistName, 'Road trip');
assert.deepEqual(p.urls, [`https://youtu.be/${ID}`, 'https://www.youtube.com/watch?v=aaaaaaaaaaa']);
assert.deepEqual(p.tagsByUrl, { [`https://youtu.be/${ID}`]: ['Chill'] });
assert.equal(p.isStructured, true);
p = parseInput(`https://youtu.be/${ID}\nhttps://youtu.be/bbbbbbbbbbb`);
assert.equal(p.playlistName, null);
assert.equal(p.urls.length, 2);
p = parseInput(`look https://youtu.be/${ID} here`);
assert.deepEqual(p.urls, [`https://youtu.be/${ID}`]);
assert.equal(p.isStructured, false);

// ---- pickStreams ----
const f = (itag, mimeType, extra = {}) => ({
  itag, mimeType, url: `https://rr1.googlevideo.com/videoplayback?itag=${itag}&expire=2000000000`,
  contentLength: '1000', bitrate: 100, ...extra,
});
const ZH = { id: 'zh.4', displayName: 'Chinese original', audioIsDefault: true };
const EN = { id: 'en.3', displayName: 'English', audioIsDefault: false };
const ranges = { initRange: { start: '0', end: '740' }, indexRange: { start: '741', end: '2000' } };
const pr = {
  playabilityStatus: { status: 'OK' },
  videoDetails: { title: 'T', author: 'C', lengthSeconds: '212', shortDescription: 'About it' },
  microformat: { playerMicroformatRenderer: { uploadDate: '2009-10-25T00:00:00-07:00' } },
  streamingData: {
    formats: [f(18, 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', { bitrate: 500, contentLength: undefined })],
    adaptiveFormats: [
      f(140, 'audio/mp4; codecs="mp4a.40.2"', { bitrate: 130, contentLength: '100', audioTrack: ZH, url: 'https://g/zh140?expire=2000000000', ...ranges }),
      f(140, 'audio/mp4; codecs="mp4a.40.2"', { bitrate: 130, contentLength: '100', audioTrack: EN, url: 'https://g/en140?expire=2000000000&x=1', ...ranges }),
      f(251, 'audio/webm; codecs="opus"', { bitrate: 160, audioTrack: ZH, url: 'https://g/zh251?expire=2000000000' }),
      f(251, 'audio/webm; codecs="opus"', { bitrate: 160, audioTrack: EN, url: 'https://g/en251?expire=2000000000' }),
      f(137, 'video/mp4; codecs="avc1.640028"', { height: 1080, width: 1920, contentLength: '3000', ...ranges }),
      f(136, 'video/mp4; codecs="avc1.4d401f"', { height: 720, width: 1280, contentLength: '900', ...ranges }),
      f(135, 'video/mp4; codecs="avc1.4d401e"', { height: 480, width: 854, contentLength: '400', ...ranges }),
      f(399, 'video/mp4; codecs="av01.0.08M.08"', { height: 1080 }),
      f(313, 'video/webm; codecs="vp9"', { height: 2160 }),
      f(22, 'video/mp4; codecs="avc1.64001F"', { height: 1440, url: undefined }),
    ],
  },
};
const s = pickStreams(pr);
// default track = the one YouTube marks default
assert.deepEqual(s.audioTracks, [{ id: 'zh.4', name: 'Chinese original', isDefault: true }, { id: 'en.3', name: 'English', isDefault: false }]);
assert.equal(s.defaultTrack, 'zh.4');
assert.equal(s.audio.url, 'https://g/zh251?expire=2000000000');
assert.equal(s.audio.ext, 'webm');
assert.equal(s.muxAudio.url, 'https://g/zh140?expire=2000000000');
assert.equal(s.muxAudio.ext, 'm4a');
// English dub on request
const en = audioFor(s, 'en.3');
assert.equal(en.audio.url, 'https://g/en251?expire=2000000000');
assert.equal(en.muxAudio.url, 'https://g/en140?expire=2000000000&x=1');
assert.equal(en.track.name, 'English');
assert.equal(audioFor(s, 'nope').track.id, 'zh.4'); // unknown → default
assert.equal(trackFor(s, 'en'), 'en.3');
assert.equal(trackFor(s, ''), 'zh.4');
assert.equal(trackFor(s, 'fr'), 'zh.4');
assert.match(s.videoUrl, /itag=137/);
assert.match(s.muxedUrl, /itag=18/);
assert.match(videoUrlUpTo(s, 720), /itag=136/);
assert.match(videoUrlUpTo(s, 100), /itag=135/); // all taller → smallest
// High download: best that fits the merge limit with the audio
assert.equal(videoFor(s, { maxBytes: 1000, audioBytes: 100 }).height, 720);
assert.equal(videoFor(s, { maxBytes: 550, audioBytes: 100 }).height, 480);
assert.equal(videoFor(s, { maxBytes: 10, audioBytes: 100 }).height, 480); // none fits → smallest
assert.equal(s.expiresAt, 2000000000 * 1000 - 5 * 60 * 1000);
assert.equal(s.durationMs, 212000);
assert.equal(s.description, 'About it');
assert.equal(s.title, 'T');
assert.throws(() => pickStreams({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm' } }), /Sign in/);
// YouTube's bot check gets a plain explanation and is marked expected (not logged as an error)
assert.throws(() => pickStreams({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } }),
  (e) => e.expected === true && /YouTube is asking this network to prove it isn't a bot/.test(e.message));
// no adaptive audio → muxed carries it; a single unnamed track
const onlyMuxed = pickStreams({ playabilityStatus: { status: 'OK' }, streamingData: { formats: [f(18, 'video/mp4')] } });
assert.match(onlyMuxed.audio.url, /itag=18/);
assert.equal(onlyMuxed.audio.ext, 'mp4');
assert.equal(onlyMuxed.videoUrl, null);
assert.equal(onlyMuxed.audioTracks.length, 1);
assert.equal(videoUrlUpTo(onlyMuxed, 720), onlyMuxed.muxedUrl);
assert.equal(dashManifest(onlyMuxed, {}), null); // nothing DASH-able

// ---- dashManifest: H.264 ≤ cap + the chosen track's AAC, SegmentBase ranges, escaped URLs ----
const mpd = dashManifest(s, { trackId: 'en.3', maxHeight: 720 });
assert.match(mpd, /mediaPresentationDuration="PT212(\.0+)?S"/);
assert.deepEqual([...mpd.matchAll(/<Representation id="([^"]+)"/g)].map((m) => m[1]), ['136', '135', 'a140']);
assert.match(mpd, /<BaseURL>https:\/\/g\/en140\?expire=2000000000&amp;x=1<\/BaseURL>/);
assert.match(mpd, /indexRange="741-2000"/);
assert.match(mpd, /<Initialization range="0-740"\/>/);
assert.match(mpd, /codecs="avc1.4d401f"/);
assert.doesNotMatch(mpd, /zh140|av01|vp9/);
const audioOnly = dashManifest(s, { trackId: 'zh.4', video: false });
assert.doesNotMatch(audioOnly, /contentType="video"/);
assert.match(audioOnly, /zh140/);

// ---- playlistPage (initial page, classic renderer + lockup + continuation) ----
const page = playlistPage({
  metadata: { playlistMetadataRenderer: { title: 'My list' } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: [
      { playlistVideoRenderer: { videoId: ID, title: { runs: [{ text: 'Song' }, { text: ' one' }] }, shortBylineText: { runs: [{ text: 'Artist' }] }, lengthSeconds: '212' } },
      { playlistVideoRenderer: { title: { simpleText: '[Deleted video]' } } },
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN1' } } } },
    ] } }] } },
  ] } } } }] } },
});
assert.equal(page.title, 'My list');
assert.deepEqual(page.items, [{ id: ID, title: 'Song one', channel: 'Artist', durationMs: 212000 }]);
assert.equal(page.token, 'TOKEN1');
const next = playlistPage({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
  { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'bbbbbbbbbbb', metadata: { lockupMetadataViewModel: { title: { content: 'Lockup' } } } } },
  { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: 'PLzzz' } },
] } }] });
assert.deepEqual(next.items, [{ id: 'bbbbbbbbbbb', title: 'Lockup', channel: '', durationMs: 0 }]);
assert.equal(next.token, null);

// ---- searchPage ----
const sp = searchPage({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
  { itemSectionRenderer: { contents: [
    { videoRenderer: { videoId: ID, title: { runs: [{ text: 'Hit' }] }, ownerText: { runs: [{ text: 'Ch' }] }, lengthText: { simpleText: '1:02:03' } } },
    { shelfRenderer: {} },
  ] } },
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'S2' } } } },
] } } } } });
assert.deepEqual(sp.items, [{ id: ID, title: 'Hit', channel: 'Ch', durationMs: 3723000 }]);
assert.equal(sp.token, 'S2');

// ---- fetchRanges: chunked download, resume mid-chunk, 403 → re-resolve with force ----
const { fetchRanges } = await import('./downloads.js');
const BODY = Uint8Array.from({ length: 25 }, (_, i) => i);
const seen = [];
let dropOnce = true;
let forbidOnce = true;
const fakeFetch = async (url, { headers }) => {
  const [a, b] = headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
  seen.push(`${url} ${a}-${b}`);
  if (url === 'old' && a >= 10 && forbidOnce) { forbidOnce = false; return { status: 403, body: null, headers: new Map() }; }
  const part = BODY.slice(a, Math.min(b + 1, 25));
  const drop = dropOnce && a === 0;
  if (drop) dropOnce = false;
  let step = 0; // pull-based so the first 4 bytes are delivered before the drop
  const body = new ReadableStream({
    pull(c) {
      if (step++ === 0) c.enqueue(part.slice(0, 4));
      else if (drop) c.error(new Error('network drop'));
      else { c.enqueue(part.slice(4)); c.close(); }
    },
  });
  return { status: 206, body, headers: new Map([['content-range', `bytes ${a}-${a + part.length - 1}/25`]]) };
};
const written = [];
let refreshed = false;
const forces = [];
const progressSeen = [];
const total = await fetchRanges({
  url: async (force) => { forces.push(force); if (force) refreshed = true; return refreshed ? 'new' : 'old'; }, // like yt.resolve's cache
  write: async (bytes) => { written.push(...bytes); },
  onBytes: (got, tot) => progressSeen.push([got, tot]),
  chunk: 10,
  fetchFn: fakeFetch,
});
assert.equal(total, 25);
assert.deepEqual(written, [...BODY]); // no gaps, no duplicates despite the drop and the 403
assert.deepEqual(seen, ['old 0-9', 'old 4-13', 'old 14-23', 'new 14-23', 'new 24-33']);
assert.deepEqual(forces, [false, false, false, true, false]);
assert.deepEqual(progressSeen.at(-1), [25, 25]);
await assert.rejects(fetchRanges({
  url: async () => 'x', write: async () => {}, onBytes: () => {}, chunk: 10,
  fetchFn: async () => ({ status: 500, body: null, headers: new Map() }),
}), /HTTP 500/);

// A range that stops sending data is abandoned after idleMs and resumed from the last byte.
{
  const reqs = [];
  const stallFetch = async (url, { headers, signal }) => {
    const [a, b] = headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    reqs.push(`${a}-${b}`);
    const part = BODY.slice(a, Math.min(b + 1, 25));
    const stall = reqs.length === 1;
    let step = 0;
    return {
      status: 206, headers: new Map([['content-range', `bytes ${a}-${a + part.length - 1}/25`]]),
      body: new ReadableStream({
        pull(c) {
          if (step++ === 0) return c.enqueue(part.slice(0, 4));
          if (stall) return new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted'))));
          c.enqueue(part.slice(4)); c.close();
        },
      }),
    };
  };
  const out = [];
  await fetchRanges({ url: async () => 'u', write: async (b) => { out.push(...b); }, onBytes: () => {}, chunk: 10, idleMs: 50, fetchFn: stallFetch });
  assert.deepEqual(out, [...BODY]);
  assert.deepEqual(reqs.slice(0, 2), ['0-9', '4-13']);
}
// Cancelling stops at once — no retries.
{
  const ac = new AbortController();
  let calls = 0;
  const p = fetchRanges({
    url: async () => 'u', write: async () => {}, onBytes: () => {}, chunk: 10, signal: ac.signal,
    fetchFn: async (u, { signal }) => {
      calls++;
      return { status: 206, headers: new Map([['content-range', 'bytes 0-9/25']]),
        body: new ReadableStream({ pull: () => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted')))) }) };
    },
  });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(calls, 1);
}

// The network goes away (the Mac sleeps, Wi-Fi drops): fetch throws TypeError "Failed to fetch".
// The download waits and resumes from the last byte instead of failing (it used to give up after
// 3 immediate tries, and the whole queue drained into "failed").
{
  let down = 6;
  const pauses = [];
  const out = [];
  const flaky = async (url, { headers }) => {
    const [a, b] = headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    if (a >= 10 && down > 0) { down--; throw new TypeError(down % 2 ? 'Failed to fetch' : 'network error'); }
    const part = BODY.slice(a, Math.min(b + 1, 25));
    return { status: 206, headers: new Map([['content-range', `bytes ${a}-${a + part.length - 1}/25`]]),
      body: new ReadableStream({ start(c) { c.enqueue(part); c.close(); } }) };
  };
  await fetchRanges({ url: async () => 'u', write: async (b) => { out.push(...b); }, onBytes: () => {}, chunk: 10,
    fetchFn: flaky, pauseFn: async (ms) => { pauses.push(ms); } });
  assert.deepEqual(out, [...BODY]);
  assert.deepEqual(pauses, [2000, 4000, 8000, 16000, 32000, 60000], 'backs off, capped at a minute');
  // …but not forever: offline long enough (~15 min of waiting), it reports a clear reason.
  await assert.rejects(fetchRanges({ url: async () => 'u', write: async () => {}, onBytes: () => {}, chunk: 10,
    fetchFn: async () => { throw new TypeError('Failed to fetch'); }, pauseFn: async () => {} }), /Network connection lost/);
  // A bug is not a network outage: it fails as before, without waiting.
  let waited = false;
  await assert.rejects(fetchRanges({ url: async () => 'u', write: async () => {}, onBytes: () => {}, chunk: 10,
    fetchFn: async () => null, pauseFn: async () => { waited = true; } }), TypeError);
  assert.equal(waited, false);
}

// ---- unusedFiles: what Clear storage may delete ----
{
  const { unusedFiles } = await import('./downloads.js');
  const names = [
    'AAAAAAAAAAA.mp4', 'AAAAAAAAAAA.jpg', // finished video + its thumbnail → keep
    'BBBBBBBBBBB.m4a', // finished audio, no thumbnail saved → keep
    'CCCCCCCCCCC.video.mp4', 'CCCCCCCCCCC.audio.m4a', 'CCCCCCCCCCC.mp4', // running High job → keep
    'DDDDDDDDDDD.video.mp4', 'DDDDDDDDDDD.audio.m4a', // failed job's parts → remove
    'EEEEEEEEEEE.m4a', 'EEEEEEEEEEE.jpg', // no row at all (cancelled / crashed) → remove
    'FFFFFFFFFFF.mp4', // queued row whose job no longer exists (tab closed) → remove
  ];
  const rows = [
    { id: 1, videoId: 'AAAAAAAAAAA', status: 'done', fileName: 'AAAAAAAAAAA.mp4' },
    { id: 2, videoId: 'BBBBBBBBBBB', status: 'done', fileName: 'BBBBBBBBBBB.m4a' },
    { id: 3, videoId: 'CCCCCCCCCCC', status: 'running', fileName: 'CCCCCCCCCCC.mp4', parts: ['CCCCCCCCCCC.video.mp4', 'CCCCCCCCCCC.audio.m4a'] },
    { id: 4, videoId: 'DDDDDDDDDDD', status: 'failed', fileName: 'DDDDDDDDDDD.mp4', parts: ['DDDDDDDDDDD.video.mp4', 'DDDDDDDDDDD.audio.m4a'] },
    { id: 5, videoId: 'FFFFFFFFFFF', status: 'queued', fileName: 'FFFFFFFFFFF.mp4' },
  ];
  assert.deepEqual(unusedFiles(names, rows, new Set([3])).sort(), [
    'DDDDDDDDDDD.audio.m4a', 'DDDDDDDDDDD.video.mp4', 'EEEEEEEEEEE.jpg', 'EEEEEEEEEEE.m4a', 'FFFFFFFFFFF.mp4']);
}

// ---- clip.js (mirrored by apps/youtube_personal/test/clip_test.dart) ----
{
  const { isClip, sourceOf, newClipId, totalMs, descriptionFor, newEdit, addSplit, removeSplit, toggleKeep, segmentsOf,
    keptSegments, compose, toLocal, nextJump, ffmpegPlan, copyIsExact } = clip;
  const cid = newClipId(ID, 1700000000000);
  assert.equal(cid, `${ID}~loyw3v28`);
  assert.ok(cid.length <= 32 && isClip(cid) && !isClip(ID));
  assert.equal(sourceOf(cid), ID);
  assert.equal(newClipId(cid, 1).split('~').length, 2, 'a clip of a clip names the source');
  assert.equal(descriptionFor(ID, '  Hello \n'), `https://youtu.be/${ID}\n\nHello`);
  assert.equal(descriptionFor(cid, ''), `https://youtu.be/${ID}`);

  // split 10 s into 0–3, 3–7, 7–10; drop the middle
  let e = addSplit(addSplit(newEdit(), 7000), 3000);
  assert.deepEqual(e, { splits: [3000, 7000], keep: [true, true, true] });
  e = toggleKeep(e, 1);
  assert.deepEqual(segmentsOf(e, 10000).map((x) => [x.start, x.end, x.keep]), [[0, 3000, true], [3000, 7000, false], [7000, 10000, true]]);
  assert.deepEqual(keptSegments(e, 10000), [[0, 3000], [7000, 10000]]);
  assert.equal(totalMs(keptSegments(e, 10000)), 6000);
  assert.deepEqual(addSplit(e, 3000), e, 'same point twice');
  assert.deepEqual(addSplit(e, 0), e, 'nothing before 0');
  assert.deepEqual(keptSegments(removeSplit(e, 0), 10000), [[0, 10000]], 'kept + dropped merge to kept');
  assert.deepEqual(keptSegments(newEdit(), 5000), [[0, 5000]]);
  assert.deepEqual(keptSegments(toggleKeep(toggleKeep(e, 0), 2), 10000), []);

  // timelines: a clip of [10–20 s, 30–40 s]; its own 5–15 s is source 15–20 + 30–35
  const parent = [[10000, 20000], [30000, 40000]];
  assert.deepEqual(compose(parent, [[5000, 15000]]), [[15000, 20000], [30000, 35000]]);
  assert.deepEqual(compose([[0, 60000]], [[1000, 2000]]), [[1000, 2000]]);
  assert.deepEqual(compose(parent, [[0, 10000], [10000, 20000]]), parent, 'touching ranges re-join only when contiguous at source');
  assert.deepEqual(toLocal(parent, [[15000, 35000]]), [[5000, 15000]]);
  assert.deepEqual(toLocal(parent, [[0, 5000]]), [], 'not in the file');
  assert.deepEqual(toLocal(parent, compose(parent, [[2000, 12000]])), [[2000, 12000]], 'round trip');

  // streaming a clip
  const segs = [[10000, 20000], [30000, 40000]];
  assert.deepEqual(nextJump(segs, 0), { seek: 10000 });
  assert.equal(nextJump(segs, 9800), null, 'a seek landing a hair early does not loop');
  assert.equal(nextJump(segs, 15000), null);
  assert.deepEqual(nextJump(segs, 20100), { seek: 30000 });
  assert.equal(nextJump(segs, 40000), 'end');

  // ffmpeg plans: exact everywhere (the A/V checks behind these rules are in clip.js)
  const tmp = (n) => `/t${n}`;
  assert.ok(copyIsExact([[1, 2], [3, 4]], false) && copyIsExact([[0, 5000]], true));
  assert.ok(!copyIsExact([[1000, 5000]], true) && !copyIsExact([[0, 1000], [2000, 3000]], true));
  const one = ffmpegPlan([[1500, 4000]], { input: 'in.m4a', output: 'out.m4a', ext: 'm4a', video: false, tmp });
  assert.deepEqual(one.runs, [['-y', '-i', 'in.m4a', '-ss', '1.500', '-t', '2.500', '-c', 'copy', 'out.m4a']], 'audio: copy, output seeking');
  assert.equal(one.list, null);
  const trim = ffmpegPlan([[0, 9000]], { input: 'in.mp4', output: 'out.mp4', ext: 'mp4', video: true, tmp });
  assert.deepEqual(trim.runs, [['-y', '-i', 'in.mp4', '-t', '9.000', '-c', 'copy', 'out.mp4']], 'video trimmed at the end: copy');
  const two = ffmpegPlan(segs, { input: 'in.webm', output: 'out.webm', ext: 'webm', video: false, tmp });
  assert.equal(two.runs.length, 3);
  assert.deepEqual(two.runs[2], ['-y', '-f', 'concat', '-safe', '0', '-i', '/tlist.txt', '-c', 'copy', 'out.webm']);
  assert.equal(two.list, "file '/t0.webm'\nfile '/t1.webm'");
  assert.deepEqual(two.temps, ['/t0.webm', '/t1.webm', '/tlist.txt']);
  const pv = ffmpegPlan(segs, { input: 'in.mp4', output: 'out.mp4', ext: 'mp4', video: true, tmp });
  assert.equal(pv.runs.length, 1, 'video ranges: one re-encode');
  const fc = pv.runs[0][pv.runs[0].indexOf('-filter_complex') + 1];
  assert.equal(fc, '[0:v]split=2[vi0][vi1];[0:a]asplit=2[ai0][ai1];'
    + '[vi0]trim=start=10.000:end=20.000,setpts=PTS-STARTPTS[v0];[ai0]atrim=start=10.000:end=20.000,asetpts=PTS-STARTPTS[a0];'
    + '[vi1]trim=start=30.000:end=40.000,setpts=PTS-STARTPTS[v1];[ai1]atrim=start=30.000:end=40.000,asetpts=PTS-STARTPTS[a1];'
    + '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
  assert.ok(pv.runs[0].includes('libx264') && pv.runs[0].includes('aac'));
  assert.ok(!ffmpegPlan([[1000, 2000]], { input: 'a.mp4', output: 'b.mp4', ext: 'mp4', video: true, tmp }).runs[0].includes('copy'), 'a video range not from 0 re-encodes');
  assert.throws(() => ffmpegPlan([], { input: 'a', output: 'b', ext: 'm4a', video: false, tmp }));
}

// ---- update.js isNewer (mirrors core_ui's app_update_test.dart) ----
assert.ok(isNewer('0.3.0', '0.2.0'));
assert.ok(isNewer('1.10.0', '1.9.9'), 'numeric, not text');
assert.ok(isNewer('2.0', '1.9.9'));
assert.ok(!isNewer('0.3.0', '0.3.0'));
assert.ok(!isNewer('1.2.0+9', '1.2.0+1'), 'build number ignored');
assert.ok(!isNewer('0.2.9', '0.3.0'), 'never offer a downgrade');

// ---- planFiles / remoteFiles (mirrors clip_test.dart) ----
{
  const at = (min) => Date.UTC(2026, 9, 25, 10, min);
  const f = (kind, segments, min) => ({ videoId: ID, kind, ext: kind === 'audio' ? 'm4a' : 'mp4', size: 1, segments, updatedAt: at(min) });
  const cut = [[0, 1000]];
  const remote = [f('audio', cut, 2), f('video', cut, 1)];
  assert.deepEqual(clip.planFiles([{ kind: 'audio', segs: null, pending: false }], remote), remote, 'whole files here: fetch both');
  assert.deepEqual(clip.planFiles([{ kind: 'audio', segs: cut, pending: false }], remote).map((x) => x.kind), ['video']);
  assert.deepEqual(clip.planFiles([{ kind: 'audio', segs: [[0, 5]], pending: true }], remote), [], 'own edit wins');
  assert.deepEqual(clip.planFiles([], [f('audio', cut, 5), f('video', [[0, 9]], 1)]).map((x) => x.kind), ['audio'], 'stale cut skipped');
  assert.deepEqual(clip.planFiles([], []), []);
  const parsed = clip.remoteFiles(ID, [
    { kind: 'video', ext: 'mp4', size: 9, segments: [[0, 1000]], updatedAt: '2026-10-25T10:00:00Z' },
    { kind: 'audio', ext: 'm4a', size: 9, segments: null, updatedAt: '2026-10-25T10:00:00Z' },
  ]);
  assert.deepEqual(parsed.map((x) => [x.kind, x.segments, x.updatedAt]), [['video', cut, Date.parse('2026-10-25T10:00:00Z')], ['audio', null, Date.parse('2026-10-25T10:00:00Z')]]);
  assert.deepEqual(clip.remoteFiles(ID, undefined), []);
  // A whole (unedited) download synced as is: segments null, equal to a local whole file.
  const whole = clip.remoteFiles(ID, [{ kind: 'audio', ext: 'm4a', size: 9, segments: null, updatedAt: '2026-10-25T10:00:00Z' }]);
  assert.equal(whole[0].segments, null);
  assert.deepEqual(clip.planFiles([{ kind: 'audio', segs: null, pending: false }], whole), []);
  assert.deepEqual(clip.planFiles([], whole), whole);
}

// ---- fetchRanges carries extra headers (the server's Authorization) ----
{
  const auth = [];
  const one = async (_u, { headers }) => {
    auth.push(headers.Authorization);
    return { status: 206, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } }), headers: new Map([['content-range', 'bytes 0-2/3']]) };
  };
  assert.equal(await fetchRanges({ url: async () => 'u', headers: { Authorization: 'Bearer t' }, write: async () => {}, onBytes: () => {}, fetchFn: one }), 3);
  assert.deepEqual(auth, ['Bearer t']);
}

console.log('test.mjs: all checks passed');
