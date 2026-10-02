// MPEG-DASH MPD parsing: representations, BaseURL hierarchy, SegmentTemplate ($Number$/$Time$,
// SegmentTimeline), SegmentList and SegmentBase. ContentProtection is reported, never processed.
globalThis.DashTools = (() => {
  const X = () => globalThis.XmlTools;
  function isoDuration(value) {
    if (!value) return 0;
    const m = String(value).trim().match(/^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return 0;
    const [, neg, y, mo, w, d, h, mi, s] = m.map(v => v === undefined ? 0 : v);
    const total = Number(y) * 31536000 + Number(mo) * 2592000 + Number(w) * 604800 + Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(s);
    return neg ? -total : total;
  }
  const join = (base, value) => value ? new URL(value.trim(), base).href : base;
  const baseOf = (node, base) => { const b = X().child(node, 'BaseURL'); return b && b.text.trim() ? join(base, b.text) : base; };
  function fill(template, values) {
    return template.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)([diuxX]))?\$/g, (match, name, width, type) => {
      if (!name) return '$';
      let value = values[name];
      if (value === undefined) return match;
      if (name !== 'RepresentationID' && type) {
        value = BigInt(value).toString(type === 'x' ? 16 : type === 'X' ? 16 : 10);
        if (type === 'X') value = value.toUpperCase();
        if (width) value = value.padStart(Number(width), '0');
      } else if (width && name !== 'RepresentationID') value = String(value).padStart(Number(width), '0');
      return String(value);
    });
  }
  const mergeTemplate = (...nodes) => {
    const present = nodes.filter(Boolean);
    if (!present.length) return null;
    const attrs = Object.assign({}, ...present.map(n => n.attrs));
    const timeline = [...present].reverse().map(n => X().child(n, 'SegmentTimeline')).find(Boolean) || null;
    const init = [...present].reverse().map(n => X().child(n, 'Initialization')).find(Boolean) || null;
    return { attrs, timeline, init, nodes: present };
  };
  const range = value => {
    const m = String(value || '').match(/^(\d+)-(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  function kindOf(rep, set) {
    const contentType = rep.attrs.contentType || set.attrs.contentType || '';
    const mime = rep.attrs.mimeType || set.attrs.mimeType || '';
    const codecs = (rep.attrs.codecs || set.attrs.codecs || '').split(',').map(c => c.trim()).filter(Boolean);
    const kinds = new Set(codecs.map(c => HlsTools.codecKind(c)).filter(Boolean));
    if (kinds.has('video') && kinds.has('audio')) return 'muxed';
    if (contentType === 'text' || /^(text|application\/(ttml|mp4.*wvtt))/.test(mime) || kinds.has('text')) return 'text';
    if (contentType === 'image' || mime.startsWith('image/')) return 'image';
    if (contentType === 'video' || mime.startsWith('video/') || kinds.has('video')) return 'video';
    if (contentType === 'audio' || mime.startsWith('audio/') || kinds.has('audio')) return 'audio';
    return 'unknown';
  }
  function segmentsFor(ctx) {
    const { rep, set, period, base, periodDuration, dynamic } = ctx;
    const values = { RepresentationID: rep.attrs.id || '', Bandwidth: rep.attrs.bandwidth || '0' };
    const list = mergeTemplate(X().child(period, 'SegmentList'), X().child(set, 'SegmentList'), X().child(rep, 'SegmentList'));
    const template = mergeTemplate(X().child(period, 'SegmentTemplate'), X().child(set, 'SegmentTemplate'), X().child(rep, 'SegmentTemplate'));
    const segBase = mergeTemplate(X().child(period, 'SegmentBase'), X().child(set, 'SegmentBase'), X().child(rep, 'SegmentBase'));
    if (template && template.attrs.media) {
      const a = template.attrs;
      const timescale = Number(a.timescale) || 1;
      const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
      const init = a.initialization ? { url: join(base, fill(a.initialization, values)), range: null }
        : template.init?.attrs.sourceURL ? { url: join(base, fill(template.init.attrs.sourceURL, values)), range: range(template.init.attrs.range) } : null;
      const media = [];
      if (template.timeline && X().children(template.timeline, 'S').length) {
        const entries = X().children(template.timeline, 'S');
        let time = 0, number = startNumber;
        const end = periodDuration ? Number(a.presentationTimeOffset || 0) + periodDuration * timescale : Infinity;
        entries.forEach((s, index) => {
          if (s.attrs.t !== undefined) time = Number(s.attrs.t);
          const d = Number(s.attrs.d);
          if (!(d > 0)) throw new Error('Invalid SegmentTimeline duration.');
          let repeat = Number(s.attrs.r || 0);
          if (repeat < 0) {
            const next = entries[index + 1]?.attrs.t !== undefined ? Number(entries[index + 1].attrs.t) : end;
            if (!Number.isFinite(next)) throw Object.assign(new Error('Open-ended SegmentTimeline repeat requires a period duration.'), { code: 'unsupported' });
            repeat = Math.max(0, Math.ceil((next - time) / d) - 1);
          }
          for (let r = 0; r <= repeat; r++) {
            media.push({ url: join(base, fill(a.media, { ...values, Number: number, Time: time })), range: null, time: time / timescale, duration: d / timescale });
            time += d; number++;
            if (media.length > 200000) throw new Error('Too many DASH segments.');
          }
        });
      } else {
        const duration = Number(a.duration);
        if (!(duration > 0)) throw new Error('SegmentTemplate has neither a duration nor a SegmentTimeline.');
        if (dynamic) throw Object.assign(new Error('Live DASH with number-based templates is not supported; only static (VOD) manifests or live manifests with SegmentTimeline are.'), { code: 'unsupported' });
        if (!periodDuration) throw new Error('DASH manifest has no duration; cannot count segments.');
        const count = Math.ceil(periodDuration * timescale / duration - 1e-9);
        if (count > 200000) throw new Error('Too many DASH segments.');
        for (let i = 0; i < count; i++) {
          const number = startNumber + i;
          media.push({ url: join(base, fill(a.media, { ...values, Number: number, Time: i * duration })), range: null, time: i * duration / timescale, duration: duration / timescale });
        }
      }
      return { init, media, addressing: template.timeline && X().children(template.timeline, 'S').length ? 'SegmentTimeline' : 'SegmentTemplate' };
    }
    if (list) {
      const node = list.nodes.at(-1);
      const urls = X().children(node, 'SegmentURL');
      const init = list.init ? { url: join(base, list.init.attrs.sourceURL || ''), range: range(list.init.attrs.range) } : null;
      const timescale = Number(list.attrs.timescale) || 1, duration = Number(list.attrs.duration) || 0;
      return { init, media: urls.map((s, i) => ({ url: join(base, s.attrs.media || ''), range: range(s.attrs.mediaRange),
        time: duration ? i * duration / timescale : 0, duration: duration / timescale })), addressing: 'SegmentList' };
    }
    // SegmentBase or plain BaseURL: one self-contained file (indexRange/sidx inside).
    return { init: null, media: [{ url: base, range: null, time: 0, duration: periodDuration }], single: true,
      addressing: segBase ? 'SegmentBase' : 'BaseURL', indexRange: segBase?.attrs.indexRange || '' };
  }
  function parse(text, url) {
    const doc = X().parse(text);
    const mpd = X().child(doc, 'MPD');
    if (!mpd) throw new Error('Not a DASH manifest.');
    const dynamic = mpd.attrs.type === 'dynamic';
    const total = isoDuration(mpd.attrs.mediaPresentationDuration);
    const base = baseOf(mpd, url);
    const periods = X().children(mpd, 'Period');
    if (!periods.length) throw new Error('DASH manifest contains no periods.');
    const protection = DrmTools.dash(text);
    let start = 0;
    const parsedPeriods = periods.map((period, index) => {
      const pStart = period.attrs.start ? isoDuration(period.attrs.start) : start;
      const nextStart = periods[index + 1]?.attrs.start ? isoDuration(periods[index + 1].attrs.start) : 0;
      const duration = isoDuration(period.attrs.duration) || (nextStart ? nextStart - pStart : total ? total - pStart : 0);
      start = pStart + duration;
      const pBase = baseOf(period, base);
      const reps = [];
      for (const set of X().children(period, 'AdaptationSet')) {
        const sBase = baseOf(set, pBase);
        const setProtected = X().children(set, 'ContentProtection').length > 0;
        const role = X().child(set, 'Role')?.attrs.value || '';
        for (const rep of X().children(set, 'Representation')) {
          const rBase = baseOf(rep, sBase);
          const kind = kindOf(rep, set);
          const mimeType = rep.attrs.mimeType || set.attrs.mimeType || '';
          const codecs = rep.attrs.codecs || set.attrs.codecs || '';
          const channels = X().child(rep, 'AudioChannelConfiguration') || X().child(set, 'AudioChannelConfiguration');
          const entry = { id: rep.attrs.id || '', kind, mimeType, codecs, role,
            bandwidth: Number(rep.attrs.bandwidth) || 0, width: Number(rep.attrs.width || set.attrs.width) || 0,
            height: Number(rep.attrs.height || set.attrs.height) || 0, frameRate: rep.attrs.frameRate || set.attrs.frameRate || '',
            lang: set.attrs.lang || rep.attrs.lang || '', label: X().child(set, 'Label')?.text.trim() || set.attrs.label || '',
            audioChannels: channels?.attrs.value || '', audioSamplingRate: rep.attrs.audioSamplingRate || set.attrs.audioSamplingRate || '',
            container: /webm/i.test(mimeType) ? 'webm' : /mp4|iso/i.test(mimeType) || !mimeType ? 'mp4' : mimeType,
            protected: setProtected || X().children(rep, 'ContentProtection').length > 0, period: index };
          try { entry.segments = segmentsFor({ rep, set, period, base: rBase, periodDuration: duration, dynamic }); }
          catch (error) { entry.error = error.message; entry.errorCode = error.code || 'unsupported'; }
          reps.push(entry);
        }
      }
      return { index, start: pStart, duration, representations: reps };
    });
    // Multi-period: concatenate matching representations (same id and init) across periods.
    const main = parsedPeriods.reduce((best, p) => p.duration > best.duration ? p : best, parsedPeriods[0]);
    let warning = '';
    const representations = main.representations.map(rep => {
      if (parsedPeriods.length === 1 || !rep.segments) return rep;
      const parts = parsedPeriods.map(p => p.representations.find(r => r.id === rep.id && r.kind === rep.kind));
      const sameInit = parts.every(r => r?.segments && !r.segments.single && JSON.stringify(r.segments.init) === JSON.stringify(rep.segments.init));
      if (!sameInit) { warning = 'Multi-period manifest: only the main period (' + Math.round(main.duration) + ' s) can be downloaded.'; return rep; }
      return { ...rep, segments: { ...rep.segments, media: parts.flatMap(r => r.segments.media) } };
    });
    return { type: dynamic ? 'dynamic' : 'static', live: dynamic, duration: total || parsedPeriods.reduce((s, p) => s + p.duration, 0),
      periods: parsedPeriods.length, protection, warning, representations };
  }
  function select(manifest, selection = {}) {
    const usable = manifest.representations.filter(r => !r.error);
    const videos = usable.filter(r => r.kind === 'video' || r.kind === 'muxed').sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    const audios = usable.filter(r => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);
    let video = null, audio = null;
    if (videos.length && selection.audioOnly !== true) {
      video = videos[0];
      if (selection.id) video = videos.find(v => v.id === selection.id) || video;
      else if (selection.height) {
        const height = Number(selection.height);
        video = videos.find(v => v.height === height && (!selection.bandwidth || v.bandwidth === Number(selection.bandwidth)))
          || videos.find(v => v.height === height) || videos.find(v => v.height && v.height <= height) || videos.at(-1);
      }
    }
    if (video?.kind !== 'muxed' && audios.length) {
      const wanted = selection.audio;
      // Prefer a container compatible with the chosen video.
      const compatible = audios.filter(a => !video || a.container === video.container);
      const pool = compatible.length ? compatible : audios;
      audio = (wanted && pool.find(a => a.id === wanted || a.lang === wanted || a.label === wanted)) || pool[0];
    }
    if (!video && !audio) {
      const failed = manifest.representations.find(r => r.error);
      throw Object.assign(new Error(failed ? failed.error : 'No downloadable audio or video representations.'), { code: failed?.errorCode || 'unsupported' });
    }
    return { video, audio };
  }
  function summary(manifest) {
    const pick = r => ({ id: r.id, height: r.height, width: r.width, bandwidth: r.bandwidth, codecs: r.codecs, frameRate: r.frameRate,
      lang: r.lang, label: r.label, channels: r.audioChannels, container: r.container, segments: r.segments?.media.length || 0, error: r.error || '' });
    return { variants: manifest.representations.filter(r => r.kind === 'video' || r.kind === 'muxed').map(pick),
      audio: manifest.representations.filter(r => r.kind === 'audio').map(pick) };
  }
  return { parse, select, summary, isoDuration, fill };
})();
