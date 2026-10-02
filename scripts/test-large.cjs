// Large-file handling: a 400 MB download goes through disk-backed (OPFS-style) storage with
// bounded memory; interrupted segment downloads resume from committed checkpoints; cancel
// releases temporary storage.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

const SIZE = 400 * 1024 * 1024;
const byteAt = i => (i * 31 + (i >>> 11)) & 255;
function fill(start, length) { const b = Buffer.allocUnsafe(length); for (let i = 0; i < length; i++) b[i] = byteAt(start + i); return b; }
function bigServer() {
  const server = http.createServer((req, res) => {
    const m = (req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}) });
    let pos = start;
    const pump = () => { while (pos <= end) { const n = Math.min(256 * 1024, end - pos + 1); const ok = res.write(fill(pos, n)); pos += n; if (!ok) return res.once('drain', pump); } res.end(); };
    pump();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
function expectedHash() { const h = crypto.createHash('sha256'); for (let p = 0; p < SIZE; p += 8 << 20) h.update(fill(p, Math.min(8 << 20, SIZE - p))); return h.digest('hex'); }
const fileHash = file => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });

(async () => {
  const out = H.tempDir('vg-large-out-');
  const opfs = H.tempDir('vg-large-opfs-');
  const { server, base } = await bigServer();
  try {
    await H.check('400 MB download is staged on disk with bounded memory and a byte-exact result', async () => {
      if (global.gc) global.gc();
      const baseline = process.memoryUsage();
      let peakBuffers = 0, peakRss = 0;
      const sampler = setInterval(() => { const m = process.memoryUsage(); peakBuffers = Math.max(peakBuffers, m.arrayBuffers - baseline.arrayBuffers); peakRss = Math.max(peakRss, m.rss - baseline.rss); }, 20);
      const result = await H.runDownloader({ params: { mode: 'file', url: base + '/big.bin', name: 'big.bin' }, outDir: out, storageDir: opfs });
      clearInterval(sampler);
      assert.equal(result.saved.length, 1, result.status + result.log);
      assert.equal(fs.statSync(result.saved[0].file).size, SIZE);
      assert.equal(await fileHash(result.saved[0].file), expectedHash());
      const mb = n => Math.round(n / 1048576);
      console.log(`    peak extra ArrayBuffer memory ${mb(peakBuffers)} MB, peak extra RSS ${mb(peakRss)} MB for a ${mb(SIZE)} MB file`);
      assert(peakBuffers < 200 * 1048576, 'ArrayBuffer memory stayed bounded');
      assert(!/browser memory/.test(result.log), 'used disk-backed storage');
      const leftovers = fs.readdirSync(path.join(opfs, 'vg-jobs'));
      assert.equal(leftovers.length, 0, 'temporary storage released: ' + leftovers.join(','));
      assert.deepEqual(Object.keys(result.local).filter(k => k.startsWith('vg_ckpt_')), [], 'checkpoint removed after success');
      fs.rmSync(result.saved[0].file);
    });

    const dir = H.tempDir('vg-resume-');
    H.media.hlsTsMuxed(dir, 'long', 20);
    let failing = true;
    const fixture = await H.serve(dir, { hooks: { '/long-12.ts': (req, res) => { if (failing) { res.writeHead(404).end(); return true; } } } });
    try {
      await H.check('an interrupted HLS download resumes from its checkpoint without refetching completed segments', async () => {
        const local = {};
        const params = { mode: 'hls', url: fixture.base + '/long.m3u8', name: 'long.mp4', auto: '1' };
        const first = await H.runDownloader({ params, outDir: out, storageDir: opfs, local, config: { TEMP_CHUNK_BYTES: 1 } });
        assert.equal(first.saved.length, 0); assert.match(first.status, /404/);
        const ckpt = Object.entries(local).find(([k]) => k.startsWith('vg_ckpt_'));
        assert(ckpt, 'checkpoint persisted');
        const done = ckpt[1].tracks.video.segEnd;
        assert(done >= 8 && done < 12, 'committed through segment ' + done);
        failing = false;
        fixture.requests.length = 0;
        const second = await H.runDownloader({ params, outDir: out, storageDir: opfs, local, config: { TEMP_CHUNK_BYTES: 1 } });
        assert.equal(second.saved.length, 1, second.status + second.log);
        assert.match(second.log, new RegExp('Resuming video at segment ' + (done + 2)));
        const fetched = fixture.requests.filter(r => /long-\d+\.ts/.test(r.path)).map(r => Number(r.path.match(/(\d+)\.ts/)[1]));
        assert(fetched.every(n => n > done), 'only remaining segments fetched: ' + fetched.join(','));
        const info = H.probe(second.saved[0].file);
        assert(Math.abs(Number(info.format.duration) - 20) < 0.5, 'complete 20 s output, got ' + info.format.duration);
        H.decodes(second.saved[0].file);
        assert(!Object.keys(local).some(k => k.startsWith('vg_ckpt_')), 'checkpoint cleared');
      });
      await H.check('a changed playlist invalidates the checkpoint instead of mixing data', async () => {
        const local = {};
        failing = true;
        await H.runDownloader({ params: { mode: 'hls', url: fixture.base + '/long.m3u8', name: 'l.mp4', auto: '1' }, outDir: out, storageDir: opfs, local, config: { TEMP_CHUNK_BYTES: 1 } });
        failing = false;
        const text = fs.readFileSync(path.join(dir, 'long.m3u8'), 'utf8');
        fs.writeFileSync(path.join(dir, 'long.m3u8'), text.replace(/#EXTINF:[\d.]+,\nlong-19\.ts\n/, ''));
        const result = await H.runDownloader({ params: { mode: 'hls', url: fixture.base + '/long.m3u8', name: 'l.mp4', auto: '1' }, outDir: out, storageDir: opfs, local, config: { TEMP_CHUNK_BYTES: 1 } });
        assert.equal(result.saved.length, 1); assert(!/Resuming/.test(result.log));
        fs.writeFileSync(path.join(dir, 'long.m3u8'), text);
      });
      await H.check('cancelling a running download stops requests, releases storage and never saves', async () => {
        const slow = await H.serve(dir, { hooks: { '*': async () => { await H.settle(250); } } });
        try {
          const reports = [];
          const onMessage = H.event();
          const runtime = { onMessage, async sendMessage(msg) { if (msg.cmd === 'scanner.claim') return { ok: true, result: { id: 'c1', item: {}, settings: {} } }; reports.push(msg); return { ok: true }; } };
          const running = H.runDownloader({ params: { mode: 'hls', url: slow.base + '/long.m3u8', name: 'c.mp4', auto: '1', job: 'c1' }, outDir: out, storageDir: opfs, runtime, config: { TEMP_CHUNK_BYTES: 1 } });
          await H.settle(900);
          let reply;
          onMessage.listeners[0]({ cmd: 'downloader.control', id: 'c1', action: 'pause' }, {}, r => { reply = r; });
          assert.equal(reply.paused, true);
          await H.settle(400);
          const before = slow.requests.length;
          await H.settle(700);
          assert(slow.requests.length - before <= 4, 'paused: only in-flight requests finish');
          onMessage.listeners[0]({ cmd: 'downloader.control', id: 'c1', action: 'cancel' }, {}, () => {});
          const result = await running;
          const after = slow.requests.length;
          await H.settle(300);
          assert.equal(slow.requests.length, after, 'no requests after cancellation');
          assert.equal(result.saved.length, 0);
          assert.equal(result.status, 'Cancelled');
          assert.equal(reports.at(-1).status, 'cancelled');
          assert(reports.some(r => r.paused), 'paused state reported');
          assert.equal(fs.readdirSync(path.join(opfs, 'vg-jobs')).length, 0, 'storage released');
        } finally { await slow.close(); }
      });
    } finally { await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    H.summary('disk-backed large downloads with bounded memory, checkpoint resume, invalidation, pause and cancellation cleanup');
  } finally {
    server.closeAllConnections?.(); server.close();
    fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(opfs, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
