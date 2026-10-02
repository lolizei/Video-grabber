(() => {
  const enabled=CFG.ENABLE_YOUTUBE??CFG.enableYouTube;
  const button=document.querySelector('#youtube-tab');
  if(!enabled){button.remove();document.querySelector('#youtube-panel').remove();return;}
  const $=selector=>document.querySelector(selector);
  let active=false,tabId,items=[],refreshing=false,diagnostics={};
  const request=async(cmd,data={})=>{
    const reply=await chrome.runtime.sendMessage({cmd:'youtube.'+cmd,...data});
    if(!reply?.ok)throw new Error(reply?.error||'YouTube converter is unavailable.');return reply.result;
  };
  function renderTracks() {
    const mp3=$('#youtube-output').value==='mp3';
    $('#youtube-quality').hidden=mp3;$('#youtube-bitrate').hidden=!mp3;
    $('#youtube-quality-label').hidden=mp3;$('#youtube-bitrate-label').hidden=!mp3;
    const selected=$('#youtube-quality').value;
    const qualities=[...new Set(items.filter(item=>item.track!=='a').map(item=>item.quality))].sort((a,b)=>(parseInt(b)||0)-(parseInt(a)||0));
    $('#youtube-quality').replaceChildren();
    for(const quality of qualities)$('#youtube-quality').add(new Option(quality,quality));
    if(qualities.includes(selected))$('#youtube-quality').value=selected;
    $('#youtube-start').disabled=!items.length||(!mp3&&!qualities.length);
    const languages=[...new Set(items.filter(item=>item.track==='a'&&item.audioTrack).map(item=>item.audioTrack))];
    $('#youtube-tracks').textContent=items.length?`${items.length} detected track${items.length===1?'':'s'} · ${qualities.join(', ')}${languages.length>1?' · audio: '+languages.join(', '):''}${diagnostics.expired?' · '+diagnostics.expired+' expired (replay to refresh)':''}`:
      diagnostics.configMessage?diagnostics.configMessage:
      diagnostics.unsupportedHits||diagnostics.unsupportedResources||diagnostics.unsupportedMetadata?'YouTube is using UMP/SABR segmented playback. This extension cannot download that format. No direct tracks are available for MP4/MP3 conversion.':
      'No direct YouTube tracks detected. If the extension was just installed or reloaded, reload this video page and start playback, then Refresh.';
    $('#youtube-debug').textContent=`${diagnostics.networkHits||0} network hits, ${diagnostics.resourceHits||0} media requests (${diagnostics.totalResources||0} total), ${diagnostics.metadataHits||0} direct player URLs, ${diagnostics.players||0} players, ${diagnostics.unsupportedHits||diagnostics.unsupportedResources||0} unsupported, ${diagnostics.failedHits||0} failed · tab id ${tabId??'unknown'}${diagnostics.error?' · '+diagnostics.error:''}${!items.length&&diagnostics.metadataError?' · '+diagnostics.metadataError:''}${diagnostics.metadataSkipped?' · '+diagnostics.metadataSkipped+' ciphered/protected or URL-less entries skipped':''}${diagnostics.config?' · config: '+diagnostics.config:''}${diagnostics.metadataSource?' · metadata: '+diagnostics.metadataSource:''}${diagnostics.playability&&diagnostics.playability!=='OK'?' · playability: '+diagnostics.playability:''}`;
  }
  // Stage numbering shown to the user (1–3 detection in the popup, 4–8 in the download tab).
  const STAGE_NUMBERS={connect:4,'download-video':5,'download-audio':6,convert:7,save:8,verify:8,done:8};
  const STAGE_LABELS={connect:'Connecting to media server','download-video':'Downloading video','download-audio':'Downloading audio',
    convert:'Merging or converting',save:'Saving completed file',verify:'Saving completed file (verifying)',done:'Done'};
  let lastJob=null;
  function detectionReport(){
    const d=diagnostics||{};
    return {
      '1 Detecting media':{pageScan:d.error||'ok',players:d.players||0,pageResources:d.totalResources||0,googlevideoRequests:d.resourceHits||0,
        observedNetworkHits:d.networkHits||0,unsupportedUmpSabr:(d.unsupportedHits||0)+(d.unsupportedResources||0),failedResponses:d.failedHits||0},
      '2 Retrieving metadata':{source:d.metadataSource||'(none)',error:d.metadataError||'',playability:d.playability||'',formatsListed:d.totalFormats||0,
        withDirectUrl:d.directFormats||0,ciphered:d.ciphered||0,withoutUrl:d.urlLess||0,serverAbrStreaming:!!d.unsupportedMetadata,drmFormats:d.drmFormats||0,live:!!d.live},
      '3 Discovering tracks':{usableVideo:d.usableVideo||0,usableAudio:d.usableAudio||0,expired:d.expired||0,configuration:d.config||'',reason:d.configMessage||'',
        tracks:d.trackList||[]}
    };
  }
  function renderDiagnostics(){
    const job=lastJob;
    const data={extension:chrome.runtime.getManifest?.().version||'',page:'YouTube watch page (URL omitted)',detection:detectionReport(),
      job:job?{status:job.status,output:job.output,message:job.message,diagnostics:job.diagnostics||null}:null};
    $('#youtube-diag-text').textContent=JSON.stringify(data,null,2);
    const stage=job?.diagnostics?.stage;
    $('#youtube-stage').textContent=job&&job.status==='running'&&stage&&STAGE_NUMBERS[stage]?`Stage ${STAGE_NUMBERS[stage]}/8 · ${STAGE_LABELS[stage]}`
      :job&&job.status==='failed'&&stage&&STAGE_NUMBERS[stage]&&!items.length?`Last job failed at stage ${STAGE_NUMBERS[stage]}/8 · ${STAGE_LABELS[stage]}`
      :items.length?'Stage 3/8 · Discovering tracks · '+items.length+' usable track'+(items.length===1?'':'s'):
      diagnostics.config?'Stage 3/8 · Discovering tracks · none usable':'';
  }
  $('#youtube-copy-diag').onclick=async()=>{
    try{await navigator.clipboard.writeText($('#youtube-diag-text').textContent);$('#youtube-copy-diag').textContent='Copied ✓';}
    catch{$('#youtube-copy-diag').textContent='Copy failed – select the text instead';}
    setTimeout(()=>{$('#youtube-copy-diag').textContent='Copy diagnostics';},1500);
  };
  async function jobStatus() {
    try {
      const job=await request('status');
      lastJob=job;renderDiagnostics();
      if(job) {
        $('#youtube-status').textContent=job.status==='running'?job.message:`Last job (${job.title||'YouTube'} · ${String(job.output).toUpperCase()}): ${job.message}`;
        $('#youtube-progress').value=job.progress||0;$('#youtube-progress').hidden=job.status!=='running';
        $('#youtube-cancel').hidden=job.status!=='running';
        $('#youtube-start').disabled=job.status==='running'||!items.length||($('#youtube-output').value==='mp4'&&!$('#youtube-quality').value);
      } else {$('#youtube-progress').hidden=true;$('#youtube-cancel').hidden=true;}
    } catch(error){$('#youtube-status').textContent=error.message;}
  }
  async function refresh() {
    if(refreshing)return;refreshing=true;
    try {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;
      const isYouTube=tab && /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(tab.url).hostname);
      $('#youtube-title').textContent=tab?.title||'YouTube';
      const detected=isYouTube?await request('tracks',{tabId}):{items:[],debug:{}};
      if(!items.length&&!diagnostics.config)$('#youtube-stage').textContent='Stage 1–2/8 · Detecting media and retrieving metadata…';
      items=detected.items;diagnostics=detected.debug;
      renderTracks();renderDiagnostics();
      if(!isYouTube)$('#youtube-tracks').textContent='Open a YouTube video page and start playback to detect available tracks.';
      await jobStatus();
    } catch(error){$('#youtube-status').textContent=error.message;}
    finally{refreshing=false;}
  }
  button.onclick=()=>{
    active=true;window.dispatchEvent(new Event('popup.youtube'));
    $('#youtube-panel').hidden=false;$('#video-panel').hidden=true;$('#media-panel').hidden=true;
    $('#count').hidden=true;$('#ytdlp').hidden=true;
    for(const id of ['video-tab','media-tab','youtube-tab']){
      const selected=id==='youtube-tab';$('#'+id).setAttribute('aria-selected',String(selected));$('#'+id).classList.toggle('ghost',!selected);
    }
    refresh();
  };
  for(const id of ['video-tab','media-tab'])$('#'+id).addEventListener('click',()=>{active=false;$('#youtube-panel').hidden=true;button.classList.add('ghost');button.setAttribute('aria-selected','false');});
  $('#youtube-output').onchange=()=>{renderTracks();jobStatus();};
  $('#youtube-start').onclick=async()=>{
    $('#youtube-start').disabled=true;$('#youtube-status').textContent='Starting…';
    try {
      await request('start',{tabId,output:$('#youtube-output').value,quality:$('#youtube-quality').value,bitrate:Number($('#youtube-bitrate').value)});
      await jobStatus();
    } catch(error){$('#youtube-status').textContent=error.message;renderTracks();}
  };
  $('#youtube-cancel').onclick=async()=>{try{await request('cancel');await jobStatus()}catch(error){$('#youtube-status').textContent=error.message}};
  const previousRefresh=$('#refresh').onclick,previousClear=$('#clear').onclick;
  $('#refresh').onclick=()=>active?refresh():previousRefresh();
  $('#clear').onclick=async()=>{
    if(!active)return previousClear();
    if(tabId!==undefined)await chrome.runtime.sendMessage({cmd:'clear',tabId});items=[];renderTracks();
  };
  setInterval(()=>{if(active&&!document.hidden)refresh()},2000);
})();
