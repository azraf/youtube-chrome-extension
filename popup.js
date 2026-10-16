import { extractVideoId, extractPlaylistId, isPlaylistUrl } from './parse.js';
import { openApp, addHash } from './open_app.js';

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = tab?.url ?? '';
const go = async (hash) => { await openApp(hash); window.close(); };

if (isPlaylistUrl(url)) {
  document.getElementById('what').textContent = `Playlist ${extractPlaylistId(url)}`;
  document.getElementById('playlist-actions').hidden = false;
} else if (extractVideoId(url)) {
  document.getElementById('what').textContent = tab.title.replace(/ - YouTube$/, '');
  document.getElementById('video-actions').hidden = false;
}
for (const b of document.querySelectorAll('[data-kind]')) b.onclick = () => go(addHash(url, b.dataset.kind));
document.getElementById('open').onclick = () => go('#library');
