(() => {
  const $=selector=>document.querySelector(selector);
  const abort=new AbortController();
  let worker,job,lastReport=0,phase='download',downloadId,finished=false,cancelConversion;
  const check=()=>{if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');};
  async function update(message,progress=0,status='running',force=false) {
    $('#status').textContent=message;$('#bar').style.width=(Math.max(0,Math.min(1,progress))*100)+'%';
    $('#progress').textContent=Math.round(progress*100)+'%';
    if(!job || (!force && Date.now()-lastReport<300))return;
    lastReport=Date.now();
    await chrome.runtime.sendMessage({cmd:'youtube.progress',id:job.id,status,phase,progress,message}).catch(()=>{});
  }
  function cancel() {
    if(finished || abort.signal.aborted)return;
    abort.abort();worker?.terminate();cancelConversion?.(new DOMException('Cancelled','AbortError'));
    if(downloadId!==undefined)chrome.downloads.cancel(downloadId).catch(()=>{});
    update('Cancelled',0,'cancelled',true);$('#cancel').disabled=true;
  }
  $('#cancel').onclick=cancel;
  function signal() {
    const controller=new AbortController();
    const signals=[abort.signal,AbortSignal.timeout(30000)];
    const stop=()=>{controller.abort();for(const value of signals)value.removeEventListener('abort',stop)};
    for(const value of signals){if(value.aborted)stop();else value.addEventListener('abort',stop,{once:true});}
    return controller.signal;
  }
  chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{if(msg.cmd==='youtube.cancel'&&msg.id===job?.id){cancel();reply({ok:true});}});
  async function fetchRetry(url,options={}) {
    for(let attempt=1;;attempt++) {
      check();
      try {
        const response=await fetch(url,{credentials:'omit',...options,signal:signal()});
        if(!response.ok){
          const fatal=[401,403,404,410].includes(response.status);
          throw Object.assign(new Error(response.status===403?'HTTP 403: YouTube rejected this track URL. It expired or requires a player token that Video Grabber does not compute. Replay the video and Refresh.'
            :fatal?'HTTP '+response.status+': the track URL is no longer valid. Replay the video and Refresh.':'HTTP '+response.status),{fatal});
        }
        return response;
      } catch(error) {
        check();if(attempt>=4||error.fatal)throw error;
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',stop);resolve()},600*attempt);
          const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'))};
          abort.signal.addEventListener('abort',stop,{once:true});
        });
      }
    }
  }
  async function track(stream,completed,totalSize) {
    let size=stream.size||Number(new URL(stream.url).searchParams.get('clen'))||0;
    if(!size) {
      const response=await fetchRetry(stream.url,{headers:{Range:'bytes=0-0'}});
      size=Number((response.headers.get('content-range')||'').split('/')[1])||Number(response.headers.get('content-length'))||0;
      await response.body?.cancel();
    }
    if(!size)throw new Error('The detected track has no usable size. Play the video and refresh its URLs.');
    const bytes=new Uint8Array(size);
    const chunk=9*1024*1024;let received=0;
    for(let start=0;start<size;start+=chunk) {
      check();const end=Math.min(start+chunk,size)-1;
      const url=new URL(stream.url);url.searchParams.set('range',start+'-'+end);
      const response=await fetchRetry(url.href);
      const part=new Uint8Array(await response.arrayBuffer());
      if(part.length!==end-start+1)throw new Error('The server returned an incomplete track or ignored its range. Refresh the detected URLs.');
      bytes.set(part,start);received+=part.length;
      await update('Downloading… '+Math.round((completed+received)/(totalSize||size)*100)+'%',(completed+received)/(totalSize||size));
    }
    return bytes;
  }
  async function validate(blob) {
    // Never save or report an output that is empty or structurally invalid.
    if(globalThis.DownloadEngine){
      const result=await DownloadEngine.validateOutput(blob,{format:job.output,expectKinds:job.output==='mp4'?['video','audio']:[]});
      if(!result.ok)throw new Error('Converted output is invalid: '+result.reason);
    } else if(!blob.size) throw new Error('Converted output is empty.');
  }
  async function save(bytes) {
    check();phase='saving';await update('Saving…',1,'running',true);
    const blob=new Blob([bytes],{type:job.output==='mp3'?'audio/mpeg':'video/mp4'});
    await validate(blob);
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
      const [item]=await chrome.downloads.search({id:downloadId}).catch(()=>[]);
      const saved=item?.fileSize>0?item.fileSize:item?.bytesReceived;
      if(item?.exists===false)throw new Error('The saved file no longer exists.');
      if(saved!==undefined&&saved!==blob.size)throw new Error('Saved file size does not match the converted output.');
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
      const total=streams.reduce((sum,[,stream])=>sum+(stream.size||Number(new URL(stream.url).searchParams.get('clen'))||0),0);
      let completed=0;const files=[];
      for(const [kind,stream]of streams) {
        const bytes=await track(stream,completed,total);completed+=bytes.length;
        files.push({name:kind+'.input',data:bytes.buffer});
      }
      check();phase='convert';await update('Converting…',0,'running',true);
      worker=new Worker('converter-worker.js');
      const result=await new Promise((resolve,reject)=>{
        cancelConversion=reject;
        worker.onmessage=({data})=>{
          if(data.type==='done')resolve(data.data);
          else if(data.type==='error')reject(new Error(data.message));
          else update(data.message||'Converting…',data.progress||0);
        };
        worker.onerror=event=>reject(new Error(event.message||'Local FFmpeg could not load. Reload the extension and try again.'));
        worker.postMessage({job,files},files.map(file=>file.data));
      });
      worker.terminate();check();await save(result);check();finished=true;
      await update('Done ✓ Saved '+job.output.toUpperCase()+' to Downloads.',1,'complete',true);
      $('#cancel').disabled=true;
    } catch(error) {
      worker?.terminate();finished=true;$('#cancel').disabled=true;
      await update(abort.signal.aborted?'Cancelled':'Failed: '+error.message,0,abort.signal.aborted?'cancelled':'failed',true);
      $('#log').textContent=abort.signal.aborted?'':'Reload the source video and refresh detected tracks if the URL expired. Large files may exceed available browser memory.';
    }
  })();
})();
