// Single-thread ffmpeg.wasm: only packaged scripts and WASM are loaded.
importScripts('../config.js','../shared/youtube.js');
if (!(VG_CONFIG.ENABLE_YOUTUBE ?? VG_CONFIG.enableYouTube)) throw new Error('YouTube conversion is disabled.');
importScripts('../vendor/ffmpeg/ffmpeg-core.js');
let busy=false;
self.onmessage=async({data:{job,files}})=>{
  if(busy)return;
  busy=true;
  let core;
  const logs=[];
  try {
    self.postMessage({type:'status',message:'loading FFmpeg'});
    const started=Date.now();
    const response=await fetch(new URL('../vendor/ffmpeg/ffmpeg-core.wasm',self.location.href));
    if(!response.ok)throw new Error('The bundled FFmpeg WebAssembly file could not be loaded (HTTP '+response.status+').');
    const wasm=await response.arrayBuffer();
    core=await createFFmpegCore({wasmBinary:wasm});
    self.postMessage({type:'loaded',ms:Date.now()-started,message:'FFmpeg loaded'});
    core.setLogger(({message})=>{logs.push(message);if(logs.length>40)logs.shift();});
    core.setProgress(({progress})=>self.postMessage({type:'progress',progress:Math.max(0,Math.min(1,progress)),message:'Converting…'}));
    for(const file of files){
      if(!file.data||!file.data.byteLength)throw new Error('Input '+file.name+' is empty.');
      core.FS.writeFile(file.name,new Uint8Array(file.data));
    }
    const args=YouTubeTools.args(job);
    logs.push('ffmpeg '+args.join(' '));
    core.setTimeout(-1);
    core.exec(...args);
    const result=core.ret;core.reset();
    if(result!==0)throw new Error('FFmpeg exited with code '+result+': '+(logs.filter(l=>/error|invalid|could not|unsupported|not found/i.test(l)).slice(-3).join(' ')||logs.slice(-3).join(' ')));
    const bytes=core.FS.readFile('output.'+job.output);
    if(!bytes.length)throw new Error('FFmpeg produced an empty output file.');
    self.postMessage({type:'done',data:bytes,log:logs.slice(-15)},[bytes.buffer]);
  } catch(error) {
    const memory=/memory|OOM|allocation/i.test(String(error?.message||error));
    self.postMessage({type:'error',log:logs.slice(-15),message:memory?'FFmpeg ran out of browser memory for these tracks. Choose a lower quality or MP3.':(error.message||'Conversion failed.')});
  } finally {
    if(core)for(const file of [...files.map(f=>f.name),'output.'+job.output])try{core.FS.unlink(file);}catch{}
  }
};
