globalThis.YouTubeTools = (() => {
  function chooseTracks(items, output, quality) {
    const now = Date.now();
    const all = items.filter(item => item.kind === 'chunked' && item.group === 'yt');
    const streams = all.filter(item => !(item.expiresAt && item.expiresAt <= now));
    if (all.length && !streams.length) throw new Error('All detected YouTube URLs have expired. Replay the video, Refresh, and try again.');
    // Prefer the original/default language, non-DRC audio, then MP4 (AAC), then bitrate.
    const audios = streams.filter(item => item.track === 'a').sort((a,b) =>
      Number(!!b.original) - Number(!!a.original) || Number(!b.drc) - Number(!a.drc) ||
      Number(b.mime.includes('mp4')) - Number(a.mime.includes('mp4')) || (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
    const muxed = streams.filter(item => item.track === 'av');
    if (output === 'mp3') {
      const audio = audios[0] || muxed[0];
      if (!audio) throw new Error('No audio URL was detected. Play the video, refresh, and try again.');
      return { audio };
    }
    const videos = streams.filter(item => item.track !== 'a' && item.quality === quality)
      .sort((a,b) => Number(b.track === 'av') - Number(a.track === 'av') || Number(b.mime.includes('mp4')) - Number(a.mime.includes('mp4')));
    const video = videos[0];
    if (!video) throw new Error('That video quality is no longer available. Refresh the detected tracks.');
    if (video.track === 'av') return { video };
    if (!audios.length) throw new Error('Only video was detected. Wait for an audio request or choose a quality with sound.');
    return { video, audio: audios[0] };
  }
  function args(job) {
    // Lossless container merge of separate audio/video (used for WebM DASH in the full build).
    if (job.mode === 'merge') {
      if (!['webm','mkv','mp4'].includes(job.output)) throw new Error('Unsupported merge container.');
      return ['-i','video.input','-i','audio.input','-map','0:v:0','-map','1:a:0','-c','copy',
        ...(job.output==='mp4'?['-movflags','+faststart']:[]),'output.'+job.output];
    }
    if (job.output === 'mp3') return ['-i','audio.input','-map','0:a:0','-vn','-c:a','libmp3lame','-b:a',job.bitrate+'k','output.mp3'];
    const inputs = ['-i','video.input', ...(job.tracks.audio ? ['-i','audio.input'] : [])];
    const maps = ['-map','0:v:0','-map',job.tracks.audio ? '1:a:0' : '0:a:0'];
    const codec = job.tracks.video.mime.includes('mp4') ? ['-c:v','copy'] : ['-c:v','libx264','-preset','veryfast','-crf','23'];
    return [...inputs,...maps,...codec,'-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest','output.mp4'];
  }
  return { chooseTracks, args };
})();
