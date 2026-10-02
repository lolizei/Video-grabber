// YouTube conversion tab (full build). Pipeline with explicit stages and diagnostics:
//   connect → download video → download audio → convert (FFmpeg WebAssembly) → save → verify → done
// Every stage records its result; failures report the stage, HTTP status and actual error.
// Diagnostics never contain cookies, signatures, tokens or other private URL parameters.
(() => {
  const $=selector=>document.querySelector(selector);
  const abort=new AbortController();
  let worker,job,lastReport=0,phase='download',downloadId,finished=false,cancelConversion;
  const check=()=>{if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');};
  const redact=url=>globalThis.MediaTools?.redactUrl?MediaTools.redactUrl(url):'(redacted)';
  const STAGES={connect:'Connecting to media server','download-video':'Downloading video','download-audio':'Downloading audio',
    convert:'Merging or converting',save:'Saving completed file',verify:'Verifying saved file',done:'Done'};
  const ORDER=['detect','metadata','tracks','connect','download-video','download-audio','convert','save','verify','done'];
  const diag={version:chrome.runtime.getManifest?.().version||'',started:new Date().toISOString(),stage:'start',stageLabel:'Starting',
    stages:[],tracks:{},requests:[],lastStatus:null,bytes:0,total:0,speed:0,lastOk:'',error:'',warning:'',ffmpeg:[],output:null};
  const fmt=n=>!n?'0 B':n>=1048576?(n/1048576).toFixed(1)+' MB':(n/1024).toFixed(0)+' KB';
  function stage(name){
    const now=Date.now(),current=diag.stages.at(-1);
    if(current&&current.status==='running'){current.status='ok';current.ms=now-current.started;}
    diag.stage=name;diag.stageLabel=STAGES[name]||name;
    if(name!=='done')diag.stages.push({name,label:STAGES[name]||name,status:'running',started:now});
    render();
  }
  const ok=message=>{diag.lastOk=message+' ('+new Date().toLocaleTimeString()+')';render();};
  function render(){
    const list=$('#stages');if(!list)return;
    list.replaceChildren(...diag.stages.map(s=>{const li=document.createElement('li');
      li.textContent=`${s.status==='ok'?'✓':s.status==='failed'?'✗':'…'} ${s.label}${s.ms!==undefined?' ('+(s.ms/1000).toFixed(1)+' s)':''}${s.error?' – '+s.error:''}`;
      li.className=s.status;return li;}));
    $('#diagnostics').textContent=report();
  }
  function report(){
    return JSON.stringify({...diag,stages:diag.stages.map(({started,...s})=>s)},null,2);
  }
  async function update(message,progress=0,status='running',force=false) {
    $('#status').textContent=message;$('#bar').style.width=(Math.max(0,Math.min(1,progress))*100)+'%';
    $('#progress').textContent=Math.round(progress*100)+'%';
    if(force||Date.now()-lastReport>=1000)render();
    if(!job || (!force && Date.now()-lastReport<300))return;
    lastReport=Date.now();
    await chrome.runtime.sendMessage({cmd:'youtube.progress',id:job.id,status,phase,progress,message,downloadId,
      diagnostics:JSON.parse(report())}).catch(()=>{});
  }
  function cancel() {
    if(finished || abort.signal.aborted)return;
    abort.abort();worker?.terminate();cancelConversion?.(new DOMException('Cancelled','AbortError'));
    if(downloadId!==undefined)chrome.downloads.cancel(downloadId).catch(()=>{});
    update('Cancelled',0,'cancelled',true);$('#cancel').disabled=true;
  }
  $('#cancel').onclick=cancel;
  $('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(report());$('#copy').textContent='Copied ✓';}catch{$('#copy').textContent='Copy failed';}};
  // Idle timeout: a request is only aborted when no data arrives for 30 s, so throttled but
  // progressing YouTube transfers keep going instead of being restarted from zero.
  function signal() {
    const controller=new AbortController();let timer;
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new DOMException('No data received for 30 s','TimeoutError')),30000);};
    const stop=()=>{clearTimeout(timer);controller.abort(new DOMException('Cancelled','AbortError'));};
    if(abort.signal.aborted)stop();else abort.signal.addEventListener('abort',stop,{once:true});
    arm();
    return Object.assign(controller.signal,{touch:arm,done:()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',stop);}});
  }
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{if(msg.cmd==='youtube.cancel'&&msg.id===job?.id){cancel();reply({ok:true});}});
  function httpError(status,kind){
    const text=status===403?`HTTP 403 Forbidden: YouTube refused the ${kind} stream URL. Current YouTube playback usually requires a proof-of-origin token and/or a transformed "n" parameter that only YouTube's player code produces; Video Grabber does not generate or bypass these. If the URL simply expired, replay the video and Refresh.`
      :status===404||status===410?`HTTP ${status}: the ${kind} stream URL is no longer valid (expired). Replay the video and Refresh.`
      :status===401?`HTTP 401: YouTube requires authentication for this ${kind} stream.`
      :`HTTP ${status} from the ${kind} stream server.`;
    return Object.assign(new Error(text),{fatal:[401,403,404,410].includes(status),status});
  }
  async function fetchRetry(url,kind,options={}) {
    for(let attempt=1;;attempt++) {
      check();
      const requestSignal=signal();const started=Date.now();
      try {
        let response;
        try{response=await fetch(url,{credentials:'omit',...options,signal:requestSignal});}
        catch(error){requestSignal.done();throw error;}
        diag.lastStatus=response.status;
        diag.requests.push({kind,status:response.status,ms:Date.now()-started,attempt,type:response.headers.get('content-type')||''});
        if(diag.requests.length>40)diag.requests.splice(0,diag.requests.length-40);
        response.requestSignal=requestSignal;
        if(!response.ok){requestSignal.done();throw httpError(response.status,kind);}
        if(/^text\/html|application\/json/i.test(response.headers.get('content-type')||'')){requestSignal.done();
          throw Object.assign(new Error(`The ${kind} stream returned ${response.headers.get('content-type')} instead of media (blocked or expired).`),{fatal:true});}
        return response;
      } catch(error) {
        check();
        if(!error.status)diag.requests.push({kind,status:0,ms:Date.now()-started,attempt,error:error.name==='TimeoutError'?'no data for 30 s':error.message});
        if(attempt>=4||error.fatal)throw error.name==='TimeoutError'?new Error(`The ${kind} server did not respond for 30 s.`):error;
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',stop);resolve()},600*attempt);
          const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'))};
          abort.signal.addEventListener('abort',stop,{once:true});
        });
      }
    }
  }
  const sizeOf=stream=>stream.size||Number(new URL(stream.url).searchParams.get('clen'))||0;
  // Stage "connect": one small range request per track checks reachability before committing.
  async function connect(kind,stream){
    const url=new URL(stream.url);url.searchParams.set('range','0-1023');
    const started=Date.now();
    const response=await fetchRetry(url.href,kind);
    const body=new Uint8Array(await response.arrayBuffer());response.requestSignal.done();
    let size=sizeOf(stream);
    if(!size)size=Number((response.headers.get('content-range')||'').split('/')[1])||0;
    diag.tracks[kind]={...diag.tracks[kind],connectMs:Date.now()-started,firstBytes:body.length,size};
    if(!body.length)throw new Error(`The ${kind} stream returned no data.`);
    if(size>1024&&body.length>1024)throw new Error(`The ${kind} server ignored the requested byte range (sent ${body.length} bytes). This stream type cannot be fetched in pieces.`);
    ok(`${kind} server answered HTTP ${response.status} in ${Date.now()-started} ms`);
    return size;
  }
  async function track(kind,stream,completed,totalSize) {
    const size=diag.tracks[kind].size;
    if(!size)throw new Error('The detected track has no usable size. Play the video and refresh its URLs.');
    const bytes=new Uint8Array(size);
    const chunk=9*1024*1024;let received=0;const samples=[];const startedAt=Date.now();
    for(let start=0;start<size;start+=chunk) {
      check();const end=Math.min(start+chunk,size)-1;
      const url=new URL(stream.url);url.searchParams.set('range',start+'-'+end);
      // Stream each chunk so progress and speed update continuously, even on throttled connections.
      let offset=0;
      for(let attempt=1;;attempt++){
        const response=await fetchRetry(url.href,kind);
        try{
          const reader=response.body.getReader();offset=0;
          for(;;){
            const {done,value}=await reader.read();
            if(done)break;
            response.requestSignal.touch();
            if(offset+value.length>end-start+1)throw Object.assign(new Error(`The ${kind} server returned more data than requested (range ignored).`),{fatal:true});
            bytes.set(value,start+offset);offset+=value.length;
            const now=Date.now();samples.push([now,received+offset]);while(samples.length>2&&now-samples[0][0]>5000)samples.shift();
            const all=completed+received+offset;
            const speed=samples.length>1?(samples.at(-1)[1]-samples[0][1])/Math.max(0.001,(samples.at(-1)[0]-samples[0][0])/1000):0;
            const left=speed?(totalSize-all)/speed:0;
            Object.assign(diag,{bytes:all,total:totalSize,speed:Math.round(speed)});
            if(now-startedAt>10000&&speed&&speed<150*1024&&!diag.warning)
              diag.warning=`YouTube is sending the ${kind} stream slowly (${(speed/1024).toFixed(0)} KB/s), which is how YouTube throttles URLs used outside its own player. Video Grabber does not bypass this; at this rate about ${Math.ceil(left/60)} min remain.`;
            update(`${STAGES[diag.stage]} · ${Math.round(all/totalSize*100)}% · ${fmt(all)} / ${fmt(totalSize)}${speed?' · '+(speed/1048576).toFixed(2)+' MB/s'+(left?' · '+(left>=60?Math.floor(left/60)+'m ':'')+Math.round(left%60)+'s left':''):''}${diag.warning?' · slow (throttled)':''}`,all/totalSize);
          }
          response.requestSignal.done();
          if(offset!==end-start+1)throw new Error(`Incomplete ${kind} data: ${offset} of ${end-start+1} bytes for this piece.`);
          break;
        }catch(error){
          response.requestSignal.done();check();
          if(attempt>=4||error.fatal)throw error.name==='TimeoutError'||/No data/.test(error.message)?new Error(`YouTube stopped sending the ${kind} stream for 30 s.`):error;
          await new Promise(r=>setTimeout(r,600*attempt));
        }
      }
      received+=offset;
    }
    ok(`${kind} downloaded (${fmt(size)})`);
    return bytes;
  }
  async function validate(blob) {
    // Never save or report an output that is empty or structurally invalid.
    if(!blob.size)throw new Error('FFmpeg produced an empty file.');
    const result=await DownloadEngine.validateOutput(blob,{format:job.output,expectKinds:job.output==='mp4'?['video','audio']:[]});
    if(!result.ok)throw new Error('Converted output is invalid: '+result.reason);
    diag.output={bytes:blob.size,format:job.output,tracks:(result.tracks||[]).map(t=>t.kind+' '+t.codec)};
    if(job.output==='mp3'){
      const info=YouTubeTools.mp3Info(new Uint8Array(await blob.slice(0,256*1024).arrayBuffer()));
      if(!info.ok)throw new Error('Converted output contains no MP3 audio frames.');
      if(info.bitrate!==job.bitrate)throw new Error(`MP3 bitrate is ${info.bitrate} kbps instead of the requested ${job.bitrate} kbps.`);
      diag.output.bitrate=info.bitrate;
    }
  }
  async function save(bytes) {
    check();phase='saving';stage('save');await update(STAGES.save+'…',1,'running',true);
    const blob=new Blob([bytes],{type:job.output==='mp3'?'audio/mpeg':'video/mp4'});
    await validate(blob);
    ok('output validated ('+diag.output.tracks.join(', ')+(diag.output.bitrate?' @ '+diag.output.bitrate+' kbps':'')+')');
    const url=URL.createObjectURL(blob);
    try {
      downloadId=await chrome.downloads.download({url,filename:MediaTools.filename(job.title)+' [YouTube].'+job.output,conflictAction:'uniquify'});
      if(abort.signal.aborted){await chrome.downloads.cancel(downloadId);check();}
      await new Promise((resolve,reject)=>{
        const changed=delta=>{if(delta.id!==downloadId||!delta.state)return;
          if(['complete','interrupted'].includes(delta.state.current)){
            chrome.downloads.onChanged.removeListener(changed);
            if(delta.state.current==='complete')resolve();else reject(new Error('File saving was interrupted.'));
          }};
        chrome.downloads.onChanged.addListener(changed);
        chrome.downloads.search({id:downloadId}).then(items=>{if(items[0])changed({id:downloadId,state:{current:items[0].state}})},error=>{chrome.downloads.onChanged.removeListener(changed);reject(error)});
      });
      stage('verify');
      const [item]=await chrome.downloads.search({id:downloadId}).catch(()=>[]);
      const saved=item?.fileSize>0?item.fileSize:item?.bytesReceived;
      if(item?.exists===false)throw new Error('The saved file no longer exists.');
      if(saved!==undefined&&saved!==blob.size)throw new Error('Saved file size does not match the converted output.');
      diag.output.saved=saved??blob.size;
      ok('saved file verified ('+fmt(diag.output.saved)+')');
    } finally{URL.revokeObjectURL(url);}
  }
  (async()=>{
    try {
      if(!(VG_CONFIG.ENABLE_YOUTUBE??VG_CONFIG.enableYouTube))throw new Error('YouTube conversion is disabled in this build.');
      const id=new URLSearchParams(location.search).get('job');
      job=(await chrome.storage.session.get('youtube_job')).youtube_job;
      if(!job||job.id!==id||job.status!=='running')throw new Error('This download job has expired. Start it again from Video Grabber.');
      $('#name').textContent=MediaTools.filename(job.title)+' · '+job.output.toUpperCase();
      const streams=Object.entries(job.tracks).filter(([,stream])=>stream);
      diag.output=null;diag.request={output:job.output,bitrate:job.output==='mp3'?job.bitrate:undefined};
      for(const [kind,stream] of streams)diag.tracks[kind]={itag:Number(new URL(stream.url).searchParams.get('itag'))||null,quality:stream.quality||'',
        mime:stream.mime||'',codecs:stream.codecs||'',url:redact(stream.url),size:sizeOf(stream)};
      if(job.output==='mp4')diag.plan=YouTubeTools.conversionPlan(job).description;
      // Stage: connect (reachability, HTTP status and range support for every track).
      stage('connect');await update(STAGES.connect+'…',0,'running',true);
      for(const [kind,stream] of streams)await connect(kind,stream);
      const total=streams.reduce((sum,[kind])=>sum+diag.tracks[kind].size,0);
      if(total>1.6*1024**3)throw new Error(`The selected tracks total ${fmt(total)}, more than in-browser FFmpeg can hold in memory (about 1.6 GB). Choose a lower quality or MP3.`);
      let completed=0;const files=[];
      for(const [kind,stream]of streams) {
        stage(kind==='video'?'download-video':'download-audio');
        await update(STAGES[diag.stage]+'…',completed/total,'running',true);
        const bytes=await track(kind,stream,completed,total);completed+=bytes.length;
        files.push({name:kind+'.input',data:bytes.buffer});
      }
      check();phase='convert';stage('convert');await update(STAGES.convert+' · loading FFmpeg…',0,'running',true);
      worker=new Worker('converter-worker.js');
      const result=await new Promise((resolve,reject)=>{
        cancelConversion=reject;
        worker.onmessage=({data})=>{
          if(data.log)diag.ffmpeg=data.log.slice(-15);
          if(data.type==='done')resolve(data.data);
          else if(data.type==='error')reject(new Error(data.message));
          else{ if(data.type==='loaded')ok('FFmpeg loaded in '+data.ms+' ms');
            update(STAGES.convert+(data.progress?` · ${Math.round(data.progress*100)}%`:' · '+(data.message||'')),data.progress||0);}
        };
        worker.onerror=event=>reject(new Error(event.message||'Local FFmpeg could not load. Reload the extension and try again.'));
        worker.postMessage({job,files},files.map(file=>file.data));
      });
      worker.terminate();check();ok('FFmpeg finished');
      await save(result);check();
      stage('done');finished=true;
      await update('Done ✓ Saved '+job.output.toUpperCase()+' to Downloads.',1,'complete',true);
      $('#cancel').disabled=true;
    } catch(error) {
      worker?.terminate();finished=true;$('#cancel').disabled=true;
      const current=diag.stages.at(-1);
      if(current&&current.status==='running'){current.status=abort.signal.aborted?'cancelled':'failed';current.error=abort.signal.aborted?'cancelled':error.message;current.ms=Date.now()-current.started;}
      diag.error=abort.signal.aborted?'':error.message;
      await update(abort.signal.aborted?'Cancelled':`Failed at "${diag.stageLabel}": ${error.message}`,0,abort.signal.aborted?'cancelled':'failed',true);
      $('#log').textContent=abort.signal.aborted?'':'Copy the diagnostics below if you report this problem. They contain no cookies, signatures or tokens.';
    }
  })();
})();
