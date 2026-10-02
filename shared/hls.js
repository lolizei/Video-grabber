// HLS master/media playlist parsing and rendition selection. Detection of encryption
// stops processing: encrypted segments and keys are never requested.
globalThis.HlsTools = (() => {
  const attr = (line, key) => {
    const match = line.match(new RegExp('(?:[:,]|^)' + key + '=("([^"]*)"|[^,]*)'));
    return match ? (match[2] ?? match[1]).trim() : null;
  };
  const resolve = (value, base) => new URL(value, base).href;
  const isMaster = text => /#EXT-X-STREAM-INF:/.test(text);
  const codecKind = codec => /^(avc|hvc|hev|vp0?[89]|av01|dvh|dva|mp4v)/i.test(codec) ? 'video' : /^(mp4a|ac-3|ec-3|opus|flac|mp3|vorbis|dtsc|alac)/i.test(codec) ? 'audio' : /^(wvtt|stpp|tx3g)/i.test(codec) ? 'text' : '';
  function parseMaster(text, base) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim());
    const variants = [], audio = [], subtitles = [], iframes = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (!lines[j]) continue;
        const res = attr(l, 'RESOLUTION');
        const [width, height] = res && /^\d+x\d+$/.test(res) ? res.split('x').map(Number) : [0, 0];
        const codecs = (attr(l, 'CODECS') || '').split(',').map(c => c.trim()).filter(Boolean);
        variants.push({ url: resolve(lines[j], base), bandwidth: Number(attr(l, 'BANDWIDTH')) || 0,
          averageBandwidth: Number(attr(l, 'AVERAGE-BANDWIDTH')) || 0, width, height,
          frameRate: Number(attr(l, 'FRAME-RATE')) || 0, codecs,
          videoCodec: codecs.find(c => codecKind(c) === 'video') || '', audioCodec: codecs.find(c => codecKind(c) === 'audio') || '',
          audioGroup: attr(l, 'AUDIO') || '', hdcp: attr(l, 'HDCP-LEVEL') || '',
          audioOnly: codecs.length > 0 && codecs.every(c => codecKind(c) === 'audio') });
        i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const type = attr(l, 'TYPE');
        const entry = { type, group: attr(l, 'GROUP-ID') || '', name: attr(l, 'NAME') || '', language: attr(l, 'LANGUAGE') || '',
          default: attr(l, 'DEFAULT') === 'YES', autoselect: attr(l, 'AUTOSELECT') === 'YES', channels: attr(l, 'CHANNELS') || '',
          url: attr(l, 'URI') ? resolve(attr(l, 'URI'), base) : '' };
        if (type === 'AUDIO') audio.push(entry); else if (type === 'SUBTITLES') subtitles.push(entry);
      } else if (l.startsWith('#EXT-X-I-FRAME-STREAM-INF:') && attr(l, 'URI')) {
        iframes.push({ url: resolve(attr(l, 'URI'), base), bandwidth: Number(attr(l, 'BANDWIDTH')) || 0 });
      }
    }
    // Audio group codecs come from the variants that reference the group.
    for (const track of audio) track.codec = variants.find(v => v.audioGroup === track.group)?.audioCodec || '';
    variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    return { variants, audio, subtitles, iframes };
  }
  function parseByteRange(spec) {
    const [length, offset] = spec.split('@');
    const size = Number(length);
    const start = offset === undefined ? null : Number(offset);
    if (!Number.isSafeInteger(size) || size <= 0 || (start !== null && (!Number.isSafeInteger(start) || start < 0))) throw new Error('Invalid byte range.');
    return { size, start };
  }
  function parseMedia(text, base) {
    if (!String(text).trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist.');
    const drm = DrmTools.hls(text);
    if (drm) { const e = new Error('Protected stream: ' + drm.summary); e.code = 'protected'; e.drm = drm; throw e; }
    const segments = [];
    let init = null, nextRange = null, lastEnd = 0, lastUrl = '', duration = 0, discontinuity = false;
    let sequence = 0, targetDuration = 0, playlistType = '', ended = false, initChanges = 0;
    for (const raw of String(text).split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = l.slice(21);
      else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
      else if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) discontinuity = true;
      else if (l.startsWith('#EXTINF:')) duration = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-MAP:')) {
        const uri = attr(l, 'URI');
        if (!uri) throw new Error('Initialization segment URL is missing.');
        const r = attr(l, 'BYTERANGE') ? parseByteRange(attr(l, 'BYTERANGE')) : null;
        const map = { url: resolve(uri, base), range: r ? [r.start ?? 0, (r.start ?? 0) + r.size - 1] : null };
        if (init && (init.url !== map.url || JSON.stringify(init.range) !== JSON.stringify(map.range))) initChanges++;
        init = map;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) nextRange = parseByteRange(l.slice(17));
      else if (!l.startsWith('#')) {
        const url = resolve(l, base);
        let range = null;
        if (nextRange) {
          if (nextRange.start === null && lastUrl !== url) throw new Error('Implicit byte range has no previous segment for this URL.');
          const start = nextRange.start ?? lastEnd;
          range = [start, start + nextRange.size - 1];
          lastEnd = range[1] + 1;
        }
        segments.push({ url, range, duration, sequence: sequence + segments.length, discontinuity, init });
        lastUrl = url; nextRange = null; duration = 0; discontinuity = false;
      }
    }
    if (initChanges) throw Object.assign(new Error('Streams whose initialization segment changes mid-playlist are not supported.'), { code: 'unsupported' });
    const first = segments[0]?.url || '';
    const path = (() => { try { return new URL(first).pathname; } catch { return ''; } })();
    const container = init || /\.(m4s|mp4|cmfv|cmfa|m4a|m4v)$/i.test(path) ? 'fmp4'
      : /\.(aac|ac3|ec3|mp3)$/i.test(path) ? 'packed-audio' : 'ts';
    return { segments, segs: segments, init, ended: ended || playlistType === 'VOD', live: !ended && playlistType !== 'VOD',
      targetDuration, container, duration: segments.reduce((sum, s) => sum + s.duration, 0) };
  }
  // selection: { height, bandwidth, audio: name|language|url }
  function select(master, selection = {}) {
    const variants = master.variants.filter(v => !v.audioOnly || master.variants.every(x => x.audioOnly));
    if (!variants.length) throw new Error('Playlist contains no variants.');
    let variant = variants[0];
    if (selection.url) variant = variants.find(v => v.url === selection.url) || variant;
    else if (selection.height) {
      const sameHeight = variants.filter(v => v.height === Number(selection.height));
      if (sameHeight.length) variant = sameHeight.find(v => !selection.bandwidth || v.bandwidth === Number(selection.bandwidth)) || sameHeight[0];
      else variant = variants.filter(v => v.height && v.height <= Number(selection.height))[0] || variants.at(-1);
    }
    let audio = null;
    if (variant.audioGroup) {
      const group = master.audio.filter(a => a.group === variant.audioGroup);
      const wanted = selection.audio;
      audio = (wanted && group.find(a => a.url === wanted || a.name === wanted || a.language === wanted))
        || group.find(a => a.default) || group[0] || null;
      if (audio && !audio.url) audio = null; // audio is muxed into the variant
    }
    return { variant, audio };
  }
  function summary(master) {
    return {
      variants: master.variants.map(v => ({ height: v.height, width: v.width, bandwidth: v.bandwidth, codecs: v.codecs.join(','), frameRate: v.frameRate, audioOnly: v.audioOnly })),
      audio: master.audio.map(a => ({ name: a.name, language: a.language, channels: a.channels, codec: a.codec, default: a.default, url: a.url }))
    };
  }
  return { attr, isMaster, parseMaster, parseMedia, select, summary, codecKind };
})();
