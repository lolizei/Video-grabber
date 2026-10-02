# Video Grabber

Manifest V3 Chrome extension for finding and saving media loaded by the current page. Version **1.5.0** adds a streaming & CDN engine: automatic discovery (network, DOM, embedded players, redirects, signed URLs), full HLS and MPEG-DASH downloading with separate audio/video merging, DRM/encryption diagnostics, a resumable disk-backed download manager with pause/cancel/speed/ETA, and a repaired YouTube detector with configuration diagnostics in the full build.

Only save content you own, that is public domain, or that you have the right to save.

## Installation

Requires Chrome 116 or newer. Clone [the repository](https://github.com/lolizei/Video-grabber), open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** with this folder. No build step is required. After updating, reload the extension. Refresh can reinject the scanner into already-open pages; reload pages to update other content scripts.

Tagged archives are available from [GitHub Releases](https://github.com/lolizei/Video-grabber/releases); unreleased changes require installation from source.

## Media Scanner

Open a page, play its media, then select **Media Scanner** in the popup. The list updates automatically while the popup is open (the service worker pushes changes over a port; polling remains as a fallback). All / Audio / Video / Playlists filters; each row shows:

- filename, media type and MIME type, size (from headers or a 1-byte range probe), CDN host and provider (CloudFront, Akamai, Fastly, Cloudflare, Google Video, …), the originating website, and *via redirect* when the media was reached through redirects;
- for HLS/DASH: available resolutions, codecs, audio tracks (name/language), duration, live/VOD, segment container and segment CDN hosts, plus **quality** and **audio track** selectors;
- signed-URL provider and expiry, and a clear status: *No encryption detected*, *DRM-protected (Widevine/PlayReady/FairPlay)*, *Encrypted HLS (AES-128 / SAMPLE-AES)*, *Link expired*, *Access denied/login page*, *Not found* or *Unsupported format* (Smooth Streaming, HDS);
- Download / Retry / Download again, Copy URL, and for running jobs **Pause/Resume**, **Cancel**, progress, speed, ETA, bytes and a separate conversion phase.

**Download all** uses the current filter and selected qualities. **Parallel** sets the number of concurrent segment requests per download (1–8, default 4). Up to three downloads run at once; the rest queue.

### Discovery engine

| Source | What is found |
|---|---|
| `webRequest` responses | MP4, WebM, MOV/MKV, MP3, AAC, M4A, OGG, Opus, FLAC, WAV, HLS (`.m3u8`, `application/x-mpegURL`, Azure `format=m3u8-aapl`), DASH (`.mpd`, `application/dash+xml`, `format=mpd-time-csf`), Smooth/HDS (reported as unsupported). Segment requests (`.ts`, `.m4s`, CMAF) are counted per CDN host instead of listed. |
| Redirects | `onBeforeRedirect` chains: the row is keyed by the stable original URL, downloads use the final CDN URL, and an expired signed URL falls back to the original URL so the CDN can issue a fresh one. |
| DOM | `<video>/<audio>/<source>`, media links, `og:video`/`twitter:player:stream` meta, preload links, `data-*` player attributes (e.g. video.js `data-setup`), inline scripts and JSON-LD (`contentUrl`) including `\/`-escaped JSON. |
| JavaScript players (Refresh) | Sources already exposed by JW Player, video.js and common `player`/`hls`/`dash`/`shaka` globals, read in the page's main world without changing player state. |
| Resource Timing | Requests made before the popup opened or before the service worker woke. |
| EME | `encrypted` events and the key system named in their init data (pssh) — detection only. |

Rows are deduplicated by URL identity: signature/expiry/range parameters (CloudFront, AWS SigV4, Google Cloud, Akamai tokens, Azure SAS, googlevideo, Meta CDN, Wowza, secure-link) are ignored for identity, so a re-signed URL **refreshes** the existing row; unrelated query strings (for example `?token=one` vs `?token=two`) stay separate. Detections are per tab, stored in `chrome.storage.session`, and reset on navigation.

### Streaming engine

| Stream | Behavior |
|---|---|
| HLS master playlists | All variants with resolution, bandwidth, codecs and frame rate; audio renditions (`EXT-X-MEDIA`) with name/language/channels; best quality by default or the selected one. |
| HLS MPEG-TS | Segments downloaded in order, remuxed to MP4 locally with mux.js (H.264/AAC). Separate TS/AAC audio renditions are remuxed separately and merged with synchronized timestamps. Unsupported codecs fall back to the original TS. |
| HLS fragmented MP4 / CMAF | `EXT-X-MAP` init segments, byte ranges, separate audio renditions merged into one MP4. |
| DASH | `SegmentTemplate` (`$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`, `%0Nd` widths), `SegmentTimeline` (including `r=-1`), `SegmentList` (URLs and `mediaRange`), `SegmentBase`/single files, `BaseURL` inheritance and multi-period concatenation when init segments match. Video and audio representations are merged into MP4. WebM (VP9/Opus) representations are merged losslessly with the bundled FFmpeg in the full build and saved as separate playable files in the store build. |
| Live HLS/DASH | The segments listed at download time are saved (with a note). Number-based live DASH templates are reported as unsupported. |
| Encrypted / DRM | **Protected – not downloadable**: HLS `METHOD=AES-128`/`SAMPLE-AES`/`SAMPLE-AES-CTR`, FairPlay (`skd://`, `com.apple.streamingkeydelivery`), Widevine/PlayReady key formats, DASH `ContentProtection` (Widevine, PlayReady, FairPlay, CENC), encrypted MP4 init segments (`encv`/`enca`/`sinf`/`tenc`/`pssh`) and SAMPLE-AES elementary streams inside TS. Detection stops processing before any key, license or encrypted media segment request. |
| Smooth Streaming, HDS | Reported as unsupported formats. |

Separate audio and video are merged by a built-in fragmented-MP4 muxer (`shared/mp4.js`): it rebuilds the `moov` with both tracks, rescales movie-timescale fields, rewrites track IDs, sequence numbers and absolute `base_data_offset`s, normalizes start times while keeping relative A/V offsets and interleaves fragments by decode time. Every output is validated (container structure, expected audio/video tracks, not HTML/empty) before it is saved, and the saved file is checked through `chrome.downloads` (exists, size matches) before a job is marked complete.

### Download manager

- Concurrent segment downloads with a configurable limit and a bounded reorder window: segments are written strictly in order while at most *concurrency + 2* segments are held in memory.
- Exponential backoff with jitter (and `Retry-After`) for timeouts, network errors, 408/425/429/5xx and incomplete ranges; 401/403/404/410 and HTML responses fail immediately with a specific explanation (expired signed URL, authentication required, not found, login page).
- Pause/Resume and Cancel from the popup or the download tab. Cancel aborts in-flight requests, releases temporary storage and never saves a file.
- Progress, speed and ETA for segment jobs (download tab) and direct jobs (`chrome.downloads`).
- Disk-backed temporary storage: segment data is written to the extension's Origin Private File System in 32 MB committed chunks and the final file is assembled from those files, so large downloads do not need to fit in memory (in the Node test a 400 MB download peaked at roughly 130–155 MB of extra buffer memory across runs; by design the window is bounded by *concurrency + 2* segments, see `test-large.cjs`). Falls back to browser memory when OPFS is unavailable.
- Partial-download recovery: committed chunks and a checkpoint survive a failed or closed download tab; **Retry** resumes after the last committed segment when the playlist is unchanged (a changed playlist restarts cleanly). Direct downloads interrupted by network errors are resumed with `chrome.downloads.resume` when Chrome allows it.
- Referrer/CORS-restricted media can use the original page/frame as a fetch fallback (browser-approved Referer and cookies; 32 MB per request; forbidden headers are never overridden).

### Manifest V3 reliability

- Detections, queue and job progress live in `chrome.storage.session`; the worker reconciles running jobs on every start (closed download tabs → failed with resume hint, finished `chrome.downloads` items → verified).
- Download tabs must **claim** their job from the worker; restored or duplicated tabs (for example after session restore) cannot re-run a job. One active job per resource and quality.
- Every handled message replies, unhandled commands do not keep channels open, badge updates on closed tabs are caught, maps are bounded and ports are removed on disconnect.
- Success is only reported after the output passed validation and the saved file was verified.

Blob URLs are player-local and skipped. Pages such as YouTube can show **This site streams in segments – use the Video Grabber tab**. Browser-protected pages cannot be scanned. Set `DEBUG: true` in `config.js` for scanner console logs.

## Video Grabber and YouTube

Video Grabber retains previews, direct downloads, quality detection, HLS-to-MP4 conversion and existing Instagram lookup. If its TS conversion fails, it saves the original TS with an explanation.

In the **full build**, open a YouTube video and let it play until Video Grabber detects the existing video/audio URLs. Select **YouTube**, Refresh tracks, and choose:

- **MP4 (video+audio)** and a detected quality, such as 1080p, 720p or 480p.
- **MP3 (audio only)** at 128, 192 or 320 kbps.

Download progress is followed by **Converting…** and saving through `chrome.downloads.download`. Filenames use the sanitized video title. Cancel stops downloading/conversion or cancels saving. Keep the conversion tab open.

This feature reuses existing detected googlevideo tracks. It does not introduce signature-cipher extraction or protection-circumvention code. Refresh recovers direct tracks from the page's request history and current player metadata, including playback started before opening the popup, and updates automatically while the tab is open. Player metadata is read from the already-loaded page; ciphered/protected entries and stale responses from a previous video are skipped. Diagnostics distinguish no observed requests from unsupported UMP/SABR playback and count failed responses, total resources, players and direct metadata URLs. A blob player alone does not block usable HTTP tracks. Refresh expired URLs by replaying the source video. One YouTube conversion runs at a time. There are no fixed input-size caps; conversion still depends on available browser/WebAssembly memory.

**1.5.0 repair.** Code review of the 1.4.3 detector found these causes of missing tracks (verified with unit tests against recorded URL/metadata shapes, not against live YouTube, which this development environment cannot reach): unknown/new itags (for example 599/600/774 audio, AV1 694–702, HDR 330–337) were classified as *video* whenever the response carried no content type, so audio could be missing and "itag N" qualities appeared; multi-language and DRC audio renditions share an itag and overwrote each other; only `movie_player` and the possibly stale `ytInitialPlayerResponse` were read; and `/embed/` and `/live/` URLs yielded no video id. Now the URL's `mime`/`xtags` parameters decide track type and audio language, distinct renditions are kept (original, non-DRC audio preferred), player metadata is read from `movie_player`, `shorts-player`, `ytd-watch-flexy`, `ytd-player`, `ytplayer` and `ytInitialPlayerResponse` (only when it matches the current video id), and expired URLs are skipped.

The most common remaining reason for "no tracks" is not a bug: when YouTube plays a video through **UMP/SABR** (server-driven POST requests) or lists only **signature-ciphered** formats, there are no directly fetchable track URLs. The tab now names the configuration — direct tracks, UMP/SABR, ciphered (no deciphering is performed), DRM, sign-in/age restriction, unplayable, upcoming, expired, or live (whose ordinary HLS manifest is handed to the Media Scanner) — instead of a generic empty state. Outputs are validated before saving, the saved size is verified, and HTTP 403 track URLs fail immediately with an explanation. YouTube conversion still holds both tracks in memory, because FFmpeg WebAssembly needs its inputs in its in-memory file system.

FFmpeg WebAssembly is bundled and runs in a separate worker: MP4 inputs keep their video codec and encode AAC audio; other supported inputs transcode video to H.264; MP3 uses libmp3lame. No remote scripts or conversion servers are used.

## Permissions and privacy

| Permission | Purpose |
|---|---|
| `webRequest` | Observe media response types/sizes and permitted Referer headers without blocking or modifying requests. |
| `downloads` | Save files, track progress and cancel downloads. |
| `storage` | Per-tab detections and job state in temporary session storage; the parallel-download setting and resumable checkpoints in local storage. Temporary media chunks use the extension's Origin Private File System (no extra permission). |
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

Node.js 20+ and native FFmpeg/ffprobe are required (FFmpeg generates local fixtures and independently validates outputs; extension users need no native FFmpeg).

```bash
node scripts/run-tests.cjs            # everything below, with a summary
node scripts/run-tests.cjs dash       # only matching test files
VERBOSE=1 node scripts/run-tests.cjs  # full output
```

| Area | Test |
|---|---|
| Direct media detection, JS players, per-tab association | `test-discovery.cjs` |
| HLS master/media playlists, fMP4/TS separate audio, quality selection | `test-hls-engine.cjs` |
| DASH parsing (Template/Timeline/List/Base, multi-period) and downloads, WebM fallback | `test-dash.cjs` |
| Separate audio/video merging (offsets, timescales, normalization) | `test-merge.cjs` |
| CDN redirects, signed/expired URLs, auth/HTML/404 errors | `test-cdn.cjs` |
| Segment retries, backoff, ordering, pause, cancellation | `test-engine.cjs` |
| 400 MB disk-backed download, checkpoint resume, cancel cleanup | `test-large.cjs` (run with `--expose-gc`) |
| Manifest V3 worker restarts, claims, duplicates, verified completion | `test-worker-restart.cjs` |
| DRM detection and rejection (HLS, DASH, MP4 init, TS, EME) | `test-drm.cjs` |
| YouTube classification and diagnostics | `test-youtube-engine.cjs` |
| 1.4.x regressions (scanner, conversion, popup race, YouTube WASM, messages) | the other `test-*.cjs` files |

Optional suites (reported as **SKIP** when unavailable):

- `test-browser-e2e.cjs [dist/full|dist/store]` loads the built extension into Chromium through Playwright (`PLAYWRIGHT_MODULE`, `CHROME_PATH`) and drives the real worker, webRequest, content scripts, downloads, download tabs, OPFS and the popup.
- `test-public-streams.cjs` downloads the first segments of public authorized test streams (Apple, Mux, DASH-IF/Akamai, Shaka demo assets) and verifies them with ffprobe.

After building, `node scripts/verify-build.cjs` checks both packages (manifests, referenced files, syntax, store exclusions, zip contents).

`node scripts/manual-fixtures.cjs` serves generated fixtures at `http://127.0.0.1:8765/` (separate-audio HLS, DASH variants, WebM DASH, DRM samples, redirects, expired/login URLs, a 1 GB resumable file and a player-config page), the popup preview with mock APIs at `/preview.html`, and `/wasm-preview.html` for the bundled FFmpeg worker. Follow [the manual checklist](docs/MEDIA-SCANNER-TESTS.md) for Google Chrome and Brave.

## Layout and licenses

Scanner modules: `background/scanner.js`, `content/dom-scan.js`, `ui/media-tab.js`. Streaming engine: `shared/hls.js`, `shared/dash.js` (with `shared/xml.js`), `shared/mp4.js`, `shared/download-engine.js`, `shared/drm.js`, `shared/cdn.js`, `downloader.js`, `ts-converter.js`. YouTube modules: `background/youtube.js`, `shared/youtube.js`, `ui/youtube-tab.js`, and `youtube/`. See [the 1.5.0 implementation report](docs/IMPLEMENTATION-REPORT-1.5.0.md) for architecture, limitations and verification.

Project code is [MIT](LICENSE). Bundled mux.js is [Apache-2.0](vendor/mux.LICENSE). The full build bundles FFmpeg core under [GPL-2.0-or-later](vendor/ffmpeg/LICENSE); see [its notices and source references](vendor/ffmpeg/README.md). Third-party license terms apply to their respective components.
