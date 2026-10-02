// Test the production worker with the actual bundled WebAssembly core, not native FFmpeg conversion.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vg-youtube-wasm-'));
const native=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error',...args]);
async function convert(job,files) {
  return new Promise((resolve,reject)=>{
    const context=vm.createContext({console,URL,Response,performance,TextDecoder,TextEncoder,
      self:{location:{href:'https://extension.test/youtube/converter-worker.js'},postMessage(msg){
        if(msg.type==='done')resolve(msg.data);else if(msg.type==='error')reject(new Error(msg.message));
      }},async fetch(){return new Response(fs.readFileSync(path.join(root,'vendor/ffmpeg/ffmpeg-core.wasm')))},
      importScripts(...files){for(const file of files)vm.runInContext(fs.readFileSync(path.resolve(root,'youtube',file),'utf8'),context)}
    });
    try {
      vm.runInContext(fs.readFileSync(path.join(root,'youtube/converter-worker.js'),'utf8'),context);
      context.self.onmessage({data:{job,files}}).catch(reject);
    }catch(error){reject(new Error(error.message))}
  });
}
const input=(file,name)=>({name,data:fs.readFileSync(path.join(temp,file))});
(async()=>{
  try {
    native(['-f','lavfi','-i','testsrc=size=160x90:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
      '-t','2','-map','0:v','-c:v','libx264','-pix_fmt','yuv420p','-an',path.join(temp,'video.mp4'),
      '-t','2','-map','1:a','-c:a','aac',path.join(temp,'audio.m4a')]);
    // YouTube-style VP9/Opus WebM and AV1 MP4 adaptive tracks.
    native(['-f','lavfi','-i','testsrc=size=160x90:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
      '-t','2','-map','0:v','-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-an',path.join(temp,'video.webm'),
      '-t','2','-map','1:a','-c:a','libopus',path.join(temp,'audio.webm')]);
    let av1=true;
    try{native(['-f','lavfi','-i','testsrc=size=160x90:rate=25','-t','2','-c:v','libaom-av1','-cpu-used','8','-b:v','100k','-an',path.join(temp,'video-av1.mp4')]);}
    catch{try{native(['-f','lavfi','-i','testsrc=size=160x90:rate=25','-t','2','-c:v','libsvtav1','-an',path.join(temp,'video-av1.mp4')]);}catch{av1=false;}}
    const shared=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(root,'shared/youtube.js'),'utf8'),shared);
    const items=[{kind:'chunked',group:'yt',track:'v',quality:'1080p',mime:'video/mp4'},
      {kind:'chunked',group:'yt',track:'a',quality:'128k',mime:'audio/mp4'}];
    assert(shared.YouTubeTools.chooseTracks(items,'mp4','1080p').audio);
    assert.throws(()=>shared.YouTubeTools.chooseTracks(items.slice(0,1),'mp4','1080p'),/audio/);
    assert.throws(()=>shared.YouTubeTools.chooseTracks(items,'mp4','720p'),/quality/);
    const cases=[{output:'mp4',tracks:{video:{mime:'video/mp4'},audio:{mime:'audio/mp4'}}},
      {output:'mp4',tracks:{video:{mime:'video/webm',codecs:'vp9'},audio:{mime:'audio/webm',codecs:'opus'}},files:['video.webm','audio.webm'],expect:['aac','vp9']},
      ...(av1?[{output:'mp4',tracks:{video:{mime:'video/mp4',codecs:'av01.0.00M.08'},audio:{mime:'audio/mp4'}},files:['video-av1.mp4','audio.m4a'],expect:['aac','av1']}]:[]),
      ...[128,192,320].map(bitrate=>({output:'mp3',bitrate,tracks:{audio:{mime:'audio/mp4'}}}))];
    for(const job of cases) {
      const files=job.files?[input(job.files[0],'video.input'),input(job.files[1],'audio.input')]:job.output==='mp4'?[input('video.mp4','video.input'),input('audio.m4a','audio.input')]:[input('audio.m4a','audio.input')];
      const started=Date.now();
      const bytes=await convert(job,files);const output=path.join(temp,'output.'+job.output);fs.writeFileSync(output,bytes);
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,duration,bit_rate','-of','json',output],{encoding:'utf8'}));
      assert.deepEqual(probe.streams.map(s=>s.codec_name).sort(),job.expect||(job.output==='mp4'?['aac','h264']:['mp3']));
      console.log('  '+job.output+' '+(job.expect||[]).join('+')+(job.bitrate?' '+job.bitrate+'k':'')+': '+(Date.now()-started)+' ms');
      assert(probe.streams.every(s=>Number(s.duration)>=1.9&&Number(s.duration)<2.2));
      if(job.output==='mp3')assert.equal(Number(probe.streams[0].bit_rate),job.bitrate*1000);
      native(['-i',output,'-f','null','-']);
    }
    console.log('Passed: bundled WASM worker merges H.264/AAC'+(av1?', AV1/AAC':'')+' and VP9/Opus tracks into MP4 (video copied, not re-encoded) and encodes MP3 at 128/192/320 kbps; outputs decode successfully.');
  }finally{fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error.message);process.exitCode=1});
