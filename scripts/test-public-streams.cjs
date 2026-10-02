// OPTIONAL network test against publicly available, authorized test streams.
// Run with:  node scripts/test-public-streams.cjs
// For each stream it parses the real manifest, picks the lowest quality, downloads only the
// first few segments of each track with the production engine and verifies the merged result
// with ffprobe. It is skipped automatically when the network is unavailable.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

const STREAMS = [
  { label: 'Apple HLS fMP4 example (separate audio)', kind: 'hls', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
  { label: 'Mux HLS test stream (MPEG-TS)', kind: 'hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { label: 'DASH-IF / Akamai Big Buck Bunny ($Number$ template)', kind: 'dash', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
  { label: 'Shaka demo "Angel One" DASH', kind: 'dash', url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd' }
];
const ctx = H.vm.createContext({ URL, URLSearchParams, console, TextDecoder, TextEncoder, Uint8Array, Blob, Response, Headers, AbortController, AbortSignal,
  DOMException, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto, atob, btoa, fetch });
for (const f of H.SHARED) H.vm.runInContext(H.read(f), ctx);
const { DownloadEngine: E, HlsTools, DashTools, Mp4Tools, DrmTools } = ctx;
const SEGMENTS = 3;

async function text(url) { const r = await E.fetchBytes(url, { expectMedia: false, retries: 2 }); return { text: new TextDecoder().decode(r.bytes), url: r.url || url }; }
async function track({ init, segments, container }) {
  const sink = new E.MemorySink();
  if (init) {
    const bytes = (await E.fetchBytes(init.url, { range: init.range, retries: 2 })).bytes;
    if (container === 'fmp4') Mp4Tools.assertClear(Mp4Tools.inspectInit(bytes));
    await sink.write(bytes);
  }
  await E.downloadSegments({ segments: segments.slice(0, SEGMENTS), sink, concurrency: 3, fetchOptions: { retries: 2 } });
  return sink;
}
async function convertTs(blob) {
  const worker = new H.TsWorker('ts-converter.js');
  const parts = [];
  await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => { if (data.blob) { parts.push(data.blob); resolve(); } else if (data.error) reject(new Error(data.error)); };
    blob.arrayBuffer().then(buffer => worker.postMessage([buffer]));
  });
  return parts[0];
}

(async () => {
  try {
    const probe = await fetch(STREAMS[0].url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!probe.ok) throw new Error('HTTP ' + probe.status + ' from the network/proxy');
  } catch (error) { console.log('SKIPPED: public test streams are not reachable from this environment (' + error.message + '). Nothing was verified.'); return; }
  const out = H.tempDir('vg-public-');
  let failures = 0;
  for (const stream of STREAMS) {
    try {
      await H.check(stream.label, async () => {
        const tracks = [];
        if (stream.kind === 'hls') {
          let { text: body, url } = await text(stream.url);
          assert.equal(DrmTools.hls(body), null);
          let audio = null;
          if (HlsTools.isMaster(body)) {
            const master = HlsTools.parseMaster(body, url);
            const lowest = master.variants.filter(v => v.height).at(-1) || master.variants.at(-1);
            const pick = HlsTools.select(master, { url: lowest.url });
            ({ text: body, url } = await text(pick.variant.url));
            if (pick.audio) { const a = await text(pick.audio.url); audio = HlsTools.parseMedia(a.text, a.url); }
          }
          const video = HlsTools.parseMedia(body, url);
          tracks.push({ role: 'video', ...video });
          if (audio) tracks.push({ role: 'audio', ...audio });
        } else {
          const { text: body, url } = await text(stream.url);
          assert.equal(DrmTools.dash(body), null);
          const manifest = DashTools.parse(body, url);
          const lowest = manifest.representations.filter(r => r.kind === 'video' && !r.error).sort((a, b) => a.height - b.height)[0];
          const pick = DashTools.select(manifest, { id: lowest.id });
          for (const [role, rep] of [['video', pick.video], ['audio', pick.audio]]) if (rep) tracks.push({ role, container: rep.container === 'webm' ? 'webm' : 'fmp4', init: rep.segments.init, segments: rep.segments.media });
        }
        const sources = [];
        for (const t of tracks) {
          const sink = await track(t);
          const blob = await sink.blob();
          sources.push(t.container === 'fmp4' ? blob : await convertTs(blob));
        }
        const file = path.join(out, stream.label.replace(/\W+/g, '_') + '.mp4');
        const fd = fs.openSync(file, 'w');
        await Mp4Tools.merge(sources, { async write(b) { fs.writeSync(fd, b); } });
        fs.closeSync(fd);
        const info = H.probe(file);
        assert(info.streams.some(s => s.codec_type === 'video'));
        if (tracks.length > 1 || tracks[0].container === 'ts') assert(info.streams.some(s => s.codec_type === 'audio'), 'audio present');
        H.decodes(file);
        console.log(`    ${tracks.map(t => t.role + ' ' + t.segments.length + ' segments').join(', ')}; verified first ${SEGMENTS} each: ${info.streams.map(s => s.codec_name + (s.height ? ' ' + s.height + 'p' : '')).join(' + ')}`);
      });
    } catch (error) { failures++; console.log('  ✗ ' + stream.label + ': ' + error.message); }
  }
  fs.rmSync(out, { recursive: true, force: true });
  if (failures) process.exitCode = 1;
  else H.summary('public authorized test streams (partial downloads)');
})().catch(error => { console.error(error); process.exitCode = 1; });
