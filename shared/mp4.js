// ISO-BMFF helpers: box scanning, init-segment inspection (codecs, timescales, encryption),
// a streaming fragmented-MP4 merger for separate audio/video tracks and output validation.
// Sources are Blob-like ({ size, slice(a, b).arrayBuffer() }) so large inputs are read in
// pieces from disk-backed storage instead of being loaded into memory.
globalThis.Mp4Tools = (() => {
  const td = new TextDecoder('latin1');
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  const w64 = (b, o, v) => { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v % 4294967296); };
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf', 'sinf', 'schi', 'udta']);
  const read = async (source, start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer());
  class Mp4Error extends Error { constructor(message, code = 'unsupported') { super(message); this.code = code; } }

  // Child boxes inside an in-memory buffer.
  function boxes(b, start = 0, end = b.length) {
    const out = [];
    for (let o = start; o + 8 <= end;) {
      let size = u32(b, o), header = 8;
      const type = fourcc(b, o + 4);
      if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) break;
      out.push({ type, start: o, size, header, end: o + size });
      o += size;
    }
    return out;
  }
  const child = (b, box, type) => boxes(b, box.start + box.header, box.end).find(x => x.type === type);
  const kids = (b, box, type) => boxes(b, box.start + box.header, box.end).filter(x => !type || x.type === type);
  function walk(b, box, fn) {
    fn(box);
    if (CONTAINERS.has(box.type)) for (const c of kids(b, box)) walk(b, c, fn);
    if (box.type === 'stsd') {
      // stsd: fullbox + entry_count, then sample entries (which can contain sinf etc.).
      for (const entry of boxes(b, box.start + box.header + 8, box.end)) {
        fn(entry);
        const skip = /^(vide|avc|hvc|hev|av01|vp0|encv|dvh)/.test(entry.type) ? 78 : 28;
        for (const inner of boxes(b, entry.start + 8 + skip, entry.end)) walk(b, inner, fn);
      }
    }
  }
  // Top-level layout of a (possibly huge) source, reading only box headers.
  async function scan(source) {
    const out = [];
    let o = 0;
    while (o + 8 <= source.size) {
      const h = await read(source, o, Math.min(o + 16, source.size));
      let size = u32(h, 0), header = 8;
      const type = fourcc(h, 4);
      if (size === 1) { size = u64(h, 8); header = 16; } else if (size === 0) size = source.size - o;
      if (size < header || !/^[\x20-\x7e]{4}$/.test(type)) throw new Mp4Error('Corrupt MP4 data at byte ' + o + '.', 'integrity');
      if (o + size > source.size) throw new Mp4Error('Truncated MP4 data (' + type + ' box at byte ' + o + ').', 'integrity');
      out.push({ type, start: o, size, header, end: o + size });
      o += size;
    }
    return out;
  }
  // Parse a moov box (bytes = the moov box itself).
  function parseMoov(b) {
    const moov = boxes(b)[0];
    if (!moov || moov.type !== 'moov') throw new Mp4Error('Missing moov box.', 'integrity');
    const mvhd = child(b, moov, 'mvhd');
    const mv = mvhd.start + mvhd.header;
    const movieTimescale = b[mv] === 1 ? u32(b, mv + 20) : u32(b, mv + 12);
    const movieDuration = b[mv] === 1 ? u64(b, mv + 24) : u32(b, mv + 16);
    const tracks = [];
    const types = new Set(), pssh = [];
    walk(b, moov, box => { types.add(box.type); if (box.type === 'pssh') pssh.push(...DrmTools.psshSystems(b.subarray(box.start, box.end))); });
    for (const trak of kids(b, moov, 'trak')) {
      const tkhd = child(b, trak, 'tkhd'), t = tkhd.start + tkhd.header;
      const id = b[t] === 1 ? u32(b, t + 20) : u32(b, t + 12);
      const mdia = child(b, trak, 'mdia'), mdhd = child(b, mdia, 'mdhd'), m = mdhd.start + mdhd.header;
      const timescale = b[m] === 1 ? u32(b, m + 20) : u32(b, m + 12);
      const hdlr = child(b, mdia, 'hdlr');
      const handler = fourcc(b, hdlr.start + hdlr.header + 8);
      const stbl = child(b, child(b, mdia, 'minf'), 'stbl');
      const stsd = child(b, stbl, 'stsd');
      const entry = boxes(b, stsd.start + stsd.header + 8, stsd.end)[0];
      let codec = entry?.type || '';
      const encrypted = /^enc[vast]$/.test(codec);
      if (encrypted && entry) {
        let frma = '';
        walk(b, stsd, box => { if (box.type === 'frma') frma = fourcc(b, box.start + box.header); });
        codec = frma ? frma + ' (encrypted)' : codec;
      }
      tracks.push({ id, timescale, handler, kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler === 'subt' || handler === 'text' ? 'text' : handler,
        codec, encrypted, box: trak });
    }
    const encrypted = tracks.some(t => t.encrypted) || types.has('sinf') || types.has('tenc') || pssh.length > 0;
    return { moov, movieTimescale, movieDuration, tracks, encrypted, pssh: [...new Set(pssh)], fragmented: types.has('mvex') };
  }
  // Inspect an init segment / file prefix held in memory.
  function inspectInit(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const moov = boxes(b).find(x => x.type === 'moov');
    if (!moov) throw new Mp4Error('The initialization segment contains no moov box.', 'integrity');
    const info = parseMoov(b.subarray(moov.start, moov.end));
    delete info.moov;
    info.tracks = info.tracks.map(({ box, ...t }) => t);
    if (info.encrypted) info.drm = { encrypted: true, drm: true, systems: info.pssh.length ? info.pssh : ['CENC'],
      summary: 'Encrypted MP4 (' + (info.pssh.length ? info.pssh.join(', ') : 'Common Encryption') + ')' };
    return info;
  }
  function assertClear(info) {
    if (info.encrypted) throw Object.assign(new Mp4Error('Protected stream: ' + info.drm.summary, 'protected'), { drm: info.drm });
  }
  // Minimal box builder.
  function box(type, ...parts) {
    const size = 8 + parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(size);
    w32(out, 0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function ftyp() {
    const brands = ['isom', 'iso6', 'iso5', 'mp41'];
    const body = new Uint8Array(8 + brands.length * 4);
    for (let i = 0; i < 4; i++) body[i] = 'isom'.charCodeAt(i);
    w32(body, 4, 0x200);
    brands.forEach((brand, n) => { for (let i = 0; i < 4; i++) body[8 + n * 4 + i] = brand.charCodeAt(i); });
    return box('ftyp', body);
  }
  // Copy a trak, renumbering its track_ID and rescaling movie-timescale fields.
  function rewriteTrak(b, trak, newId, scale) {
    const out = b.slice(trak.start, trak.end);
    const t0 = trak.start;
    const tkhd = child(b, trak, 'tkhd');
    const t = tkhd.start + tkhd.header - t0;
    const v1 = out[t] === 1;
    w32(out, t + (v1 ? 20 : 12), newId);
    const durOffset = t + (v1 ? 28 : 20);
    if (scale !== 1) {
      if (v1) w64(out, durOffset, Math.round(u64(out, durOffset) * scale));
      else w32(out, durOffset, Math.min(0xffffffff, Math.round(u32(out, durOffset) * scale)));
      const edts = child(b, trak, 'edts');
      const elst = edts && child(b, edts, 'elst');
      if (elst) {
        const e = elst.start + elst.header - t0;
        const ev1 = out[e] === 1, count = u32(out, e + 4);
        for (let i = 0, o = e + 8; i < count; i++, o += ev1 ? 20 : 12) {
          if (ev1) w64(out, o, Math.round(u64(out, o) * scale));
          else w32(out, o, Math.min(0xffffffff, Math.round(u32(out, o) * scale)));
        }
      }
    }
    return out;
  }
  function trex(id, source) {
    const body = new Uint8Array(24);
    if (source) body.set(source.subarray(0, 24));
    else { w32(body, 8, 1); }
    w32(body, 4, id);
    return box('trex', body);
  }
  async function loadSource(source, index) {
    const top = await scan(source);
    const moovBox = top.find(x => x.type === 'moov');
    if (!moovBox) throw new Mp4Error('Track ' + (index + 1) + ' has no initialization (moov) data.', 'integrity');
    if (moovBox.size > 64 * 1024 * 1024) throw new Mp4Error('The moov box is too large for fragment merging.');
    const moovBytes = await read(source, moovBox.start, moovBox.end);
    const info = parseMoov(moovBytes);
    if (info.encrypted) throw Object.assign(new Mp4Error('Protected stream: Encrypted MP4 (' + (info.pssh.join(', ') || 'Common Encryption') + ')', 'protected'),
      { drm: { encrypted: true, drm: true, systems: info.pssh.length ? info.pssh : ['CENC'] } });
    const trexById = new Map();
    const mvex = child(moovBytes, info.moov, 'mvex');
    if (mvex) for (const tr of kids(moovBytes, mvex, 'trex')) {
      const p = tr.start + tr.header;
      trexById.set(u32(moovBytes, p + 4), moovBytes.subarray(p, p + 24));
    }
    const fragments = [];
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== 'moof') continue;
      let end = top[i].end;
      for (let j = i + 1; j < top.length && top[j].type === 'mdat'; j++) end = top[j].end;
      fragments.push({ source, index, moof: top[i], end });
    }
    if (!fragments.length) {
      const hasMdat = top.some(x => x.type === 'mdat');
      throw new Mp4Error(hasMdat ? 'Track ' + (index + 1) + ' is a progressive (non-fragmented) MP4; fragment merging is not possible.' : 'Track ' + (index + 1) + ' contains no media fragments.', hasMdat ? 'unsupported' : 'integrity');
    }
    return { source, index, info, moovBytes, trexById, fragments };
  }
  async function parseFragment(fragment, timescales) {
    const bytes = await read(fragment.source, fragment.moof.start, fragment.moof.end);
    const moof = boxes(bytes)[0];
    const trafs = [];
    for (const traf of kids(bytes, moof, 'traf')) {
      const tfhd = child(bytes, traf, 'tfhd');
      const p = tfhd.start + tfhd.header;
      const flags = (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
      const tfdt = child(bytes, traf, 'tfdt');
      let time = null;
      if (tfdt) { const q = tfdt.start + tfdt.header; time = bytes[q] === 1 ? u64(bytes, q + 4) : u32(bytes, q + 4); }
      trafs.push({ id: u32(bytes, p + 4), tfhdPos: p, flags, tfdtPos: tfdt ? tfdt.start + tfdt.header : -1, time });
    }
    fragment.bytes = bytes; fragment.trafs = trafs;
    const seconds = trafs.filter(t => t.time !== null).map(t => t.time / (timescales.get(fragment.index + ':' + t.id) || 1));
    fragment.seconds = seconds.length ? Math.min(...seconds) : null;
    fragment.bytes = null; // re-read when writing to keep memory flat
    fragment.meta = trafs;
    return fragment;
  }
  // Merge one or more fragmented MP4 sources into a single fragmented MP4 written to sink.
  // sink: { write(Uint8Array) -> Promise }. Returns a summary of the output.
  async function merge(sources, sink, { normalize = true, signal, onProgress } = {}) {
    const loaded = [];
    for (let i = 0; i < sources.length; i++) loaded.push(await loadSource(sources[i], i));
    const base = loaded[0].info;
    const movieTimescale = base.movieTimescale || 1000;
    const idMap = new Map(), timescales = new Map();
    let nextId = 1;
    const traks = [], trexes = [];
    let movieDuration = 0;
    for (const src of loaded) {
      const scale = movieTimescale / (src.info.movieTimescale || movieTimescale);
      movieDuration = Math.max(movieDuration, Math.round(src.info.movieDuration * scale));
      for (const track of src.info.tracks) {
        if (track.kind === 'text' && loaded.length > 1) continue;
        const id = nextId++;
        idMap.set(src.index + ':' + track.id, id);
        timescales.set(src.index + ':' + track.id, track.timescale);
        traks.push(rewriteTrak(src.moovBytes, track.box, id, scale));
        trexes.push(trex(id, src.trexById.get(track.id)));
      }
    }
    if (!traks.length) throw new Mp4Error('No audio or video tracks to merge.', 'integrity');
    // mvhd from the first source with new duration and next_track_ID.
    const mvhdBox = child(loaded[0].moovBytes, base.moov, 'mvhd');
    const mvhd = loaded[0].moovBytes.slice(mvhdBox.start, mvhdBox.end);
    const mv = mvhdBox.header;
    if (mvhd[mv] === 1) w64(mvhd, mv + 24, movieDuration); else w32(mvhd, mv + 16, Math.min(0xffffffff, movieDuration));
    w32(mvhd, mvhd.length - 4, nextId);
    const moov = box('moov', mvhd, ...traks, box('mvex', ...trexes));
    let written = 0;
    const write = async bytes => { await sink.write(bytes); written += bytes.length; };
    await write(ftyp());
    await write(moov);
    const fragments = [];
    for (const src of loaded) for (const f of src.fragments) fragments.push(await parseFragment(f, timescales));
    // Common start offset so tracks keep their relative timing but begin near zero.
    let offsetSeconds = 0;
    if (normalize) {
      const starts = fragments.filter(f => f.seconds !== null).map(f => f.seconds);
      offsetSeconds = starts.length ? Math.min(...starts) : 0;
    }
    const ordered = fragments.map((f, n) => ({ f, n })).sort((a, b) => {
      if (a.f.seconds === null || b.f.seconds === null) return a.n - b.n;
      return a.f.seconds - b.f.seconds || a.f.index - b.f.index || a.n - b.n;
    }).map(x => x.f);
    let sequence = 0, totalBytes = ordered.reduce((s, f) => s + (f.end - f.moof.start), 0), done = 0;
    const perTrack = new Map();
    for (const f of ordered) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const moofBytes = await read(f.source, f.moof.start, f.moof.end);
      const moof = boxes(moofBytes)[0];
      const mfhd = child(moofBytes, moof, 'mfhd');
      if (mfhd) w32(moofBytes, mfhd.start + mfhd.header + 4, ++sequence);
      for (const t of f.meta) {
        const key = f.index + ':' + t.id;
        const newId = idMap.get(key);
        if (!newId) continue;
        w32(moofBytes, t.tfhdPos + 4, newId);
        if (t.flags & 1) {
          const old = u64(moofBytes, t.tfhdPos + 8);
          w64(moofBytes, t.tfhdPos + 8, written + (old - f.moof.start));
        }
        if (t.tfdtPos >= 0 && t.time !== null && offsetSeconds) {
          const shift = Math.round(offsetSeconds * timescales.get(key));
          const value = Math.max(0, t.time - shift);
          if (moofBytes[t.tfdtPos] === 1) w64(moofBytes, t.tfdtPos + 4, value); else w32(moofBytes, t.tfdtPos + 4, value);
        }
        perTrack.set(newId, (perTrack.get(newId) || 0) + 1);
      }
      await write(moofBytes);
      // Copy the following mdat region in bounded chunks.
      for (let o = f.moof.end; o < f.end; o += 8 * 1024 * 1024) {
        await write(await read(f.source, o, Math.min(f.end, o + 8 * 1024 * 1024)));
      }
      done += f.end - f.moof.start;
      onProgress?.(totalBytes ? done / totalBytes : 1);
    }
    return { bytes: written, tracks: [...idMap.entries()].map(([key, id]) => {
      const [index, old] = key.split(':').map(Number);
      const track = loaded[index].info.tracks.find(t => t.id === old);
      return { id, kind: track.kind, codec: track.codec, fragments: perTrack.get(id) || 0 };
    }), fragments: ordered.length, offsetSeconds };
  }
  // Structural validation of a finished MP4 (fragmented or progressive).
  async function validate(source, { expectKinds = [] } = {}) {
    if (!source || !source.size) return { ok: false, reason: 'The output file is empty.' };
    let top;
    try { top = await scan(source); } catch (error) { return { ok: false, reason: error.message }; }
    if (!top.some(b => b.type === 'ftyp')) return { ok: false, reason: 'Missing ftyp box.' };
    const moovBox = top.find(b => b.type === 'moov');
    if (!moovBox) return { ok: false, reason: 'Missing moov box.' };
    let info;
    try { info = parseMoov(await read(source, moovBox.start, moovBox.end)); } catch (error) { return { ok: false, reason: error.message }; }
    const mdatBytes = top.filter(b => b.type === 'mdat').reduce((s, b) => s + b.size - b.header, 0);
    if (!mdatBytes) return { ok: false, reason: 'The output contains no media data.' };
    const kinds = info.tracks.map(t => t.kind);
    for (const kind of expectKinds) if (!kinds.includes(kind)) return { ok: false, reason: 'The output has no ' + kind + ' track.' };
    if (info.encrypted) return { ok: false, reason: 'The output is encrypted.' };
    return { ok: true, tracks: info.tracks.map(({ box, ...t }) => t), fragments: top.filter(b => b.type === 'moof').length, mdatBytes };
  }
  return { boxes, scan, parseMoov, inspectInit, assertClear, merge, validate, Mp4Error, fourcc };
})();
