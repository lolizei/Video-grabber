#!/usr/bin/env bash
# Builds two zips in dist/:
#   video-grabber-full-vX.zip   - everything, incl. YouTube (for GitHub releases)
#   video-grabber-store-vX.zip  - YouTube turned off (upload this to the Chrome Web Store)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
FILES=(manifest.json background.js config.js popup.html popup.js downloader.html downloader.js style.css icons)

rm -rf dist
for build in full store; do
  mkdir -p "dist/$build"
  cp -r "${FILES[@]}" "dist/$build/"
done

cat > dist/store/config.js <<'CFG'
// Chrome Web Store build: YouTube support is turned off.
globalThis.VG_CONFIG = {
  build: 'store',
  enableYouTube: false
};
CFG

for build in full store; do
  (cd "dist/$build" && zip -qr "../video-grabber-$build-v$VERSION.zip" .)
done
echo "Built dist/video-grabber-full-v$VERSION.zip and dist/video-grabber-store-v$VERSION.zip"
