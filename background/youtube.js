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
        const tab = await chrome.tabs.create({url:chrome.runtime.getURL('youtube/download.html')+'?job='+job.id,active:true});
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
    })().then(result=>reply({ok:true,result}),error=>reply({ok:false,error:error.message}));
    return true;
  });
  return { status };
})();
