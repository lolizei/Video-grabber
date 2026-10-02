const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const stored = {}, fixtures = new Map(), tasks = new Map();
const pages = new Map([[8, { id: 8, url: 'https://example.test/page' }]]);
let nextDownload = 1, nextTab = 100, fetchCount = 0;
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
}
function setup(enableYouTube = true) {
  const chrome = {
    storage: { session: {
      async get(key) { return structuredClone({ [key]: stored[key] }); },
      async set(data) { Object.assign(stored, structuredClone(data)); },
      async remove(key) { delete stored[key]; }
    } },
    action: { async setBadgeText() {}, setBadgeBackgroundColor() {} },
    webRequest: Object.fromEntries(['onHeadersReceived', 'onCompleted', 'onErrorOccurred', 'onSendHeaders', 'onBeforeRequest'].map(name => [name, event()])),
    tabs: { onUpdated: event(), onRemoved: event(),
      async get(id) { if (!pages.has(id)) throw new Error('No tab'); return pages.get(id); },
      async create(options) { const id = nextTab++; pages.set(id, { id, ...options }); return { id }; },
      async sendMessage() { return { ok: false, error: 'Blocked by CORS' }; }
    },
    downloads: { onChanged: event(), async download(options) {
      const id = nextDownload++; tasks.set(id, { id, options, state: 'in_progress', totalBytes: 100, bytesReceived: 10 }); return id;
    }, async search({ id }) { return tasks.has(id) ? [tasks.get(id)] : []; } },
    runtime: { onMessage: event(), getURL: file => 'chrome-extension://test/' + file },
    scripting: { async executeScript() { return []; } }
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, Response, Uint8Array, AbortSignal, structuredClone,
    console, atob, btoa, crypto: webcrypto,
    async fetch(url) { fetchCount++; if (!fixtures.has(url)) throw new Error('HTTP 403');
      const response = new Response(fixtures.get(url)); Object.defineProperty(response, 'url', { value: url }); return response; },
    importScripts(...files) {
      for (const file of files) {
        if (file === 'config.js') context.VG_CONFIG = { enableYouTube };
        else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const send = (msg, sender = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No reply for ' + msg.cmd)), 3000);
    for (const fn of chrome.runtime.onMessage.listeners) fn(msg, sender, reply => { clearTimeout(timeout); resolve(reply); });
  });
  const request = async (cmd, data = {}) => {
    const response = await send({ cmd: 'scanner.' + cmd, tabId: 8, ...data });
    assert(response.ok, response.error); return response.result;
  };
  return { context, chrome, send, request };
}
async function run() {
  let env = setup();
  const tools = env.context.MediaTools, playlist = env.context.PlaylistTools;
  for (const ext of ['mp3','m4a','aac','ogg','wav','flac','opus','mp4','webm','m3u8','mpd']) {
    const item = tools.classify('https://cdn.test/file.' + ext + '?signed=a#fragment');
    assert(item); assert(!item.url.includes('#')); assert(item.url.includes('?signed=a'));
  }
  const audio = tools.classify('https://cdn.test/download?token=1', [{ name: 'Content-Type', value: 'audio/mpeg; charset=binary' }, { name: 'Content-Length', value: '12' }]);
  assert.equal(audio.type, 'audio'); assert.equal(audio.size, 12); assert.equal(audio.filename, 'download.mp3');
  assert.equal(tools.classify('https://cdn.test/v.mp4', [{name:'content-range',value:'bytes 0-9/999'}]).size, 999);
  assert.equal(tools.classify('blob:https://page.test/id'), null);
  assert.equal(tools.classify('https://cdn.test/seg.ts'), null);
  assert.equal(tools.classify('https://cdn.test/image.png'), null);
  assert.equal(tools.classify('https://cdn.test/login.mp3', [{name:'content-type',value:'text/html'}]), null);
  assert(!tools.filename('../../CON.mp3').includes('..'));
  assert.equal(tools.filename('CON.mp3'), '_CON.mp3');
  assert(!/[\\/:*?"<>|]/.test(tools.filename('test:*?/.mp3')));
  const dom = urls => env.send({ cmd: 'scanner.dom', urls: urls.map(url => ({url})), blobs: 1 }, { tab: pages.get(8), frameId: 0, url: pages.get(8).url });
  const page = vm.createContext({ URL, console, setTimeout, clearTimeout,
    location:{href:pages.get(8).url},
    document:{documentElement:{},addEventListener(){},removeEventListener(){},querySelectorAll(selector){
      return selector === 'video,audio' ? ['AUDIO','VIDEO'].map(tagName=>({tagName,currentSrc:'',getAttribute(){return tagName==='AUDIO'?'https://cdn.test/tone.mp3':'https://cdn.test/video.mp4'}})) : [];
    }},performance:{getEntriesByType(){return []}},
    MutationObserver:class{observe(){}disconnect(){}},PerformanceObserver:class{observe(){}disconnect(){}},
    chrome:{runtime:{onMessage:event(),sendMessage(msg){return env.send(msg,{tab:pages.get(8),frameId:0,url:pages.get(8).url})}}}
  });
  env.chrome.scripting.executeScript = async options => {
    if(options.files) { for(const file of options.files)vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),page);return[{frameId:0}]; }
    return[{frameId:0,result:vm.runInContext('('+options.func.toString()+')()',page)}];
  };
  const baseline = await env.request('refresh');
  assert.deepEqual(Array.from(baseline.items,item=>item.type).sort(),['audio','video']);
  assert.equal(baseline.debug.domHits,2);assert.equal(baseline.debug.scanError,'');
  await env.request('refresh'); // Fresh content-script reinjection must still collect both items.
  await env.request('clear');
  for (const listener of env.chrome.webRequest.onSendHeaders.listeners) listener({ tabId:8, requestId:'media-1', requestHeaders:[{name:'Referer',value:'https://example.test/page'}] });
  for (const listener of env.chrome.webRequest.onHeadersReceived.listeners) listener({ tabId:8, frameId:0, requestId:'media-1', method:'GET', statusCode:200, timeStamp:Date.now(), url:'https://cdn.test/tiny', responseHeaders:[{name:'content-type',value:'audio/mpeg'},{name:'content-length',value:'12'}] });
  const network = (await env.request('list')).items[0];
  assert.equal(network.filename,'tiny.mp3'); assert.equal(network.size,12); assert.equal(network.referrer,'https://example.test/page');
  await env.request('clear');
  await dom(['https://cdn.test/sound.mp3?one=1', 'https://cdn.test/sound.mp3?one=1', 'https://cdn.test/sound.mp3?one=2']);
  let snapshot = await env.request('list');
  assert.equal(snapshot.items.length, 2); assert.equal(snapshot.blobs, 1);
  // Worker restart reads session storage rather than an in-memory cache.
  env = setup(); snapshot = await env.request('list'); assert.equal(snapshot.items.length, 2);
  await env.context.MediaScanner.navigate(8, 'https://example.test/next');
  snapshot = await env.request('list'); assert.equal(snapshot.items.length, 0);
  await env.context.MediaScanner.navigate(8, pages.get(8).url);
  const hls = 'https://cdn.test/master.m3u8', child = 'https://cdn.test/protected.m3u8';
  fixtures.set(hls, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nprotected.m3u8');
  fixtures.set(child, '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\npart.ts');
  const dash = 'https://cdn.test/protected.mpd';
  fixtures.set(dash, '<MPD><cenc:ContentProtection/></MPD>');
  const clear = 'https://cdn.test/clear.m3u8'; fixtures.set(clear, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\npart.ts\n#EXT-X-ENDLIST');
  await dom([hls, dash, clear]);
  assert.equal((await env.request('inspect', { url: hls })).status, 'protected');
  assert.equal((await env.request('inspect', { url: dash })).status, 'protected');
  assert.equal((await env.request('inspect', { url: clear })).reason, 'AES-128');
  assert.equal((await env.request('inspect', { url: clear })).status, 'protected');
  assert.equal((await env.request('download', { urls: [hls, dash] })).length, 0);
  await dom(['https://cdn.test/a.mp3','https://cdn.test/b.mp3','https://cdn.test/c.mp3','https://cdn.test/d.mp3']);
  const ids = await env.request('download', { urls: ['a','b','c','d'].map(name => 'https://cdn.test/' + name + '.mp3') });
  assert.equal(ids.length, 4);
  snapshot = await env.request('list');
  assert.equal(snapshot.jobs.filter(j => j.status === 'running').length, 3);
  assert.equal(snapshot.jobs.filter(j => j.status === 'queued').length, 1);
  assert.equal((await env.request('download', { urls: ['https://cdn.test/a.mp3'] }))[0], ids[0]);
  let first = snapshot.jobs.find(j => j.id === ids[0]); tasks.get(first.downloadId).state = 'complete';
  for (const listener of env.chrome.downloads.onChanged.listeners) listener({ id: first.downloadId, state: { current: 'complete' } });
  snapshot = await env.request('list');
  assert.equal(snapshot.jobs.find(j => j.id === ids[0]).status, 'complete');
  assert.equal(snapshot.jobs.filter(j => j.status === 'running').length, 3);
  const retryJob = snapshot.jobs.find(j => j.status === 'running');
  tasks.get(retryJob.downloadId).state = 'interrupted'; tasks.get(retryJob.downloadId).error = 'NETWORK_FAILED';
  for (const listener of env.chrome.downloads.onChanged.listeners) listener({ id: retryJob.downloadId, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  snapshot = await env.request('list');
  assert.equal(snapshot.jobs.find(j => j.id === retryJob.id).attempts, 2);
  const restart = setup(); snapshot = await restart.request('list'); assert.equal(snapshot.jobs.filter(j => j.status === 'running').length, 3);
  assert.equal(playlist.protection('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="key"'), 'AES-128 · com.apple.streamingkeydelivery');
  const text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:257\n#EXT-X-KEY:METHOD=AES-128,URI="key1"\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x10\nb.ts\n#EXT-X-KEY:METHOD=NONE\nc.ts\n#EXT-X-ENDLIST';
  assert.throws(()=>playlist.parseMedia(text,'https://cdn.test/p.m3u8'),/Protected/);
  assert.throws(() => playlist.parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\na.ts', clear), /Protected/);
  const ranges = playlist.parseMedia('#EXTM3U\n#EXT-X-BYTERANGE:10@0\nfile.mp4\n#EXT-X-BYTERANGE:5\nfile.mp4', clear);
  assert.deepEqual(Array.from(ranges.segs[1].range), [10,14]);
  assert.throws(() => playlist.parseMedia('#EXTM3U\n#EXT-X-BYTERANGE:10\nfile.mp4', clear), /previous/);
  assert.throws(() => playlist.parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\nfile.m4s', clear), /Protected/);
  // Both network detection and DOM recovery enforce the store build exclusion.
  const store = setup(false);
  assert.equal(store.context.MediaScanner.classifyRequest({ url: 'https://r.googlevideo.com/videoplayback?itag=18', method: 'GET', responseHeaders: [{name:'content-type',value:'video/mp4'}] }), null);
  const full = setup(true);
  assert.equal(full.context.MediaScanner.classifyRequest({ url: 'https://r.googlevideo.com/videoplayback?itag=18&range=0-1&mime=video%2Fmp4', method: 'GET', responseHeaders: [] }).mode, 'chunked');
  assert(fetchCount >= 4);
  stored.scanner_jobs = [];
  const rawIds = await env.request('download', { urls: [hls,dash], rawPlaylist:true });
  assert.equal(rawIds.length,0);
  console.log('Passed: actual MP3/MP4 DOM baseline and reinjection, classification, session restart, navigation, encrypted/DRM blocking, byte ranges, queue/concurrency/retries, store exclusion.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
