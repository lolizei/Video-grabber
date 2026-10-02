# Changelog

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
