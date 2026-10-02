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
    self.postMessage({type:'status',message:'Converting… Loading local FFmpeg'});
    const wasm=await(await fetch(new URL('../vendor/ffmpeg/ffmpeg-core.wasm',self.location.href))).arrayBuffer();
    core=await createFFmpegCore({wasmBinary:wasm});
    core.setLogger(({message})=>{logs.push(message);if(logs.length>20)logs.shift();});
    core.setProgress(({progress})=>self.postMessage({type:'progress',progress:Math.max(0,Math.min(1,progress)),message:'Converting…'}));
    for(const file of files)core.FS.writeFile(file.name,new Uint8Array(file.data));
    const args=YouTubeTools.args(job);
    core.setTimeout(-1);
    core.exec(...args);
    const result=core.ret;core.reset();
    if(result!==0)throw new Error('FFmpeg could not convert these detected tracks. '+logs.slice(-4).join(' '));
    const bytes=core.FS.readFile('output.'+job.output);
    self.postMessage({type:'done',data:bytes},[bytes.buffer]);
  } catch(error) {
    self.postMessage({type:'error',message:error.message||'Conversion failed. The media may be too large for available browser memory.'});
  } finally {
    if(core)for(const file of [...files.map(f=>f.name),'output.'+job.output])try{core.FS.unlink(file);}catch{}
  }
};
