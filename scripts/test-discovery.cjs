// Automatic media discovery: direct files by MIME/extension, manifests, segment association,
// per-tab association, media embedded in JavaScript players/markup, deduplication.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

(async () => {
  const ctx = H.vm.createContext({ URL, console });
  H.vm.runInContext(H.read('shared/media.js'), ctx);
  const M = ctx.MediaTools;
  await H.check('direct MP4/WebM/MP3/AAC and HLS/DASH are identified by MIME type or extension', () => {
    const ct = value => [{ name: 'Content-Type', value }];
    const cases = [
      ['https://c.test/a/video', ct('video/mp4'), 'video', 'video.mp4'], ['https://c.test/clip', ct('video/webm'), 'video', 'clip.webm'],
      ['https://c.test/song', ct('audio/mpeg'), 'audio', 'song.mp3'], ['https://c.test/radio', ct('audio/aac'), 'audio', 'radio.aac'],
      ['https://c.test/f.mp4', ct('application/octet-stream'), 'video', 'f.mp4'], ['https://c.test/x.m4a', [], 'audio', 'x.m4a'],
      ['https://c.test/live', ct('application/x-mpegURL'), 'playlist', 'live.m3u8'], ['https://c.test/m', ct('application/dash+xml'), 'playlist', 'm.mpd'],
      ['https://c.test/v.ism/manifest(format=m3u8-aapl)', [], 'playlist', null], ['https://c.test/v.ism/manifest(format=mpd-time-csf)', [], 'playlist', null],
      ['https://c.test/v.ism/Manifest', [], 'playlist', null], ['https://c.test/v.f4m', [], 'playlist', 'v.f4m']];
    for (const [url, headers, type, filename] of cases) {
      const item = M.classify(url, headers);
      assert(item, url); assert.equal(item.type, type, url);
      if (filename) assert.equal(item.filename, filename, url);
    }
    assert.equal(M.classify('https://c.test/v.ism/manifest(format=m3u8-aapl)').kind, 'hls');
    assert.equal(M.classify('https://c.test/v.ism/manifest(format=mpd-time-csf)').kind, 'dash');
    assert.equal(M.classify('https://c.test/v.ism/Manifest').kind, 'mss');
    for (const [url, type] of [['https://c.test/seg-1.ts', ''], ['https://c.test/chunk.m4s', ''], ['https://c.test/p', 'text/html'], ['https://c.test/t.jpg', 'image/jpeg'], ['https://c.test/api', 'application/json']])
      assert.equal(M.classify(url, type ? ct(type) : []), null, url);
  });

  const pages = new Map([[1, { id: 1, url: 'https://one.example/' }], [2, { id: 2, url: 'https://two.example/' }]]);
  let mainWorld = {};
  const bg = H.loadBackground({ tabs: pages, extra: {} });
  const hit = (tabId, url, type, extra = {}) => bg.fire('onHeadersReceived', { tabId, frameId: 0, requestId: Math.random().toString(), method: 'GET', statusCode: 200,
    timeStamp: Date.now(), url, initiator: tabId === 1 ? 'https://one.example' : 'https://two.example', responseHeaders: [{ name: 'content-type', value: type }, { name: 'content-length', value: '400000' }], ...extra });
  await H.check('network responses are associated with their originating tab and deduplicated', async () => {
    hit(1, 'https://media.cdn.test/a.mp4', 'video/mp4');
    hit(1, 'https://media.cdn.test/a.mp4', 'video/mp4');
    hit(1, 'https://media.cdn.test/b.webm', 'video/webm');
    hit(1, 'https://media.cdn.test/c.mp3', 'audio/mpeg');
    hit(1, 'https://media.cdn.test/d.aac', 'audio/aac');
    hit(1, 'https://media.cdn.test/master.m3u8', 'application/vnd.apple.mpegurl');
    hit(2, 'https://media.cdn.test/other.mpd', 'application/dash+xml');
    hit(1, 'https://media.cdn.test/ignored.mp4', 'video/mp4', { method: 'POST' });
    hit(1, 'https://media.cdn.test/forbidden.mp4', 'video/mp4', { statusCode: 403 });
    hit(-1, 'https://media.cdn.test/background.mp4', 'video/mp4');
    for (let i = 0; i < 3; i++) hit(1, `https://seg.cdn.test/s${i}.ts`, 'video/mp2t');
    await H.settle(50);
    const one = await bg.request('scanner.list', { tabId: 1 });
    same(one.items.map(i => i.filename).sort(), ['a.mp4', 'b.webm', 'c.mp3', 'd.aac', 'master.m3u8']);
    assert.equal(one.segments, 3); same([...one.debug.segmentHosts], ['seg.cdn.test']);
    assert(one.items.every(i => i.pageHost === 'one.example' && i.size === 400000));
    const two = await bg.request('scanner.list', { tabId: 2 });
    same(two.items.map(i => i.filename), ['other.mpd']);
  });
  await H.check('requests from before a navigation are ignored; navigation resets the tab', async () => {
    const before = Date.now() - 1000;
    bg.fire('onBeforeRequest', { tabId: 2, type: 'main_frame', url: 'https://two.example/next', timeStamp: Date.now() });
    await H.settle(20);
    hit(2, 'https://media.cdn.test/late.mp4', 'video/mp4', { timeStamp: before });
    await H.settle(30);
    assert.equal((await bg.request('scanner.list', { tabId: 2 })).items.length, 0);
  });
  await H.check('content script finds media in scripts, JSON-LD, data attributes, meta tags and preload links', async () => {
    const sent = [];
    const node = (attrs, text = '') => ({ attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), getAttribute: n => attrs[n], textContent: text, ...attrs });
    const doc = {
      'video,audio': [], 'video source,audio source': [], 'a[href]': [],
      meta: [{ content: 'https://cdn.example/og.mp4', getAttribute: () => 'og:video' }],
      link: [{ href: 'https://cdn.example/preload.m3u8' }],
      data: [node({ 'data-setup': '{"sources":[{"src":"https:\\/\\/cdn.example\\/vjs\\/index.m3u8","type":"application/x-mpegURL"}]}' }), node({ 'data-hls': 'https://cdn.example/data.m3u8' })],
      script: [node({}, 'var config = {"file":"https:\\/\\/cdn.example\\/player\\/master.m3u8?token=a\\u0026b=1"}; jwplayer("x").setup(config);'),
        node({}, '{"@type":"VideoObject","contentUrl":"https://cdn.example/ld/video.mp4"}'), node({}, 'console.log("https://cdn.example/app.js")')]
    };
    const page = H.vm.createContext({ URL, console, setTimeout, clearTimeout, location: { href: 'https://site.example/' },
      document: { documentElement: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll(selector) {
        if (selector.startsWith('meta')) return doc.meta; if (selector.startsWith('link')) return doc.link;
        if (selector.startsWith('[data-')) return doc.data; if (selector.startsWith('script')) return doc.script; return doc[selector] || [];
      } },
      performance: { getEntriesByType: () => [] }, MutationObserver: class { observe() {} disconnect() {} }, PerformanceObserver: class { observe() {} disconnect() {} },
      chrome: { runtime: { onMessage: H.event(), sendMessage: async msg => { sent.push(msg); } } } });
    H.vm.runInContext(H.read('content/dom-scan.js'), page);
    const urls = sent.find(m => m.cmd === 'scanner.dom').urls.map(u => u.url);
    for (const expected of ['https://cdn.example/og.mp4', 'https://cdn.example/preload.m3u8', 'https://cdn.example/vjs/index.m3u8', 'https://cdn.example/data.m3u8',
      'https://cdn.example/player/master.m3u8?token=a&b=1', 'https://cdn.example/ld/video.mp4']) assert(urls.includes(expected), expected + ' in ' + urls.join(', '));
    assert(!urls.some(u => u.endsWith('app.js')));
  });
  await H.check('Refresh reads sources exposed by JavaScript players in the page (jwplayer, video.js, hls.js globals)', async () => {
    bg.chrome.scripting.executeScript = async options => {
      if (options.files) return [{ frameId: 0 }];
      if (options.world === 'MAIN') {
        const world = H.vm.createContext({ URL, document: { querySelectorAll: () => [] },
          jwplayer: () => ({ getPlaylist: () => [{ file: 'https://jw.example/stream.m3u8', sources: [{ file: 'https://jw.example/720.mp4' }] }] }),
          videojs: { getPlayers: () => ({ p: { currentSrc: () => 'https://vjs.example/master.mpd', currentSources: () => [] } }) },
          hls: { url: 'https://hlsjs.example/live.m3u8' } });
        world.globalThis = world;
        return [{ frameId: 0, documentUrl: 'https://one.example/', result: H.vm.runInContext('(' + options.func.toString() + ')()', world) }];
      }
      return [{ frameId: 0, result: { urls: [], blobs: 0, pageUrl: 'https://one.example/' } }];
    };
    const snap = await bg.request('scanner.refresh', { tabId: 1 });
    const found = snap.items.filter(i => i.source === 'player').map(i => i.url).sort();
    same(found, ['https://hlsjs.example/live.m3u8', 'https://jw.example/720.mp4', 'https://jw.example/stream.m3u8', 'https://vjs.example/master.mpd']);
    assert(snap.debug.playerHits >= 4);
  });
  H.summary('MIME/extension detection, per-tab association, dedup, navigation reset, segment association, player/script/markup discovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
