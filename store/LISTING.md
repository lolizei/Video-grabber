# Chrome Web Store listing – copy & paste

Upload **`dist/video-grabber-store-vX.zip`** (made by `scripts/build.ps1`), never the full build.

## Store listing tab

**Name:** Video Grabber

**Summary (max 132 characters):**
Find the videos on any page and download them in one click. Supports MP4, WebM, HLS streams and Instagram reels.

**Category:** Tools

**Language:** English

**Description:**
```
Video Grabber finds the videos on the page you're viewing and lets you save them in one click.

HOW IT WORKS
1. Open a page and start playing the video.
2. Click the Video Grabber icon. The badge shows how many videos were found.
3. Click a thumbnail to preview the video, pick a quality, and click Download.

FEATURES
• Lists every video the page loads, with thumbnail, file size and quality
• Preview the full video right in the popup before downloading
• Downloads MP4, WebM, MOV and other video files directly
• Downloads HLS (.m3u8) streams and saves them as one file
• Instagram: downloads the reel or post you're viewing as one MP4 with sound
• Groups the pieces a site loads into one entry per video
• Light and dark mode

PRIVACY
No tracking, no analytics, no accounts. Nothing you do is sent anywhere. The list of found videos stays in your browser and is cleared when you close the tab.

NOT SUPPORTED
• DRM-protected streaming services (Netflix, Disney+ and similar)
• Encrypted HLS streams
• YouTube

Only download videos you have the right to save.

Open source: https://github.com/lolizei/Video-grabber
```

**Graphics** (all in this folder):
- Store icon: `icon-128.png`
- Screenshots (1280×800): `screenshot-1-list.png`, `screenshot-2-preview.png`
- Small promo tile (440×280): `promo-small-440x280.png`

## Privacy practices tab

**Single purpose:**
Detect video files on the page the user is viewing and download the one the user chooses.

**Permission justifications:**
- **webRequest:** Detects video and audio files by reading the content type and size of responses the current page loads. Requests are only observed, never blocked or changed.
- **downloads:** Saves the video the user chooses to their computer.
- **storage:** Keeps the list of detected videos for each tab in session storage while the tab is open.
- **scripting:** When the user opens the popup, reads the video elements on the current page (and, on Instagram, which post is in view) to list them.
- **Host permission (all sites):** Videos can appear on any website and are usually served from separate media servers (CDNs), so the extension must see responses from any host and fetch the video file the user picks.

**Remote code:** No, I am not using remote code.

**Data usage:** tick nothing. The extension collects no user data.
Tick all three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:**
https://github.com/lolizei/Video-grabber/blob/main/PRIVACY.md

## Before you submit
- One-time $5 developer registration fee at https://chrome.google.com/webstore/devconsole
- Review usually takes a few days. Extensions with access to all sites are reviewed more closely.
- Instagram downloading can still be flagged under the store's content policy. If the review is rejected
  for that, the fix is to turn Instagram off in the store build the same way YouTube is.
