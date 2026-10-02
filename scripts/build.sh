#!/usr/bin/env bash
# Builds two zips in dist/:
#   video-grabber-full-vX.zip   - everything, incl. YouTube (for GitHub releases)
#   video-grabber-store-vX.zip  - YouTube turned off (upload this to the Chrome Web Store)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
FILES=(manifest.json background.js config.js popup.html popup.js downloader.html downloader.js ts-converter.js youtube vendor shared background content ui style.css icons)

rm -rf dist
for build in full store; do
  mkdir -p "dist/$build"
  cp -r "${FILES[@]}" "dist/$build/"
done

cat > dist/store/config.js <<'CFG'
// Chrome Web Store build: YouTube support is turned off.
globalThis.VG_CONFIG = {
  build: 'store',
  ENABLE_YOUTUBE: false,
  enableYouTube: false,
  DEBUG: false
};
CFG

rm -rf dist/store/youtube dist/store/vendor/ffmpeg dist/store/shared/youtube.js dist/store/background/youtube.js dist/store/ui/youtube-tab.js
python3 - <<'PY'
import json, pathlib, re
p = pathlib.Path('dist/store/popup.html')
html = p.read_text()
html = re.sub(r'^.*id="youtube-tab".*\n', '', html, flags=re.M)
html = re.sub(r'\s*<section id="youtube-panel".*?</section>', '', html, flags=re.S)
html = re.sub(r'^.*src="ui/youtube-tab.js".*\n', '', html, flags=re.M)
p.write_text(html)
p = pathlib.Path('dist/store/manifest.json')
data = json.loads(p.read_text())
data['content_security_policy']['extension_pages'] = "script-src 'self'; object-src 'self'"
p.write_text(json.dumps(data, indent=2) + '\n')
PY

for build in full store; do
  (cd "dist/$build" && zip -qr "../video-grabber-$build-v$VERSION.zip" .)
done
echo "Built dist/video-grabber-full-v$VERSION.zip and dist/video-grabber-store-v$VERSION.zip"
