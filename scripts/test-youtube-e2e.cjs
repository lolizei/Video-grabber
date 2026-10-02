// OPTIONAL real-browser test of the complete YouTube pipeline against a LOCAL YouTube-shaped
// simulation. Chromium resolves www.youtube.com and *.googlevideo.com to a local HTTPS server
// (--host-resolver-rules) that serves a watch page with player metadata and byte-range
// `videoplayback` responses built from generated media. The real extension, popup, service worker,
// download tab, bundled FFmpeg WebAssembly and chrome.downloads are exercised.
//
// This verifies the extension's own pipeline. It does NOT prove that real YouTube serves
// downloadable URLs to it: real YouTube may use UMP/SABR, ciphered formats or PO tokens.
//
//   node scripts/test-youtube-e2e.cjs [dist/full]
const assert = require('node:assert/strict');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const H = require('./lib/harness.cjs');
const { fs, path } = H;
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.log('SKIPPED: the playwright package is not installed (set PLAYWRIGHT_MODULE). Nothing was verified.'); process.exit(0); }
const extension = path.resolve(process.argv[2] || path.join(H.root, 'dist', 'full'));
const until = async (fn, timeout = 60000, label = 'condition') => {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out waiting for ' + label); await H.settle(300); }
};
const VIDEO_ID = 'vgTestVid01';

(async () => {
  if (!fs.existsSync(path.join(extension, 'youtube', 'converter-worker.js'))) { console.log('SKIPPED: needs the full build (' + extension + '). Nothing was verified.'); return; }
  const dir = H.tempDir('vg-yt-'), downloads = H.tempDir('vg-yt-dl-'), profile = H.tempDir('vg-yt-profile-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=www.youtube.com', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  // YouTube-like adaptive formats: fragmented MP4 (H.264 / AAC) and WebM (VP9 / Opus).
  const src = ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6'];
  H.ffmpeg([...src, '-map', '0:v', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'v134.mp4'], dir);
  H.ffmpeg([...src, '-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'a140.m4a'], dir);
  H.ffmpeg([...src, '-map', '0:v', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-s', '426x240', '-f', 'webm', 'v242.webm'], dir);
  H.ffmpeg([...src, '-map', '1:a', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', 'a251.webm'], dir);
  const files = { 134: ['v134.mp4', 'video/mp4; codecs="avc1.4d401e"', '360p'], 140: ['a140.m4a', 'audio/mp4; codecs="mp4a.40.2"', ''],
    242: ['v242.webm', 'video/webm; codecs="vp9"', '240p'], 251: ['a251.webm', 'audio/webm; codecs="opus"', ''] };
  const expire = Math.floor(Date.now() / 1000) + 6 * 3600;
  let mode = 'ok';
  const requests = [];
  const url = itag => `https://rr3---sn-test.googlevideo.com/videoplayback?expire=${expire}&itag=${itag}&mime=${encodeURIComponent(files[itag][1].split(';')[0])}&clen=${fs.statSync(path.join(dir, files[itag][0])).size}&sig=TESTSIG&lsig=TESTLSIG`;
  const playerResponse = id => ({ videoDetails: { videoId: id, title: 'Local test video', lengthSeconds: '6' }, playabilityStatus: { status: 'OK' },
    streamingData: mode === 'sabr' ? { serverAbrStreamingUrl: 'https://rr3---sn-test.googlevideo.com/videoplayback?sabr=1', adaptiveFormats: Object.keys(files).map(i => ({ itag: Number(i), mimeType: files[i][1] })) }
      : mode === 'cipher' ? { adaptiveFormats: Object.keys(files).map(i => ({ itag: Number(i), mimeType: files[i][1], signatureCipher: 's=AAAA&sp=sig&url=' + encodeURIComponent(url(i)) })) }
      : { adaptiveFormats: Object.keys(files).map(i => ({ itag: Number(i), url: url(i), mimeType: files[i][1], qualityLabel: files[i][2] || undefined, contentLength: String(fs.statSync(path.join(dir, files[i][0])).size) })) } });
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    const u = new URL(req.url, 'https://' + req.headers.host);
    requests.push({ host: req.headers.host, path: u.pathname, query: u.search, method: req.method });
    if (req.headers.host.startsWith('www.youtube.com')) {
      if (u.pathname === '/watch') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>Local test video - YouTube</title><h1>Local YouTube simulation</h1><video id="v" muted></video>
          <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse(u.searchParams.get('v')))};
          // Emulate the classic player: ranged GET requests for the selected video/audio formats.
          ${mode === 'ok' ? `for (const f of ytInitialPlayerResponse.streamingData.adaptiveFormats.filter(f => f.itag === 134 || f.itag === 140)) fetch(f.url + '&range=0-65535&rn=1').catch(() => {});` : ''}</script>`);
      }
      res.writeHead(404).end(); return;
    }
    if (u.pathname === '/videoplayback') {
      const itag = u.searchParams.get('itag');
      if (mode === 'forbidden') { res.writeHead(403, { 'Content-Type': 'text/plain' }).end(); return; }
      if (!files[itag]) { res.writeHead(404).end(); return; }
      const file = path.join(dir, files[itag][0]), size = fs.statSync(file).size;
      const [a, b] = (u.searchParams.get('range') || `0-${size - 1}`).split('-').map(Number);
      const end = Math.min(b, size - 1);
      res.writeHead(200, { 'Content-Type': files[itag][1].split(';')[0], 'Content-Length': end - a + 1, 'Access-Control-Allow-Origin': '*' });
      if (mode === 'slow' && end - a > 2048) {
        // Throttled like YouTube's out-of-player URLs: ~8 KB/s, but steadily progressing.
        const data = fs.readFileSync(file).subarray(a, end + 1);
        let o = 0;
        const timer = setInterval(() => { res.write(data.subarray(o, o + 4096)); o += 4096; if (o >= data.length) { clearInterval(timer); res.end(); } }, 500);
        req.on('close', () => clearInterval(timer));
        return;
      }
      return fs.createReadStream(file, { start: a, end }).pipe(res);
    }
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const context = await playwright.chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true, downloadsPath: downloads,
    ...(process.env.CHROME_PATH || fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium' } : {}),
    args: ['--headless=new', '--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors',
      `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${port},MAP *.googlevideo.com 127.0.0.1:${port}`] });
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    await sw.evaluate(() => !!globalThis.YouTubeDownloads);
    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    const popup = await context.newPage();
    const ext = (fn, arg) => popup.evaluate(fn, arg);
    async function open(m) {
      mode = m;
      const id = { ok: VIDEO_ID, sabr: 'vgTestSabr1', cipher: 'vgTestCiph1' }[m] || VIDEO_ID;
      await page.goto(`https://www.youtube.com/watch?v=${id}`);
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await page.bringToFront();
      await H.settle(1500);
      await popup.evaluate(() => document.querySelector('#youtube-tab').click());
      return until(async () => { const t = await popup.locator('#youtube-tracks').innerText(); return t && !/^$/.test(t) && t; }, 15000, 'track detection');
    }
    async function convert(output, quality, bitrate = 192) {
      const before = new Set((await ext(() => chrome.downloads.search({}))).map(d => d.id));
      await popup.selectOption('#youtube-output', output);
      if (quality) await popup.selectOption('#youtube-quality', quality);
      if (output === 'mp3') await popup.selectOption('#youtube-bitrate', String(bitrate));
      const previous = (await ext(() => chrome.storage.session.get('youtube_job'))).youtube_job?.id;
      await until(async () => !(await popup.locator('#youtube-start').isDisabled()), 15000, 'start button');
      await popup.evaluate(() => document.querySelector('#youtube-start').click());
      const job = await until(async () => { const j = (await ext(() => chrome.storage.session.get('youtube_job'))).youtube_job; return j && j.id !== previous && j.status !== 'running' && j; }, 180000, 'conversion');
      const saved = (await ext(() => chrome.downloads.search({ state: 'complete' }))).filter(d => !before.has(d.id));
      return { job, saved };
    }
    let text;
    await H.check('detection: direct player-metadata formats and ranged network requests yield video and audio tracks', async () => {
      text = await open('ok');
      assert.match(text, /detected track/);
      const qualities = await popup.locator('#youtube-quality option').allInnerTexts();
      assert(qualities.includes('360p') && qualities.includes('240p'), qualities.join(','));
    });
    await H.check('MP4 360p (H.264 + AAC): download → FFmpeg merge → saved file with video and audio', async () => {
      const { job, saved } = await convert('mp4', '360p');
      assert.equal(job.status, 'complete', job.message + ' ' + JSON.stringify(job.diagnostics || {}));
      assert.equal(saved.length, 1);
      const info = H.probe(saved[0].filename);
      assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
      assert(Math.abs(Number(info.format.duration) - 6) < 0.5, 'duration ' + info.format.duration);
      H.decodes(saved[0].filename);
      console.log('    ' + path.basename(saved[0].filename) + ': ' + info.streams.map(s => s.codec_name + (s.height ? ' ' + s.height + 'p' : '')).join(' + '));
    });
    await H.check('MP4 240p from VP9/Opus WebM tracks converts within the time limit', async () => {
      const t = Date.now();
      const { job, saved } = await convert('mp4', '240p');
      assert.equal(job.status, 'complete', job.message + ' ' + JSON.stringify(job.diagnostics || {}));
      const info = H.probe(saved[0].filename);
      assert(info.streams.some(s => s.codec_type === 'video') && info.streams.some(s => s.codec_type === 'audio'));
      H.decodes(saved[0].filename);
      console.log(`    ${info.streams.map(s => s.codec_name).join(' + ')} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    });
    for (const bitrate of [128, 192, 320]) {
      await H.check(`MP3 ${bitrate} kbps: audio-only output at the requested bitrate`, async () => {
        const { job, saved } = await convert('mp3', null, bitrate);
        assert.equal(job.status, 'complete', job.message);
        const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,bit_rate:format=duration', '-of', 'json', saved[0].filename], { encoding: 'utf8' }));
        assert.deepEqual(info.streams.map(s => s.codec_name), ['mp3']);
        assert.equal(Number(info.streams[0].bit_rate), bitrate * 1000);
        H.decodes(saved[0].filename);
      });
    }
    await H.check('diagnostics are recorded per stage and contain no signatures', async () => {
      const job = (await ext(() => chrome.storage.session.get('youtube_job'))).youtube_job;
      const diag = job.diagnostics;
      assert(diag, 'diagnostics present');
      assert.equal(diag.stage, 'done');
      assert(diag.bytes > 0 && diag.tracks.audio && diag.output.bitrate === 320 && diag.stages.every(s => s.status === 'ok'));
      const text = JSON.stringify(diag);
      assert(!/TESTSIG|TESTLSIG|sig=|expire=/.test(text), 'sanitized: ' + text);
    });
    await H.check('HTTP 403 from the media server fails at "Connecting to media server" with the status code, no file', async () => {
      await open('ok');
      mode = 'forbidden';
      const { job, saved } = await convert('mp3', null, 128);
      assert.equal(job.status, 'failed'); assert.match(job.message, /403/);
      assert.equal(saved.length, 0);
      assert.equal(job.diagnostics.stage, 'connect'); assert.equal(job.diagnostics.lastStatus, 403); assert.match(job.message, /Failed at "Connecting to media server"/);
    });
    await H.check('throttled stream (~8 KB/s): progress keeps moving, a throttling warning is shown, the MP3 still completes', async () => {
      await open('ok');
      mode = 'slow';
      const progress = [];
      const sampler = setInterval(async () => { try { const j = (await ext(() => chrome.storage.session.get('youtube_job'))).youtube_job; if (j?.status === 'running') progress.push([j.progress, j.message]); } catch {} }, 1000);
      const { job, saved } = await convert('mp3', null, 128);
      clearInterval(sampler);
      assert.equal(job.status, 'complete', job.message);
      assert.equal(saved.length, 1);
      const values = [...new Set(progress.filter(([, m]) => /Downloading audio/.test(m)).map(([p]) => p))];
      assert(values.length >= 5, 'progress updates during the throttled download: ' + values.join(','));
      assert.match(job.diagnostics.warning, /throttles/);
      console.log('    ' + values.length + ' distinct progress values; warning: ' + job.diagnostics.warning.slice(0, 70) + '…');
    });
    await H.check('UMP/SABR-only metadata: zero tracks with the exact reason', async () => {
      await page.evaluate(() => 0);
      const t = await open('sabr');
      assert.match(t, /UMP\/SABR/);
    });
    await H.check('signature-ciphered metadata: zero tracks with the exact reason', async () => {
      const t = await open('cipher');
      assert.match(t, /signature/);
    });
    if (process.env.VG_SCREENSHOT_DIR) {
      await popup.evaluate(() => { document.querySelector('#youtube-diag').open = true; document.body.style.maxHeight = 'none'; });
      await popup.setViewportSize({ width: 460, height: 1100 });
      await popup.screenshot({ path: path.join(process.env.VG_SCREENSHOT_DIR, 'youtube-popup-cipher.png'), fullPage: true });
    }
    H.summary('simulated-YouTube pipeline in real Chromium: detection, MP4 (H.264/AAC and VP9/Opus), MP3 128/192/320, diagnostics, 403/SABR/cipher');
  } finally {
    await context.close(); server.close();
    for (const d of [dir, downloads, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
