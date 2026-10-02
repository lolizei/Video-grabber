// Runs the actual download page and conversion worker against local FFmpeg fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hls-test-'));
const port = 18765;
const server = spawn(process.execPath, [path.join(__dirname, 'manual-fixtures.cjs')], {
  env: { ...process.env, VG_TEST_PORT: String(port) }, stdio: ['pipe','pipe','pipe']
});
const ready = new Promise((resolve, reject) => {
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; if (output.includes('Fixtures:')) resolve(); });
  server.stderr.on('data', chunk => { output += chunk; });
  server.on('exit', code => { if (code) reject(new Error(output)); });
  server.on('error', reject);
});
class ConversionWorker {
  constructor() {
    const worker = this;
    this.context = vm.createContext({ Blob, Uint8Array, console, importScripts() {},
      self: { postMessage(data) { if (!worker.stopped) worker.onmessage?.({ data }); } } });
    for (const file of ['vendor/mux.min.js','ts-converter.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),this.context);
  }
  postMessage(data) { queueMicrotask(() => {
    try { this.context.self.onmessage({ data }); } catch (error) { this.onerror?.({ message: error.message }); }
  }); }
  terminate() { this.stopped = true; }
}
async function download(file, mode = 'hls') {
  const elements = Object.fromEntries(['#name','#status','#log','#bar','#progress','#variants'].map(key => [key,{ textContent:'', style:{} }]));
  let saved;
  const requests = [];
  const blobUrls = new Map();
  class LocalURL extends URL {
    static createObjectURL(blob) { const key = 'blob:test-' + blobUrls.size; blobUrls.set(key,blob); return key; }
    static revokeObjectURL(url) { blobUrls.delete(url); }
  }
  const chrome = { downloads: {
    async download({ url, filename }) { saved = { blob: blobUrls.get(url), filename }; return 1; },
    async search() { return [{state:'complete'}]; }, onChanged: { addListener() {}, removeListener() {} }
  } };
  const params = new URLSearchParams({ mode, url: `http://127.0.0.1:${port}/` + file, name:file, auto:'1' });
  const context = vm.createContext({ URL:LocalURL, URLSearchParams, Blob, Response, Uint8Array, AbortSignal,
    crypto:webcrypto, console, chrome, Worker:ConversionWorker, setTimeout,
    location:{search:'?' + params}, document:{ querySelector: selector => elements[selector] },
    async fetch(url, options) { requests.push(url); return fetch(url, options); }
  });
  for (const source of ['shared/media.js','shared/playlists.js']) vm.runInContext(fs.readFileSync(path.join(root,source),'utf8'),context);
  await vm.runInContext(fs.readFileSync(path.join(root,'downloader.js'),'utf8'),context);
  return { saved, status:elements['#status'].textContent, requests };
}
(async () => {
  try {
    await ready;
    for (const file of ['clear.m3u8']) {
      const result = await download(file);
      assert(result.saved, result.status);
      assert.match(result.saved.filename,/\.mp4$/);
      const output = path.join(temp,result.saved.filename);
      fs.writeFileSync(output, Buffer.from(await result.saved.blob.arrayBuffer()));
      const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,duration','-of','json',output],{encoding:'utf8'}));
      assert.deepEqual(probe.streams.map(s=>s.codec_name).sort(),['aac','h264']);
      assert(probe.streams.every(s=>Number(s.duration)>=3.9 && Number(s.duration)<4.3));
      execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-']);
      assert.match(result.status,/Done/);
    }
    for (const [file,mode] of [['encrypted.m3u8','hls'],['protected.m3u8','hls'],['protected.mpd','manifest']]) {
      const result = await download(file,mode);
      assert.equal(result.saved,undefined);
      assert.match(result.status,/Protected stream/);
      assert.equal(result.requests.length,1);
    }
    const dash = await download('clear.mpd','manifest');
    assert.equal(dash.saved.filename,'clear.mpd');
    assert.match(await dash.saved.blob.text(),/<MPD/);
    for (const file of ['protected.m3u8','protected.mpd']) {
      const result = await download(file,'raw-playlist');
      assert.equal(result.saved,undefined);
      assert.equal(result.requests.length,0);
    }
    console.log('Passed: clear HLS MP4 audio/video; encrypted/DRM blocking before segment/key requests; protected raw-download mode removed.');
  } finally {
    server.kill(); fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
