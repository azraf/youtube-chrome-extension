// Find-or-create the one pinned app tab (it owns player, downloads and ffmpeg).
export async function openApp(hash = '#library') {
  const url = chrome.runtime.getURL('app.html');
  const [tab] = await chrome.tabs.query({ url: `${url}*` });
  if (tab) {
    await chrome.tabs.update(tab.id, { url: url + hash, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url + hash, pinned: true });
  }
}

/** app.html hash for a URL + what to do with it: 'audio' | 'video' | 'none'. */
export const addHash = (link, kind) => `#add=${encodeURIComponent(link)}&kind=${kind}`;
