globalThis.YouTubeDownloads = (() => {
  let queue = Promise.resolve();
  const enabled = () => CFG.ENABLE_YOUTUBE ?? CFG.enableYouTube;
  const serial = fn => {
    const next = queue.catch(()=>{}).then(async()=>{
      const job = (await chrome.storage.session.get('youtube_job')).youtube_job || null;
      const result = await fn(job);
      return result;
    }); queue=next;return next;
  };
  const youtubeHost = url => {try{return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname)}catch{return false}};
  const unsupported = details => {
    const url=new URL(details.url);
    return details.method==='POST' || url.searchParams.has('sabr') ||
      (url.searchParams.has('ump') && url.searchParams.get('ump')!=='0') ||
      header(details.responseHeaders,'content-type').includes('ump');
  };
  // Diagnostic observation only: never replay or unwrap UMP/SABR requests.
  chrome.webRequest.onHeadersReceived.addListener(details=>{
    if(details.tabId<0)return;
    let url;try{url=new URL(details.url)}catch{return}
    if(!/(^|\.)googlevideo\.com$/.test(url.hostname)||!url.pathname.includes('/videoplayback'))return;
    serial(async()=>{
      const tab=await chrome.tabs.get(details.tabId);if(!youtubeHost(tab.url))return;
      const key='youtube_detection_'+details.tabId;
      let info=(await chrome.storage.session.get(key))[key];
      if(info?.pageUrl!==tab.url)info={pageUrl:tab.url,networkHits:0,unsupportedHits:0};
      info.networkHits++;if(unsupported(details))info.unsupportedHits++;
      if(details.statusCode>=400)info.failedHits=(info.failedHits||0)+1;
      await chrome.storage.session.set({[key]:info});
    }).catch(()=>{});
  },{urls:['*://*.googlevideo.com/*']},['responseHeaders']);
  chrome.tabs.onRemoved.addListener(tabId=>chrome.storage.session.remove('youtube_detection_'+tabId));
  // Explain the playback configuration of the current video in one category.
  function diagnose(usable,meta,debug) {
    const reason=meta.reason?' ('+meta.reason+')':'';
    if(['LOGIN_REQUIRED','AGE_CHECK_REQUIRED','CONTENT_CHECK_REQUIRED','AGE_VERIFICATION_REQUIRED'].includes(meta.status))
      return {config:'login-required',configMessage:'YouTube requires sign-in or age/content confirmation for this video'+reason+'. Video Grabber does not bypass this.'};
    if(['UNPLAYABLE','ERROR'].includes(meta.status))return {config:'unplayable',configMessage:'YouTube reports this video as unplayable'+reason+'.'};
    if(meta.upcoming)return {config:'upcoming',configMessage:'This is an upcoming live stream or premiere; there is no media yet.'};
    if(meta.drm)return {config:'drm',configMessage:'This video is DRM-protected (licensed content). Protected media is not downloadable.'};
    if(usable>0)return {config:'direct',configMessage:''};
    if(debug.expired)return {config:'expired',configMessage:'The detected track URLs have expired. Replay the video, then Refresh.'};
    if(meta.live&&meta.hls)return {config:'live-hls',configMessage:'Live stream: its HLS manifest was added to the Media Scanner tab, where it can be downloaded.'};
    if(debug.unsupportedHits||debug.unsupportedResources||meta.unsupported)
      return {config:'sabr',configMessage:'YouTube is using UMP/SABR segmented playback (server-driven streaming over POST requests). Those responses are a proprietary container that cannot be fetched as files, so no direct tracks are available.'};
    if(meta.ciphered)return {config:'ciphered',configMessage:'The player lists '+meta.ciphered+' format(s) whose URLs require signature deciphering. Video Grabber does not run or reimplement YouTube signature code.'};
    if(debug.failedHits)return {config:'failed',configMessage:'YouTube rejected '+debug.failedHits+' media request(s). Reload the page and play the video again.'};
    return {config:'none',configMessage:''};
  }
  async function tracks(tabId) {
    const tab=await chrome.tabs.get(tabId);
    if(!youtubeHost(tab.url))return {items:[],debug:{error:'Open a YouTube video page first.'}};
    let resources=[],blobs=0,error='',formats=[],metadataSkipped=0,metadataError='',unsupportedMetadata=false,totalResources=0,players=0;
    try {
      const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>({
        urls:performance.getEntriesByType('resource').map(entry=>entry.name),
        players:document.querySelectorAll('video,audio').length,
        blobs:[...document.querySelectorAll('video,audio')].filter(el=>(el.currentSrc||el.src||'').startsWith('blob:')).length
      })});
      resources=[...new Set(results.flatMap(frame=>frame.result?.urls||[]))];
      totalResources=resources.length;
      players=results.reduce((sum,frame)=>sum+(frame.result?.players||0),0);
      blobs=results.reduce((sum,frame)=>sum+(frame.result?.blobs||0),0);
    }catch(failure){error='Page scan failed: '+failure.message;}
    // Read existing page metadata only: no network player API requests, signature transforms or license requests.
    let meta={};
    try {
      const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{
        const path=location.pathname;
        const id=new URL(location.href).searchParams.get('v')||path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1]||'';
        if(!id)return {formats:[],skipped:0,error:'This page URL contains no video id.'};
        const candidates=[];
        const probe=(read,source)=>{try{const value=read();if(value&&typeof value==='object')candidates.push([value,source]);}catch{}};
        probe(()=>document.getElementById('movie_player')?.getPlayerResponse?.(),'movie_player');
        probe(()=>document.getElementById('shorts-player')?.getPlayerResponse?.(),'shorts-player');
        probe(()=>document.querySelector('ytd-watch-flexy')?.playerData,'ytd-watch-flexy');
        probe(()=>document.querySelector('ytd-player')?.getPlayer?.()?.getPlayerResponse?.(),'ytd-player');
        probe(()=>window.ytInitialPlayerResponse,'ytInitialPlayerResponse');
        probe(()=>window.ytplayer?.config?.args?.raw_player_response,'ytplayer.config');
        probe(()=>window.ytplayer?.bootstrapPlayerResponse,'ytplayer.bootstrap');
        const match=candidates.find(([value])=>value?.videoDetails?.videoId===id);
        if(!match)return {formats:[],skipped:0,stale:candidates.length>0,
          error:candidates.length?'Player metadata belongs to a previous video. Reload the page.':'Current player metadata is unavailable.'};
        const [response,source]=match;
        const play=response.playabilityStatus||{},data=response.streamingData||{},details=response.videoDetails||{};
        const all=[...(data.formats||[]),...(data.adaptiveFormats||[])];
        const drm=!!(data.licenseInfos?.length||data.drmFamilies?.length);
        const direct=drm?[]:all.filter(format=>format.url&&!format.signatureCipher&&!format.cipher&&!format.drmFamilies?.length&&!format.drmTrackType);
        const text=value=>typeof value==='string'?value:value?.simpleText||value?.runs?.map(run=>run.text).join('')||'';
        return {source,status:play.status||'',reason:text(play.reason||play.messages?.[0]).slice(0,200),
          live:!!details.isLive,upcoming:!!details.isUpcoming||play.status==='LIVE_STREAM_OFFLINE',
          hls:data.hlsManifestUrl||'',dash:data.dashManifestUrl||'',unsupported:!!data.serverAbrStreamingUrl,drm,
          total:all.length,ciphered:all.filter(format=>format.signatureCipher||format.cipher).length,
          drmFormats:all.filter(format=>format.drmFamilies?.length||format.drmTrackType).length,
          formats:direct.map(format=>({url:format.url,mime:format.mimeType||'',size:format.contentLength,quality:format.qualityLabel||'',
            bitrate:format.bitrate||0,width:format.width||0,height:format.height||0,fps:format.fps||0,
            audioTrack:format.audioTrack?.displayName||'',audioDefault:!!format.audioTrack?.audioIsDefault,drc:!!format.isDrc})),
          skipped:all.length-direct.length,error:drm?'Protected player metadata – not downloadable.':''};
      }});
      meta=result?.result||{};
      formats=meta.formats||[];metadataSkipped=meta.skipped||0;metadataError=meta.error||'';
      unsupportedMetadata=!!meta.unsupported;
    }catch(failure){metadataError='Player metadata scan failed: '+failure.message;}
    const recoveryKey='recovery_'+tabId;
    const recovery=(await chrome.storage.session.get(recoveryKey))[recoveryKey]||{};
    const list=await getList(tabId);
    for(const entry of Object.values(recovery))if(entry.group==='yt'&&!list[entry.key])await addMedia(tabId,entry);
    let metadataHits=0;
    for(const format of formats.slice(0,100)) {
      let parsed;try{parsed=new URL(format.url)}catch{continue}
      if(parsed.protocol!=='https:'||!/(^|\.)googlevideo\.com$/.test(parsed.hostname)||unsupported({url:format.url}))continue;
      let entry;try{entry=classify({url:format.url,method:'GET',responseHeaders:[{name:'content-type',value:String(format.mime)}],
        quality:format.quality,audioTrack:format.audioTrack,audioDefault:format.audioDefault,drc:format.drc,bitrate:format.bitrate,
        width:format.width,height:format.height,fps:format.fps,codecs:String(format.mime).match(/codecs="([^"]+)"/)?.[1]||''})}catch{continue}
      if(entry?.group!=='yt')continue;
      if(Number(format.size)>0)entry.size=Number(format.size);
      if(format.quality && entry.track!=='a')entry.quality=String(format.quality).slice(0,30);
      await addMedia(tabId,entry);metadataHits++;
    }
    let resourceHits=0,unsupportedResources=0;
    for(const url of resources) {
      let parsed;try{parsed=new URL(url)}catch{continue}
      if(!/(^|\.)googlevideo\.com$/.test(parsed.hostname)||!parsed.pathname.includes('/videoplayback'))continue;
      resourceHits++;
      if(unsupported({url})){unsupportedResources++;continue;}
      const entry=classify({url,method:'GET',responseHeaders:[]});
      if(entry?.group==='yt'&&!list[entry.key])await addMedia(tabId,entry);
    }
    const key='youtube_detection_'+tabId;
    const saved=(await chrome.storage.session.get(key))[key];
    const info=saved?.pageUrl===tab.url?saved:{};
    // Live streams expose an ordinary (unencrypted) HLS manifest: hand it to the Media Scanner.
    if(meta.hls&&globalThis.MediaScanner){
      try{await MediaScanner.dom({urls:[{url:meta.hls,source:'player'}]},{tab,frameId:0,url:tab.url});}catch{}
    }
    const items=Object.values(await getList(tabId)).filter(entry=>entry.group==='yt'&&entry.kind==='chunked');
    const now=Date.now();
    const expired=items.filter(entry=>entry.expiresAt&&entry.expiresAt<=now).length;
    const debug={tabId,networkHits:info.networkHits||0,failedHits:info.failedHits||0,resourceHits,totalResources,players,
      metadataHits,metadataSkipped,metadataError,unsupportedMetadata,unsupportedHits:info.unsupportedHits||0,unsupportedResources,blobs,error,
      metadataSource:meta.source||'',playability:meta.status||'',ciphered:meta.ciphered||0,drmFormats:meta.drmFormats||0,
      totalFormats:meta.total||0,live:!!meta.live,hlsManifest:!!meta.hls,expired};
    Object.assign(debug,diagnose(items.length-expired,meta,debug));
    return {items,debug};
  }
  async function status() {
    return serial(async job => {
      if (job?.status === 'running') {
        try { await chrome.tabs.get(job.workerTab); }
        catch { job.status='cancelled';job.message='Download tab was closed.';await chrome.storage.session.set({youtube_job:job}); }
      }
      return job;
    });
  }
  async function start(msg) {
    if (!enabled()) throw new Error('YouTube conversion is disabled in this build.');
    if (!['mp3','mp4'].includes(msg.output)) throw new Error('Choose MP4 or MP3 output.');
    if (msg.output==='mp3' && ![128,192,320].includes(Number(msg.bitrate))) throw new Error('Choose a supported MP3 bitrate.');
    const source = await chrome.tabs.get(msg.tabId);
    if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(source.url).hostname)) throw new Error('Open a YouTube video page first.');
    const list = await getList(msg.tabId);
    const tracks = YouTubeTools.chooseTracks(Object.values(list),msg.output,msg.quality);
    return serial(async existing => {
      if (existing?.status==='running') {
        try { await chrome.tabs.get(existing.workerTab); throw new Error('A YouTube job is already running. Finish or cancel it first.'); }
        catch (error) { if(error.message.includes('already running'))throw error; }
      }
      const job = { id:crypto.randomUUID(),sourceTab:msg.tabId,output:msg.output,bitrate:Number(msg.bitrate)||192,
        tracks,title:source.title||'YouTube video',status:'running',phase:'download',progress:0,message:'Starting download…' };
      // Persist first so a fast download tab can read its input safely.
      await chrome.storage.session.set({youtube_job:job});
      try {
        // Keep the popup alive until its start request receives a reply.
        const tab = await chrome.tabs.create({url:chrome.runtime.getURL('youtube/download.html')+'?job='+job.id,active:false});
        job.workerTab=tab.id;
      } catch(error) {job.status='failed';job.message=error.message;}
      await chrome.storage.session.set({youtube_job:job});return job;
    });
  }
  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(!msg.cmd?.startsWith('youtube.'))return;
    (async()=>{
      if(!enabled())throw new Error('YouTube conversion is disabled in this build.');
      if(msg.cmd==='youtube.start')return start(msg);
      if(msg.cmd==='youtube.tracks')return tracks(msg.tabId);
      if(msg.cmd==='youtube.status')return status();
      if(msg.cmd==='youtube.cancel') {
        const job=await status();
        if(job?.status==='running') await chrome.tabs.sendMessage(job.workerTab,{cmd:'youtube.cancel',id:job.id});
        return true;
      }
      if(msg.cmd==='youtube.progress')return serial(async job=>{
        if(!job || job.id!==msg.id || job.workerTab!==sender.tab?.id || job.status!=='running')return;
        job.progress=Math.max(0,Math.min(1,Number(msg.progress)||0));job.phase=msg.phase;
        job.message=String(msg.message||'').slice(0,500);
        if(['complete','failed','cancelled'].includes(msg.status))job.status=msg.status;
        await chrome.storage.session.set({youtube_job:job});return true;
      });
      throw new Error('Unknown YouTube command: '+msg.cmd);
    })().then(result=>reply({ok:true,result}),error=>reply({ok:false,error:error.message}));
    return true;
  });
  return { status };
})();
