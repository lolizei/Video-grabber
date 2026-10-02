# Video Grabber

A Chrome extension that finds the videos on the page you're viewing and downloads them in one click.

![Video Grabber popup](store/screenshot-1-list.png)

## Features

- Lists every video a page loads, with a **thumbnail**, file size and quality picker
- **Click a thumbnail to preview** the full video before you download it
- Direct files (MP4, WebM, MOV, MKV …) download straight away
- **HLS streams** (`.m3u8`) are downloaded piece by piece and saved as one file
- **Instagram**: finds the reel or post you're looking at and downloads it as one MP4 with sound
- **YouTube** (full build only): lists each quality; video and audio come as separate files
- Groups the many pieces a site loads into one card per video, most recently played first
- **Copy yt-dlp command** button as a fallback for sites the extension can't handle
- Light and dark mode, no tracking, no accounts, nothing leaves your browser

## Install

### From a release (easiest)
1. Download `video-grabber-full-vX.zip` from the [Releases](https://github.com/lolizei/Video-grabber/releases) page and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder.

### From source
Clone the repo and load the repo folder itself with **Load unpacked**. The repo root is the extension.

```bash
git clone https://github.com/lolizei/Video-grabber.git
```

## How to use

1. Open a page and **start playing** the video. Streams are only detected once they load.
2. Click the Video Grabber icon. The badge shows how many videos were found.
3. Click a thumbnail to preview, pick a quality if offered, then click **Download**.

## Builds

There are two builds from the same code. The only difference is `config.js`:

| Build | YouTube | Use it for |
|---|---|---|
| `full` | on | GitHub releases, loading unpacked |
| `store` | off | Chrome Web Store (store policy doesn't allow YouTube downloaders) |

Build both zips into `dist/`:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```
```bash
# macOS / Linux
bash scripts/build.sh
```

Pushing a version tag (for example `git tag v1.2.0 && git push --tags`) makes GitHub Actions build both zips and attach them to a release.

## Tips and limits

- **YouTube** sends video and audio separately. Download one of each and merge them with
  `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`. YouTube increasingly uses a streaming format
  extensions can't capture. If nothing shows up, use **Copy yt-dlp command** and run it with [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- **Instagram** lookup needs you to be logged in. If it fails, the popup falls back to the detected pieces
  (video and audio may then be separate files).
- **HLS** downloads automatically convert MPEG-TS streams with H.264/AAC to `.mp4` after downloading, without installing FFmpeg. Conversion runs locally without re-encoding. If conversion fails, the original `.ts` is saved with an explanation. Streams already in MP4 format are saved directly.
- **DRM-protected or encrypted streams** (Netflix, Disney+, encrypted HLS) are not supported and won't be.

## Project layout

```
manifest.json      extension manifest (MV3)
config.js          build switches (YouTube on/off)
background.js      service worker: watches network responses, keeps the per-tab list
popup.html/js      the popup UI: grouping, thumbnails, preview, Instagram lookup
downloader.html/js tab that downloads HLS and chunked streams and saves one file
style.css          shared styles
icons/             extension icons
scripts/           build scripts
store/             Chrome Web Store listing text and images
```

## Privacy

Video Grabber doesn't collect, store or send any personal data. See [PRIVACY.md](PRIVACY.md).

## Legal

Only download videos you have the right to save. Downloading content from some sites may break their
terms of service or copyright law where you live. You are responsible for how you use this tool.

## License

[MIT](LICENSE) © 2026 lolizei
