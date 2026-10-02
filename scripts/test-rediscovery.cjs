const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const stored = {};
const listeners = {};
const event = name => ({ addListener(fn) { listeners[name] = fn; } });
const chrome = {
  storage: { session: {
    async get(key) { return { [key]: stored[key] }; },
    async set(values) { Object.assign(stored, structuredClone(values)); },
    async remove(key) { delete stored[key]; }
  } },
  action: { async setBadgeText() {}, setBadgeBackgroundColor() {} },
  webRequest: { onHeadersReceived: event('headers') },
  tabs: { onUpdated: event('updated'), onRemoved: event('removed') },
  runtime: { onMessage: event('message') }
};
const context = vm.createContext({ chrome, URL, console, atob, importScripts() {} });
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
const message = msg => new Promise(resolve => listeners.message(msg, {}, resolve));

(async () => {
  const stream = 'https://media.example/playlist.m3u8?token=old';
  await vm.runInContext(`addMedia(5, classify({ url: '${stream}', responseHeaders: [] }))`, context);
  await message({ cmd: 'clear', tabId: 5 });
  assert.equal(Object.keys(await vm.runInContext('getList(5)', context)).length, 0);
  let items = await message({ cmd: 'list', tabId: 5 });
  assert.equal(items[0].url, stream);
  assert.equal(items[0].kind, 'hls');
  await message({ cmd: 'clear', tabId: 5 });
  await vm.runInContext(`addMedia(5, classify({ url: '${stream.replace('old', 'new')}', responseHeaders: [] }))`, context);
  items = await message({ cmd: 'list', tabId: 5 });
  assert.equal(items.length, 1);
  assert(items[0].url.endsWith('token=new'));
  await vm.runInContext('clearTab(5)', context);
  assert.equal((await message({ cmd: 'list', tabId: 5 })).length, 0);
  items = await message({ cmd: 'list', tabId: 5, resourceUrls: [stream,
    'https://media.example/part.ts', 'https://media.example/style.css',
    'https://media.example/video.mp4', 'https://r.googlevideo.com/videoplayback?itag=18&range=0-99'] });
  assert.equal(items.length, 3);
  assert(items.some(i => i.kind === 'hls'));
  assert(items.some(i => i.kind === 'chunked' && !i.url.includes('range=')));
  assert(items.some(i => i.kind === 'file'));
  const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  const scan = popup.slice(popup.indexOf('function scanDom()'), popup.indexOf('// Instagram:'));
  const page = vm.createContext({ URL, location: { href: 'https://example.com/page' },
    document: { querySelectorAll(selector) { return selector === 'video, audio' ?
      [{ currentSrc: 'blob:https://example.com/id', src: '' }, { currentSrc: '', src: '' }] : []; } },
    performance: { getEntriesByType() { return [{ name: stream }]; } } });
  const result = vm.runInContext(scan + '\nscanDom()', page);
  assert.equal(result.domUrls.length, 0);
  assert.equal(result.resourceUrls[0], stream);
  console.log('Passed: clear/refresh recovery, fresh signed URLs, navigation reset, resource classification, blob/empty DOM sources.');
})().catch(error => { console.error(error); process.exitCode = 1; });
