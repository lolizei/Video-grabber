# Changelog

## 1.5.2 – YouTube converter
- Root cause analysis and fixes for the YouTube converter (see docs/YOUTUBE-DIAGNOSTICS.md)
- Fix: VP9/AV1 video was re-encoded to H.264 in single-threaded WebAssembly (10 s of 1080p VP9 took 43.6 s, so long videos appeared stuck on "Converting"); H.264/VP9/AV1 video and AAC audio are now copied into MP4 (1.1 s for the same input)
- Eight visible pipeline stages (detecting, metadata, tracks, connecting, video, audio, converting, saving) with per-stage duration, HTTP status and the actual error; the popup shows the current stage
- New connection check before downloading (HTTP status, content type, byte-range support), memory guard for in-browser conversion, throttling warning with estimated time
- Diagnostics panel with Copy diagnostics in the YouTube tab and the download tab; URLs are reduced to itag/mime/clen, no cookies, signatures, tokens, IPs or page URL
- Player responses that list formats without URLs are reported as UMP/SABR instead of "no tracks"
- MP3 output verified by its frame header (bitrate must match the request); "complete" is accepted only after the saved download is re-checked (exists, non-empty, matching size)
- New real-browser test against a local YouTube simulation (`scripts/test-youtube-e2e.cjs`); WebAssembly tests extended to VP9/Opus and AV1 tracks

## 1.5.1
- Fix: slow but progressing downloads (throttled CDNs, YouTube) were aborted after 30 s per request/chunk and retried from zero, so they appeared to load forever. Timeouts now only trigger when no data arrives for 30 s
- YouTube tab: progress, speed and time left update continuously within each chunk; a stalled stream fails with a clear message
- Media Scanner: direct downloads show "waiting for the save dialog" and "no data received" hints; download-tab jobs show a hint when they stop reporting progress
- Temporary-storage detection has a timeout and falls back to memory when a browser blocks or restricts it (privacy settings)

## 1.5.0 – Streaming & CDN engine
- Discovery: redirect chains (keyed by the stable original URL), signed/expiring URL detection for CloudFront, AWS SigV4, Google Cloud, Akamai, Azure SAS, googlevideo, Meta, Wowza and secure-link tokens; re-signed URLs refresh the existing row; expired links are flagged; CDN provider from hostnames and response headers; segment requests counted per CDN host; originating website per row
- Discovery: media embedded in inline scripts, JSON-LD, `data-*` player attributes, meta/preload tags, and sources exposed by JW Player, video.js and common player globals (read-only, on Refresh); Azure `format=m3u8/mpd` manifests; Smooth Streaming/HDS reported as unsupported
- Live popup updates over a port (polling kept as fallback); quality and audio-track selectors; resolutions, codecs, audio tracks, duration, CDN, size probes; pause/resume/cancel; speed, ETA and conversion progress; parallel-segment setting
- HLS: full master/media parsing (variants, codecs, frame rate, audio renditions, I-frame lists, byte ranges, init maps, discontinuities, live detection); separate audio renditions for MPEG-TS and fMP4 are downloaded and merged into one MP4
- DASH: new parser for SegmentTemplate (`$Number$`, `$Time$`, widths), SegmentTimeline (`r=-1`), SegmentList, SegmentBase/single files, BaseURL inheritance and multi-period concatenation; video+audio merged into MP4 (DASH previously saved the manifest only); WebM merged with FFmpeg in the full build, saved as separate files in the store build
- New fragmented-MP4 muxer for separate tracks (track/timescale rewriting, absolute data offsets, start-time normalization, interleaving) and structural output validation
- Download manager: configurable concurrency with an ordered bounded window, exponential backoff with jitter and Retry-After, per-request timeouts, specific errors for expired/unauthorized/login-page/missing URLs, pause/resume/cancel, OPFS disk-backed chunks, resumable checkpoints, `chrome.downloads.resume` for interrupted direct downloads
- DRM: Widevine/PlayReady/FairPlay/ClearKey identification in HLS keys, DASH ContentProtection, MP4 init segments (encv/enca/tenc/pssh), SAMPLE-AES TS stream types and EME `encrypted` events; rejection happens before any key, license or encrypted segment request
- YouTube (full build): new/unknown itags classified by mime, multi-language/DRC audio kept distinct with original-language preference, more player-metadata sources with video-id matching, embed/live ids, expired URL handling, configuration diagnostics (UMP/SABR, ciphered, DRM, login, unplayable, upcoming, live HLS hand-off), output validation and saved-size verification
- MV3: download tabs claim their jobs (restored/duplicate tabs cannot re-run them), jobs reconciled on worker start, success only after output validation and download verification, cancelled state, no unhandled badge/listener rejections
- Tests: ten new automated suites plus an optional real-Chromium end-to-end test and an optional public-stream test; `run-tests.cjs` and `verify-build.cjs`; extended manual fixtures and Chrome/Brave checklist

## 1.4.3
- Recover already-present direct player URLs when network/request history contains no usable tracks
- Validate the current video id and skip ciphered/protected metadata without new network player API or license requests
- Count failed network responses and show total resources, player count, metadata URLs and SABR metadata diagnostics
- Refresh track metadata when URLs were initially detected without MIME/size information

## 1.4.2
- Background listeners keep channels open only for handled commands and reply on async failures
- YouTube conversion tabs open in the background so starting a job does not close the popup before its reply arrives
- Popup reports list/clear errors instead of leaving rejected promises unhandled
- Added message-response regression checks

## 1.4.1
- YouTube Refresh recovers existing direct tracks from page request history and Clear recovery state
- Refresh detection automatically while the YouTube tab is open; show request counts, page-scan errors and specific unsupported UMP/SABR diagnostics
- Exclude UMP resource URLs from ordinary direct-track classification even when response headers are unavailable
- Removed fixed 512 MB/768 MB YouTube input-size caps; browser/WebAssembly memory limits still apply
- Added detection-recovery and unsupported-stream regression tests

## 1.4.0
- Fixed a reproduced polling/Refresh race that discarded scanner results; added visible diagnostics and scan errors
- Refresh reinjects current DOM scanning and recovers existing Video Grabber detections
- Restored all-URL host/content-script matching while retaining synchronous listeners and session state
- Blocked all encrypted HLS and protected DASH downloads, including previously supported AES-128 and protected manifest saving
- Added full-build YouTube MP4 video/audio merge, MP3 bitrate options, progress and cancellation using bundled FFmpeg WebAssembly in a worker
- Added ENABLE_YOUTUBE and excluded YouTube conversion UI/code/assets from store packages
- Added real WebAssembly conversion tests and updated manual testing instructions

## 1.3.0
- Added Media Scanner popup tab with audio/video/playlist filters, sizes, source domains, Copy URL and Download all
- Added per-tab DOM/network detection and session storage, clearing on navigation
- Added durable download queue with three active jobs, progress, errors and retries
- Added local AES-128 HLS decryption, segment merging and automatic MP4 conversion
- Marked DRM HLS and DASH ContentProtection as Protected; protected items can save their original playlist, and unprotected DASH can save its manifest
- Added browser-approved original-page fetch fallback for referrer-protected media
- Narrowed host permissions to HTTP/HTTPS and documented every permission
- Added scanner regression tests and a local manual test fixture/checklist

## 1.2.0
- Separate Chrome Web Store build with YouTube turned off (`config.js`, `scripts/build.*`)
- Removed the unneeded `tabs` permission
- Direct files now show their file name instead of the file type
- Store icon now has the recommended transparent padding
- Added README, MIT license, privacy policy, store listing and GitHub release workflow

## 1.1.0
- Instagram: looks up the post or reel you're viewing and offers one MP4 with sound
- Groups all pieces of the same video into one card, most recently played first
- Thumbnails on every card, and a preview player in the popup
- Quality picker, plus an Audio button when a site sends the sound separately

## 1.0.0
- First version: detects MP4/WebM/HLS/YouTube streams and downloads them
