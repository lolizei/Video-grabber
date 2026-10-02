# Media Scanner manual test checklist

Load the unpacked extension or the **full** build in Chrome. After an update, reload the extension
in `chrome://extensions`, then reload the test page so its content script is installed.
These checks exercise real Chrome APIs; the optional UI preview uses mock APIs only.

## Local fixtures

With Node.js and FFmpeg on your PATH, run:

```bash
node scripts/manual-fixtures.cjs
```

Open [the fixture page](http://127.0.0.1:8765/) in Chrome. All media is generated locally
(a tone and a test pattern); no copyrighted samples or remote services are required.
Stop the server with Ctrl+C when finished. Set `VG_TEST_PORT` if port 8765 is in use.

- [ ] Open **Media Scanner**. MP3, MP4, HLS and DASH links appear without opening each link.
- [ ] Play the MP3 and MP4. Their sizes update from response headers, and each row shows its filename, type and source domain.
- [ ] The MP3 player and matching link produce one row; the two different query-string URLs produce separate rows.
- [ ] Audio / Video / Playlists / All filters work. Copy URL copies the full URL, including query parameters.
- [ ] Download the MP3. The saved file plays and the row changes from progress to Downloaded. On an authorized public-domain MP3 page, repeat this check with the actual CDN-hosted file.
- [ ] Download `clear.m3u8`. A download tab merges the segments and saves a playable MP4 with video and audio.
- [ ] `encrypted.m3u8`, `protected.m3u8` and `protected.mpd` show **Protected – not downloadable** with a disabled button. No key, encrypted segment or DRM license requests are made. Download all skips them.
- [ ] `clear.mpd` says **Download manifest**, saves an MPD, and explains that DASH media assembly is unsupported.
- [ ] Download `referrer.m3u8`. The extension request receives 403; the original-page fetch fallback succeeds with the browser-approved Referer.
- [ ] Filter Audio, then click Download all. At most three jobs run at once; the rest queue. Closing/reopening the popup preserves their status.
- [ ] Download `retry.mp3` before playing/opening that link: two 503 responses trigger retries, then the file saves. `missing.mp3` produces an error with Retry.
- [ ] First open [the plain baseline page](http://127.0.0.1:8765/plain), containing only a direct MP3 audio element and MP4 video element. Both appear, including after Clear/Refresh while playback continues. Leave Refresh pending longer than 1.5 seconds: polling must not discard its response.
- [ ] Clear, then Refresh: current media links return. Navigate to **Empty page**: scanner results reset, and the empty state shows network hits, DOM hits and active tab id. Return and reload: results reappear without duplicates. Switch tabs and confirm only the active tab's results appear.
- [ ] Reload the extension while the page remains open; Refresh reinjects the DOM scanner. Browser-protected pages show a useful scan error. Set DEBUG in config.js to see scanner logs.
- [ ] Test a page with a `blob:` player (for example, an authorized HLS player). Blob URLs are skipped and explained; its HTTP playlist/media remains detectable.
- [ ] Test a media link in a cross-origin iframe where you have access. It appears once, and the source frame is retained for an allowed referrer fallback.
- [ ] While downloads run, stop the service worker from extension developer tools. Reopen the popup: session detections and the queue remain; completed jobs are reconciled from Chrome downloads.
- [ ] Close a playlist download tab before completion. Its job becomes failed and the next queued job starts. A user-cancelled direct download stays cancelled without automatic retry.
- [ ] Use an inaccessible or expired signed URL. Show a useful error; never report success or save HTML as a media file.
- [ ] On YouTube/blob segmented playback, an empty scanner says **This site streams in segments – use the Video Grabber tab**.
- [ ] Full build: play an authorized YouTube video until existing detection has video and audio tracks. In the YouTube tab choose MP4 at available 1080p/720p/480p quality. The saved file has both picture and sound; test separate-track and combined-track sources where available.
- [ ] Choose MP3 at 128/192/320 kbps; each saved file contains audio only at the requested bitrate. Download %, Converting and Done appear; the title becomes a sanitized filename.
- [ ] Cancel during download and conversion: no output is saved and the job becomes Cancelled. Cancel during saving cancels the Chrome download. Close the conversion tab: reopening the popup reconciles the cancelled job. Expired URLs and missing audio show readable errors. No new cipher/DRM handling is performed.
- [ ] Build with `scripts/build.ps1` or `scripts/build.sh`. Both packages contain scanner modules and TS conversion. Full includes the YouTube UI/worker and local FFmpeg assets. Store excludes youtube/, background/youtube.js, shared/youtube.js, ui/youtube-tab.js and vendor/ffmpeg/, disables ENABLE_YOUTUBE, removes its tab and WebAssembly CSP permission, and excludes YouTube/googlevideo detection.

For an isolated browser conversion check, open `/wasm-preview.html` and press Test MP4/Test MP3.
It runs the real bundled conversion worker under an extension-style CSP with local generated media;
it does not verify live YouTube extraction or Chrome extension permissions. Keep actual Chrome/YouTube
checks marked pending until they have been run in a loaded extension.

For a visual-only popup check, open [the UI preview](http://127.0.0.1:8765/preview.html).
It runs the real popup HTML/CSS/UI against mock Chrome responses; it cannot verify extension permissions,
webRequest, actual downloads or worker lifecycle behavior.
