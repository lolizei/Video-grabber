// MPEG-DASH manifest parsing and end-to-end downloads of generated DASH streams.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;
const plain = v => JSON.parse(JSON.stringify(v));

(async () => {
  const dir = H.tempDir('vg-dash-');
  const out = H.tempDir('vg-dash-out-');
  const ctx = H.vm.createContext({ URL, console, TextDecoder, TextEncoder, Uint8Array });
  for (const f of ['shared/drm.js', 'shared/xml.js', 'shared/hls.js', 'shared/dash.js']) H.vm.runInContext(H.read(f), ctx);
  const { DashTools, XmlTools } = ctx;
  let server;
  try {
    await H.check('XML reader: namespaces, entities, comments, CDATA', () => {
      const doc = XmlTools.parse('<?xml version="1.0"?><!-- c --><a:MPD xmlns:a="x" t="1 &amp; 2"><B><![CDATA[x<y]]></B><C v=\'q\'/></a:MPD>');
      const mpd = XmlTools.child(doc, 'MPD');
      assert.equal(mpd.attrs.t, '1 & 2'); assert.equal(XmlTools.child(mpd, 'B').text, 'x<y'); assert.equal(XmlTools.child(mpd, 'C').attrs.v, 'q');
    });
    await H.check('SegmentTemplate with SegmentTimeline ($Time$, r=-1), BaseURL hierarchy, $Number%05d$', () => {
      const m = DashTools.parse(`<MPD type="static" mediaPresentationDuration="PT10S"><BaseURL>https://cdn.example/root/</BaseURL>
        <Period duration="PT10S"><BaseURL>p1/</BaseURL>
          <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/t$Time$.m4s">
            <SegmentTimeline><S t="0" d="4000" r="-1"/></SegmentTimeline></SegmentTemplate>
            <Representation id="v1" bandwidth="1000000" width="1280" height="720" codecs="avc1.64001f"/>
            <Representation id="v2" bandwidth="300000" width="640" height="360" codecs="avc1.4d401e"><BaseURL>low/</BaseURL></Representation>
          </AdaptationSet>
          <AdaptationSet contentType="audio" lang="de" mimeType="audio/mp4"><Label>Deutsch</Label>
            <SegmentTemplate timescale="48000" duration="96000" startNumber="5" initialization="a/init.mp4" media="a/$Number%05d$.m4s"/>
            <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"><AudioChannelConfiguration value="2"/></Representation>
          </AdaptationSet></Period></MPD>`, 'https://origin.example/manifest.mpd');
      const [v1, v2, a1] = m.representations;
      assert.equal(v1.segments.init.url, 'https://cdn.example/root/p1/v1/init.mp4');
      assert.deepEqual(plain(v1.segments.media.map(s => s.url.split('/').pop())), ['t0.m4s', 't4000.m4s', 't8000.m4s']);
      assert.equal(v2.segments.media[0].url, 'https://cdn.example/root/p1/low/v2/t0.m4s');
      assert.equal(a1.segments.media.length, 5);
      assert.equal(a1.segments.media[0].url, 'https://cdn.example/root/p1/a/00005.m4s');
      assert.equal(a1.lang, 'de'); assert.equal(a1.label, 'Deutsch'); assert.equal(a1.audioChannels, '2');
      const pick = DashTools.select(m, { height: 360 });
      assert.equal(pick.video.id, 'v2'); assert.equal(pick.audio.id, 'a1');
      assert.equal(DashTools.select(m, {}).video.id, 'v1');
      const summary = DashTools.summary(m);
      assert.equal(summary.variants.length, 2); assert.equal(summary.audio[0].lang, 'de');
    });
    await H.check('SegmentList, SegmentBase, multi-period concatenation, live/number limits', () => {
      const list = DashTools.parse(`<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4">
        <Representation id="r" bandwidth="1" height="240"><BaseURL>file.mp4</BaseURL><SegmentList><Initialization range="0-99"/>
        <SegmentURL mediaRange="100-199"/><SegmentURL media="other.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>`, 'https://h.example/x/m.mpd');
      const r = list.representations[0];
      assert.equal(r.segments.init.url, 'https://h.example/x/file.mp4'); assert.deepEqual(plain([...r.segments.init.range]), [0, 99]);
      assert.deepEqual(plain([...r.segments.media[0].range]), [100, 199]); assert.equal(r.segments.media[1].url, 'https://h.example/x/other.m4s');
      const base = DashTools.parse(`<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="audio/mp4">
        <Representation id="a" bandwidth="1"><BaseURL>audio.mp4</BaseURL><SegmentBase indexRange="800-900"/></Representation></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
      assert.equal(base.representations[0].segments.single, true); assert.equal(base.representations[0].segments.addressing, 'SegmentBase');
      const periods = DashTools.parse(`<MPD mediaPresentationDuration="PT4S"><Period duration="PT2S"><AdaptationSet mimeType="video/mp4">
        <SegmentTemplate timescale="1" duration="1" initialization="init.mp4" media="p1-$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>
        <Period duration="PT2S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="1" initialization="init.mp4" media="p2-$Number$.m4s"/>
        <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
      assert.equal(periods.periods, 2);
      assert.deepEqual(plain(periods.representations[0].segments.media.map(s => s.url.split('/').pop())), ['p1-1.m4s', 'p1-2.m4s', 'p2-1.m4s', 'p2-2.m4s']);
      const live = DashTools.parse(`<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="$Number$.m4s"/>
        <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`, 'https://h.example/m.mpd');
      assert.match(live.representations[0].error, /Live DASH/);
      assert.throws(() => DashTools.select(live), /Live DASH/);
      assert.equal(DashTools.isoDuration('PT1H2M3.5S'), 3723.5);
    });

    H.media.dash(dir, 'tl');
    H.media.dash(dir, 'num', ['-use_timeline', '0']);
    H.media.dash(dir, 'single', ['-single_file', '1']);
    H.media.dashWebm(dir, 'wm');
    // Hand-written SegmentBase manifest over the single-file representations.
    fs.writeFileSync(path.join(dir, 'base.mpd'), `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
      <Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="50000" width="320" height="180" codecs="avc1.64000c">
      <BaseURL>single-stream0.mp4</BaseURL><SegmentBase indexRange="816-867"><Initialization range="0-815"/></SegmentBase></Representation></AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a" bandwidth="69000" codecs="mp4a.40.2"><BaseURL>single-stream2.mp4</BaseURL>
      <SegmentBase/></Representation></AdaptationSet></Period></MPD>`);
    server = await H.serve(dir);
    const verify = (file, height) => {
      const info = H.probe(file);
      const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
      assert.equal(video?.codec_name, 'h264'); assert.equal(audio?.codec_name, 'aac');
      if (height) assert.equal(video.height, height);
      assert(Math.abs(Number(info.format.duration) - 4) < 0.35, 'duration ' + info.format.duration);
      H.decodes(file);
    };
    for (const [name, label, height, sel] of [['tl', 'SegmentTimeline', 180], ['num', '$Number$ duration template', 90, { id: '1' }], ['single', 'SegmentList with byte ranges', 180], ['base', 'SegmentBase single files', 180]]) {
      await H.check(`${label}: downloads video+audio representations and merges into MP4`, async () => {
        const result = await H.runDownloader({ params: { mode: 'dash', url: server.base + '/' + name + '.mpd', name: name + '.mp4', auto: '1', ...(sel ? { sel: JSON.stringify(sel) } : {}) },
          outDir: out, storageDir: H.tempDir('vg-opfs-') });
        assert.equal(result.saved.length, 1, result.status + '\n' + result.log);
        verify(result.saved[0].file, height);
        assert.match(result.status, /Done/);
      });
    }
    await H.check('quality selection by representation id downloads only that representation', async () => {
      server.requests.length = 0;
      await H.runDownloader({ params: { mode: 'dash', url: server.base + '/tl.mpd', name: 'q.mp4', auto: '1', sel: JSON.stringify({ id: '1' }) }, outDir: out });
      assert(server.requests.some(r => r.path.startsWith('/tl-1-')));
      assert(!server.requests.some(r => r.path.startsWith('/tl-0-')));
    });
    await H.check('WebM DASH without FFmpeg (store build) saves playable separate audio and video files', async () => {
      const result = await H.runDownloader({ params: { mode: 'dash', url: server.base + '/wm.mpd', name: 'wm.webm', auto: '1' }, outDir: out, config: { ENABLE_YOUTUBE: false } });
      assert.equal(result.saved.length, 2, result.status + '\n' + result.log);
      const files = result.saved.map(s => s.file).sort();
      assert.match(files[0], /\[audio\]\.webm$/); assert.match(files[1], /\[video\]\.webm$/);
      assert.equal(H.probe(files[0]).streams[0].codec_name, 'opus');
      assert.equal(H.probe(files[1]).streams[0].codec_name, 'vp9');
      files.forEach(H.decodes);
      assert.match(result.log, /separate files/);
    });
    await H.check('unprotected DASH manifest-only mode still works', async () => {
      fs.writeFileSync(path.join(dir, 'empty.mpd'), '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period/></MPD>');
      const result = await H.runDownloader({ params: { mode: 'manifest', url: server.base + '/empty.mpd', name: 'empty.mpd' }, outDir: out });
      assert.equal(result.saved.length, 1); assert.match(fs.readFileSync(result.saved[0].file, 'utf8'), /<MPD/);
    });
    H.summary('DASH parsing (Template/Timeline/List/Base, multi-period, live limits), downloads, merging, quality selection, WebM fallback');
  } finally {
    await server?.close();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
