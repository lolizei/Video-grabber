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
    const plan = conversionPlan(job);
    const video = plan.copyVideo ? ['-c:v','copy'] : ['-c:v','libx264','-preset','veryfast','-crf','23'];
    const audio = plan.copyAudio ? ['-c:a','copy'] : ['-c:a','aac','-b:a','192k'];
    return [...inputs,...maps,...video,...audio,'-movflags','+faststart','-shortest','output.mp4'];
  }
  // H.264, VP9 and AV1 are stored in MP4 without re-encoding (re-encoding high resolutions in
  // single-threaded WebAssembly can take longer than the video itself). AAC audio is copied;
  // Opus/Vorbis audio is encoded to AAC (fast) for broad player compatibility.
  function conversionPlan(job) {
    const vmime = String(job.tracks.video?.mime || '') + ' ' + String(job.tracks.video?.codecs || '');
    const amime = String((job.tracks.audio || job.tracks.video)?.mime || '') + ' ' + String((job.tracks.audio || job.tracks.video)?.codecs || '');
    const copyVideo = /avc1|avc3|vp09|vp9|vp8|av01|video\/mp4|video\/webm/i.test(vmime);
    const copyAudio = job.tracks.audio ? /mp4a|audio\/mp4/i.test(amime) && !/opus|vorbis|webm/i.test(amime) : /video\/mp4/i.test(vmime);
    return { copyVideo, copyAudio, description: (copyVideo ? 'copy video' : 'encode H.264') + ' · ' + (copyAudio ? 'copy AAC audio' : 'encode AAC audio') };
  }
  // Reads the first MPEG audio frame header (after an ID3v2 tag) to verify MP3 output.
  function mp3Info(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let o = 0;
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
    const rates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
    for (let tries = 0; o + 4 <= b.length && tries < 65536; o++, tries++) {
      if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
      const version = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, index = b[o + 2] >> 4;
      if (version !== 3 || layer !== 1 || !index || index === 15) continue; // MPEG-1 Layer III
      return { ok: true, bitrate: rates[index], offset: o };
    }
    return { ok: false };
  }
  return { chooseTracks, args, conversionPlan, mp3Info };
})();
