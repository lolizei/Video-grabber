# Privacy Policy – Video Grabber

_Last updated: 30 September 2026_

Video Grabber is a browser extension that finds videos on the page you are viewing and lets you download them.

## What data the extension handles

- **Addresses of media files.** To find videos, the extension looks at the web addresses and response
  headers (content type and size) of files the page you're viewing loads. This list is kept only in your
  browser's temporary session storage for that tab. It is cleared when you close the tab or leave the page.
- **Page title and address.** Used only to name downloaded files and to show tips for the current site.
- **Instagram posts.** On instagram.com, when you open the popup, the extension asks Instagram for details
  of the post you're viewing (video links, thumbnail, username, caption), using your existing session in
  your own browser. This is the same request the Instagram website makes itself. The result is only shown
  in the popup and is not stored.

## What the extension does not do

- It does not collect, sell or share any personal data.
- It does not send any data to the developer or to any third-party server.
- It has no analytics, tracking, ads or accounts.
- It does not read your passwords, form entries, messages or browsing history.

## Permissions

| Permission | Why it's needed |
|---|---|
| `webRequest` | To notice video and audio files as the page loads them |
| `downloads` | To save the video you choose to your computer |
| `storage` | To keep the list of found videos while the tab is open |
| `scripting` | To find `<video>` elements on the page and the Instagram post in view, only when you open the popup |
| Access to all sites | Videos can be on any site, and their files often come from other servers (CDNs) |

## Contact

Questions or problems: open an issue at https://github.com/lolizei/Video-grabber/issues
