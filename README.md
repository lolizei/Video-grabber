# Video Grabber

Manifest V3 Chrome extension for finding and saving media loaded by the current page. Version **1.4.0** includes Media Scanner diagnostics and local YouTube MP4/MP3 conversion in the full build.

Only save content you own, that is public domain, or that you have the right to save.

## Installation

Requires Chrome 116 or newer. Clone [the repository](https://github.com/lolizei/Video-grabber), open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** with this folder. No build step is required. After updating, reload the extension. Refresh can reinject the scanner into already-open pages; reload pages to update other content scripts.

Tagged archives are available from [GitHub Releases](https://github.com/lolizei/Video-grabber/releases); unreleased changes require installation from source.

## Media Scanner

Open a page, play its media, then select **Media Scanner** in the popup. All / Audio / Video / Playlists filters show filenames, type, size when available, source domain, Download and Copy URL. Download all uses the current filter; up to three scanner jobs run at once.

The scanner combines synchronous `webRequest` response listeners with DOM scans of audio, video, source and media links. It recognizes Content-Type and MP3, M4A, AAC, OGG, WAV, FLAC, Opus, MP4, WebM, M3U8 and MPD extensions, ignoring query strings for classification while preserving full URLs for downloads and deduplication. Per-tab detections and queue state live in `chrome.storage.session` across service-worker restarts and reset on navigation.

**Clear** removes results. **Refresh** rescans the DOM, reinjects the content script if needed, recovers existing Video Grabber detections and reads background results. Empty results display network hits, DOM hits, tab id and scan errors. Set `DEBUG: true` in `config.js` for scanner console logs.

### Fixed empty-results race

A reproduced popup bug let the 1.5-second polling timer invalidate a slower Refresh response, so the returned media list was discarded. Polling now waits for the in-flight scan. Scan errors are visible, stale content-script listeners are replaced on reinjection, and Refresh also recovers URLs from the working Video Grabber detector. Regression tests exercise the production DOM collector and delayed popup controller. The exact behavior of a live Chrome installation still requires the checklist below.

### Playlists and limitations

| Stream | Behavior |
|---|---|
| Unencrypted HLS | Fetches and merges segments; supported H.264/AAC MPEG-TS converts locally to MP4. |
| Any encrypted HLS, including AES-128 and SAMPLE-AES | **Protected – not downloadable**. No key or encrypted-segment downloads. |
| DASH with ContentProtection, including Widevine/PlayReady/FairPlay | **Protected – not downloadable**. |
| Unprotected DASH | Saves the manifest; DASH media assembly is unsupported. |

Master playlists are checked recursively; unsuccessful protection checks block download until a successful retry. Download all skips protected items. There is no DRM license acquisition, decryption or protection bypass.

Blob URLs are player-local and skipped. Pages such as YouTube can show **This site streams in segments – use the Video Grabber tab**. Browser-protected pages cannot be scanned. Expired URLs need fresh playback and Refresh.

Referrer-protected files may use an allowed fetch from their original page/frame with the browser's Referer and session; forbidden headers are not overridden. This fallback has a 32 MB per-request limit. HLS conversion runs in memory, live HLS saves only listed segments, and separate HLS audio requires a separate download. Keep conversion/download tabs open until saving completes.

## Video Grabber and YouTube

Video Grabber retains previews, direct downloads, quality detection, HLS-to-MP4 conversion and existing Instagram lookup. If its TS conversion fails, it saves the original TS with an explanation.

In the **full build**, open a YouTube video and let it play until Video Grabber detects the existing video/audio URLs. Select **YouTube**, Refresh tracks, and choose:

- **MP4 (video+audio)** and a detected quality, such as 1080p, 720p or 480p.
- **MP3 (audio only)** at 128, 192 or 320 kbps.

Download progress is followed by **Converting…** and saving through `chrome.downloads.download`. Filenames use the sanitized video title. Cancel stops downloading/conversion or cancels saving. Keep the conversion tab open.

This feature reuses existing detected googlevideo tracks. It does not introduce signature-cipher extraction or protection-circumvention code. If the necessary tracks have not been detected, it explains what is missing. Refresh expired URLs by replaying the source video. One YouTube conversion runs at a time; each input track is limited to 512 MB and known combined inputs to 768 MB, with browser memory imposing additional limits.

FFmpeg WebAssembly is bundled and runs in a separate worker: MP4 inputs keep their video codec and encode AAC audio; other supported inputs transcode video to H.264; MP3 uses libmp3lame. No remote scripts or conversion servers are used.

## Permissions and privacy

| Permission | Purpose |
|---|---|
| `webRequest` | Observe media response types/sizes and permitted Referer headers without blocking or modifying requests. |
| `downloads` | Save files, track progress and cancel downloads. |
| `storage` | Persist per-tab detections and job state in temporary session storage. |
| `scripting` | Refresh already-open pages/frames and retain existing site lookup. |
| `host_permissions: ["<all_urls>"]` | Observe pages and fetch media from arbitrary CDNs; Chrome still restricts protected browser pages. |

Declarative content scripts match `<all_urls>` at `document_idle` in all frames. The full build's `wasm-unsafe-eval` CSP permits the bundled WebAssembly core; scripts and workers remain restricted to the extension itself. No offscreen permission is needed because conversion uses a worker in a dedicated extension tab.

No accounts, telemetry or external processing servers. Requests go directly to original media hosts. URLs, referrers, titles and job status are handled locally. See [PRIVACY.md](PRIVACY.md).

## Build and distribution

`ENABLE_YOUTUBE` in `config.js` controls the feature. Build scripts create both packages in `dist/`:

| Build | YouTube support |
|---|---|
| `full` | Enabled; intended for GitHub/unpacked installation. |
| `store` | Disabled; YouTube tab, conversion code and FFmpeg assets omitted, and WebAssembly CSP permission removed. |

Use the store package for Chrome Web Store submission; YouTube download functionality is excluded. Exclusion does not guarantee store approval.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

```bash
# macOS/Linux: Python 3 is required by this build script.
bash scripts/build.sh
```

Version tags run the existing release workflow. See [CHANGELOG.md](CHANGELOG.md).

## Testing

Node.js is required. Native FFmpeg/ffprobe generate fixtures and independently validate outputs; extension users need no native FFmpeg installation.

```bash
node scripts/test-rediscovery.cjs
node scripts/test-conversion.cjs
node scripts/test-scanner.cjs
node scripts/test-popup-refresh.cjs
node scripts/test-hls-download.cjs
node scripts/test-youtube-conversion.cjs
node scripts/test-youtube-download.cjs
node scripts/manual-fixtures.cjs
```

Open `http://127.0.0.1:8765/` for generated media fixtures. The popup preview uses mock Chrome APIs. `/wasm-preview.html` exercises the real bundled worker and WebAssembly under the extension-style CSP with generated local input. Automated tests verify separate-track MP4 merge and MP3 bitrates with actual bundled WebAssembly, but do not verify live YouTube availability.

Follow [the manual Chrome checklist](docs/MEDIA-SCANNER-TESTS.md), including MP3/MP4 detection, unencrypted HLS, protection handling, worker restart and actual YouTube MP4/MP3 downloads.

## Layout and licenses

Scanner modules: `background/scanner.js`, `content/dom-scan.js`, `ui/media-tab.js`. YouTube modules: `background/youtube.js`, `shared/youtube.js`, `ui/youtube-tab.js`, and `youtube/`. Shared classification/playlist helpers live in `shared/`.

Project code is [MIT](LICENSE). Bundled mux.js is [Apache-2.0](vendor/mux.LICENSE). The full build bundles FFmpeg core under [GPL-2.0-or-later](vendor/ffmpeg/LICENSE); see [its notices and source references](vendor/ffmpeg/README.md). Third-party license terms apply to their respective components.
