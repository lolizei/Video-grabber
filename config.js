// Build configuration. scripts/build.* overwrites this file for the Chrome Web Store build,
// where YouTube support is turned off (store policy doesn't allow YouTube downloaders).
globalThis.VG_CONFIG = {
  build: 'full',
  ENABLE_YOUTUBE: true,
  enableYouTube: true,
  DEBUG: false
};
