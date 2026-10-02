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
// 1.5.0 streaming fixtures: separate audio renditions, DASH variants, encrypted init, players.
const { media } = require('./lib/harness.cjs');
media.hlsFmp4Separate(temp); media.hlsTsSeparate(temp);
media.dash(temp, 'dash-timeline'); media.dash(temp, 'dash-number', ['-use_timeline', '0']); media.dash(temp, 'dash-single', ['-single_file', '1']);
try { media.dashWebm(temp, 'dash-webm'); } catch { console.warn('libvpx/libopus unavailable: WebM DASH fixture skipped'); }
media.cencMp4(temp, 'cenc.mp4');
fs.writeFileSync(path.join(temp,'widevine.mpd'), '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><SegmentTemplate media="dash-timeline-0-$Number%05d$.m4s" initialization="dash-timeline-init-0.m4s" duration="1" startNumber="1"/><Representation id="0" bandwidth="1" height="180"/></AdaptationSet></Period></MPD>');
{
  const b = fs.readFileSync(path.join(temp,'cenc.mp4'));
  let o = 0, moovEnd = 0; while (o + 8 <= b.length) { const size = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8); if (type === 'moov') moovEnd = o + size; o += size; }
  fs.writeFileSync(path.join(temp,'cenc-init.m3u8'), `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="cenc.mp4",BYTERANGE="${moovEnd}@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:${b.length - moovEnd}@${moovEnd}\ncenc.mp4\n#EXT-X-ENDLIST\n`);
}
fs.writeFileSync(path.join(temp,'smooth.ism'), '');
const future = Math.floor(Date.now() / 1000) + 7200, past = Math.floor(Date.now() / 1000) - 600;
const html = `<!doctype html><meta charset="utf-8"><title>Media Scanner test fixtures</title>
<h1>Media Scanner test fixtures</h1><p>Generated tone and test pattern: no third-party copyrighted content.</p>
<audio controls src="/tone.mp3"></audio><video controls width="320" src="/video.mp4"></video>
<ul><li><a href="/tone.mp3">MP3 link (same URL as the player)</a></li>
<li><a href="/tone.mp3?token=one">MP3 with query one</a></li><li><a href="/tone.mp3?token=two">MP3 with query two</a></li>
<li><a href="/clear.m3u8">Unencrypted HLS</a></li><li><a href="/encrypted.m3u8">AES-128 HLS</a></li>
<li><a href="/protected.m3u8">Protected SAMPLE-AES HLS</a></li><li><a href="/protected.mpd">Protected DASH</a></li>
<li><a href="/clear.mpd">Unprotected DASH (manifest only)</a></li><li><a href="/referrer.m3u8">Referrer-required HLS</a></li>
<li><a href="/retry.mp3">MP3 with two temporary failures</a></li><li><a href="/missing.mp3">Missing MP3 (error test)</a></li>
</ul><h2>1.5.0 streaming engine</h2><ul>
<li><a href="/fmp4-master.m3u8">HLS fMP4, two qualities + separate English audio</a></li>
<li><a href="/ts-master.m3u8">HLS MPEG-TS with separate audio rendition</a></li>
<li><a href="/dash-timeline.mpd">DASH SegmentTemplate + SegmentTimeline (2 qualities + audio)</a></li>
<li><a href="/dash-number.mpd">DASH $Number$ template</a></li><li><a href="/dash-single.mpd">DASH SegmentList byte ranges (single files)</a></li>
<li><a href="/dash-webm.mpd">DASH WebM (VP9/Opus)</a></li>
<li><a href="/widevine.mpd">DASH with Widevine ContentProtection</a></li><li><a href="/cenc-init.m3u8">HLS whose init segment is CENC-encrypted</a></li>
<li><a href="/smooth.ism/Manifest">Smooth Streaming manifest (unsupported format)</a></li>
<li><a href="/redirect.mp4">Redirect to a signed CDN URL</a></li><li><a href="/expired.mp4?Expires=${past}&amp;Signature=x&amp;Key-Pair-Id=TEST">Expired signed URL</a></li>
<li><a href="/login.mp4">URL that returns a login page</a></li><li><a href="/big-test.mp4">Large 1 GB generated file (pause/resume test; not playable media)</a></li>
</ul><p><a href="/player">JavaScript player page (media only in script/config)</a></p><p><a href="/empty">Empty page / navigation reset</a> · <a href="/preview.html">Popup UI preview (mock Chrome API)</a></p>`;
const previewMock = `(() => {
  const entries = [
    {url:'${base}/tone.mp3',type:'audio',kind:'audio',filename:'tone.mp3',domain:'127.0.0.1',size:24429},
    {url:'${base}/video.mp4',type:'video',kind:'video',filename:'video.mp4',domain:'127.0.0.1',size:60234},
    {url:'${base}/clear.m3u8',type:'playlist',kind:'hls',filename:'clear.m3u8',domain:'127.0.0.1',size:248,protection:{status:'clear'}},
    {url:'${base}/fmp4-master.m3u8',type:'playlist',kind:'hls',filename:'fmp4-master.m3u8',domain:'127.0.0.1',size:366,pageHost:'site.example',cdn:{provider:'Amazon CloudFront'},
      protection:{status:'clear'},details:{variants:[{height:180,bandwidth:515900,codecs:'avc1.64000d,mp4a.40.2'},{height:90,bandwidth:240900,codecs:'avc1.64000c,mp4a.40.2'}],
      audio:[{name:'English',language:'en',url:'${base}/fmp4-English.m3u8'},{name:'Deutsch',language:'de',url:'${base}/fmp4-English.m3u8?de'}],container:'fmp4',duration:4,segmentHosts:['segments.cdn.example']}},
    {url:'${base}/widevine.mpd',type:'playlist',kind:'dash',filename:'widevine.mpd',domain:'127.0.0.1',size:300,protection:{status:'protected',reason:'DASH ContentProtection',label:'DRM-protected (Widevine)'}},
    {url:'${base}/expired.mp4?Expires=1&Signature=x&Key-Pair-Id=T',type:'video',kind:'video',filename:'expired.mp4',domain:'127.0.0.1',size:0,status:'expired',signed:{provider:'CloudFront signed URL',expiresAt:1000}},
    {url:'${base}/encrypted.m3u8',type:'playlist',kind:'hls',filename:'encrypted.m3u8',domain:'127.0.0.1',size:310,protection:{status:'protected',reason:'AES-128'}},
    {url:'${base}/protected.m3u8',type:'playlist',kind:'hls',filename:'protected.m3u8',domain:'127.0.0.1',size:180,protection:{status:'protected',reason:'SAMPLE-AES · FairPlay'}},
    {url:'${base}/clear.mpd',type:'playlist',kind:'dash',filename:'clear.mpd',domain:'127.0.0.1',size:100,protection:{status:'clear'}}
  ];
  let items = structuredClone(entries), jobs = [];
  const snapshot = () => ({items:structuredClone(items),jobs:structuredClone(jobs),blobs:1,eme:null,segments:12,debug:{networkHits:2,domHits:6,playerHits:1,redirectHits:1,segmentHosts:['127.0.0.1']}});
  window.chrome = {
    tabs:{async query(){return [{id:1,url:'${base}/',title:'Media Scanner fixtures'}]}},
    scripting:{async executeScript(){return []}},
    runtime:{async sendMessage(msg){
      if(msg.cmd==='list')return [];
      if(msg.cmd==='clear')return true;
      if(msg.cmd==='youtube.status')return {ok:true,result:null};
      if(msg.cmd==='youtube.tracks')return {ok:true,result:{items:[],debug:{networkHits:0,resourceHits:0}}};
      if(msg.cmd==='scanner.clear'){items=[];return {ok:true}}
      if(msg.cmd==='scanner.refresh'){items=structuredClone(entries);return {ok:true,result:snapshot()}}
      if(msg.cmd==='scanner.list')return {ok:true,result:snapshot()};
      if(msg.cmd==='scanner.settings')return {ok:true,result:{concurrency:4,retries:4}};
      if(msg.cmd==='scanner.probe')return {ok:true,result:{status:'available'}};
      if(msg.cmd==='scanner.control'){const j=jobs.find(x=>x.id===msg.id);if(j){if(msg.action==='cancel'){j.status='cancelled';j.message='Cancelled';}else j.paused=msg.action==='pause';}return {ok:true,result:j}}
      if(msg.cmd==='scanner.download'){
        for(const url of msg.urls){const item=items.find(i=>i.url===url);if(!item||item.protection?.status==='protected')continue;
          jobs.push({id:String(jobs.length),item,status:'running',progress:.5,message:'Downloading · 50%',phase:'download',speed:2400000,eta:42,bytes:52000000,total:104000000});}
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
function bigFile() {
  const file = path.join(temp, 'big.bin');
  if (!fs.existsSync(file)) { const fd = fs.openSync(file, 'w'); const chunk = Buffer.alloc(8 << 20); for (let i = 0; i < 128; i++) { chunk.fill(i & 255); fs.writeSync(fd, chunk); } fs.closeSync(fd); }
  return file;
}
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
  if (url.pathname === '/player') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Player config</title><h1>Embedded player configuration</h1><div class="video-js" data-setup=\'{"sources":[{"src":"' + base.replace(/\//g,'\\/') + '\\/fmp4-master.m3u8"}]}\'></div><script>window.player={src:"' + base + '/dash-timeline.mpd"};var config={"file":"' + base.replace(/\//g,'\\/') + '\\/ts-master.m3u8"};</script><script type="application/ld+json">{"@type":"VideoObject","contentUrl":"' + base + '/video.mp4"}</script>'); return; }
  if (url.pathname === '/redirect.mp4') { res.writeHead(302, { Location: `/video.mp4?Expires=${future}&Signature=x&Key-Pair-Id=TEST` }).end(); return; }
  if (url.pathname === '/expired.mp4') { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Request has expired'); return; }
  if (url.pathname === '/login.mp4') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Sign in</title><form>Sign in</form>'); return; }
  if (url.pathname === '/smooth.ism/Manifest') { res.setHeader('Content-Type','application/vnd.ms-sstr+xml'); res.end('<SmoothStreamingMedia/>'); return; }
  if (url.pathname === '/big-test.mp4') { require('./lib/harness.cjs').sendFile(req, res, bigFile(), 'application/octet-stream'); return; }
  if (url.pathname === '/referrer.m3u8' && !(req.headers.referer || '').startsWith(base + '/')) { res.writeHead(403).end('Referer required'); return; }
  if (url.pathname === '/retry.mp3' && retry++ < 2) { res.writeHead(503).end('Temporary failure'); return; }
  const filename = url.pathname === '/retry.mp3' ? 'tone.mp3' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(filename)) { res.writeHead(404).end(); return; }
  const file = path.join(temp,filename);
  if (!fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  // Byte ranges are honored (DASH SegmentList/SegmentBase, resumable downloads).
  require('./lib/harness.cjs').sendFile(req, res, file, ({'.mp3':'audio/mpeg','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.mpd':'application/dash+xml','.m4s':'video/iso.segment','.ts':'video/mp2t','.webm':'video/webm'})[path.extname(file)] || 'application/octet-stream');
});
server.listen(port,'127.0.0.1',()=>console.log('Fixtures: '+base+'\nPopup UI preview (mock APIs): '+base+'/preview.html\nPress Ctrl+C to stop.'));
process.on('SIGINT',()=>server.close(()=>{fs.rmSync(temp,{recursive:true,force:true});process.exit();}));
