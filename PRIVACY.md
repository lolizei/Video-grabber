# Privacy Policy – Video Grabber

_Last updated: 2 October 2026 (version 1.5.0)_

Video Grabber is a browser extension that finds videos on the page you are viewing and lets you download them.

## What data the extension handles

- **Addresses of media files.** To find videos, the extension looks at the web addresses and response
  headers (content type, size and Referer) of files the page you're viewing loads. The Media Scanner also
  scans media elements and links in page frames. This list is kept only in your
  browser's temporary session storage for that tab. It is cleared when you close the tab or leave the page.
- **Page title and address.** Used only to name downloaded files and to show tips for the current site.
- **Instagram posts.** On instagram.com, when you open the popup, the extension asks Instagram for details
  of the post you're viewing (video links, thumbnail, username, caption), using your existing session in
  your own browser. This is the same request the Instagram website makes itself. The result is only shown
  in the popup and is not stored.
- **Download queue.** Selected media URLs, filenames and job status are kept in temporary browser session
  storage so downloads continue when the popup closes or the service worker restarts. Up to 100 completed
  or failed jobs are retained until the browser session ends. Active downloads can finish after the source
  tab closes. Unencrypted playlist/segment requests go directly to the media host; a permitted fallback uses the
  original page and its existing session. Encrypted playlists are blocked. All merging and MP4/MP3 conversion
  happen locally. The full build stores one YouTube conversion job in session storage and uses the already
  detected media URLs, with a bundled FFmpeg worker; no conversion data is uploaded to a processing server.
- **Temporary download data (1.5.0).** Segmented downloads are staged in the extension's private
  Origin Private File System storage on your computer so large files do not have to fit in memory and
  interrupted downloads can resume. A small checkpoint (a hashed job key, segment counts,
  chunk sizes and the paths of the first/last segment, used to detect a changed playlist) is kept in local
  extension storage. Both are deleted when the download completes
  or is cancelled; abandoned data is removed automatically after 7 days.
- **Settings.** The parallel-segment setting is stored in local extension storage.
- **Encryption indicators.** To explain why protected media cannot be saved, the extension notes whether
  the page fired Encrypted Media Extensions "encrypted" events and which key system the event's
  initialization data names (for example Widevine). It never requests licenses or keys and never changes
  the page's player.
- **Player sources.** On Refresh, the Media Scanner reads media addresses already exposed by common
  web players on the page (for example video.js or JW Player). Nothing is sent anywhere.

## What the extension does not do

- It does not collect, sell or share any personal data.
- It does not send any data to the developer or to any third-party server.
- It has no analytics, tracking, ads or accounts.
- It does not read your passwords, form entries, messages or browsing history.

## Permissions

| Permission | Why it's needed |
|---|---|
| `webRequest` | To notice media files and inspect headers without modifying requests |
| `downloads` | To save selected media and monitor download progress and errors |
| `storage` | Per-tab detections and the download queue in temporary session storage; the parallel-download setting and resumable-download checkpoints in local extension storage |
| `scripting` | To rescan already-open pages/frames on Refresh and preserve the existing video/Instagram lookup; declarative content scripts automatically scan media links |
| `<all_urls>` host access | Media can be on arbitrary pages and CDNs; Chrome still restricts protected browser pages |

## Contact

Questions or problems: open an issue at https://github.com/lolizei/Video-grabber/issues
