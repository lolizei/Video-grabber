# Privacy Policy – Video Grabber

_Last updated: 2 October 2026_

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
  tab closes. Playlist/segment/key requests go directly to the media host; a permitted fallback uses the
  original page and its existing session. All merging, AES-128 decryption and MP4 conversion happen locally.

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
| `storage` | To keep per-tab detections and download queue state in temporary session storage |
| `scripting` | To rescan already-open pages/frames on Refresh and preserve the existing video/Instagram lookup; declarative content scripts automatically scan media links |
| HTTP/HTTPS site access | Media can be on any web page, and its files often come from other servers (CDNs) |

## Contact

Questions or problems: open an issue at https://github.com/lolizei/Video-grabber/issues
