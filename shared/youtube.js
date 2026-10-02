globalThis.YouTubeTools = (() => {
  function chooseTracks(items, output, quality) {
    const streams = items.filter(item => item.kind === 'chunked' && item.group === 'yt');
    const audios = streams.filter(item => item.track === 'a').sort((a,b) =>
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
    if (job.output === 'mp3') return ['-i','audio.input','-map','0:a:0','-vn','-c:a','libmp3lame','-b:a',job.bitrate+'k','output.mp3'];
    const inputs = ['-i','video.input', ...(job.tracks.audio ? ['-i','audio.input'] : [])];
    const maps = ['-map','0:v:0','-map',job.tracks.audio ? '1:a:0' : '0:a:0'];
    const codec = job.tracks.video.mime.includes('mp4') ? ['-c:v','copy'] : ['-c:v','libx264','-preset','veryfast','-crf','23'];
    return [...inputs,...maps,...codec,'-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest','output.mp4'];
  }
  return { chooseTracks, args };
})();
