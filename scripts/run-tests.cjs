// Runs every automated test sequentially and prints a summary. Requires Node.js 20+ and
// native ffmpeg/ffprobe on PATH (used only to generate fixtures and verify outputs).
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const tests = [
  ['Direct media detection & JS players', 'test-discovery.cjs'],
  ['HLS master/media playlists & downloads', 'test-hls-engine.cjs'],
  ['DASH manifest parsing & downloads', 'test-dash.cjs'],
  ['Separate audio/video merging', 'test-merge.cjs'],
  ['CDN redirects & expired URLs', 'test-cdn.cjs'],
  ['Segment retries & cancellation', 'test-engine.cjs'],
  ['Large-file handling & resume', 'test-large.cjs', ['--expose-gc']],
  ['Manifest V3 worker restarts', 'test-worker-restart.cjs'],
  ['DRM detection & rejection', 'test-drm.cjs'],
  ['YouTube detection & diagnostics', 'test-youtube-engine.cjs'],
  // Pre-existing regression tests (1.4.x).
  ['Rediscovery (1.4.x)', 'test-rediscovery.cjs'],
  ['TS conversion (1.4.x)', 'test-conversion.cjs'],
  ['Media Scanner (1.4.x)', 'test-scanner.cjs'],
  ['Popup refresh race (1.4.x)', 'test-popup-refresh.cjs'],
  ['HLS download page (1.4.x)', 'test-hls-download.cjs'],
  ['YouTube WASM conversion (1.4.x)', 'test-youtube-conversion.cjs'],
  ['YouTube download page (1.4.x)', 'test-youtube-download.cjs'],
  ['YouTube detection (1.4.x)', 'test-youtube-detection.cjs'],
  ['Message responses (1.4.x)', 'test-message-responses.cjs'],
  // Optional: skipped (not failed) when Playwright or network access is unavailable.
  ['Real Chromium E2E – full build', 'test-browser-e2e.cjs', [], ['dist/full']],
  ['Real Chromium E2E – store build', 'test-browser-e2e.cjs', [], ['dist/store']],
  ['Public authorized test streams', 'test-public-streams.cjs']
];
const only = process.argv.slice(2);
let failed = 0;
const started = Date.now();
let skipped = 0;
for (const [label, file, flags = [], args = []] of tests) {
  if (only.length && !only.some(name => file.includes(name))) continue;
  const t = Date.now();
  const run = spawnSync(process.execPath, [...flags, path.join(__dirname, file), ...args.map(a => path.join(__dirname, '..', a))], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
  const ok = run.status === 0;
  const skip = ok && /^SKIPPED/m.test(run.stdout);
  if (!ok) failed++;
  if (skip) skipped++;
  console.log(`${skip ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${((Date.now() - t) / 1000).toFixed(1)} s${skip ? '  ' + run.stdout.trim().split('\n').pop() : ''}`);
  if (!ok || process.env.VERBOSE) console.log((run.stdout + run.stderr).split('\n').map(l => '      ' + l).join('\n'));
}
console.log(`\n${failed ? failed + ' test file(s) failed' : 'All executed test files passed'}${skipped ? ', ' + skipped + ' skipped' : ''} in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
process.exitCode = failed ? 1 : 0;
