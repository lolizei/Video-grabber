const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../youtube/download.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function scenario(mode) {
  const nodes=Object.fromEntries(['status','bar','progress','cancel','name','log'].map(id=>['#'+id,{style:{},textContent:''}]));
  const reports=[],saved=[];let worker,listener;
  const job={id:'test',status:'running',title:'A/b: title',output:'mp3',bitrate:192,
    tracks:{audio:{url:'https://example.googlevideo.com/videoplayback?clen=4',size:4}}};
  const url=class extends URL {};
  url.createObjectURL=()=> 'blob:output';url.revokeObjectURL=()=>{};
  const context=vm.createContext({console,URL:url,URLSearchParams,Blob,DOMException,AbortController,AbortSignal,
    setTimeout,clearTimeout,Uint8Array,Date,location:{search:'?job=test'},VG_CONFIG:{ENABLE_YOUTUBE:true},
    MediaTools:{filename:s=>s.replace(/[/:]/g,'_')},document:{querySelector:s=>nodes[s]},
    chrome:{runtime:{onMessage:{addListener:fn=>{listener=fn}},async sendMessage(message){reports.push(message)}},
      storage:{session:{async get(){return {youtube_job:mode==='expired'?null:job}}}},
      downloads:{async download(options){saved.push(options);return 1},async cancel(){},
        onChanged:{addListener(){},removeListener(){}},async search(){return [{state:'complete'}]}}},
    async fetch(_url,options){
      if(mode==='download-cancel')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError'))));
      return {ok:true,async arrayBuffer(){return new Uint8Array([1,2,3,4]).buffer}};
    },Worker:class {
      constructor(){worker=this}
      terminate(){this.terminated=true}
      postMessage(){if(mode==='complete')queueMicrotask(()=>this.onmessage({data:{type:'done',data:new Uint8Array([5]).buffer}}))}
    }});
  vm.runInContext(source,context);
  for(let i=0;i<30;i++){await tick();if(mode==='expired'||mode==='complete'){if(nodes['#cancel'].disabled)break}
    else if(mode==='download-cancel'||worker){nodes['#cancel'].onclick();break}}
  for(let i=0;i<10;i++)await tick();
  if(mode.includes('cancel')) {
    assert.equal(saved.length,0);assert.equal(reports.at(-1).status,'cancelled');
    if(worker)assert(worker.terminated);
  } else if(mode==='complete') {
    assert.equal(saved.length,1);assert.equal(saved[0].filename,'A_b_ title [YouTube].mp3');
    assert.equal(reports.at(-1).status,'complete');
    assert(reports.some(r=>r.phase==='convert'));assert(reports.some(r=>r.phase==='saving'));
  }else{assert.match(nodes['#status'].textContent,/expired/);assert.equal(saved.length,0)}
  assert.equal(typeof listener,'function');
}
(async()=>{for(const mode of ['download-cancel','conversion-cancel','complete','expired'])await scenario(mode);
  console.log('Passed: YouTube download/conversion cancellation, sanitized saving, phase reporting and expired-job errors.');
})().catch(error=>{console.error(error);process.exitCode=1});
