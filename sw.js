// MV3 service worker: context menus only (it dies after ~30 s idle; the app tab does the work).
import { openApp, addHash } from './open_app.js';

const ITEMS = [['audio', 'Download audio'], ['video', 'Download video'], ['none', 'Add to Personal YouTube…']];
const YT_URLS = ['*://*.youtube.com/*', '*://youtu.be/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [kind, title] of ITEMS) {
      // A YouTube link anywhere, or the YouTube page itself.
      chrome.contextMenus.create({ id: `link:${kind}`, title, contexts: ['link'], targetUrlPatterns: YT_URLS });
      chrome.contextMenus.create({ id: `page:${kind}`, title, contexts: ['page'], documentUrlPatterns: YT_URLS });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const [where, kind] = info.menuItemId.split(':');
  openApp(addHash(where === 'link' ? info.linkUrl : info.pageUrl, kind));
});
