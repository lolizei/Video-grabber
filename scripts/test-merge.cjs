// Separate audio/video merging (fragmented MP4 muxer): absolute base_data_offset rewriting,
// different movie timescales, start-time normalization, interleaving and validation.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

(async () => {
  const dir = H.tempDir('vg-merge-');
  const ctx = H.vm.createContext({ console, TextDecoder, TextEncoder, Uint8Array, DOMException });
  for (const f of ['shared/drm.js', 'shared/mp4.js']) H.vm.runInContext(H.read(f), ctx);
  const { Mp4Tools } = ctx;
  const blob = file => fs.openAsBlob(path.join(dir, file));
  async function merge(files, name, options) {
    const out = fs.openSync(path.join(dir, name), 'w');
    const result = await Mp4Tools.merge(await Promise.all(files.map(blob)), { async write(b) { fs.writeSync(out, b); } }, options);
    fs.closeSync(out);
    return result;
  }
  try {
    // Absolute offsets (no default-base-is-moof), offset start times and a 600-unit movie timescale.
    H.ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25',
      '-output_ts_offset', '10', '-movflags', 'frag_keyframe+empty_moov', 'v.mp4'], dir);
    H.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:a', 'aac', '-output_ts_offset', '10.2',
      '-movie_timescale', '600', '-frag_duration', '500000', '-movflags', 'empty_moov', 'a.mp4'], dir);
    // ffmpeg normalizes fragment times, so shift the tfdt of every fragment like a live/HLS source would.
    const shift = (file, seconds) => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, file)));
      const moov = Mp4Tools.boxes(bytes).find(b => b.type === 'moov');
      const timescale = Mp4Tools.parseMoov(bytes.subarray(moov.start, moov.end)).tracks[0].timescale;
      const view = new DataView(bytes.buffer);
      for (const moof of Mp4Tools.boxes(bytes).filter(b => b.type === 'moof')) {
        const traf = Mp4Tools.boxes(bytes, moof.start + 8, moof.end).find(b => b.type === 'traf');
        const tfdt = Mp4Tools.boxes(bytes, traf.start + 8, traf.end).find(b => b.type === 'tfdt');
        const q = tfdt.start + 8, add = Math.round(seconds * timescale);
        if (bytes[q] === 1) view.setBigUint64(q + 4, view.getBigUint64(q + 4) + BigInt(add)); else view.setUint32(q + 4, view.getUint32(q + 4) + add);
      }
      fs.writeFileSync(path.join(dir, file), bytes);
    };
    shift('v.mp4', 10); shift('a.mp4', 10.2);
    await H.check('tracks with absolute data offsets and different movie timescales merge into a decodable MP4', async () => {
      const result = await merge(['v.mp4', 'a.mp4'], 'av.mp4');
      assert.deepEqual([...result.tracks.map(t => t.kind)], ['video', 'audio']);
      assert(result.tracks.every(t => t.fragments >= 3), JSON.stringify(result.tracks));
      const info = H.probe(path.join(dir, 'av.mp4'));
      assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
      H.decodes(path.join(dir, 'av.mp4'));
      const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
      assert(Number(video.start_time) < 0.5, 'normalized start ' + video.start_time);
      const offset = Number(audio.start_time) - Number(video.start_time);
      assert(Math.abs(offset - 0.2) < 0.1, 'relative audio offset preserved: ' + offset);
    });
    await H.check('fragments are interleaved by decode time', async () => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'av.mp4')));
      const order = [];
      for (const box of Mp4Tools.boxes(bytes).filter(b => b.type === 'moof')) {
        const traf = Mp4Tools.boxes(bytes, box.start + 8, box.end).find(b => b.type === 'traf');
        const tfhd = Mp4Tools.boxes(bytes, traf.start + 8, traf.end).find(b => b.type === 'tfhd');
        order.push(bytes[tfhd.start + 15]);
      }
      assert(order.indexOf(2) < order.lastIndexOf(1), 'audio fragments appear before the last video fragment: ' + order.join(''));
    });
    await H.check('normalization can be disabled to keep original timestamps', async () => {
      await merge(['v.mp4', 'a.mp4'], 'raw.mp4', { normalize: false });
      const video = H.probe(path.join(dir, 'raw.mp4')).streams.find(s => s.codec_type === 'video');
      assert(Number(video.start_time) >= 9.9, 'original start ' + video.start_time);
    });
    await H.check('validation catches missing tracks, empty files and non-fragmented inputs', async () => {
      assert.equal((await Mp4Tools.validate(await blob('av.mp4'), { expectKinds: ['video', 'audio'] })).ok, true);
      const onlyVideo = await Mp4Tools.validate(await blob('v.mp4'), { expectKinds: ['video', 'audio'] });
      assert.equal(onlyVideo.ok, false); assert.match(onlyVideo.reason, /no audio track/);
      assert.equal((await Mp4Tools.validate(new Blob([]))).ok, false);
      H.ffmpeg(['-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:a', 'aac', 'progressive.m4a'], dir);
      await assert.rejects(merge(['progressive.m4a'], 'x.mp4'), /progressive/);
      fs.writeFileSync(path.join(dir, 'truncated.mp4'), fs.readFileSync(path.join(dir, 'v.mp4')).subarray(0, 3000));
      await assert.rejects(merge(['truncated.mp4'], 'y.mp4'), /Truncated|Corrupt/);
    });
    H.summary('fMP4 merging: absolute offsets, timescale rescaling, normalization, interleaving, validation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
