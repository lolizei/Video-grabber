// Shared helpers for the automated tests: generated local media, a fixture HTTP server with
// failure injection, a disk-backed fake of the Origin Private File System, mocked Chrome APIs
// and loaders that run the production service-worker and download-page scripts in Node's vm.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { webcrypto } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const SHARED = ['shared/media.js', 'shared/cdn.js', 'shared/drm.js', 'shared/xml.js', 'shared/hls.js', 'shared/dash.js', 'shared/mp4.js',
  'shared/playlists.js', 'shared/download-engine.js'];

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const ffmpeg = (args, cwd) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration,start_time:format=duration',
    '-of', 'json', file], { encoding: 'utf8' }));
}
const decodes = file => { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']); return true; };
const AV = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4'];

// ---------- generated media ----------
const media = {
  hlsFmp4Separate(dir) {
    ffmpeg([...AV, '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-s:v:0', '320x180', '-s:v:1', '160x90',
      '-b:v:0', '400k', '-b:v:1', '150k', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod',
      '-master_pl_name', 'fmp4-master.m3u8', '-var_stream_map', 'v:0,agroup:aud v:1,agroup:aud a:0,agroup:aud,default:yes,language:en,name:English',
      '-hls_segment_filename', 'fmp4-%v-%d.m4s', '-hls_fmp4_init_filename', 'fmp4-init-%v.mp4', 'fmp4-%v.m3u8'], dir);
  },
  hlsTsSeparate(dir) {
    ffmpeg([...AV, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1',
      '-hls_playlist_type', 'vod', '-master_pl_name', 'ts-master.m3u8', '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,name:Main',
      '-hls_segment_filename', 'ts-%v-%d.ts', 'ts-%v.m3u8'], dir);
  },
  hlsTsMuxed(dir, name = 'muxed', seconds = 4) {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', name + '-%d.ts', name + '.m3u8'], dir);
  },
  dash(dir, name, extra = []) {
    ffmpeg([...AV, '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-s:v:0', '320x180', '-s:v:1', '160x90',
      '-c:a', 'aac', '-f', 'dash', '-seg_duration', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      '-init_seg_name', name + '-init-$RepresentationID$.m4s', '-media_seg_name', name + '-$RepresentationID$-$Number%05d$.m4s', ...extra, name + '.mpd'], dir);
  },
  dashWebm(dir, name) {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-g', '25', '-c:a', 'libopus',
      '-f', 'dash', '-dash_segment_type', 'webm', '-use_timeline', '0', '-seg_duration', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      '-init_seg_name', name + '-init-$RepresentationID$.webm', '-media_seg_name', name + '-$RepresentationID$-$Number%05d$.webm', name + '.mpd'], dir);
  },
  cencMp4(dir, name) {
    // Locally generated CENC-encrypted fragmented MP4, used only to verify detection/rejection.
    ffmpeg([...AV, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-encryption_scheme', 'cenc-aes-ctr',
      '-encryption_key', '00112233445566778899aabbccddeeff', '-encryption_kid', 'a7e61c373e219033c21091fa607bf3b8',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', name], dir);
  }
};

// ---------- fixture server ----------
function serve(dir, { hooks = {} } = {}) {
  const requests = [];
  const counts = new Map();
  const types = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m3u8': 'application/vnd.apple.mpegurl',
    '.mpd': 'application/dash+xml', '.ts': 'video/mp2t', '.webm': 'video/webm', '.aac': 'audio/aac', '.bin': 'application/octet-stream' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, url: req.url, range: req.headers.range || '', time: Date.now() });
    const n = (counts.get(url.pathname) || 0) + 1; counts.set(url.pathname, n);
    for (const hook of [hooks[url.pathname], hooks['*']].filter(Boolean)) {
      if (await hook(req, res, { n, url, requests })) return;
    }
    const file = path.join(dir, path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    sendFile(req, res, file, types[path.extname(file)] || 'application/octet-stream');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, requests, counts, server, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const range = (req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- fake OPFS backed by real files (exercises the disk-backed code path) ----------
function notFound(name) { return Object.assign(new Error(name + ' not found'), { name: 'NotFoundError' }); }
class FakeDirectory {
  constructor(dir) { this.path = dir; fs.mkdirSync(dir, { recursive: true }); }
  async getDirectoryHandle(name, { create = false } = {}) {
    const p = path.join(this.path, name);
    if (!fs.existsSync(p) && !create) throw notFound(name);
    return new FakeDirectory(p);
  }
  async getFileHandle(name, { create = false } = {}) {
    const p = path.join(this.path, name);
    if (!fs.existsSync(p)) { if (!create) throw notFound(name); fs.writeFileSync(p, ''); }
    return new FakeFile(p);
  }
  async removeEntry(name, { recursive = false } = {}) {
    const p = path.join(this.path, name);
    if (!fs.existsSync(p)) throw notFound(name);
    fs.rmSync(p, { recursive, force: true });
  }
  async *keys() { for (const name of fs.readdirSync(this.path)) yield name; }
}
class FakeFile {
  constructor(p) { this.path = p; }
  async getFile() { return fs.openAsBlob(this.path); }
  async createWritable({ keepExistingData = false } = {}) {
    const swap = this.path + '.crswap';
    if (keepExistingData) fs.copyFileSync(this.path, swap); else fs.writeFileSync(swap, '');
    const fd = fs.openSync(swap, 'r+');
    let position = keepExistingData ? fs.statSync(swap).size : 0;
    const target = this.path;
    return {
      async write(data) { const bytes = data instanceof Uint8Array ? data : new Uint8Array(data); fs.writeSync(fd, bytes, 0, bytes.length, position); position += bytes.length; },
      async close() { fs.closeSync(fd); fs.renameSync(swap, target); },
      async abort() { try { fs.closeSync(fd); } catch {} fs.rmSync(swap, { force: true }); }
    };
  }
}
function fakeStorage(dir) { const top = new FakeDirectory(dir); return { getDirectory: async () => top }; }

// ---------- Chrome API mocks ----------
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener: fn => listeners.includes(fn) };
}
function storageArea(data = {}) {
  return { data, async get(key) {
    if (key === null || key === undefined) return structuredClone(data);
    const keys = Array.isArray(key) ? key : [key];
    return structuredClone(Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])));
  }, async set(values) { Object.assign(data, structuredClone(values)); },
  async remove(key) { for (const k of Array.isArray(key) ? key : [key]) delete data[k]; } };
}
// Saves Blob URLs to disk by streaming (never buffers the whole output in the test process).
function downloadsMock(outDir, { blobs }) {
  const items = new Map();
  let next = 1;
  const onChanged = event();
  return { items, onChanged,
    async download({ url, filename }) {
      const id = next++;
      const blob = blobs.get(url);
      const file = path.join(outDir, path.basename(filename));
      const item = { id, url, filename, state: 'in_progress', bytesReceived: 0, exists: true, file };
      items.set(id, item);
      (async () => {
        if (!blob) { item.state = 'interrupted'; item.error = 'NETWORK_FAILED'; }
        else {
          const out = fs.createWriteStream(file);
          for await (const chunk of blob.stream()) { if (!out.write(chunk)) await new Promise(r => out.once('drain', r)); item.bytesReceived += chunk.length; }
          await new Promise(r => out.end(r));
          item.fileSize = fs.statSync(file).size; item.state = 'complete';
        }
        for (const fn of [...onChanged.listeners]) fn({ id, state: { current: item.state } });
      })();
      return id;
    },
    async search({ id }) { return items.has(id) ? [structuredClone({ ...items.get(id) })] : []; },
    async cancel(id) { const item = items.get(id); if (item && item.state === 'in_progress') item.state = 'interrupted'; },
    async pause() {}, async resume() {}
  };
}
class TsWorker {
  constructor(file) {
    if (!/ts-converter\.js$/.test(file)) throw new Error('Worker ' + file + ' is unavailable in Node tests.');
    const worker = this;
    this.context = vm.createContext({ Blob, Uint8Array, console, importScripts() {},
      self: { postMessage(data) { if (!worker.stopped) queueMicrotask(() => worker.onmessage?.({ data })); } } });
    for (const f of ['vendor/mux.min.js', 'ts-converter.js']) vm.runInContext(read(f), this.context);
  }
  postMessage(data) { queueMicrotask(() => { try { this.context.self.onmessage({ data }); } catch (error) { this.onerror?.({ message: error.message }); } }); }
  terminate() { this.stopped = true; }
}

// Run downloader.js as the extension download page would.
async function runDownloader({ params, outDir, storageDir, local = {}, runtime, fetchImpl, config = {}, onContext } = {}) {
  const elements = new Map();
  const element = () => ({ textContent: '', style: {}, hidden: false, disabled: false, children: [], append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); } });
  const blobs = new Map();
  class LocalURL extends URL {
    static createObjectURL(blob) { const key = 'blob:vg-test/' + (blobs.size + 1) + '-' + Math.random(); blobs.set(key, blob); return key; }
    static revokeObjectURL(url) { setTimeout(() => blobs.delete(url), 2000); }
  }
  const downloads = downloadsMock(outDir, { blobs });
  const requests = [];
  const chrome = { downloads, storage: { local: storageArea(local) }, runtime: runtime || undefined };
  const context = vm.createContext({ URL: LocalURL, URLSearchParams, Blob, Response, Headers, Uint8Array, AbortSignal, AbortController, DOMException,
    TextDecoder, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, crypto: webcrypto, console, atob, btoa, chrome,
    Worker: TsWorker, VG_CONFIG: { ENABLE_YOUTUBE: false, ...config },
    navigator: storageDir ? { storage: fakeStorage(storageDir) } : {},
    location: { search: '?' + new URLSearchParams(params) },
    document: { title: '', querySelector: s => { if (!elements.has(s)) elements.set(s, element()); return elements.get(s); }, createElement: element },
    fetch: async (url, options) => { requests.push(String(url)); return (fetchImpl || fetch)(url, options); } });
  onContext?.(context);
  for (const file of SHARED) vm.runInContext(read(file), context);
  await vm.runInContext(read('downloader.js'), context);
  const saved = [...downloads.items.values()].filter(item => item.state === 'complete');
  return { context, saved, status: elements.get('#status')?.textContent || '', log: elements.get('#log')?.textContent || '', requests, downloads, local: chrome.storage.local.data };
}

// Load the service worker (background.js + modules) with mocked Chrome APIs.
function loadBackground({ session = {}, local = {}, tabs = new Map(), enableYouTube = true, fetchImpl, extra = {} } = {}) {
  const sessionArea = storageArea(session), localArea = storageArea(local);
  let nextTab = 1000, nextDownload = 1;
  const downloads = new Map();
  const sent = [];
  const chrome = {
    storage: { session: sessionArea, local: localArea },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    webRequest: Object.fromEntries(['onHeadersReceived', 'onCompleted', 'onErrorOccurred', 'onSendHeaders', 'onBeforeRequest', 'onBeforeRedirect'].map(n => [n, event()])),
    tabs: { onUpdated: event(), onRemoved: event(),
      async get(id) { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); },
      async create(options) { const id = nextTab++; tabs.set(id, { id, ...options }); return { id }; },
      async sendMessage(tabId, message) { sent.push({ tabId, message }); if (!tabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.'); return { ok: true }; } },
    downloads: { onChanged: event(), items: downloads,
      async download(options) { const id = nextDownload++; downloads.set(id, { id, ...options, state: 'in_progress', bytesReceived: 0, totalBytes: 100 }); return id; },
      async search({ id }) { return downloads.has(id) ? [structuredClone(downloads.get(id))] : []; },
      async pause(id) { downloads.get(id).paused = true; }, async resume(id) { downloads.get(id).paused = false; },
      async cancel(id) { const d = downloads.get(id); if (d) { d.state = 'interrupted'; d.error = 'USER_CANCELED'; } } },
    runtime: { onMessage: event(), onConnect: event(), getURL: file => 'chrome-extension://test/' + file },
    scripting: { async executeScript() { return []; } },
    ...extra
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, Response, Headers, Uint8Array, AbortSignal, AbortController, DOMException, structuredClone,
    console, atob, btoa, crypto: webcrypto, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    fetch: fetchImpl || (async () => { throw new Error('HTTP 403'); }),
    importScripts(...files) {
      for (const file of files) {
        if (file === 'config.js') context.VG_CONFIG = { ENABLE_YOUTUBE: enableYouTube, enableYouTube, DEBUG: false };
        else vm.runInContext(read(file), context);
      }
    } });
  vm.runInContext(read('background.js'), context);
  const send = (msg, sender = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No reply for ' + msg.cmd)), 5000);
    let handled = false;
    for (const fn of chrome.runtime.onMessage.listeners) if (fn(msg, sender, reply => { clearTimeout(timer); resolve(reply); }) === true) handled = true;
    if (!handled) { clearTimeout(timer); resolve(undefined); }
  });
  const request = async (cmd, data = {}, sender) => {
    const reply = await send({ cmd, ...data }, sender);
    if (!reply?.ok) throw new Error(reply?.error || 'no reply');
    return reply.result;
  };
  const fire = (name, details) => { for (const fn of chrome.webRequest[name].listeners) fn(details); };
  return { context, chrome, send, request, fire, tabs, sent, session: sessionArea.data, local: localArea.data };
}
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
let passed = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); }); }
const summary = label => console.log(`Passed: ${label} (${passed} checks).`);

module.exports = { root, read, SHARED, tempDir, ffmpeg, probe, decodes, media, serve, sendFile, fakeStorage, FakeDirectory, storageArea, event,
  downloadsMock, TsWorker, runDownloader, loadBackground, settle, check, summary, vm, fs, path };
