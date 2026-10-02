// CDN discovery: redirects, signed/expiring URLs, deduplication, CDN identification and
// accurate error reporting for expired, unauthorized and HTML responses.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const { fs, path } = H;

(async () => {
  const ctx = H.vm.createContext({ URL, URLSearchParams, console, atob });
  H.vm.runInContext(H.read('shared/cdn.js'), ctx);
  const C = ctx.CdnTools;
  const future = Math.floor(Date.now() / 1000) + 3600, past = Math.floor(Date.now() / 1000) - 60;
  await H.check('signed URL providers and expiry times', () => {
    const aws = C.signedInfo('https://b.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260101T000000Z&X-Amz-Expires=600&X-Amz-Signature=abc');
    assert.equal(aws.provider, 'AWS SigV4'); assert.equal(aws.expiresAt, Date.UTC(2026, 0, 1, 0, 10));
    const cf = C.signedInfo(`https://d1.cloudfront.net/v.m3u8?Expires=${future}&Signature=x&Key-Pair-Id=K`);
    assert.equal(cf.provider, 'CloudFront signed URL'); assert.equal(cf.expiresAt, future * 1000);
    assert.equal(C.signedInfo(`https://a.akamaized.net/m.mpd?hdnts=st=1~exp=${past}~acl=/*~hmac=ff`).expiresAt, past * 1000);
    assert(C.isExpired(C.signedInfo(`https://a.akamaized.net/m.mpd?hdnts=exp=${past}~hmac=ff`)));
    assert.equal(C.signedInfo(`https://r1.googlevideo.com/videoplayback?expire=${future}&sig=x`).provider, 'Google Video');
    assert.equal(C.signedInfo('https://x.blob.core.windows.net/c/v.mp4?sv=2020&se=2026-01-01T00:00:00Z&sig=x').provider, 'Azure SAS');
    assert.equal(C.signedInfo(`https://scontent.cdninstagram.com/v.mp4?oh=a&oe=${future.toString(16)}`).expiresAt, future * 1000);
    assert.equal(C.signedInfo('https://cdn.test/tone.mp3?token=one').signed, false);
  });
  await H.check('deduplication merges re-signed URLs but keeps distinct resources apart', () => {
    const a = C.dedupKey(`https://d1.cloudfront.net/v/720.m3u8?Expires=1&Signature=a&Key-Pair-Id=K&quality=hd`);
    const b = C.dedupKey(`https://d1.cloudfront.net/v/720.m3u8?quality=hd&Expires=2&Signature=b&Key-Pair-Id=K`);
    assert.equal(a, b);
    assert.notEqual(C.dedupKey('https://cdn.test/tone.mp3?token=one'), C.dedupKey('https://cdn.test/tone.mp3?token=two'));
    assert.equal(C.dedupKey('https://cdn.test/v.mp4?range=0-100#x'), C.dedupKey('https://cdn.test/v.mp4'));
  });
  await H.check('CDN identification from hostnames and response headers', () => {
    assert.equal(C.identify('https://abc.cloudfront.net/x').provider, 'Amazon CloudFront');
    assert.equal(C.identify('https://vod.akamaized.net/x').provider, 'Akamai');
    assert.equal(C.identify('https://media.example/x', [{ name: 'X-Amz-Cf-Id', value: 'q' }]).provider, 'Amazon CloudFront');
    assert.equal(C.identify('https://media.example/x', [{ name: 'cf-ray', value: '1' }]).provider, 'Cloudflare');
    assert.equal(C.identify('https://media.example/x', [{ name: 'x-served-by', value: 'cache-fra1' }]).provider, 'Fastly');
    assert.equal(C.identify('https://media.example/x').provider, '');
  });
  await H.check('failure classification distinguishes expired, auth, missing and transient errors', () => {
    const signedExpired = `https://d1.cloudfront.net/v.mp4?Expires=${past}&Signature=a&Key-Pair-Id=K`;
    assert.equal(C.classifyFailure({ status: 403, url: signedExpired }).code, 'expired');
    assert.equal(C.classifyFailure({ status: 403, url: 'https://x.test/v.mp4' }).code, 'auth');
    assert.equal(C.classifyFailure({ status: 401 }).code, 'auth');
    assert.equal(C.classifyFailure({ status: 410, url: signedExpired }).code, 'expired');
    assert.equal(C.classifyFailure({ status: 404, url: 'https://x.test/v.mp4' }).code, 'not-found');
    assert.equal(C.classifyFailure({ status: 503 }).retryable, true);
    assert.equal(C.classifyFailure({ status: 200, contentType: 'text/html' }).code, 'auth');
    assert.equal(C.classifyFailure({ url: signedExpired, error: 'Failed to fetch' }).code, 'expired');
  });

  // ---- background discovery ----
  const page = { id: 8, url: 'https://site.example/watch' };
  const bg = H.loadBackground({ tabs: new Map([[8, page]]) });
  const tabReq = (cmd, data = {}) => bg.request('scanner.' + cmd, { tabId: 8, ...data });
  await H.check('redirect chains collapse into one row keyed by the original URL with CDN details', async () => {
    const original = 'https://site.example/media/42.mp4';
    const final = `https://d9.cloudfront.net/42.mp4?Expires=${future}&Signature=s&Key-Pair-Id=K`;
    bg.fire('onBeforeRedirect', { tabId: 8, requestId: 'r1', url: original, redirectUrl: final });
    bg.fire('onHeadersReceived', { tabId: 8, frameId: 0, requestId: 'r1', method: 'GET', statusCode: 200, timeStamp: Date.now(), url: final,
      responseHeaders: [{ name: 'content-type', value: 'video/mp4' }, { name: 'content-length', value: '500000' }, { name: 'x-amz-cf-id', value: 'q' }] });
    await H.settle();
    await bg.send({ cmd: 'scanner.dom', urls: [{ url: original }] }, { tab: page, frameId: 0, url: page.url });
    const snap = await tabReq('list');
    assert.equal(snap.items.length, 1, JSON.stringify(snap.items.map(i => i.url)));
    const item = snap.items[0];
    assert.equal(item.url, final); assert.equal(item.originUrl, original); assert.equal(item.redirects, 2);
    assert.equal(item.cdn.provider, 'Amazon CloudFront'); assert.equal(item.signed.provider, 'CloudFront signed URL');
    assert.equal(item.pageHost, 'site.example'); assert.equal(snap.debug.redirectHits, 1);
  });
  await H.check('a fresh signature for the same resource refreshes the row instead of duplicating it', async () => {
    await tabReq('clear');
    const url = s => `https://cdn.akamaized.net/show/master.m3u8?hdnts=exp=${s}~hmac=${s}`;
    for (const exp of [past, future]) bg.fire('onHeadersReceived', { tabId: 8, frameId: 0, requestId: 'x' + exp, method: 'GET', statusCode: 200, timeStamp: Date.now(), url: url(exp),
      responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }] });
    await H.settle();
    const snap = await tabReq('list');
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].url, url(future)); assert(snap.items[0].refreshedAt);
    assert.notEqual(snap.items[0].status, 'expired');
  });
  await H.check('expired signed URLs are flagged in snapshots', async () => {
    await tabReq('clear');
    await bg.send({ cmd: 'scanner.dom', urls: [{ url: `https://d1.cloudfront.net/old.mp4?Expires=${past}&Signature=a&Key-Pair-Id=K` }] }, { tab: page, frameId: 0, url: page.url });
    const snap = await tabReq('list');
    assert.equal(snap.items[0].status, 'expired');
  });

  // ---- downloads through redirects and failures ----
  const dir = H.tempDir('vg-cdn-'), out = H.tempDir('vg-cdn-out-');
  H.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'libmp3lame', 'tone.mp3'], dir);
  const server = await H.serve(dir, { hooks: {
    '/redirect.mp3': (req, res) => { res.writeHead(302, { Location: `/tone.mp3?Expires=${future}&Signature=s&Key-Pair-Id=K` }).end(); return true; },
    '/expired.mp3': (req, res) => { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Request has expired'); return true; },
    '/login.mp3': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Sign in</title>'); return true; },
    '/private.mp3': (req, res) => { res.writeHead(401).end(); return true; },
    '/flaky.mp3': (req, res, { n }) => { if (n <= 2) { res.writeHead(503, { 'Retry-After': '0' }).end(); return true; } }
  } });
  fs.copyFileSync(path.join(dir, 'tone.mp3'), path.join(dir, 'flaky.mp3'));
  try {
    const reports = [];
    const runtime = { async sendMessage(msg) { if (msg.cmd === 'scanner.claim') return { ok: true, result: { id: 'job', item: {}, settings: { retries: 3 } } }; reports.push(msg); return { ok: true }; }, onMessage: H.event() };
    await H.check('downloads follow CDN redirects to signed URLs and save a valid file', async () => {
      const result = await H.runDownloader({ params: { mode: 'file', url: server.base + '/redirect.mp3', name: 'redirect.mp3' }, outDir: out, storageDir: H.tempDir('vg-opfs-') });
      assert.equal(result.saved.length, 1, result.status);
      assert.equal(fs.statSync(result.saved[0].file).size, fs.statSync(path.join(dir, 'tone.mp3')).size);
      H.decodes(result.saved[0].file);
    });
    await H.check('temporary 503s are retried and recovered', async () => {
      const result = await H.runDownloader({ params: { mode: 'file', url: server.base + '/flaky.mp3', name: 'flaky.mp3' }, outDir: out });
      assert.equal(result.saved.length, 1, result.status); assert.match(result.log, /Retry 1/);
    });
    for (const [file, url, code, pattern] of [
      ['expired', `/expired.mp3?Expires=${past}&Signature=a&Key-Pair-Id=K`, 'expired', /expired/i],
      ['forbidden', '/expired.mp3', 'auth', /403/],
      ['login page', '/login.mp3', 'auth', /web page instead of media/],
      ['unauthorized', '/private.mp3', 'auth', /401/],
      ['missing', '/missing.mp3', 'not-found', /404/]]) {
      await H.check(`${file} URL fails with an accurate "${code}" error and saves nothing`, async () => {
        reports.length = 0;
        const result = await H.runDownloader({ params: { mode: 'file', url: server.base + url, name: 'x.mp3', job: 'job' }, outDir: out, runtime });
        assert.equal(result.saved.length, 0);
        assert.match(result.status, /^Failed: /); assert.match(result.status, pattern);
        const final = reports.at(-1);
        assert.equal(final.status, 'failed'); assert.equal(final.errorCode, code);
      });
    }
    H.summary('signed URL detection/expiry, dedup, CDN identification, redirect discovery, refresh, expired/auth/HTML/404 errors');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
