// Download engine: retries with exponential backoff, Retry-After, non-retryable failures,
// ordered concurrent segments, concurrency limits, pause/resume, cancellation and metering.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');

const ctx = H.vm.createContext({ URL, ReadableStream, console, TextDecoder, TextEncoder, Uint8Array, Blob, Response, Headers, AbortController, AbortSignal,
  DOMException, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto, atob, btoa });
for (const f of H.SHARED) H.vm.runInContext(H.read(f), ctx);
const E = ctx.DownloadEngine;
const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);
const respond = (status, body = bytes(4), headers = {}) => new Response(body, { status, headers: { 'content-type': 'video/mp4', ...headers } });
const fast = { baseDelay: 5, maxDelay: 20, random: () => 0.5 };

(async () => {
  await H.check('exponential backoff with jitter bounds and Retry-After', () => {
    assert.equal(E.backoff(1, { baseDelay: 500, random: () => 0.5 }), 500);
    assert.equal(E.backoff(3, { baseDelay: 500, random: () => 0.5 }), 2000);
    assert.equal(E.backoff(10, { baseDelay: 500, maxDelay: 15000, random: () => 0.5 }), 15000);
    assert(E.backoff(2, { baseDelay: 500, random: () => 0 }) === 750 && E.backoff(2, { baseDelay: 500, random: () => 0.999 }) <= 1250);
    assert.equal(E.backoff(1, { retryAfter: 3 }), 3000);
  });
  await H.check('transient 503/429/network failures are retried until success', async () => {
    let calls = 0; const retries = [];
    const result = await E.fetchBytes('https://cdn.test/seg.ts', { ...fast, retries: 4, onRetry: r => retries.push(r.error.code),
      fetchImpl: async () => { calls++; if (calls === 1) return respond(503); if (calls === 2) return respond(429, undefined, { 'retry-after': '0' }); if (calls === 3) throw new TypeError('Failed to fetch'); return respond(200, bytes(10)); } });
    assert.equal(calls, 4); assert.equal(result.bytes.length, 10);
    assert.deepEqual([...retries], ['http', 'http', 'network']);
  });
  await H.check('non-retryable 401/403/404/HTML responses fail immediately with a category', async () => {
    for (const [status, code, headers] of [[401, 'auth'], [403, 'auth'], [404, 'not-found'], [200, 'auth', { 'content-type': 'text/html' }]]) {
      let calls = 0;
      await assert.rejects(E.fetchBytes('https://cdn.test/a.mp4', { ...fast, retries: 4, fetchImpl: async () => { calls++; return respond(status, bytes(4), headers); } }),
        error => error.code === code);
      assert.equal(calls, 1, 'no retry for ' + status);
    }
  });
  await H.check('retries are exhausted and reported', async () => {
    let calls = 0;
    await assert.rejects(E.fetchBytes('https://cdn.test/x.ts', { ...fast, retries: 2, fetchImpl: async () => { calls++; return respond(500); } }), /HTTP 500/);
    assert.equal(calls, 3);
  });
  await H.check('incomplete range responses are detected and retried', async () => {
    let calls = 0;
    const result = await E.fetchBytes('https://cdn.test/f.mp4', { ...fast, range: [0, 9], fetchImpl: async () => { calls++; return respond(206, bytes(calls === 1 ? 5 : 10)); } });
    assert.equal(calls, 2); assert.equal(result.bytes.length, 10);
    await assert.rejects(E.fetchBytes('https://cdn.test/f.mp4', { ...fast, range: [0, 9], fetchImpl: async () => respond(200, bytes(100)) }), error => error.code === 'range');
  });
  await H.check('per-request timeout is retried', async () => {
    let calls = 0;
    const result = await E.fetchBytes('https://cdn.test/slow.ts', { ...fast, timeoutMs: 50, fetchImpl: (url, { signal }) => {
      calls++;
      if (calls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return Promise.resolve(respond(200, bytes(3)));
    } });
    assert.equal(calls, 2); assert.equal(result.bytes.length, 3);
  });
  await H.check('slow but steadily progressing transfers are not killed by the timeout (throttled CDNs)', async () => {
    let calls = 0;
    const slowBody = () => new ReadableStream({ async start(controller) { for (let i = 0; i < 10; i++) { await H.settle(30); controller.enqueue(bytes(100)); } controller.close(); } });
    const result = await E.fetchBytes('https://cdn.test/throttled.ts', { ...fast, timeoutMs: 80, fetchImpl: async (url, { signal }) => { calls++; return new Response(slowBody(), { status: 200, headers: { 'content-type': 'video/mp2t' } }); } });
    assert.equal(calls, 1, 'no restart'); assert.equal(result.bytes.length, 1000);
    // A stream that stops sending data is still aborted by the idle timeout.
    let stalled = 0;
    await assert.rejects(E.fetchBytes('https://cdn.test/stalled.ts', { ...fast, retries: 1, timeoutMs: 80, fetchImpl: async (url, { signal }) => { stalled++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes(10)); signal.addEventListener('abort', () => c.error(signal.reason)); } }), { status: 200, headers: { 'content-type': 'video/mp2t' } }); } }),
      error => /No data received/.test(error.message));
    assert.equal(stalled, 2);
  });
  await H.check('page-context fallback is used for 403 responses', async () => {
    const result = await E.fetchBytes('https://cdn.test/ref.ts', { ...fast, fetchImpl: async () => respond(403), fallback: async () => respond(200, bytes(7)) });
    assert.equal(result.bytes.length, 7);
  });
  const segments = n => Array.from({ length: n }, (_, i) => ({ url: 'https://cdn.test/s' + i + '.ts', range: null }));
  await H.check('segments download concurrently, respect the limit and are written in order', async () => {
    let active = 0, peak = 0;
    const sink = new E.MemorySink();
    await E.downloadSegments({ segments: segments(30), sink, concurrency: 4, fetchOptions: { ...fast, fetchImpl: async url => {
      active++; peak = Math.max(peak, active);
      const i = Number(url.match(/s(\d+)/)[1]);
      await H.settle(Math.random() * 15);
      active--;
      return respond(200, bytes(3, i));
    } } });
    assert(peak <= 4 && peak >= 2, 'peak concurrency ' + peak);
    const data = new Uint8Array(await (await sink.blob()).arrayBuffer());
    for (let i = 0; i < 30; i++) assert.equal(data[i * 3], i, 'segment ' + i + ' in order');
    assert.deepEqual([...sink.sizes], Array(30).fill(3));
  });
  await H.check('a failing segment is retried and the download continues', async () => {
    const attempts = new Map();
    const sink = new E.MemorySink();
    await E.downloadSegments({ segments: segments(8), sink, concurrency: 3, fetchOptions: { ...fast, retries: 3, fetchImpl: async url => {
      const n = (attempts.get(url) || 0) + 1; attempts.set(url, n);
      if (url.endsWith('s5.ts') && n < 3) return respond(502);
      return respond(200, bytes(2));
    } } });
    assert.equal(attempts.get('https://cdn.test/s5.ts'), 3); assert.equal(sink.size, 16);
  });
  await H.check('a permanently failing segment aborts the whole download with its index', async () => {
    const sink = new E.MemorySink();
    await assert.rejects(E.downloadSegments({ segments: segments(10), sink, concurrency: 3, fetchOptions: { ...fast, retries: 1,
      fetchImpl: async url => url.endsWith('s4.ts') ? respond(404) : respond(200, bytes(1)) } }), error => error.segment === 4 && error.code === 'not-found');
  });
  await H.check('cancellation stops in-flight and future requests and rejects with AbortError', async () => {
    const controller = new AbortController();
    let started = 0, aborted = 0;
    const sink = new E.MemorySink();
    const run = E.downloadSegments({ segments: segments(50), sink, concurrency: 4, signal: controller.signal, fetchOptions: { ...fast, fetchImpl: (url, { signal }) => {
      started++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(respond(200, bytes(1))), 20);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted++; reject(new DOMException('aborted', 'AbortError')); });
      });
    } } });
    await H.settle(70);
    controller.abort();
    await assert.rejects(run, error => error.name === 'AbortError');
    const startedAtCancel = started;
    await H.settle(60);
    assert.equal(started, startedAtCancel, 'no requests after cancellation');
    assert(started < 50 && aborted >= 1);
  });
  await H.check('pause holds new requests; resume continues; cancel while paused releases waiters', async () => {
    const gate = new E.PauseGate();
    let calls = 0;
    const sink = new E.MemorySink();
    gate.pause();
    const run = E.downloadSegments({ segments: segments(6), sink, concurrency: 2, gate, fetchOptions: { ...fast, fetchImpl: async () => { calls++; return respond(200, bytes(1)); } } });
    await H.settle(40);
    assert.equal(calls, 0, 'paused before start');
    gate.resume();
    await run;
    assert.equal(calls, 6);
    const controller = new AbortController();
    gate.pause();
    const waiting = gate.wait(controller.signal);
    controller.abort();
    await assert.rejects(waiting, error => error.name === 'AbortError');
    assert.equal(gate.waiters.length, 0, 'aborted waiter removed');
  });
  await H.check('progress meter: speed, ETA and estimated totals', () => {
    let now = 0;
    const meter = new E.ProgressMeter({ totalUnits: 10, now: () => now });
    for (let i = 1; i <= 4; i++) { now = i * 1000; meter.add(1000); meter.unit(1000); }
    const snap = meter.snapshot();
    assert.equal(snap.fraction, 0.4); assert.equal(snap.total, 10000);
    assert.equal(snap.speed, 1000); assert.equal(snap.eta, 6);
    const sized = new E.ProgressMeter({ totalBytes: 5000, now: () => now });
    now += 1000; sized.add(2500); now += 1000; sized.add(0);
    assert.equal(sized.fraction, 0.5);
    assert.equal(E.fmtTime(75), '1m 15s'); assert.equal(E.fmtBytes(1536 * 1024), '1.5 MB');
  });
  await H.check('output validation rejects empty, HTML and wrong-format outputs', async () => {
    assert.equal((await E.validateOutput(new Blob([]), { format: 'mp4' })).ok, false);
    assert.equal((await E.validateOutput(new Blob(['<!doctype html><html>login']), { format: 'mp3' })).ok, false);
    assert.equal((await E.validateOutput(new Blob([bytes(400, 0x47)]), { format: 'ts' })).ok, true);
    assert.equal((await E.validateOutput(new Blob([Uint8Array.of(0xff, 0xfb, 0x90, 0)]), { format: 'mp3' })).ok, true);
    assert.equal((await E.validateOutput(new Blob([bytes(64, 0)]), { format: 'mp4' })).ok, false);
  });
  H.summary('retries/backoff, error classification, ordered concurrency, pause/resume, cancellation, metering, output validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
