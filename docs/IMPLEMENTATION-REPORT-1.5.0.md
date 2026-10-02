# Video Grabber 1.5.0 – implementation report

Date: 2 October 2026 · Base: 1.4.3 (`main`) · Result: version 1.5.0, full and store builds

## 1. What was inspected

All source files, both build scripts, the release workflow, the 1.4.3 `dist/` packages, the nine
existing test scripts (all passed before any change), `README.md`, `docs/MEDIA-SCANNER-TESTS.md` and
`background/youtube.js`. The repository contains no saved diagnostic output, so the YouTube analysis
was done from the detector code and its tests.

## 2. Architectural problems found in 1.4.3

| # | Problem | Consequence | 1.5.0 |
|---|---|---|---|
| 1 | Segment downloads collected every segment as an `ArrayBuffer`, then built one `Blob`; TS conversion received the whole array | Memory grew with file size; large streams could crash the tab | Ordered bounded window + OPFS chunk files; streaming TS remux per segment |
| 2 | DASH saved only the manifest; HLS separate audio renditions were dropped ("video only") | No usable output for most DASH sites and many HLS sites | DASH parser + downloader; fMP4 muxer merges separate tracks |
| 3 | Scanner jobs had no pause/cancel; direct retries restarted from zero | Broken cancellation, wasted bandwidth | Pause/resume/cancel for tab and `chrome.downloads` jobs; `chrome.downloads.resume` |
| 4 | "complete" was trusted from the download tab and from `chrome.downloads` without checking the file | Empty or HTML files could be reported as successful | Output validation before saving; size/exists/MIME verification before "complete" |
| 5 | A download tab restored by session restore re-ran its old job id | Duplicate downloads | Tabs must claim their job; restored/duplicate tabs are refused |
| 6 | Rejected promises: `setBadgeText` on closed tabs, `addMedia`/`clearTab` from listeners | Unhandled rejections in the worker console | Caught |
| 7 | Rows deduplicated by full URL; redirects not tracked | Every re-signed CDN URL produced a new row; expiring links undetected | Identity without signature params, redirect chains, expiry detection, refresh |
| 8 | Popup only polled every 1.5 s | Late updates, extra work | Port push notifications + fallback polling |
| 9 | Linear retry (600 ms × n) for every error, including 403/404 | Slow failures with generic messages | Classified errors, exponential backoff with jitter/Retry-After, immediate specific failures |
| 10 | Encryption detected only from playlist key tags | fMP4 streams with encrypted init segments or SAMPLE-AES TS stream types were downloaded as unusable files | Init-segment (`encv/enca/sinf/tenc/pssh`) and PMT stream-type detection before media requests |
| 11 | YouTube: unknown itags became *video* without a content type; multi-language/DRC audio shared one key; few metadata sources; no embed/live ids | Missing audio, "itag N" qualities, lost renditions | See §5 |

Not changed (documented follow-up): the legacy *Video Grabber* tab still has its own detector in
`background.js` alongside the Media Scanner. Unifying them would touch the Instagram and legacy UI paths;
the scanner now consumes the legacy detections on Refresh.

## 3. Implementation by requirement

**Automatic CDN discovery (§2).** `background/scanner.js`, `content/dom-scan.js`, `shared/cdn.js`,
`shared/media.js`. Network responses (MIME + extension, including Azure `format=` URLs, Smooth/HDS as
unsupported), `onBeforeRedirect` chains, DOM/meta/preload/`data-*`/inline-script/JSON-LD URLs, a
main-world read of JW Player, video.js and common player globals on Refresh, Resource Timing, and EME
`encrypted` events. Signed URL providers and expiry; deduplication ignoring signature/range params;
expired rows flagged; a fresh signature refreshes the row; expired redirected media falls back to the
original URL. Qualities, codecs, bitrates, audio tracks, duration and segment CDN hosts come from playlist
inspection; size from headers or a 1-byte range probe. Per-tab state in `chrome.storage.session`; UI
updates pushed over a port.

**Streaming engine (§3).** `shared/hls.js`, `shared/dash.js`, `shared/xml.js`, `shared/mp4.js`,
`ts-converter.js`, `downloader.js`. HLS master/media (variants, audio renditions, init maps, byte ranges,
TS and fMP4, live snapshot), DASH (Template/Timeline/List/Base, BaseURL inheritance, multi-period with
identical init), quality/audio selection, ordered download, separate-track merge into MP4 with
synchronized timestamps, WebM via FFmpeg (full) or separate files (store), retries and resume.

**DRM detection (§4).** `shared/drm.js`, `shared/mp4.js`, `ts-converter.js`, `content/dom-scan.js`.
Widevine, PlayReady, FairPlay, ClearKey and others by key format/UUID/pssh; HLS AES-128/SAMPLE-AES;
DASH ContentProtection; encrypted init segments; SAMPLE-AES TS stream types; EME events. Statuses
distinguish clear, protected, expired, auth, not found and unsupported. No license, key, CDM or
encrypted-segment requests are made; tests assert this from the server request logs.

**YouTube repair (§5).** See README "1.5.0 repair". FFmpeg merging and MP3 128/192/320 kbps are
unchanged and still covered by the WebAssembly test; success now requires a validated output and a
verified saved file.

**Download manager (§6).** `shared/download-engine.js`: `fetchBytes` (classification, backoff,
timeouts, page fallback), `downloadSegments` (concurrency, ordered writes, bounded memory),
`PauseGate`, `ProgressMeter` (speed/ETA), `OpfsSink`/`MemorySink`, `Storage.prune`, `validateOutput`.
Checkpoints in `chrome.storage.local`, chunks in OPFS, deleted on success/cancel, pruned after 7 days.

**UI (§7).** `ui/media-tab.js`, `popup.html`, `style.css`, `downloader.html`. All listed fields,
automatic updates, manual Refresh, quality/audio selection, Copy URL, Download all, Pause/Resume/Cancel,
parallel setting, DRM/expired/unsupported explanations, EME notice.

**MV3 reliability (§8).** Persistent queue and progress, reconciliation on worker start, job claims,
duplicate prevention by resource+quality, verified completion, cancelled state, replies for every
handled message, bounded maps, port cleanup. All processing is local; no telemetry was added.

## 4. Technical limitations (not implementable or deliberately not implemented)

- **DRM:** protected content is never downloaded; no circumvention of Widevine/PlayReady/FairPlay or CDMs.
  AES-128 HLS stays blocked (policy since 1.4.0), although it is not a DRM system.
- **MV3:** service workers cannot run long downloads reliably, so segmented jobs run in a background
  extension tab (as in 1.4.x). Closing that tab stops the job; Retry resumes from the last committed chunk.
- **Resume granularity:** OPFS `createWritable` only commits on `close()` and cannot append without copying
  the file, so data is committed in 32 MB chunks; up to one chunk is re-downloaded after an interruption.
- **Memory:** YouTube conversion and the WebM FFmpeg merge (≤ 1.5 GB) still need both inputs in memory
  (FFmpeg WebAssembly uses an in-memory file system). The page-context Referer fallback is limited to 32 MB
  per request and transfers data as base64 messages.
- **Formats:** Smooth Streaming and HDS are detected but unsupported; live DASH with number-only templates is
  unsupported; HLS with changing `EXT-X-MAP` is unsupported; multi-period DASH with different init segments
  downloads the main period only; mux.js remuxes H.264/AAC TS only (other codecs fall back to the original TS
  or separate files); subtitles are ignored.
- **YouTube:** UMP/SABR playback and signature-ciphered formats have no directly fetchable URLs; the
  extension explains them but does not decipher signatures or unwrap UMP. Live tests against YouTube were
  not possible from the development environment.
- **EME indicator:** derived from `encrypted` events and init data (no page API patching), so a page that
  never fires `encrypted` shows no EME notice; manifest/init-segment detection still applies.
- **Direct files** saved by `chrome.downloads` are verified as existing, non-empty and not HTML, but their
  container is not parsed (segmented outputs are fully validated).
- **First-install race:** requests made before the worker registered its listeners are not observed; DOM
  scanning and Resource Timing on Refresh recover them.

## 5. Verification

Environment: Linux, Node.js 22.22, FFmpeg/ffprobe (fixtures and independent validation), Playwright
Chromium 141.0.7390.37. `node scripts/run-tests.cjs` (all executed suites passed; 1 optional suite skipped):

| Area (requirement §9) | Suite | Checks |
|---|---|---|
| 1 Direct media detection | `test-discovery.cjs` | 5 |
| 2 HLS master and media playlists | `test-hls-engine.cjs` | 7 |
| 3 DASH manifest parsing | `test-dash.cjs` | 10 |
| 4 Separate audio/video merging | `test-merge.cjs` (+ HLS/DASH suites) | 4 |
| 5 CDN redirects and expired URLs | `test-cdn.cjs` | 14 |
| 6 Segment retries and cancellation | `test-engine.cjs` | 14 |
| 7 Large-file handling | `test-large.cjs` | 4 |
| 8 MV3 worker restarts | `test-worker-restart.cjs` | 14 |
| 9 DRM detection and graceful rejection | `test-drm.cjs` | 13 |
| 10 YouTube detection and diagnostics | `test-youtube-engine.cjs` | 14 |
| 1.4.x regressions | 9 existing suites | all passed |
| Real browser, full build | `test-browser-e2e.cjs dist/full` | 10 |
| Real browser, store build | `test-browser-e2e.cjs dist/store` | 9 |
| Public authorized streams | `test-public-streams.cjs` | **skipped** – blocked by the environment's network proxy (HTTP 403); nothing verified |

Large-file result: a 400 MB download through the OPFS code path (disk-backed fake in Node) was byte-exact
(SHA-256) with 128–154 MB peak extra buffer memory across runs; temporary files and checkpoints were removed.

Defects found and fixed while testing: DASH empty `SegmentTimeline` (ffmpeg WebM output) produced zero
segments; a page link to an already redirected URL overwrote the resolved CDN URL; DRC audio preference was
inverted; the `manifest.googlevideo.com` live HLS manifest was rejected by the googlevideo branch; a retry
counted twice on network interruptions; rows without a key matched every job in the popup; the
checkpoint/prune order allowed a concurrent tab to delete a new job folder; pages without navigation events
had no originating host.

Builds: `bash scripts/build.sh` produced `dist/video-grabber-full-v1.5.0.zip` (39 files, 9.96 MB) and
`dist/video-grabber-store-v1.5.0.zip` (28 files, 0.12 MB); `node scripts/verify-build.cjs` passed 154
checks (manifests, referenced scripts, JS syntax, store exclusions incl. no WebAssembly CSP, zip = folder).
`scripts/build.ps1` was not executed (no PowerShell in the environment); it copies the same folders and
needed no changes.

**Real-browser status:** both builds were loaded and exercised in Chromium 141 (Playwright,
`--headless=new`): detection, direct/HLS/DASH/WebM downloads, DRM refusal, a forced service-worker stop,
cancellation, the FFmpeg worker under the extension CSP and the popup. **Google Chrome and Brave were not
tested**; use `docs/MEDIA-SCANNER-TESTS.md`.

## 6. Files

New: `shared/{cdn,drm,xml,hls,dash,mp4,download-engine}.js`, `scripts/lib/harness.cjs`, ten test suites,
`scripts/test-browser-e2e.cjs`, `scripts/test-public-streams.cjs`, `scripts/run-tests.cjs`,
`scripts/verify-build.cjs`, this report. Rewritten: `downloader.js`, `background/scanner.js`,
`ui/media-tab.js`, `docs/MEDIA-SCANNER-TESTS.md`. Updated: `background.js`, `background/youtube.js`,
`content/dom-scan.js`, `shared/media.js`, `shared/youtube.js`, `ts-converter.js`, `youtube/download.*`,
`ui/youtube-tab.js`, `downloader.html`, `popup.html`, `style.css`, `manifest.json` (1.5.0),
`scripts/manual-fixtures.cjs`, `scripts/test-hls-download.cjs` (new page elements/scripts), README,
CHANGELOG, PRIVACY. Permissions are unchanged. Nothing was pushed to GitHub.
