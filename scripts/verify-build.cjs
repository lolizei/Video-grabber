// Verifies dist/ after scripts/build.sh or scripts/build.ps1: manifests, versions, referenced
// files, JavaScript syntax, store-build exclusions and zip contents matching the folders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
let checks = 0;
const ok = (cond, message) => { assert(cond, message); checks++; };

for (const build of ['full', 'store']) {
  const dir = path.join(dist, build);
  ok(fs.existsSync(dir), `dist/${build} exists`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  ok(manifest.manifest_version === 3 && manifest.version === version, `${build}: MV3 manifest version ${version}`);
  ok(fs.existsSync(path.join(dir, manifest.background.service_worker)), `${build}: service worker present`);
  for (const icon of Object.values(manifest.icons)) ok(fs.existsSync(path.join(dir, icon)), `${build}: icon ${icon}`);
  for (const script of manifest.content_scripts.flatMap(c => c.js)) ok(fs.existsSync(path.join(dir, script)), `${build}: content script ${script}`);
  const files = walk(dir).map(f => path.relative(dir, f).split(path.sep).join('/'));
  // Every script referenced from HTML pages and importScripts exists.
  for (const html of files.filter(f => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(dir, html), 'utf8');
    for (const [, src] of text.matchAll(/<script src="([^"]+)"/g)) ok(fs.existsSync(path.join(dir, path.dirname(html), src)), `${build}: ${html} → ${src}`);
  }
  const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
  for (const [, list] of bg.matchAll(/importScripts\(([^)]*)\)/g))
    for (const [, src] of list.matchAll(/'([^']+)'/g)) {
      const needed = !/youtube/.test(src) || build === 'full';
      if (needed) ok(fs.existsSync(path.join(dir, src)), `${build}: importScripts ${src}`);
    }
  for (const js of files.filter(f => f.endsWith('.js') && !f.includes('vendor/'))) execFileSync(process.execPath, ['--check', path.join(dir, js)]), checks++;
  const config = fs.readFileSync(path.join(dir, 'config.js'), 'utf8');
  if (build === 'store') {
    ok(/ENABLE_YOUTUBE: false/.test(config), 'store: YouTube disabled');
    for (const excluded of ['youtube/', 'vendor/ffmpeg/', 'shared/youtube.js', 'background/youtube.js', 'ui/youtube-tab.js'])
      ok(!files.some(f => f.startsWith(excluded)), 'store: excludes ' + excluded);
    ok(!/wasm-unsafe-eval/.test(manifest.content_security_policy.extension_pages), 'store: no WebAssembly CSP');
    ok(!/youtube-tab|youtube-panel/.test(fs.readFileSync(path.join(dir, 'popup.html'), 'utf8')), 'store: no YouTube tab in popup');
  } else {
    ok(/ENABLE_YOUTUBE: true/.test(config), 'full: YouTube enabled');
    for (const needed of ['youtube/converter-worker.js', 'vendor/ffmpeg/ffmpeg-core.wasm', 'vendor/ffmpeg/ffmpeg-core.js', 'ui/youtube-tab.js'])
      ok(files.includes(needed), 'full: includes ' + needed);
  }
  for (const needed of ['shared/download-engine.js', 'shared/mp4.js', 'shared/dash.js', 'shared/hls.js', 'shared/drm.js', 'shared/cdn.js', 'shared/xml.js', 'downloader.js', 'ts-converter.js', 'vendor/mux.min.js'])
    ok(files.includes(needed), `${build}: includes ${needed}`);
  ok(!files.some(f => f.startsWith('scripts/') || f.startsWith('docs/') || f.startsWith('.git')), `${build}: no dev files`);
  // Zip mirrors the folder with forward-slash paths.
  const zip = path.join(dist, `video-grabber-${build}-v${version}.zip`);
  ok(fs.existsSync(zip), `${build}: zip exists`);
  const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(l => l && !l.endsWith('/'));
  ok(listing.every(l => !l.includes('\\')), `${build}: zip uses forward slashes`);
  assert.deepEqual([...listing].sort(), [...files].sort(), `${build}: zip matches folder`); checks++;
  console.log(`${build}: ${files.length} files, ${(fs.statSync(zip).size / 1048576).toFixed(2)} MB zip`);
}
console.log(`Passed: build verification (${checks} checks) for version ${version}.`);
