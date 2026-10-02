# Video Grabber

A Chrome extension that finds the videos on the page you're viewing and downloads them in one click.

![Video Grabber popup](store/screenshot-1-list.png)

## Features

- Lists every video a page loads, with a **thumbnail**, file size and quality picker
- **Click a thumbnail to preview** the full video before you download it
- Direct files (MP4, WebM, MOV, MKV …) download straight away
- **HLS streams** (`.m3u8`) are downloaded piece by piece, then automatically converted to MP4 for H.264/AAC streams without losing quality
- **Instagram**: finds the reel or post you're looking at and downloads it as one MP4 with sound
- **YouTube** (full build only): lists each quality; video and audio come as separate files
- Groups the many pieces a site loads into one card per video, most recently played first
- **Refresh** rediscovers videos after **Clear**, including buffered streams and players using `blob:` URLs
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

For HLS streams, keep the download tab open until downloading, MP4 conversion and saving finish.
Conversion runs inside the browser; no FFmpeg installation is needed. If a stream uses an unsupported
codec or conversion fails, the original `.ts` file is saved and the download tab explains why.

**Refresh** scans the current page again and recovers previously detected streams, even if the video
is already buffered and makes no new requests. **Clear** empties the visible list; click **Refresh**
or reopen the popup to rediscover videos on that page. Detection history is reset when navigating
to another page, except during Instagram/Facebook in-app navigation, where preloaded reels are retained.

After updating an unpacked installation, click **Reload** for Video Grabber in `chrome://extensions`.

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
- **Missing videos after Refresh**: some sites hide their media URLs or use unsupported streaming formats. Reload the video page and start playback again to capture fresh requests.
- **DRM-protected or encrypted streams** (Netflix, Disney+, encrypted HLS) are not supported and won't be.

## Project layout

```
manifest.json      extension manifest (MV3)
config.js          build switches (YouTube on/off)
background.js      service worker: watches network responses, keeps the per-tab list
popup.html/js      the popup UI: grouping, thumbnails, preview, Instagram lookup
downloader.html/js tab that downloads HLS and chunked streams and saves one file
ts-converter.js    worker that converts MPEG-TS to MP4 without re-encoding
vendor/            bundled mux.js conversion library and its Apache-2.0 license
style.css          shared styles
icons/             extension icons
scripts/           build scripts and conversion/rediscovery regression checks
store/             Chrome Web Store listing text and images
```

## Privacy

Video Grabber doesn't collect, store or send any personal data. See [PRIVACY.md](PRIVACY.md).

## Development checks

Run the rediscovery regression check with Node.js:

```bash
node scripts/test-rediscovery.cjs
```

The conversion integration check also requires `ffmpeg` and `ffprobe` on your PATH:

```bash
node scripts/test-conversion.cjs
```

## Legal

Only download videos you have the right to save. Downloading content from some sites may break their
terms of service or copyright law where you live. You are responsible for how you use this tool.

## License

[MIT](LICENSE) © 2026 lolizei

The bundled [mux.js](https://github.com/videojs/mux.js) library is licensed under
[Apache-2.0](vendor/mux.LICENSE).
