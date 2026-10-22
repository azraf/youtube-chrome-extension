# Personal YouTube — Chrome extension

Save YouTube videos, Shorts and playlists to your own library, play them (video or audio only), and download them to watch offline. Everything stays on your computer, inside the browser.

For personal use only. It isn't on the Chrome Web Store.

## Install

1. Download this repository: **Code › Download ZIP**, then unzip it. Or `git clone https://github.com/azraf/youtube-chrome-extension.git`.
2. In Chrome (version 121 or newer), open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder (the one with `manifest.json` in it).
5. Pin **Personal YouTube** to the toolbar from the puzzle-piece menu.

## Updating

The extension checks GitHub once a day and tells you when a new version is out. You can also check yourself in **Settings › Updates**. Your library, settings and downloaded files stay with every update. Chrome keeps them under the extension's ID (`lfchnfidjdegnhgajhmbmmjmpdoibmhi`, fixed by the `key` in `manifest.json`), not under the folder.

1. **Download the ZIP** (the link in Settings › Updates, or **Code › Download ZIP**) and unzip it.
2. Do one of these:
   - Copy its files over your current extension folder, replacing them, then press **Reload extension** in Settings › Updates (or ↻ on its card in `chrome://extensions`).
   - Keep the new folder anywhere, then in `chrome://extensions` click **Load unpacked** and choose it. It takes the place of the old copy.
3. **Never click Remove** on the extension's card: removing it deletes its library and downloads.

Installed with git? Run `git pull` in its folder, then Reload.

**Coming from version 0.2 or older:** those versions had no fixed ID, so version 0.3 starts with an empty library once. Connect web sync in Settings to bring your playlists, tags and descriptions back; downloads need downloading again. You can remove the old copy afterwards. From 0.3 on, updates keep everything.

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
- **✂** opens the [editor](#editor). If the video isn't downloaded yet, it offers to download it (video or audio only), and the editor opens by itself when the download finishes.
- **Description**: open it under the title. It starts with the YouTube link followed by YouTube's own description, and you can change it to anything. Changes save when you click outside the box, and sync to the website and the phone app.
- If playback fails, use **Retry** or **Try 360p**.

The mini player at the bottom keeps playing while you browse the other pages. Click it to return to the Player.

### Downloads

This page shows progress, size and the audio track for each download. For each one you can:

- **▶** play it offline
- **✂** open it in the [editor](#editor)
- **💾** save the file to disk
- **Remove after…** delete it automatically after a number of days
- **Cancel** or **🗑** delete it, and **Retry** a failed one

Downloads are stored inside the browser, not in your Downloads folder. To get a normal file, use 💾.

### Editor

The editor splits a downloaded video or audio file into parts. You choose which parts to keep, then save the result.

1. Play or scrub to the point you want, then click **Split at …**. Repeat to make more parts.
2. Click a part on the timeline to keep it (solid) or drop it (striped). Kept parts are joined in order.
3. **Remove nearest split** joins the two parts around the playhead again. **Reset** starts over.
4. Save:
   - **Save** replaces this file with the kept parts. This cannot be undone.
   - **Save as new** keeps this file and makes a new **clip** from the kept parts. You can give it a title and add it to a playlist, either an existing one or a new one.

Cuts are exact, so picture and sound always stay together:

- **Audio** is saved instantly, with no loss of quality.
- **Video** is saved instantly when you only trim the end. Any other video cut is re-encoded so it starts on the exact frame. That takes a while in the browser, about real time or longer, and the progress bar shows how far it has got.
- If a video has both an audio download and a video download, **Save** cuts both the same way, so both files always show the same part. A cancelled or failed save changes neither file. If you download the other kind later, it is cut to match.

Clips sync to the website and the phone app with their parts. A device without the clip's file streams the original YouTube video and plays only those parts. Downloading a clip there downloads the original and cuts the clip out of it.

### Search

Search YouTube from inside the app. Results can be played, added (＋) or downloaded straight away.

### Settings

- **Video quality**
  - *Standard*: streams at 360p and downloads small files (≤360p, or 480p when YouTube has no smaller file).
  - *High*: streams up to 1080p and downloads the best quality that fits a 1 GB merge. Long videos get a lower resolution. High downloads are merged inside the browser, so they take longer.
- **Audio language**: the preferred dubbed track for streaming and playlist downloads.
- **Auto-remove downloads** after a number of days. A per-download *Remove after…* overrides this.
- **Updates**: the installed version, **Check for updates**, the steps to update without losing anything, and **Reload extension**.
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
