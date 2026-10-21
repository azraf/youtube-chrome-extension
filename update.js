// Updates. An unpacked extension never updates itself, so this checks GitHub
// and walks the user through it. manifest.json "key" pins the extension ID,
// and Chrome keeps IndexedDB + OPFS (the library and downloads) per ID — so
// any copy of a newer version keeps them, wherever it is unzipped. Only
// Chrome's Remove deletes them.
export const REPO = 'https://github.com/azraf/youtube-chrome-extension';
export const ZIP_URL = `${REPO}/archive/refs/heads/main.zip`;
const MANIFEST_URL = 'https://raw.githubusercontent.com/azraf/youtube-chrome-extension/main/manifest.json';

/** PURE — true when latest is a higher x.y.z than current (mirrors core_ui's isNewer). */
export function isNewer(latest, current) {
  const parts = (v) => String(v).trim().split(/[+-]/)[0].split('.').map((p) => parseInt(p, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const currentVersion = () => chrome.runtime.getManifest().version;

/** The newer version on GitHub, or null when this one is the latest. */
export async function check(fetchFn = fetch) {
  const res = await fetchFn(MANIFEST_URL, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`Could not check for updates (HTTP ${res.status})`);
  const { version } = await res.json();
  return isNewer(version, currentVersion()) ? version : null;
}
