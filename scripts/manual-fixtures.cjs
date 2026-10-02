// Local, generated media fixtures. Requires ffmpeg; no network downloads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-scanner-fixtures-'));
const port = Number(process.env.VG_TEST_PORT) || 8765;
const base = `http://127.0.0.1:${port}`;
const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:a','libmp3lame',path.join(temp,'tone.mp3')]);
ffmpeg(['-f','lavfi','-i','testsrc=size=160x90:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
  '-t','4','-c:v','libx264','-pix_fmt','yuv420p','-g','25','-c:a','aac',path.join(temp,'video.mp4')]);
fs.writeFileSync(path.join(temp,'key.bin'), crypto.randomBytes(16));
fs.writeFileSync(path.join(temp,'key-info.txt'), base + '/key.bin\n' + path.join(temp,'key.bin') + '\n');
for (const type of ['clear','encrypted']) {
  ffmpeg(['-i',path.join(temp,'video.mp4'),'-c','copy','-f','hls','-hls_time','1',
    ...(type === 'encrypted' ? ['-hls_key_info_file',path.join(temp,'key-info.txt')] : []),
    '-hls_segment_filename',path.join(temp,type+'-%d.ts'),path.join(temp,type+'.m3u8')]);
}
fs.writeFileSync(path.join(temp,'protected.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:1,\nclear-0.ts\n#EXT-X-ENDLIST\n');
fs.writeFileSync(path.join(temp,'protected.mpd'), '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period></MPD>');
fs.writeFileSync(path.join(temp,'clear.mpd'), '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period/></MPD>');
fs.writeFileSync(path.join(temp,'referrer.m3u8'), fs.readFileSync(path.join(temp,'clear.m3u8')));
const html = `<!doctype html><meta charset="utf-8"><title>Media Scanner test fixtures</title>
<h1>Media Scanner test fixtures</h1><p>Generated tone and test pattern: no third-party copyrighted content.</p>
<audio controls src="/tone.mp3"></audio><video controls width="320" src="/video.mp4"></video>
<ul><li><a href="/tone.mp3">MP3 link (same URL as the player)</a></li>
<li><a href="/tone.mp3?token=one">MP3 with query one</a></li><li><a href="/tone.mp3?token=two">MP3 with query two</a></li>
<li><a href="/clear.m3u8">Unencrypted HLS</a></li><li><a href="/encrypted.m3u8">AES-128 HLS</a></li>
<li><a href="/protected.m3u8">Protected SAMPLE-AES HLS</a></li><li><a href="/protected.mpd">Protected DASH</a></li>
<li><a href="/clear.mpd">Unprotected DASH (manifest only)</a></li><li><a href="/referrer.m3u8">Referrer-required HLS</a></li>
<li><a href="/retry.mp3">MP3 with two temporary failures</a></li><li><a href="/missing.mp3">Missing MP3 (error test)</a></li>
</ul><p><a href="/empty">Empty page / navigation reset</a> · <a href="/preview.html">Popup UI preview (mock Chrome API)</a></p>`;
const previewMock = `(() => {
  const entries = [
    {url:'${base}/tone.mp3',type:'audio',kind:'audio',filename:'tone.mp3',domain:'127.0.0.1',size:24429},
    {url:'${base}/video.mp4',type:'video',kind:'video',filename:'video.mp4',domain:'127.0.0.1',size:60234},
    {url:'${base}/clear.m3u8',type:'playlist',kind:'hls',filename:'clear.m3u8',domain:'127.0.0.1',size:248,protection:{status:'clear'}},
    {url:'${base}/encrypted.m3u8',type:'playlist',kind:'hls',filename:'encrypted.m3u8',domain:'127.0.0.1',size:310,protection:{status:'protected',reason:'AES-128'}},
    {url:'${base}/protected.m3u8',type:'playlist',kind:'hls',filename:'protected.m3u8',domain:'127.0.0.1',size:180,protection:{status:'protected',reason:'SAMPLE-AES · FairPlay'}},
    {url:'${base}/clear.mpd',type:'playlist',kind:'dash',filename:'clear.mpd',domain:'127.0.0.1',size:100,protection:{status:'clear'}}
  ];
  let items = structuredClone(entries), jobs = [];
  const snapshot = () => ({items:structuredClone(items),jobs:structuredClone(jobs),blobs:1,debug:{networkHits:2,domHits:6}});
  window.chrome = {
    tabs:{async query(){return [{id:1,url:'${base}/',title:'Media Scanner fixtures'}]}},
    scripting:{async executeScript(){return []}},
    runtime:{async sendMessage(msg){
      if(msg.cmd==='list')return [];
      if(msg.cmd==='clear')return true;
      if(msg.cmd==='youtube.status')return {ok:true,result:null};
      if(msg.cmd==='scanner.clear'){items=[];return {ok:true}}
      if(msg.cmd==='scanner.refresh'){items=structuredClone(entries);return {ok:true,result:snapshot()}}
      if(msg.cmd==='scanner.list')return {ok:true,result:snapshot()};
      if(msg.cmd==='scanner.download'){
        for(const url of msg.urls){const item=items.find(i=>i.url===url);if(!item||item.protection?.status==='protected')continue;
          jobs.push({id:String(jobs.length),item,status:'running',progress:.5,message:'Downloading · 50%'});}
        setTimeout(()=>{jobs.forEach(j=>{j.status='complete';j.progress=1;j.message='Downloaded ✓ (UI test)'});},3000);
        return {ok:true,result:jobs.map(j=>j.id)};
      }
      return {ok:true,result:{status:'clear'}};
    }}
  };
})();`;
const extensions = new Set(['popup.html','popup.js','config.js','style.css','shared/media.js','ui/media-tab.js','ui/youtube-tab.js',
  'shared/youtube.js','youtube/converter-worker.js','vendor/ffmpeg/ffmpeg-core.js','vendor/ffmpeg/ffmpeg-core.wasm']);
let retry = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === '/') { res.setHeader('Content-Type','text/html'); res.end(html); return; }
  if (url.pathname === '/plain') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Plain MP3 and MP4 baseline</title><h1>Direct media baseline</h1><audio controls src="/tone.mp3"></audio><video controls src="/video.mp4" width="320"></video>'); return; }
  if (url.pathname === '/empty') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Empty test page</title><h1>No media here</h1>'); return; }
  if (url.pathname === '/preview-chrome.js') { res.setHeader('Content-Type','text/javascript'); res.end(previewMock); return; }
  if (url.pathname === '/preview.html') {
    res.setHeader('Content-Type','text/html');
    res.end(fs.readFileSync(path.join(root,'popup.html'),'utf8')
      .replace('<head>','<head><script src="/preview-chrome.js"></script>')
      .replace(/src="(config.js|shared\/media.js|popup.js|ui\/media-tab.js|ui\/youtube-tab.js)"/g,'src="/extension/$1"')
      .replace('href="style.css"','href="/extension/style.css"'));
    return;
  }
  if (url.pathname === '/wasm-preview.html') {
    res.setHeader('Content-Type','text/html');
    res.setHeader('Content-Security-Policy',"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'");
    res.end('<!doctype html><meta charset="utf-8"><title>Bundled FFmpeg worker test</title><h1>Bundled FFmpeg worker test</h1><p>Generated local test-pattern video; no YouTube or remote services.</p><button id="run-mp4">Test MP4</button> <button id="run-mp3">Test MP3</button><p id="status">Ready</p><a id="save" hidden>Save converted fixture</a><video id="preview" controls width="320"></video><script src="/wasm-preview.js"></script>');return;
  }
  if (url.pathname === '/wasm-preview.js') {
    res.setHeader('Content-Type','text/javascript');
    res.end(`let blobURL;async function run(output){
      document.querySelector('#status').textContent='Loading generated fixture…';
      const bytes=await(await fetch('/video.mp4')).arrayBuffer();
      const worker=new Worker('/extension/youtube/converter-worker.js');
      worker.onmessage=({data})=>{
        if(data.type==='done'){
          if(blobURL)URL.revokeObjectURL(blobURL);
          blobURL=URL.createObjectURL(new Blob([data.data],{type:output==='mp3'?'audio/mpeg':'video/mp4'}));
          document.querySelector('#preview').src=blobURL;
          const link=document.querySelector('#save');link.href=blobURL;link.download='fixture.'+output;link.hidden=false;
          document.querySelector('#status').textContent='Passed '+output.toUpperCase()+' conversion · '+data.data.length+' bytes';worker.terminate();
        }else document.querySelector('#status').textContent=data.message||'Converting…';
      };
      worker.onerror=event=>{document.querySelector('#status').textContent='Failed: '+event.message;worker.terminate()};
      const job={output,bitrate:192,tracks:output==='mp4'?{video:{mime:'video/mp4'}}:{audio:{mime:'audio/mp4'}}};
      worker.postMessage({job,files:[{name:output==='mp4'?'video.input':'audio.input',data:bytes}]},[bytes]);
    }document.querySelector('#run-mp4').onclick=()=>run('mp4');document.querySelector('#run-mp3').onclick=()=>run('mp3');`);return;
  }
  if (url.pathname.startsWith('/extension/')) {
    const file = url.pathname.slice('/extension/'.length);
    if (!extensions.has(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':'text/javascript'); res.end(fs.readFileSync(path.join(root,file))); return;
  }
  if (url.pathname === '/referrer.m3u8' && !(req.headers.referer || '').startsWith(base + '/')) { res.writeHead(403).end('Referer required'); return; }
  if (url.pathname === '/retry.mp3' && retry++ < 2) { res.writeHead(503).end('Temporary failure'); return; }
  const filename = url.pathname === '/retry.mp3' ? 'tone.mp3' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(filename)) { res.writeHead(404).end(); return; }
  const file = path.join(temp,filename);
  if (!fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  const bytes = fs.readFileSync(file);
  res.setHeader('Content-Type',({'.mp3':'audio/mpeg','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.mpd':'application/dash+xml'})[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Content-Length',bytes.length); res.end(bytes);
});
server.listen(port,'127.0.0.1',()=>console.log('Fixtures: '+base+'\nPopup UI preview (mock APIs): '+base+'/preview.html\nPress Ctrl+C to stop.'));
process.on('SIGINT',()=>server.close(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit();}));
