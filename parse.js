// PURE — URL ids and the structured paste format. Ports of yt_gateway.dart's
// extractVideoId/extractPlaylistId (youtube_explode regexes) and input_parser.dart.

const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;
const VIDEO_RES = [
  /youtube\..+?\/watch.*?v=(.*?)(?:&|\/|$)/,
  /youtu\.be\/(.*?)(?:\?|&|\/|$)/,
  /youtube\..+?\/embed\/(.*?)(?:\?|&|\/|$)/,
  /youtube\..+\/shorts\/([A-Za-z0-9_-]+$)/,
  /youtube\..+?\/live\/(.*?)(?:\?|&|\/|$)/,
];
const PLAYLIST_RES = [
  /youtube\..+?\/playlist.*?list=(.*?)(?:&|\/|$)/,
  /youtube\..+?\/watch.*?list=(.*?)(?:&|\/|$)/,
  /youtu\.be\/.*?\/.*?list=(.*?)(?:&|\/|$)/,
  /youtube\..+?\/embed\/.*?\/.*?list=(.*?)(?:&|\/|$)/,
];

const firstMatch = (s, res, valid) => {
  if (valid(s)) return s;
  for (const re of res) {
    const m = s.match(re)?.[1];
    if (m && valid(m)) return m;
  }
  return null;
};

export function extractVideoId(url) {
  // ponytail: upstream shorts regex chokes on ?si=/trailing slash; strip suffix here
  const s = url.trim().replace(/\/shorts\/([0-9A-Za-z_-]{11})\S*/, '/shorts/$1');
  return s ? firstMatch(s, VIDEO_RES, (id) => VIDEO_ID.test(id)) : null;
}

const validPlaylistId = (id) => {
  const u = id.toUpperCase();
  return u === 'WL' || u === 'RDMM' || /^[0-9A-Za-z_-]{2,}$/.test(id);
};

/** Note `watch?v=X&list=Y` parses as BOTH — use isPlaylistUrl to decide. */
export function extractPlaylistId(url) {
  const s = url.trim();
  return s ? firstMatch(s, PLAYLIST_RES, validPlaylistId) : null;
}

/** A URL is a playlist import only when it carries no video id. */
export const isPlaylistUrl = (url) => extractVideoId(url) === null && extractPlaylistId(url) !== null;

export const extractUrls = (raw) => raw.match(/https?:\/\/\S+/g) ?? [];

/**
 * First line without a URL = playlist name; `Label: url` = tag; one URL per line.
 * Returns { urls, playlistName, tagsByUrl: {url: [labels]}, isStructured }.
 */
export function parseInput(input) {
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { urls: extractUrls(input), playlistName: null, tagsByUrl: {}, isStructured: false };
  }
  let playlistName = null;
  let start = 0;
  if (!extractUrls(lines[0]).length) {
    playlistName = lines[0].replace(/:$/, '').trim();
    start = 1;
  }
  const urls = [];
  const tagsByUrl = {};
  for (const line of lines.slice(start)) {
    const url = extractUrls(line)[0];
    if (!url) continue;
    urls.push(url);
    const parts = line.split(':');
    const label = parts[0].trim();
    if (parts.length >= 2 && label && !label.toLowerCase().startsWith('http')) {
      const set = (tagsByUrl[url] ??= []);
      if (!set.includes(label)) set.push(label);
    }
  }
  return { urls: urls.length ? urls : extractUrls(input), playlistName, tagsByUrl, isStructured: urls.length > 0 };
}
