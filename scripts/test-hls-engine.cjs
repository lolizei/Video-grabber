// HLS master/media playlist parsing and end-to-end downloads of generated streams:
// fMP4 with separate audio, MPEG-TS with separate audio, quality selection, init segments.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

(async () => {
  const dir = H.tempDir('vg-hls-engine-');
  const out = H.tempDir('vg-hls-out-');
  const ctx = H.vm.createContext({ URL, console, TextDecoder, TextEncoder, Uint8Array });
  for (const f of ['shared/drm.js', 'shared/hls.js']) H.vm.runInContext(H.read(f), ctx);
  const { HlsTools } = ctx;
  let server;
  try {
    await H.check('master playlist: variants, codecs, resolution, audio groups, I-frame streams', () => {
      const master = HlsTools.parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",LANGUAGE="de",URI="audio/de.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="EN",URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=25,AUDIO="aac"
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"
https://cdn.example/v720.m3u8?sig=1
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"
audio-only.m3u8`, 'https://media.example/path/master.m3u8');
      assert.equal(master.variants.length, 3);
      assert.equal(master.variants[0].height, 720);
      assert.equal(master.variants[0].url, 'https://cdn.example/v720.m3u8?sig=1');
      assert.equal(master.variants[1].videoCodec, 'avc1.4d401e');
      assert.equal(master.variants[1].frameRate, 25);
      assert.equal(master.variants.at(-1).audioOnly, true);
      assert.equal(master.audio.length, 2);
      assert.equal(master.audio[0].url, 'https://media.example/path/audio/en.m3u8');
      assert.equal(master.audio[0].codec, 'mp4a.40.2');
      assert.equal(master.iframes.length, 1);
      const pick = HlsTools.select(master, { height: 360 });
      assert.equal(pick.variant.height, 360); assert.equal(pick.audio.language, 'en');
      assert.equal(HlsTools.select(master, { height: 720, audio: 'de' }).audio.name, 'Deutsch');
      assert.equal(HlsTools.select(master, { height: 540 }).variant.height, 360, 'falls back to the next lower quality');
      assert.equal(HlsTools.select(master, {}).variant.height, 720, 'best quality by default');
    });
    await H.check('media playlist: durations, init map, byte ranges, discontinuities, live detection', () => {
      const media = HlsTools.parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@700
media.mp4
#EXTINF:3.5,
#EXT-X-BYTERANGE:900
media.mp4
#EXT-X-DISCONTINUITY
#EXTINF:2,
seg3.m4s`, 'https://m.example/a/b.m3u8');
      assert.equal(media.segments.length, 3);
      assert.deepEqual([...media.init.range], [0, 699]);
      assert.deepEqual([...media.segments[1].range], [1700, 2599]);
      assert.equal(media.segments[2].discontinuity, true);
      assert.equal(media.segments[0].sequence, 10);
      assert.equal(media.container, 'fmp4');
      assert.equal(media.live, true);
      assert.equal(media.duration, 9.5);
      const vod = HlsTools.parseMedia('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', 'https://m.example/x.m3u8');
      assert.equal(vod.container, 'ts'); assert.equal(vod.live, false);
      assert.throws(() => HlsTools.parseMedia('#EXTM3U\n#EXT-X-MAP:URI="a.mp4"\nx.m4s\n#EXT-X-MAP:URI="b.mp4"\ny.m4s', 'https://m.example/x.m3u8'), /initialization segment changes/);
    });

    H.media.hlsFmp4Separate(dir);
    H.media.hlsTsSeparate(dir);
    H.media.hlsTsMuxed(dir);
    server = await H.serve(dir);

    await H.check('fMP4 HLS with separate audio rendition merges into one MP4 (best quality)', async () => {
      const result = await H.runDownloader({ params: { mode: 'hls', url: server.base + '/fmp4-master.m3u8', name: 'fmp4.mp4', auto: '1' }, outDir: out, storageDir: H.tempDir('vg-opfs-') });
      assert.equal(result.saved.length, 1, result.status + '\n' + result.log);
      const info = H.probe(result.saved[0].file);
      const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264'); assert.equal(video.height, 180);
      assert.equal(audio.codec_name, 'aac');
      assert(Math.abs(Number(info.format.duration) - 4) < 0.3, 'duration ' + info.format.duration);
      H.decodes(result.saved[0].file);
      assert(result.requests.some(u => u.includes('fmp4-init-English.mp4')), 'audio init segment requested');
      assert(result.requests.filter(u => u.includes('fmp4-0-')).length >= 4, 'video segments requested');
      assert(!result.requests.some(u => u.includes('fmp4-1-')), 'unselected quality not downloaded');
      assert.match(result.status, /Done/);
    });
    await H.check('quality selection picks the 90p variant and still merges audio', async () => {
      const result = await H.runDownloader({ params: { mode: 'hls', url: server.base + '/fmp4-master.m3u8', name: 'low.mp4', auto: '1', sel: JSON.stringify({ height: 90 }) }, outDir: out });
      const info = H.probe(result.saved[0].file);
      assert.equal(info.streams.find(s => s.codec_type === 'video').height, 90);
      assert(info.streams.some(s => s.codec_type === 'audio'));
      assert(!result.requests.some(u => u.includes('fmp4-0-')));
    });
    await H.check('MPEG-TS HLS with separate audio: transmux both tracks, merge, keep sync', async () => {
      const result = await H.runDownloader({ params: { mode: 'hls', url: server.base + '/ts-master.m3u8', name: 'ts.mp4', auto: '1' }, outDir: out, storageDir: H.tempDir('vg-opfs-') });
      assert.equal(result.saved.length, 1, result.status + '\n' + result.log);
      assert.match(result.saved[0].file, /\.mp4$/);
      const info = H.probe(result.saved[0].file);
      assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
      const starts = info.streams.map(s => Number(s.start_time));
      assert(Math.abs(starts[0] - starts[1]) < 0.15, 'audio/video start offset ' + starts.join(' vs '));
      assert(Math.abs(Number(info.format.duration) - 4) < 0.3);
      H.decodes(result.saved[0].file);
    });
    await H.check('muxed MPEG-TS HLS remuxes to MP4 (existing behavior preserved)', async () => {
      const result = await H.runDownloader({ params: { mode: 'hls', url: server.base + '/muxed.m3u8', name: 'muxed.mp4', auto: '1' }, outDir: out });
      const info = H.probe(result.saved[0].file);
      assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
      H.decodes(result.saved[0].file);
    });
    await H.check('segments are written in playlist order despite out-of-order completion', async () => {
      const slow = await H.serve(dir, { hooks: { '*': async (req) => { if (/ts-0-0\.ts/.test(req.url)) await H.settle(300); } } });
      try {
        const result = await H.runDownloader({ params: { mode: 'hls', url: slow.base + '/ts-0.m3u8', name: 'order.mp4', auto: '1' }, outDir: out });
        const order = slow.requests.filter(r => /ts-0-\d\.ts/.test(r.path)).map(r => r.path);
        assert.equal(order[0], '/ts-0-0.ts');
        assert.equal(result.saved.length, 1);
        H.decodes(result.saved[0].file);
        const info = H.probe(result.saved[0].file);
        assert(Math.abs(Number(info.format.duration) - 4) < 0.3, 'all segments present in order');
      } finally { await slow.close(); }
    });
    H.summary('HLS master/media parsing, fMP4/TS separate-audio merging, quality selection, ordered segments');
  } finally {
    await server?.close();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
