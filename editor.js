// Media editor — split a downloaded file's timeline, keep or drop each part,
// then Save (replace the file) or Save as (a new clip, optionally into a
// playlist). The maths is clip.js; the cut runs in ffmpeg.wasm (downloads.js).
// Lives in the app's one <dialog>; buttons use data-ed, not the app's data-act.
import * as db from './db.js';
import * as dl from './downloads.js';
import * as sync from './sync.js';
import { newEdit, addSplit, removeSplit, toggleKeep, segmentsOf, keptSegments, totalMs } from './clip.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** m:ss.t — tenths, since cuts are finer than seconds. */
const fmt = (ms) => {
  const t = Math.max(0, Math.round(ms / 100));
  const s = Math.floor(t / 10);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  const two = (n) => String(n).padStart(2, '0');
  return `${h ? `${h}:${two(m)}` : m}:${two(sec)}.${t % 10}`;
};

/**
 * Open the editor on a finished download row. toast(msg) reports results;
 * onSaved(videoId) runs after Save replaced the video's files.
 */
export async function openEditor(d, { toast, onSaved }) {
  const [v, pls, files] = await Promise.all([db.videoById(d.videoId), db.playlists(), db.downloadsOf(d.videoId)]);
  const other = files.find((x) => x.status === 'done' && x.kind !== d.kind);
  const dlg = document.getElementById('dlg');
  const isVideo = d.kind === 'video';
  let url = await dl.fileUrl(d);
  dlg.innerHTML = `<form method="dialog" class="editor">
    <h2>Edit · ${esc(v?.title ?? d.videoId)}</h2>
    <${isVideo ? 'video' : 'audio'} id="ed-media" controls preload="metadata"></${isVideo ? 'video' : 'audio'}>
    <div id="ed-bar" class="ed-bar" role="group" aria-label="Timeline: click a part to keep or drop it"></div>
    <div class="row">
      <button type="button" data-ed="split" disabled>Split at playhead</button>
      <button type="button" class="secondary" data-ed="unsplit" disabled>Remove nearest split</button>
      <button type="button" class="secondary" data-ed="reset">Reset</button>
    </div>
    <p id="ed-sum" class="muted"></p>
    <p id="ed-note" class="muted"></p>
    <fieldset><legend>Save as a new file</legend>
      <label>Title <input name="title" value="${esc(`${v?.title ?? d.videoId} (clip)`)}" style="width:100%"></label>
      <label>Playlist <select name="pl"><option value="">None</option>${pls.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <input name="newPl" placeholder="…or a new playlist" aria-label="New playlist">
    </fieldset>
    <div id="ed-prog" class="prog" hidden><progress max="1" value="0"></progress> <span class="muted">Cutting…</span></div>
    <menu>
      <button type="button" class="secondary" data-ed="close">Close</button>
      <button type="button" class="secondary" data-ed="save" title="Replace this file with the kept parts">Save</button>
      <button type="button" data-ed="saveAs" title="Keep this file; save the kept parts as a new clip">Save as new</button>
    </menu></form>`;
  const form = dlg.querySelector('form');
  const media = dlg.querySelector('#ed-media');
  const bar = dlg.querySelector('#ed-bar');
  const btn = (n) => dlg.querySelector(`[data-ed="${n}"]`);
  media.src = url;

  let edit = newEdit();
  let dur = 0; // ms; from the file itself once its metadata loads
  let ac = null; // the running cut

  function render() {
    const segs = segmentsOf(edit, dur || 1);
    bar.innerHTML = `${segs.map((s, i) => `<button type="button" class="ed-seg ${s.keep ? 'keep' : 'drop'}" style="flex-grow:${s.end - s.start}"
      data-ed="toggle" data-i="${i}" aria-pressed="${s.keep}" title="${fmt(s.start)}–${fmt(s.end)} · ${s.keep ? 'kept — click to drop' : 'dropped — click to keep'}"></button>`).join('')}
      <span class="ed-head" aria-hidden="true"></span>`;
    const keep = keptSegments(edit, dur);
    const kept = segs.filter((s) => s.keep).length;
    note(keep);
    dlg.querySelector('#ed-sum').textContent = dur
      ? `Keeping ${kept} of ${segs.length} part${segs.length > 1 ? 's' : ''} · ${fmt(totalMs(keep))} of ${fmt(dur)}`
      : 'Loading…';
    const busy = !!ac;
    btn('split').disabled = busy || !dur;
    btn('unsplit').disabled = busy || !edit.splits.length;
    btn('reset').disabled = busy;
    btn('save').disabled = busy || !dur || !keep.length || (keep.length === 1 && keep[0][0] === 0 && keep[0][1] === dur);
    btn('saveAs').disabled = busy || !dur || !keep.length;
    for (const b of bar.querySelectorAll('button')) b.disabled = busy;
    head();
  }
  // What Save will do, so a slow save is no surprise. Async: asks downloads.js.
  let noteSeq = 0;
  async function note(keep) {
    const mine = ++noteSeq;
    const slow = dur && keep.length ? await dl.editReencodes(d, keep, dur) : false;
    if (mine !== noteSeq) return;
    dlg.querySelector('#ed-note').textContent = [
      'Cuts are exact, so picture and sound stay together.',
      slow ? 'Save re-encodes the video, which takes a while in the browser (trimming only the end is instant).' : '',
      other ? `Save also cuts this video's downloaded ${other.kind} the same way, so both files show the same part.` : '',
    ].filter(Boolean).join(' ');
  }
  function head() {
    const h = bar.querySelector('.ed-head');
    if (h && dur) h.style.left = `${Math.min(100, (media.currentTime * 1000 * 100) / dur)}%`;
    btn('split').textContent = `Split at ${fmt(media.currentTime * 1000)}`;
  }

  media.addEventListener('loadedmetadata', () => {
    if (!dur) dur = Math.round((Number.isFinite(media.duration) ? media.duration * 1000 : 0) || v?.durationMs || 0);
    render();
  });
  media.addEventListener('timeupdate', head);
  media.addEventListener('seeked', head);
  render();

  const cleanup = () => {
    ac?.abort(new Error('Cancelled'));
    media.pause();
    media.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  dlg.onclose = cleanup;
  form.onsubmit = (e) => e.preventDefault(); // Enter in a field must not close the dialog

  async function run(asNew) {
    const keep = keptSegments(edit, dur);
    if (!asNew && !confirm(`Replace the downloaded file${other ? 's (audio and video)' : ''} with the kept parts? This cannot be undone.`)) return;
    const fd = new FormData(form);
    const prog = dlg.querySelector('#ed-prog');
    prog.hidden = false;
    const onFraction = (f) => {
      prog.querySelector('progress').value = f;
      prog.querySelector('span').textContent = `Cutting… ${Math.round(f * 100)}%`;
    };
    media.pause();
    ac = new AbortController();
    render();
    try {
      if (asNew) {
        const fresh = fd.get('newPl')?.trim();
        const playlistId = fresh ? await db.createOrGetPlaylist(fresh) : +fd.get('pl') || null;
        await dl.saveEditAs(d, keep, dur, { title: fd.get('title')?.trim(), playlistId, onFraction, signal: ac.signal });
        toast(playlistId ? 'Saved as a new clip in the playlist' : 'Saved as a new clip');
      } else {
        // The preview reads this very file: let go of it first.
        media.removeAttribute('src');
        media.load();
        URL.revokeObjectURL(url);
        await dl.saveEdit(d, keep, dur, { onFraction, signal: ac.signal });
        toast('Saved');
        await onSaved?.(d.videoId);
      }
      ac = null;
      sync.sync({ manual: true }).catch(console.info); // send the edit to the other devices now
      dlg.close();
    } catch (e) {
      const cancelled = ac?.signal.aborted;
      ac = null;
      if (!dlg.open) return;
      prog.hidden = true;
      if (!asNew) { url = await dl.fileUrl(d); media.src = url; } // the old file survives a failed save
      render();
      if (!cancelled) toast(e.message ?? String(e));
    }
  }

  dlg.onclick = (e) => {
    const b = e.target.closest('[data-ed]');
    if (!b || b.disabled) return;
    const at = media.currentTime * 1000;
    switch (b.dataset.ed) {
      case 'split': edit = addSplit(edit, at); break;
      case 'unsplit': {
        const near = edit.splits.reduce((best, t, i) => (Math.abs(t - at) < Math.abs(edit.splits[best] - at) ? i : best), 0);
        edit = removeSplit(edit, near);
        break;
      }
      case 'reset': edit = newEdit(); break;
      case 'toggle': edit = toggleKeep(edit, +b.dataset.i); break;
      case 'close': dlg.close(); return;
      case 'save': run(false); return;
      case 'saveAs': run(true); return;
      default: return;
    }
    render();
  };
  dlg.showModal();
}
