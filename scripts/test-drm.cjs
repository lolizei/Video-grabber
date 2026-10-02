// DRM/encryption detection and graceful rejection. No keys, licenses or encrypted media
// segments may be requested once protection is detected.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

(async () => {
  const ctx = H.vm.createContext({ URL, console, TextDecoder, TextEncoder, Uint8Array });
  for (const f of ['shared/drm.js', 'shared/mp4.js']) H.vm.runInContext(H.read(f), ctx);
  const { DrmTools, Mp4Tools } = ctx;
  await H.check('HLS key tags: FairPlay, Widevine, PlayReady, AES-128 and SAMPLE-AES are classified', () => {
    const fp = DrmTools.hls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key42",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"');
    assert.equal(fp.drm, true); assert.deepEqual([...fp.systems], ['FairPlay']);
    const wv = DrmTools.hls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"');
    assert.deepEqual([...wv.systems], ['Widevine']);
    const pr = DrmTools.hls('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="com.microsoft.playready"');
    assert.deepEqual([...pr.systems], ['PlayReady']);
    const aes = DrmTools.hls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    assert.equal(aes.encrypted, true); assert.equal(aes.drm, false); assert.match(aes.summary, /Encrypted HLS: AES-128/);
    assert.equal(DrmTools.hls('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\na.ts'), null);
    assert.equal(DrmTools.label(fp), 'DRM-protected (FairPlay)');
  });
  await H.check('DASH ContentProtection: Widevine, PlayReady, FairPlay UUIDs and generic CENC', () => {
    const info = DrmTools.dash(`<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
      <ContentProtection schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"/></AdaptationSet></Period></MPD>`);
    assert.deepEqual([...info.systems], ['CENC (cenc)', 'Widevine', 'PlayReady', 'FairPlay']);
    assert.equal(info.drm, true);
    assert.equal(DrmTools.dash('<MPD><Period/></MPD>'), null);
  });
  await H.check('pssh boxes in EME init data identify key systems', () => {
    const pssh = id => { const b = new Uint8Array(32); b[3] = 32; b.set([0x70, 0x73, 0x73, 0x68], 4); id.match(/../g).forEach((h, i) => { b[12 + i] = parseInt(h, 16); }); return b; };
    const both = new Uint8Array(64); both.set(pssh('edef8ba979d64acea3c827dcd51d21ed')); both.set(pssh('9a04f07998404286ab92e65be0885f95'), 32);
    assert.deepEqual([...DrmTools.psshSystems(both)], ['Widevine', 'PlayReady']);
  });

  const dir = H.tempDir('vg-drm-'), out = H.tempDir('vg-drm-out-');
  H.media.cencMp4(dir, 'cenc.mp4');
  H.media.hlsTsMuxed(dir, 'clear');
  await H.check('encrypted MP4 initialization data (encv/enca/tenc) is detected', () => {
    const info = Mp4Tools.inspectInit(fs.readFileSync(path.join(dir, 'cenc.mp4')));
    assert.equal(info.encrypted, true);
    assert.deepEqual([...info.tracks.map(t => t.codec)], ['avc1 (encrypted)', 'mp4a (encrypted)']);
  });
  // Playlists/manifests around the locally encrypted file, without any key signalling.
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'cenc.mp4')));
  const top = Mp4Tools.boxes(bytes);
  const moov = top.find(b => b.type === 'moov'), moof = top.find(b => b.type === 'moof'), mdat = top.find(b => b.type === 'mdat');
  fs.writeFileSync(path.join(dir, 'hidden.m3u8'), `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="cenc.mp4",BYTERANGE="${moov.end}@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:${mdat.end - moof.start}@${moof.start}\ncenc.mp4\n#EXT-X-ENDLIST\n`);
  fs.writeFileSync(path.join(dir, 'hidden.mpd'), `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4">
    <Representation id="v" bandwidth="1" height="180"><BaseURL>cenc.mp4</BaseURL><SegmentList><Initialization range="0-${moov.end - 1}"/>
    <SegmentURL mediaRange="${moof.start}-${mdat.end - 1}"/></SegmentList></Representation></AdaptationSet></Period></MPD>`);
  fs.writeFileSync(path.join(dir, 'widevine.mpd'), `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><SegmentTemplate media="s$Number$.m4s" initialization="i.mp4" duration="1"/>
    <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`);
  fs.writeFileSync(path.join(dir, 'fairplay.m3u8'), '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nclear.m3u8\n');
  // SAMPLE-AES elementary stream types inside a TS PMT (playlist itself does not declare a key).
  for (const name of fs.readdirSync(dir).filter(n => /^clear-\d+\.ts$/.test(n))) {
    const ts = fs.readFileSync(path.join(dir, name));
    for (let o = 0; o + 188 <= ts.length; o += 188) for (let i = o + 4; i < o + 186; i++) if (ts[i] === 0x1b && ts[i + 1] >> 5 === 7) { ts[i] = 0xdb; break; }
    fs.writeFileSync(path.join(dir, name.replace('clear', 'sampleaes')), ts);
  }
  fs.writeFileSync(path.join(dir, 'sampleaes.m3u8'), fs.readFileSync(path.join(dir, 'clear.m3u8'), 'utf8').replace(/clear-/g, 'sampleaes-'));
  const server = await H.serve(dir);
  try {
    const reports = [];
    const runtime = { onMessage: H.event(), async sendMessage(msg) { if (msg.cmd === 'scanner.claim') return { ok: true, result: { id: 'd', item: {}, settings: {} } }; reports.push(msg); return { ok: true }; } };
    for (const [label, mode, file, allowed] of [
      ['DASH with Widevine ContentProtection', 'dash', 'widevine.mpd', ['/widevine.mpd']],
      ['HLS master with a FairPlay session key', 'hls', 'fairplay.m3u8', ['/fairplay.m3u8']],
      ['HLS fMP4 whose init segment is CENC-encrypted', 'hls', 'hidden.m3u8', ['/hidden.m3u8', '/cenc.mp4']],
      ['DASH whose init segment is CENC-encrypted', 'dash', 'hidden.mpd', ['/hidden.mpd', '/cenc.mp4']]]) {
      await H.check(`${label} is rejected before any media segment is requested`, async () => {
        server.requests.length = 0; reports.length = 0;
        const result = await H.runDownloader({ params: { mode, url: server.base + '/' + file, name: 'p.mp4', auto: '1', job: 'd' }, outDir: out, runtime });
        assert.equal(result.saved.length, 0);
        assert.match(result.status, /Protected stream/);
        assert.equal(reports.at(-1).status, 'protected'); assert.equal(reports.at(-1).errorCode, 'protected');
        assert(server.requests.every(r => allowed.includes(r.path)), 'requests: ' + server.requests.map(r => r.path + ' ' + r.range).join(', '));
        if (allowed.includes('/cenc.mp4')) assert(server.requests.filter(r => r.path === '/cenc.mp4').every(r => r.range === `bytes=0-${moov.end - 1}`), 'only the init range was fetched');
      });
    }
    await H.check('SAMPLE-AES elementary streams inside MPEG-TS are rejected instead of saved', async () => {
      reports.length = 0;
      const result = await H.runDownloader({ params: { mode: 'hls', url: server.base + '/sampleaes.m3u8', name: 's.mp4', auto: '1', job: 'd' }, outDir: out, runtime });
      assert.equal(result.saved.length, 0, 'no TS fallback for protected streams');
      assert.match(result.status, /Protected stream: SAMPLE-AES/);
      assert.equal(reports.at(-1).status, 'protected');
    });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }

  // Background: protection details, EME indicators and queue rejection.
  const page = { id: 3, url: 'https://drm.example/' };
  const manifest = '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/></AdaptationSet></Period></MPD>';
  const bg = H.loadBackground({ tabs: new Map([[3, page]]), fetchImpl: async () => new Response(manifest, { headers: { 'content-type': 'application/dash+xml' } }) });
  await bg.send({ cmd: 'scanner.dom', urls: [{ url: 'https://drm.example/stream.mpd' }, { url: 'https://drm.example/live.ism/Manifest' }] }, { tab: page, frameId: 0, url: page.url });
  await H.check('background inspection labels the DRM system and Download refuses protected items', async () => {
    const protection = await bg.request('scanner.inspect', { tabId: 3, url: 'https://drm.example/stream.mpd' });
    assert.equal(protection.status, 'protected'); assert.equal(protection.label, 'DRM-protected (PlayReady)');
    assert.equal((await bg.request('scanner.download', { tabId: 3, urls: ['https://drm.example/stream.mpd'] })).length, 0);
  });
  await H.check('unsupported streaming formats (Smooth Streaming) are reported distinctly from DRM', async () => {
    const protection = await bg.request('scanner.inspect', { tabId: 3, url: 'https://drm.example/live.ism/Manifest' });
    assert.equal(protection.status, 'unsupported'); assert.match(protection.reason, /Smooth Streaming/);
  });
  await H.check('EME "encrypted" events from the page are recorded as a tab-level indicator', async () => {
    await bg.send({ cmd: 'scanner.eme', events: 2, systems: ['Widevine'], initDataTypes: ['cenc'], mediaKeys: 1 }, { tab: page, frameId: 0 });
    const snap = await bg.request('scanner.list', { tabId: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(snap.eme)), { events: 2, systems: ['Widevine'], initDataTypes: ['cenc'], mediaKeys: 1 });
  });
  await H.check('content script reads key systems from encrypted-event init data without touching page APIs', async () => {
    const listeners = {}, sent = [];
    const initData = new Uint8Array(32); initData[3] = 32; initData.set([0x70, 0x73, 0x73, 0x68], 4);
    'edef8ba979d64acea3c827dcd51d21ed'.match(/../g).forEach((h, i) => { initData[12 + i] = parseInt(h, 16); });
    const pageCtx = H.vm.createContext({ URL, console, setTimeout, clearTimeout, location: { href: page.url },
      document: { documentElement: {}, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {}, querySelectorAll: () => [] },
      performance: { getEntriesByType: () => [] }, MutationObserver: class { observe() {} disconnect() {} }, PerformanceObserver: class { observe() {} disconnect() {} },
      chrome: { runtime: { onMessage: H.event(), sendMessage: async msg => { sent.push(msg); } } } });
    H.vm.runInContext(H.read('content/dom-scan.js'), pageCtx);
    listeners.encrypted({ initDataType: 'cenc', initData: initData.buffer });
    const eme = sent.find(m => m.cmd === 'scanner.eme');
    assert.deepEqual([...eme.systems], ['Widevine']); assert.equal(eme.events, 1);
  });
  H.summary('HLS/DASH/MP4/TS/EME DRM indicators, rejection before segment/key requests, unsupported formats');
})().catch(error => { console.error(error); process.exitCode = 1; });
