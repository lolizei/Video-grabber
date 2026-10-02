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
  async function jobStatus() {
    try {
      const job=await request('status');
      if(job) {
        $('#youtube-status').textContent=job.message;
        $('#youtube-progress').value=job.progress||0;$('#youtube-progress').hidden=false;
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
      items=detected.items;diagnostics=detected.debug;
      renderTracks();
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
