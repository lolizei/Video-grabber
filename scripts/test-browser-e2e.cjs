// OPTIONAL real-browser integration test: loads the built extension into Chromium through
// Playwright and drives the real service worker, webRequest, content scripts, chrome.downloads,
// download tabs, OPFS storage and the popup against generated local fixtures.
//
//   node scripts/test-browser-e2e.cjs [dist/full|dist/store]
//
// Requires the `playwright` package (PLAYWRIGHT_MODULE can point to it) and a Chromium build
// that supports extensions (CHROME_PATH, default: Playwright's Chromium). This covers Chromium
// only; Google Chrome and Brave still need the manual checklist in docs/MEDIA-SCANNER-TESTS.md.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.log('SKIPPED: the playwright package is not installed (set PLAYWRIGHT_MODULE). Nothing was verified.'); process.exit(0); }

const extension = path.resolve(process.argv[2] || path.join(H.root, 'dist', 'full'));
const until = async (fn, timeout = 60000, label = 'condition') => {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('Timed out waiting for ' + label); await H.settle(250); }
};

(async () => {
  if (!fs.existsSync(path.join(extension, 'manifest.json'))) { console.log('SKIPPED: build the extension first (' + extension + '). Nothing was verified.'); return; }
  const store = /build: 'store'/.test(fs.readFileSync(path.join(extension, 'config.js'), 'utf8'));
  const dir = H.tempDir('vg-e2e-media-'), downloads = H.tempDir('vg-e2e-dl-'), profile = H.tempDir('vg-e2e-profile-');
  H.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:a', 'libmp3lame', 'tone.mp3'], dir);
  H.ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'video.mp4'], dir);
  H.media.hlsFmp4Separate(dir); H.media.dash(dir, 'tl'); H.media.dashWebm(dir, 'wm'); H.media.hlsTsMuxed(dir, 'long', 20); H.media.cencMp4(dir, 'cenc.mp4');
  const cenc = new Uint8Array(fs.readFileSync(path.join(dir, 'cenc.mp4')));
  let moovEnd = 0; for (let o = 0; o + 8 <= cenc.length;) { const size = Buffer.from(cenc).readUInt32BE(o); if (Buffer.from(cenc).toString('latin1', o + 4, o + 8) === 'moov') moovEnd = o + size; o += size; }
  fs.writeFileSync(path.join(dir, 'cenc-init.m3u8'), `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="cenc.mp4",BYTERANGE="${moovEnd}@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:${cenc.length - moovEnd}@${moovEnd}\ncenc.mp4\n#EXT-X-ENDLIST\n`);
  fs.writeFileSync(path.join(dir, 'widevine.mpd'), '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><SegmentTemplate media="tl-0-$Number%05d$.m4s" initialization="tl-init-0.m4s" duration="1"/><Representation id="0" bandwidth="1"/></AdaptationSet></Period></MPD>');
  let slow = 0;
  const server = await H.serve(dir, { hooks: {
    '/': (req, res, { url }) => { if (url.pathname !== '/') return false;
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>E2E fixtures</title><audio src="/tone.mp3" controls></audio><video src="/video.mp4" muted controls></video>
        <a href="/fmp4-master.m3u8">fmp4</a> <a href="/tl.mpd">dash</a> <a href="/widevine.mpd">wv</a> <a href="/cenc-init.m3u8">cenc</a> <a href="/long.m3u8">long</a> <a href="/wm.mpd">webm</a>
        <script>var playerConfig = {"sources":[{"file":"http:\\/\\/127.0.0.1:${'${PORT}'}\\/script-only.m3u8"}]};</script>`.replace('${PORT}', req.socket.localPort)); return true; },
    '/script-only.m3u8': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(fs.readFileSync(path.join(dir, 'long.m3u8'))); return true; },
    '*': async (req) => { if (/^\/long-\d+\.ts/.test(new URL(req.url, 'http://x').pathname) && slow) await H.settle(slow); }
  } });
  const base = server.base;
  const context = await playwright.chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true, downloadsPath: downloads,
    ...(process.env.CHROME_PATH || fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium' } : {}),
    args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = async () => context.serviceWorkers().filter(w => w.url().endsWith('/background.js')).at(-1) || context.waitForEvent('serviceworker', { timeout: 15000 });
  // After a worker stop the old handle is dead; wait for Chrome to start a new worker.
  async function sw(fn, arg) {
    for (let attempt = 0; ; attempt++) {
      try { return await (await worker()).evaluate(fn, arg); }
      catch (error) {
        if (attempt > 20 || !/destroyed|closed|Target|detached/i.test(error.message)) throw error;
        await context.waitForEvent('serviceworker', { timeout: 2000 }).catch(() => {});
      }
    }
  }
  try {
    await sw(() => !!globalThis.MediaScanner); // worker running with listeners registered before the page loads
    let page = await context.newPage();
    await page.goto(base + '/');
    const tabId = await sw(async base => (await chrome.tabs.query({ url: base + '/*' }))[0].id, base);
    const extId = new URL((await worker()).url()).host;
    console.log(`  Chromium ${context.browser()?.version() || ''} · extension ${extId} · ${path.basename(extension)} build`);
    const snapshot = () => sw(id => MediaScanner.snapshot(id), tabId);
    const snapshotViaMessage = () => message({ cmd: 'scanner.list', tabId });
    // Job state and downloads are read from an extension page, which keeps working while the
    // service worker is stopped and restarted.
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extId}/popup.html`);
    await page.bringToFront();
    const ext = (fn, arg) => extPage.evaluate(fn, arg);
    const job = id => ext(async id => (await chrome.storage.session.get('scanner_jobs')).scanner_jobs.find(j => j.id === id), id);
    const finished = (id, timeout) => until(async () => { const j = await job(id); return j && !['queued', 'running'].includes(j.status) && j; }, timeout, 'job ' + id);
    const savedFile = async j => {
      const id = j.downloadId ?? j.savedDownloadId;
      const [item] = await ext(id => chrome.downloads.search({ id }), id);
      assert(item && item.state === 'complete', 'download item complete');
      return item;
    };
    await H.check('content script + webRequest detect page media, playlists and script-embedded manifests', async () => {
      await page.evaluate(() => Promise.all([...document.querySelectorAll('audio,video')].map(m => { m.muted = true; return m.play().catch(() => {}); })));
      const snap = await until(async () => { const s = await snapshot(); return s.items.length >= 8 && s; }, 15000, 'detections');
      const names = snap.items.map(i => i.filename);
      for (const name of ['tone.mp3', 'video.mp4', 'fmp4-master.m3u8', 'tl.mpd', 'widevine.mpd', 'cenc-init.m3u8', 'script-only.m3u8']) assert(names.includes(name), name + ' in ' + names.join(', '));
      assert.equal(snap.items.find(i => i.filename === 'script-only.m3u8').source, 'script');
      assert(snap.debug.networkHits >= 1, 'network hits from playback: ' + JSON.stringify(snap.debug) + JSON.stringify(snap.items.map(i => i.filename + ':' + i.source + ':' + i.size)) + JSON.stringify(server.requests.map(r => r.path + ' ' + r.range)));
    });
    // Commands go through the real runtime messaging path, exactly like the popup.
    const message = async msg => { const reply = await ext(m => chrome.runtime.sendMessage(m), msg); if (!reply?.ok) throw new Error(reply?.error || 'no reply'); return reply.result; };
    const enqueue = (url, selection) => message({ cmd: 'scanner.download', tabId, urls: [url], selections: selection ? { [url]: selection } : {} });
    const inspect = url => message({ cmd: 'scanner.inspect', tabId, url });
    await H.check('direct MP3 download completes through chrome.downloads with a verified file', async () => {
      const [id] = await enqueue(base + '/tone.mp3');
      const j = await finished(id, 30000);
      assert.equal(j.status, 'complete', j.message);
      const item = await savedFile(j);
      assert.equal(item.fileSize || item.bytesReceived, fs.statSync(path.join(dir, 'tone.mp3')).size);
    });
    await H.check('HLS fMP4 with separate audio: quality selection, download tab, merged MP4 saved', async () => {
      const protection = await inspect(base + '/fmp4-master.m3u8');
      assert.equal(protection.status, 'clear');
      const item = (await snapshotViaMessage()).items.find(i => i.filename === 'fmp4-master.m3u8');
      assert.deepEqual(item.details.variants.map(v => v.height), [180, 90]);
      const [id] = await enqueue(item.url, { height: 90 });
      const j = await finished(id, 60000);
      assert.equal(j.status, 'complete', j.message);
      const saved = await savedFile(j);
      const info = H.probe(saved.filename);
      assert.equal(info.streams.find(s => s.codec_type === 'video').height, 90);
      assert(info.streams.some(s => s.codec_type === 'audio'));
      H.decodes(saved.filename);
    });
    await H.check('DASH SegmentTimeline download merges audio and video in the real browser', async () => {
      await inspect(base + '/tl.mpd');
      const [id] = await enqueue(base + '/tl.mpd');
      const j = await finished(id, 60000);
      assert.equal(j.status, 'complete', j.message);
      const info = H.probe((await savedFile(j)).filename);
      assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
    });
    await H.check('DRM: Widevine DASH is refused; CENC-encrypted init segment ends as "protected"', async () => {
      const wv = await inspect(base + '/widevine.mpd');
      assert.equal(wv.status, 'protected'); assert.match(wv.label, /Widevine/);
      assert.equal((await enqueue(base + '/widevine.mpd')).length, 0);
      await inspect(base + '/cenc-init.m3u8');
      const [id] = await enqueue(base + '/cenc-init.m3u8');
      const j = await finished(id, 30000);
      assert.equal(j.status, 'protected', j.message);
      assert(!server.requests.some(r => r.path === '/cenc.mp4' && r.range !== `bytes=0-${moovEnd - 1}`), 'no encrypted media range requested');
    });
    await H.check('a download survives a forced service-worker stop and completes once', async () => {
      slow = 200;
      await inspect(base + '/long.m3u8');
      const [id] = await enqueue(base + '/long.m3u8');
      await until(async () => (await job(id))?.progress > 0.1, 30000, 'progress');
      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await H.settle(1000);
      const j = await finished(id, 90000);
      assert.equal(j.status, 'complete', j.message);
      H.decodes((await savedFile(j)).filename);
      // The job was completed by a newly started worker instance (the stopped one had no state).
      assert.equal((await snapshotViaMessage()).jobs.filter(x => x.item.url === base + '/long.m3u8' && x.status === 'complete').length, 1, 'exactly one completed job');
      slow = 0;
    });
    await H.check('cancel from the popup API stops a running segment download', async () => {
      slow = 400;
      const [id] = await enqueue(base + '/long.m3u8', { height: 1 });
      await until(async () => (await job(id))?.progress > 0.05, 30000, 'progress');
      const result = await message({ cmd: 'scanner.control', id, action: 'cancel' });
      assert.equal(result.status, 'cancelled');
      const before = server.requests.length;
      await H.settle(1500);
      assert(server.requests.length - before <= 4, 'only in-flight requests may finish after cancel');
      slow = 0;
    });
    await H.check(`WebM DASH: ${store ? 'store build saves separate audio and video files' : 'full build merges audio and video with the bundled FFmpeg'}`, async () => {
      await inspect(base + '/wm.mpd');
      const before = new Set((await ext(() => chrome.downloads.search({}))).map(d => d.id));
      const [id] = await enqueue(base + '/wm.mpd');
      const j = await finished(id, 120000);
      assert.equal(j.status, 'complete', j.message);
      const files = (await ext(() => chrome.downloads.search({ state: 'complete' }))).filter(d => !before.has(d.id));
      assert.equal(files.length, store ? 2 : 1, files.map(f => f.filename).join(', '));
      const codecs = files.flatMap(f => H.probe(f.filename).streams.map(s => s.codec_name)).sort();
      assert.deepEqual(codecs, ['opus', 'vp9']);
      files.forEach(f => H.decodes(f.filename));
    });
    if (!store) await H.check('bundled FFmpeg WebAssembly worker encodes MP3 inside the extension CSP', async () => {
      const result = await ext(async url => {
        const data = await (await fetch(url)).arrayBuffer();
        const worker = new Worker('youtube/converter-worker.js');
        return new Promise(resolve => {
          worker.onmessage = ({ data }) => { if (data.type === 'done') resolve({ ok: true, bytes: data.data.byteLength, head: [...new Uint8Array(data.data).slice(0, 3)] }); else if (data.type === 'error') resolve({ ok: false, error: data.message }); };
          worker.postMessage({ job: { output: 'mp3', bitrate: 192, tracks: { audio: { mime: 'audio/mpeg' } } }, files: [{ name: 'audio.input', data }] }, [data]);
        });
      }, base + '/tone.mp3');
      assert(result.ok, result.error); assert(result.bytes > 10000);
    });
    await H.check('popup renders the scanner list, details and DRM explanation for the active tab', async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await page.bringToFront();
      await popup.evaluate(() => document.querySelector('#media-tab').click());
      await until(async () => (await popup.locator('.scanner-item').count()) >= 6, 15000, 'popup rows');
      const text = await popup.locator('#media-list').innerText();
      assert.match(text, /Protected – not downloadable/);
      assert.match(text, /180p, 90p/);
      await popup.close();
    });
    console.log(`  (${store ? 'store' : 'full'} build)`);
    H.summary('real Chromium: detection, direct/HLS/DASH downloads, DRM refusal, worker stop, cancel, popup');
  } finally {
    await context.close();
    await server.close();
    for (const d of [dir, downloads, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
