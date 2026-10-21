// Clips and the media editor's maths — PURE, mirrored by
// apps/youtube_personal/lib/services/clip.dart (same names, same tests).
// A clip is a video row cut from a YouTube video: id `<ytId>~<base36 ms>`,
// `segments` = [[startMs, endMs], …] on the SOURCE video's timeline, played in
// order. A file made by the editor carries its own `segments` the same way
// (null = the whole source, untouched).

export const isClip = (id) => String(id).includes('~');
export const sourceOf = (id) => String(id).split('~')[0];
export const newClipId = (id, now = Date.now()) => `${sourceOf(id)}~${now.toString(36)}`;
export const totalMs = (segs) => segs.reduce((n, [a, b]) => n + b - a, 0);

/** The URL first, then YouTube's own description — the row's starting Description. */
export const descriptionFor = (id, text) => `https://youtu.be/${sourceOf(id)}${text?.trim() ? `\n\n${text.trim()}` : ''}`;

/** Join touching/overlapping ranges, drop empty ones; input in play order. */
function merge(segs) {
  const out = [];
  for (const [a, b] of segs) {
    if (b <= a) continue;
    const last = out.at(-1);
    if (last && a <= last[1] && a >= last[0]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---- editor state: sorted split points, one keep flag per segment ----

export const newEdit = () => ({ splits: [], keep: [true] });

/** Split the segment under t (ms). Both halves inherit its keep flag. */
export function addSplit(e, t) {
  t = Math.round(t);
  if (t <= 0 || e.splits.includes(t)) return e;
  const i = e.splits.filter((s) => s < t).length;
  const splits = [...e.splits];
  splits.splice(i, 0, t);
  const keep = [...e.keep];
  keep.splice(i, 1, keep[i], keep[i]);
  return { splits, keep };
}

/** Remove split i; the merged segment is kept if either side was. */
export function removeSplit(e, i) {
  if (i < 0 || i >= e.splits.length) return e;
  const splits = e.splits.filter((_, j) => j !== i);
  const keep = [...e.keep];
  keep.splice(i, 2, e.keep[i] || e.keep[i + 1]);
  return { splits, keep };
}

export const toggleKeep = (e, i) => ({ ...e, keep: e.keep.map((k, j) => (j === i ? !k : k)) });

/** Every segment of [0, durationMs] as { start, end, keep }. */
export function segmentsOf(e, durationMs) {
  const cuts = [0, ...e.splits.filter((t) => t < durationMs), durationMs];
  return cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1], keep: e.keep[i] ?? true }));
}

/** The kept ranges, touching ones joined. */
export const keptSegments = (e, durationMs) =>
  merge(segmentsOf(e, durationMs).filter((s) => s.keep).map((s) => [s.start, s.end]));

// ---- timelines ----

/** Ranges on a file's own timeline → the source timeline, given the source ranges the file holds. */
export function compose(parent, child) {
  const out = [];
  for (const [a, b] of child) {
    let off = 0;
    for (const [s, e] of parent) {
      const lo = Math.max(a, off);
      const hi = Math.min(b, off + e - s);
      if (hi > lo) out.push([s + lo - off, s + hi - off]);
      off += e - s;
    }
  }
  return merge(out);
}

/** The inverse: source ranges → a file's own timeline; parts the file lacks are dropped. */
export function toLocal(parent, want) {
  const out = [];
  for (const [a, b] of want) {
    let off = 0;
    for (const [s, e] of parent) {
      const lo = Math.max(a, s);
      const hi = Math.min(b, e);
      if (hi > lo) out.push([off + lo - s, off + hi - s]);
      off += e - s;
    }
  }
  return merge(out);
}

/**
 * Streaming a clip: where to go from position pos (ms, source timeline).
 * null = keep playing, { seek } = jump to the next kept range, 'end' = done.
 * The slack stops a seek that lands a hair early from looping.
 */
export function nextJump(segs, pos, slack = 300) {
  for (const [s, e] of segs) {
    if (pos < s - slack) return { seek: s };
    if (pos < e) return null;
  }
  return 'end';
}

// ---- FFmpeg ----

const sec = (ms) => (ms / 1000).toFixed(3);

/**
 * Whether a cut can be a lossless stream copy and still be exact. Audio:
 * always (output seeking is packet-exact). Video: only one range from 0 — a
 * copied video can only start on a keyframe and joined copies drift ~50 ms per
 * join (measured), which would put it out of step with its audio file.
 */
export const copyIsExact = (segs, video) => !video || (segs.length === 1 && segs[0][0] === 0);

/**
 * FFmpeg runs that cut `segs` (ms, the input's own timeline) out of `input`
 * into `output`, same container — exactly, so a video's audio file and video
 * file cut with the same ranges stay in step. Where copyIsExact: stream copy
 * (several audio ranges are cut to temp files and joined with the concat
 * demuxer; the caller writes `list` to `listPath` before the last run).
 * Otherwise video is re-encoded through one trim/concat filter graph (x264 +
 * AAC/Opus), which keeps picture and sound locked together.
 * @returns {{ runs: string[][], list: string|null, listPath: string|null, temps: string[] }}
 */
export function ffmpegPlan(segs, { input, output, ext, video, preset = 'veryfast', tmp }) {
  if (!segs.length) throw new Error('Nothing selected to keep');
  if (!copyIsExact(segs, video)) {
    const n = segs.length;
    const parts = [
      `[0:v]split=${n}${segs.map((_, i) => `[vi${i}]`).join('')}`,
      `[0:a]asplit=${n}${segs.map((_, i) => `[ai${i}]`).join('')}`,
    ];
    segs.forEach(([a, b], i) => {
      parts.push(`[vi${i}]trim=start=${sec(a)}:end=${sec(b)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[ai${i}]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    parts.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[v][a]`);
    const audioCodec = ext === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k'];
    return {
      runs: [['-y', '-i', input, '-filter_complex', parts.join(';'),
        '-map', '[v]', '-c:v', 'libx264', '-preset', preset, '-crf', '20', '-pix_fmt', 'yuv420p',
        '-map', '[a]', ...audioCodec, output]],
      list: null, listPath: null, temps: [],
    };
  }
  // Seeking the output: input seeking in Opus/WebM keeps everything from the
  // file's start, and -avoid_negative_ts make_zero shifts video by its B-frame delay.
  const cut = ([a, b], out) => ['-y', '-i', input, ...(a ? ['-ss', sec(a)] : []), '-t', sec(b - a), '-c', 'copy', out];
  if (segs.length === 1) return { runs: [cut(segs[0], output)], list: null, listPath: null, temps: [] };
  const temps = segs.map((_, i) => tmp(`${i}.${ext}`));
  const listPath = tmp('list.txt');
  return {
    runs: [...segs.map((s, i) => cut(s, temps[i])), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output]],
    list: temps.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'),
    listPath,
    temps: [...temps, listPath],
  };
}
