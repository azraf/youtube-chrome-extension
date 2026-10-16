# Personal YouTube — Chrome extension

Save YouTube videos, Shorts and playlists to your own library, play them (video or audio only), and download them to watch offline. Everything stays on your computer, inside the browser.

For personal use only. It isn't on the Chrome Web Store.

## Install

1. Download this repository: **Code › Download ZIP**, then unzip it. Or `git clone https://github.com/azraf/youtube-chrome-extension.git`.
2. In Chrome (version 121 or newer), open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder (the one with `manifest.json` in it).
5. Pin **Personal YouTube** to the toolbar from the puzzle-piece menu.

To update later: replace the folder with the new version (or `git pull`), then click the ↻ reload icon on the extension's card in `chrome://extensions`.

## Getting started

The extension opens in its own **pinned tab**. This tab does the playing and downloading, so keep it open while a download runs. Chrome asks before you close it if something is playing or downloading.

You can add videos in three ways:

- **Toolbar button.** On a YouTube video or playlist page, click the extension icon:
  - video: **Download audio**, **Download video** or **Add to library…**
  - playlist: **Import playlist…** (choose which videos to keep)
  - **Open library** opens the app tab.
- **Right-click.** Right-click a YouTube link, or anywhere on a YouTube page, for the same three options.
- **Paste.** Paste one or more links into the box at the top of the app, then click **Add** (or **Add & play**).

### Paste format

One link is enough. To build a playlist in one go, paste several lines:

```
Morning music
Calm: https://www.youtube.com/watch?v=xxxxxxxxxxx
https://youtu.be/yyyyyyyyyyy
Calm: https://www.youtube.com/shorts/zzzzzzzzzzz
```

- A first line **without a link** becomes the playlist name.
- `Label: link` adds the tag *Label* to that video.
- Use one link per line.

## The app

The top bar has five pages.

### Library

- **Recently added** and **Recently played** videos.
- **Playlists**: filter them by name, tag or category, and press ▶ to play one.
- **Tags** and **Categories**: open one to see its videos.

Each video row has the same buttons: **▶** play, **＋** add to playlists, tags and categories, **♪** download audio, **⬇** download video.

Open a playlist to **Play all**, **Shuffle play**, **Download all audio / video**, **Rename**, set its category, add tags, reorder videos (↑ ↓), move a video to another playlist (⇄) or remove it (✕). **Delete downloads** removes only the downloaded files. **Delete playlist** keeps the videos and their files.

### Player

- Switch between **Video** and **Audio**. Audio mode shows the thumbnail only.
- Controls: previous, back 10 s, play/pause, forward 10 s, next, plus a seek bar.
- **Shuffle**, **Repeat** (off / all / one), **speed**, and a **sleep timer**.
- **Queue** shows what's coming up. You can reorder it or jump to any item.
- **Quality chip**: switches the stream between 360p and up to 1080p.
- **Audio track**: pick a dubbed language, if the video has one.
- **Play live stream** appears on a downloaded video and plays YouTube's version instead of your file.
- **＋ / ♪ / ⬇**: add the current video to the library, or download it.
- If playback fails, use **Retry** or **Try 360p**.

The mini player at the bottom keeps playing while you browse the other pages. Click it to return to the Player.

### Downloads

This page shows progress, size and the audio track for each download. For each one you can:

- **▶** play it offline
- **💾** save the file to disk
- **Remove after…** delete it automatically after a number of days
- **Cancel** or **🗑** delete it, and **Retry** a failed one

Downloads are stored inside the browser, not in your Downloads folder. To get a normal file, use 💾.

### Search

Search YouTube from inside the app. Results can be played, added (＋) or downloaded straight away.

### Settings

- **Video quality**
  - *Standard*: streams at 360p and downloads small files (≤360p, or 480p when YouTube has no smaller file).
  - *High*: streams up to 1080p and downloads the best quality that fits a 1 GB merge. Long videos get a lower resolution. High downloads are merged inside the browser, so they take longer.
- **Audio language**: the preferred dubbed track for streaming and playlist downloads.
- **Auto-remove downloads** after a number of days. A per-download *Remove after…* overrides this.
- **Storage**: shows space used. **Clear storage…** removes leftovers from failed downloads and can also remove all your downloads.
- **Web sync**: keeps playlists, tags and categories in step with the Personal Youtube phone app through app.makewebsmart.com. Files are never uploaded. To connect:
  1. On the website, go to **Settings › Devices › Generate PIN** for Personal Youtube.
  2. Enter your email and the 8-digit PIN here.

  After that, the extension syncs every time you return to its tab, or when you click **Sync now**.

## Tips and troubleshooting

- **A video won't play or download.** YouTube changes its systems from time to time. Click **Retry** or **Try 360p**. If it still fails, try again later, or update the extension.
- **Downloads disappeared.** Clearing Chrome's site data for this extension, or uninstalling it, deletes the library and every download. Save important files to disk with 💾 first.
- **Running out of space.** Turn on *Auto-remove downloads*, or use *Clear storage…*.

## For developers

The extension is plain JavaScript with no build step. Edit the files, then reload the extension.

Run the tests with:

```bash
node test.mjs
```
