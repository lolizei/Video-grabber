// Runs in an extension tab. Downloads HLS (TS/fMP4, separate audio), DASH (SegmentTemplate,
// SegmentTimeline, SegmentList, SegmentBase), range-chunked streams and direct files with the
// shared DownloadEngine: concurrent ordered segments, retries with backoff, pause/cancel,
// disk-backed temporary storage, resumable checkpoints, local merging and output validation.
// Encrypted/DRM media is detected and rejected before any key, license or segment request.

const $ = s => document.querySelector(s);
const E = DownloadEngine;
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const srcUrl = params.get('url');
let name = MediaTools.filename(params.get('name') || 'video.mp4');
const knownSize = Number(params.get('size')) || 0;
const jobId = params.get('job');
const sourceTab = params.has('sourceTab') ? Number(params.get('sourceTab')) : undefined;
const frameId = Number(params.get('frame')) || 0;
const auto = params.get('auto') === '1';
let selection = (() => { try { return JSON.parse(params.get('sel') || '{}') || {}; } catch { return {}; } })();
let settings = { concurrency: 4, retries: 4 };
const controller = new AbortController();
const signal = controller.signal;
const gate = new E.PauseGate();
let phase = 'download', meter = null, store = null, resumeKey = '', downloadId, finished = false, cancelled = false;
let jobProgress = 0, jobMessage = 'Starting…', lastReport = 0, errorCode = '';
const hasRuntime = () => !!globalThis.chrome?.runtime?.sendMessage;
const CONFIG = globalThis.VG_CONFIG || {};

async function report(status = 'running', force = false) {
  if (!jobId || !hasRuntime() || (!force && Date.now() - lastReport < 300)) return;
  lastReport = Date.now();
  const snap = meter?.snapshot() || {};
  try {
    await chrome.runtime.sendMessage({ cmd: 'scanner.progress', id: jobId, status, progress: jobProgress, message: jobMessage, phase,
      paused: gate.paused, speed: snap.speed || 0, eta: snap.eta ?? null, bytes: snap.bytes || 0, total: snap.total || 0, downloadId, errorCode });
  } catch { /* The service worker may be restarting; the next report retries. */ }
}
const log = m => { $('#log').textContent += m + '\n'; };
const setStatus = m => { $('#status').textContent = m; jobMessage = m; report(); };
function setProgress(frac, text) {
  jobProgress = Math.max(0, Math.min(1, frac || 0));
  $('#bar').style.width = (jobProgress * 100).toFixed(1) + '%';
  $('#progress').textContent = text || '';
  if (text) jobMessage = text;
  report();
}
function showMeter() {
  if (!meter) return;
  const s = meter.snapshot();
  const parts = [E.fmtBytes(s.bytes) + (s.total ? ' / ' + (meter.totalBytes ? '' : '~') + E.fmtBytes(s.total) : '')];
  if (s.speed) parts.push(E.fmtBytes(s.speed) + '/s');
  if (s.eta !== null && s.eta !== undefined) parts.push(E.fmtTime(s.eta) + ' left');
  if (gate.paused) parts.push('paused');
  $('#speed').textContent = parts.join(' · ');
  const units = s.totalUnits ? ` · ${s.units}/${s.totalUnits} segments` : '';
  setProgress(s.fraction, `${Math.round(s.fraction * 100)}%${units}`);
}
const setName = value => { name = MediaTools.filename(value); $('#name').textContent = name; document.title = 'Downloading – ' + name; };
const withExt = ext => name.replace(/\.[^/.]+$/, '') + '.' + ext;
setName(name);

// ---------- controls ----------
function pause(toggle = !gate.paused) {
  if (finished) return;
  if (toggle) gate.pause(); else gate.resume();
  $('#pause').textContent = gate.paused ? 'Resume' : 'Pause';
  setStatus(gate.paused ? 'Paused' : 'Resuming…');
  report('running', true);
}
async function cancel() {
  if (finished || cancelled) return;
  cancelled = true;
  gate.resume();
  controller.abort();
  if (downloadId !== undefined) await chrome.downloads.cancel(downloadId).catch(() => {});
  $('#pause').disabled = true; $('#cancel').disabled = true;
}
$('#pause').onclick = () => pause();
$('#cancel').onclick = () => cancel();
globalThis.chrome?.runtime?.onMessage?.addListener((msg, _sender, reply) => {
  if (msg?.cmd !== 'downloader.control' || msg.id !== jobId) return;
  if (msg.action === 'pause') pause(true);
  else if (msg.action === 'resume') pause(false);
  else if (msg.action === 'cancel') cancel();
  reply({ ok: true, paused: gate.paused });
});

// ---------- network ----------
const fallback = sourceTab === undefined || !hasRuntime() ? null : async (url, range) => {
  const reply = await chrome.runtime.sendMessage({ cmd: 'scanner.fetch', tabId: sourceTab, frameId, referrer: params.get('referrer') || '',
    url, range: range ? `bytes=${range[0]}-${range[1]}` : undefined });
  if (!reply?.ok) throw new Error(reply?.error || 'Page fetch failed.');
  const r = reply.result;
  const response = new Response(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)), { status: r.status, headers: r.headers });
  Object.defineProperty(response, 'url', { value: r.url });
  return response;
};
const fetchOptions = () => ({ retries: settings.retries, fallback, fetchImpl: (...args) => fetch(...args),
  onRetry: ({ attempt, delay, error, index }) => log(`Retry ${attempt}${index !== undefined ? ' for segment ' + (index + 1) : ''} in ${(delay / 1000).toFixed(1)} s: ${error.message}`) });
async function fetchText(url) {
  const result = await E.fetchBytes(url, { ...fetchOptions(), signal, gate, expectMedia: false });
  return { text: new TextDecoder().decode(result.bytes), url: result.url || url };
}
function protectedError(drm) {
  return E.vgError('Protected stream: ' + (drm.summary || DrmTools.label(drm)), 'protected', { drm });
}

// ---------- quality chooser ----------
function choose(options, title = 'Choose a quality:') {
  return new Promise(resolve => {
    setStatus(title);
    const ul = $('#variants');
    ul.hidden = false;
    options.forEach((option, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = option.label;
      const b = document.createElement('button');
      b.textContent = i === 0 ? 'Download (best)' : 'Download';
      b.onclick = () => { ul.hidden = true; resolve(option); };
      li.append(span, b);
      ul.appendChild(li);
    });
  });
}
const mbps = bw => bw ? (bw / 1e6).toFixed(bw < 1e6 ? 2 : 1) + ' Mbps' : '';
const variantLabel = v => [v.height ? v.height + 'p' : v.audioOnly ? 'Audio only' : 'Stream', mbps(v.bandwidth), v.codecs?.join?.(',') || v.codecs || ''].filter(Boolean).join(' · ');

// ---------- checkpoints ----------
const ckptKey = () => 'vg_ckpt_' + resumeKey;
const local = () => globalThis.chrome?.storage?.local;
async function loadCheckpoint() { try { return (await local().get(ckptKey()))[ckptKey()] || null; } catch { return null; } }
async function saveCheckpoint(data) { try { await local()?.set({ [ckptKey()]: { ...data, updated: Date.now() } }); } catch {} }
async function dropCheckpoint() { try { await local()?.remove(ckptKey()); } catch {} }
async function pruneStorage() {
  try {
    const all = (await local()?.get(null)) || {};
    const keep = new Set(), stale = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('vg_ckpt_')) continue;
      if (Date.now() - (value?.updated || 0) > 7 * 86400000) stale.push(key); else keep.add(key.slice(8));
    }
    if (stale.length) await local().remove(stale);
    keep.add(resumeKey);
    await E.Storage.prune(keep);
  } catch {}
}

// ---------- download tracks ----------
const pathOf = url => { try { return new URL(url).pathname; } catch { return url; } };
async function prepareStore(tracks, kind) {
  const identity = { src: CdnTools.dedupKey(srcUrl), kind, sel: selection, tracks: tracks.map(t => [t.role, t.segments.length, pathOf(t.segments[0]?.url), pathOf(t.segments.at(-1)?.url), t.init ? pathOf(t.init.url) : ''] ) };
  resumeKey = await E.digest(JSON.stringify(identity));
  const fingerprint = JSON.stringify(identity.tracks);
  const options = { chunkBytes: Number(CONFIG.TEMP_CHUNK_BYTES) || undefined };
  // Register the job in storage.local before creating its folder, so a concurrent download tab
  // pruning abandoned folders never removes this one.
  let ckpt = await loadCheckpoint();
  const stale = ckpt && ckpt.fingerprint !== fingerprint;
  if (stale) ckpt = null;
  const state = { fingerprint, tracks: { ...(ckpt?.tracks || {}) } };
  await saveCheckpoint(state);
  store = await E.Storage.open(resumeKey, options);
  if (store.kind !== 'opfs') ckpt = null;
  else if (stale) { await store.remove(); store = await E.Storage.open(resumeKey, options); }
  pruneStorage();
  return { ckpt, state };
}
async function downloadTrack(track, context) {
  const { ckpt, state } = context;
  let resume = ckpt?.tracks?.[track.role] || null;
  let sink = store.sink(track.role, resume, async checkpoint => { state.tracks[track.role] = checkpoint; await saveCheckpoint(state); });
  if (resume && !(await sink.verify())) {
    log(`Saved ${track.role} data could not be verified; restarting that track.`);
    await sink.remove(); resume = null; delete state.tracks[track.role];
    sink = store.sink(track.role, null, async checkpoint => { state.tracks[track.role] = checkpoint; await saveCheckpoint(state); });
  }
  let startAt = 0;
  if (track.init) {
    const init = await E.fetchBytes(track.init.url, { ...fetchOptions(), range: track.init.range, signal, gate });
    if (track.container === 'fmp4') {
      const info = Mp4Tools.inspectInit(init.bytes);
      if (info.encrypted) throw protectedError(info.drm);
      log(`${track.role}: ${info.tracks.map(t => t.kind + ' ' + t.codec).join(', ')}`);
    }
    if (!resume) { await sink.write(init.bytes); await sink.mark(-1); }
  }
  if (resume) {
    startAt = resume.segEnd + 1;
    meter.add(resume.bytes); for (let i = 0; i < startAt; i++) meter.unit(0);
    log(`Resuming ${track.role} at segment ${startAt + 1} of ${track.segments.length} (${E.fmtBytes(resume.bytes)} recovered).`);
  }
  const timer = setInterval(showMeter, 500);
  try {
    await E.downloadSegments({ segments: track.segments, sink, concurrency: settings.concurrency, signal, gate, meter, startAt,
      fetchOptions: fetchOptions(), onRetry: fetchOptions().onRetry,
      transform: track.firstCheck ? async (data, index) => { if (index === 0) track.firstCheck(data); return data; } : undefined });
  } finally { clearInterval(timer); }
  await sink.commit();
  showMeter();
  return sink;
}

// ---------- conversion ----------
function transmux(blob, sizes, out, { keepOriginalTimestamps = false, label = '', flush = true } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('ts-converter.js');
    let writing = Promise.resolve(), waiter = null, failed = null;
    const fail = error => { failed ||= error; worker.terminate(); waiter?.reject(failed); reject(failed); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'data') writing = writing.then(() => out.write(new Uint8Array(data.bytes))).catch(fail);
      else if (data.type === 'ack' || data.type === 'done') { const w = waiter; waiter = null; w?.resolve(data); }
      else if (data.type === 'error') fail(E.vgError(data.message, /^Protected stream/.test(data.message) ? 'protected' : 'conversion'));
    };
    worker.onerror = event => fail(E.vgError(event.message || 'MP4 conversion failed.', 'conversion'));
    const next = message => new Promise((res, rej) => { waiter = { resolve: res, reject: rej }; worker.postMessage(message, message.data ? [message.data] : []); });
    (async () => {
      worker.postMessage({ type: 'start', options: { keepOriginalTimestamps } });
      let offset = 0;
      for (let i = 0; i < sizes.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        await gate.wait(signal);
        const data = await blob.slice(offset, offset + sizes[i]).arrayBuffer();
        offset += sizes[i];
        await next({ type: 'push', data, flush });
        await writing;
        setProgress((i + 1) / sizes.length, `Converting${label ? ' ' + label : ''} · ${Math.round((i + 1) / sizes.length * 100)}%`);
      }
      const done = await next({ type: 'end' });
      await writing;
      worker.terminate();
      if (failed) throw failed;
      resolve(done);
    })().catch(fail);
  });
}
async function ffmpegMerge(video, audio, container) {
  if (!(CONFIG.ENABLE_YOUTUBE ?? CONFIG.enableYouTube)) throw E.vgError('FFmpeg is not included in this build.', 'unsupported');
  if (video.size + audio.size > 1.5 * 1024 ** 3) throw E.vgError('Tracks are too large for in-browser FFmpeg merging.', 'unsupported');
  const files = [{ name: 'video.input', data: await video.arrayBuffer() }, { name: 'audio.input', data: await audio.arrayBuffer() }];
  const worker = new Worker('youtube/converter-worker.js');
  try {
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      worker.onmessage = ({ data }) => {
        if (data.type === 'done') resolve(new Blob([data.data], { type: 'video/' + container }));
        else if (data.type === 'error') reject(E.vgError(data.message, 'conversion'));
        else setProgress(data.progress || 0, 'Merging with FFmpeg…');
      };
      worker.onerror = event => reject(E.vgError(event.message || 'FFmpeg could not load.', 'conversion'));
      worker.postMessage({ job: { mode: 'merge', output: container }, files }, files.map(f => f.data));
    });
  } finally { worker.terminate(); }
}

// ---------- saving ----------
function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = async state => {
      chrome.downloads.onChanged.removeListener(changed);
      if (state !== 'complete') return reject(E.vgError('File saving was interrupted.', 'save'));
      const [item] = await chrome.downloads.search({ id }).catch(() => []);
      resolve(item || null);
    };
    const changed = delta => { if (delta.id === id && delta.state && ['complete', 'interrupted'].includes(delta.state.current)) finish(delta.state.current); };
    chrome.downloads.onChanged.addListener(changed);
    chrome.downloads.search({ id }).then(items => { if (items[0] && ['complete', 'interrupted'].includes(items[0].state)) finish(items[0].state); },
      error => { chrome.downloads.onChanged.removeListener(changed); reject(error); });
  });
}
async function save(blob, filename, format, expectKinds = []) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  phase = 'saving';
  const check = await E.validateOutput(blob, { format, expectKinds });
  if (!check.ok) throw E.vgError('Output validation failed: ' + check.reason, 'integrity');
  setName(filename);
  const url = URL.createObjectURL(blob);
  try {
    downloadId = await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
    setStatus('Saving file…');
    report('running', true);
    const item = await waitForDownload(downloadId);
    if (item?.exists === false) throw E.vgError('The saved file no longer exists.', 'save');
    const savedSize = item?.fileSize > 0 ? item.fileSize : item?.bytesReceived;
    if (savedSize !== undefined && savedSize !== blob.size) throw E.vgError(`Saved file size (${savedSize}) does not match the output (${blob.size}).`, 'save');
  } finally { URL.revokeObjectURL(url); }
  setProgress(1, E.fmtBytes(blob.size));
}
async function cleanup() { try { await store?.remove(); } catch {} if (resumeKey) await dropCheckpoint(); }

// ---------- assembling outputs ----------
const formatFor = track => track.container === 'fmp4' ? 'mp4' : track.container === 'webm' ? 'webm' : track.container === 'packed-audio' ? 'aac' : 'ts';
async function assemble(tracks, sinks) {
  phase = 'convert';
  const out = () => store.sink('output-' + Date.now(), null);
  const blobs = {};
  for (const track of tracks) blobs[track.role] = await sinks[track.role].blob();
  const hasAudio = tracks.some(t => t.role === 'audio');
  // WebM DASH: lossless FFmpeg merge in the full build, otherwise separate files.
  if (tracks.some(t => t.container === 'webm')) {
    if (tracks.length === 2) {
      try {
        setStatus('Merging WebM audio and video…');
        const merged = await ffmpegMerge(blobs.video, blobs.audio, 'webm');
        return save(merged, withExt('webm'), 'webm');
      } catch (error) {
        if (E.isAbort(error)) throw error;
        log('WebM merge unavailable: ' + error.message + ' Saving audio and video as separate files.');
      }
      await save(blobs.video, withExt('webm').replace(/\.webm$/, ' [video].webm'), 'webm');
      await save(blobs.audio, withExt('webm').replace(/\.webm$/, ' [audio].webm'), 'webm');
      return;
    }
    return save(blobs[tracks[0].role], withExt('webm'), 'webm');
  }
  // TS-only single track: mux.js remux to MP4, falling back to the original TS.
  if (tracks.length === 1 && tracks[0].container !== 'fmp4') {
    const sink = out();
    try {
      setStatus('Download finished. Converting to MP4…');
      await transmux(blobs[tracks[0].role], sinks[tracks[0].role].sizes, sink, { flush: !tracks[0].byteChunks });
      return await save(await sink.blob('video/mp4'), withExt('mp4'), 'mp4', tracks[0].role === 'audio' ? ['audio'] : []);
    } catch (error) {
      if (E.isAbort(error) || error.code === 'protected') throw error;
      await sink.remove();
      log('MP4 conversion failed: ' + error.message + ' Saving the original stream instead.');
      const format = formatFor(tracks[0]);
      await save(blobs[tracks[0].role], withExt(format), format);
      setStatus(`Saved the original ${format.toUpperCase()} file. MP4 conversion failed; see the details below.`);
      return 'fallback';
    }
  }
  // Convert TS tracks to fragmented MP4, then merge all fMP4 tracks.
  const sources = [];
  try {
    for (const track of tracks) {
      if (track.container === 'fmp4') { sources.push(blobs[track.role]); continue; }
      const sink = out();
      await transmux(blobs[track.role], sinks[track.role].sizes, sink, { keepOriginalTimestamps: tracks.length > 1, label: track.role });
      sources.push(await sink.blob());
    }
    setStatus(hasAudio ? 'Merging audio and video…' : 'Finalizing MP4…');
    const merged = out();
    const result = await Mp4Tools.merge(sources, merged, { signal, onProgress: f => setProgress(f, `Merging · ${Math.round(f * 100)}%`) });
    log('Output tracks: ' + result.tracks.map(t => `${t.kind} ${t.codec} (${t.fragments} fragments)`).join(', '));
    const kinds = tracks.length > 1 ? ['video', 'audio'] : [];
    return await save(await merged.blob('video/mp4'), withExt('mp4'), 'mp4', kinds);
  } catch (error) {
    if (E.isAbort(error) || error.code === 'protected' || error.code === 'save') throw error;
    log('Could not merge into one MP4: ' + error.message);
    if (tracks.length === 2) {
      try {
        const merged = await ffmpegMerge(blobs.video, blobs.audio, 'mp4');
        return await save(merged, withExt('mp4'), 'mp4', ['video', 'audio']);
      } catch (ffmpegError) { if (E.isAbort(ffmpegError)) throw ffmpegError; log('FFmpeg merge unavailable: ' + ffmpegError.message); }
    }
    for (const track of tracks) {
      const format = formatFor(track);
      await save(blobs[track.role], tracks.length > 1 ? withExt(format).replace(/(\.\w+)$/, ` [${track.role}]$1`) : withExt(format), format);
    }
    setStatus('Saved the tracks as separate files because they could not be merged; see details below.');
    return 'fallback';
  }
}
async function runTracks(tracks, kind) {
  const context = await prepareStore(tracks, kind);
  meter = new E.ProgressMeter({ totalUnits: tracks.reduce((s, t) => s + t.segments.length, 0), totalBytes: tracks.reduce((s, t) => s + (t.totalBytes || 0), 0) });
  if (store.kind === 'memory') log('Disk-backed temporary storage is unavailable; using browser memory.');
  $('#pause').hidden = false;
  const sinks = {};
  for (const track of tracks) {
    setStatus(`Downloading ${track.role} · ${track.segments.length} segment${track.segments.length === 1 ? '' : 's'}…`);
    sinks[track.role] = await downloadTrack(track, context);
  }
  $('#pause').hidden = true;
  const result = await assemble(tracks, sinks);
  await cleanup();
  return result;
}

// ---------- byte-range segmentation for single files ----------
async function rangeSegments(url, size = 0, chunk = 8 * 1024 * 1024) {
  if (!size) {
    try {
      const probe = await E.fetchBytes(url, { ...fetchOptions(), range: [0, 0], signal, gate, retries: 1 });
      size = Number((probe.headers.get('content-range') || '').split('/')[1]) || 0;
    } catch (error) {
      if (error.code !== 'range' && !E.isAbort(error) && !['network', 'http'].includes(error.code)) throw error;
      if (E.isAbort(error)) throw error;
    }
  }
  if (!size) return { segments: [{ url, range: null }], totalBytes: 0 };
  const segments = [];
  for (let s = 0; s < size; s += chunk) segments.push({ url, range: [s, Math.min(s + chunk, size) - 1] });
  return { segments, totalBytes: size };
}

// ---------- modes ----------
async function hls() {
  let { text, url } = await fetchText(srcUrl);
  if (!text.trimStart().startsWith('#EXTM3U')) throw E.vgError('Not a valid HLS playlist.', 'unsupported');
  let audio = null;
  for (let depth = 0; HlsTools.isMaster(text); depth++) {
    if (depth > 5) throw E.vgError('Too many nested playlists.', 'unsupported');
    const drm = DrmTools.hls(text);
    if (drm) throw protectedError(drm);
    const master = HlsTools.parseMaster(text, url);
    if (!master.variants.length) throw E.vgError('Playlist contains no variants.', 'unsupported');
    let sel = selection;
    if (!auto && !sel.height && !sel.url && master.variants.length > 1) sel = { ...sel, url: (await choose(master.variants.map(v => ({ label: variantLabel(v), url: v.url })))).url };
    const picked = HlsTools.select(master, sel);
    log('Selected ' + variantLabel(picked.variant) + (picked.audio ? ' with audio "' + (picked.audio.name || picked.audio.language) + '"' : ''));
    ({ text, url } = await fetchText(picked.variant.url));
    if (picked.audio) {
      const a = await fetchText(picked.audio.url);
      audio = HlsTools.parseMedia(a.text, a.url);
    }
  }
  const video = HlsTools.parseMedia(text, url);
  if (!video.segments.length) throw E.vgError('Playlist contains no segments.', 'unsupported');
  if (video.live) log('Note: this looks like a live stream. Only the segments currently listed will be saved.');
  const tracks = [{ role: 'video', ...video }];
  if (audio?.segments.length) tracks.push({ role: 'audio', ...audio });
  return runTracks(tracks, 'hls');
}
async function dash() {
  const { text, url } = await fetchText(srcUrl);
  if (!/<(?:[\w.-]+:)?MPD\b/i.test(text)) throw E.vgError('Not a DASH manifest.', 'unsupported');
  const drm = DrmTools.dash(text);
  if (drm) throw protectedError(drm);
  const manifest = DashTools.parse(text, url);
  if (manifest.warning) log(manifest.warning);
  if (manifest.live) log('Note: live DASH. Only the segments currently listed will be saved.');
  let sel = selection;
  const videos = manifest.representations.filter(r => (r.kind === 'video' || r.kind === 'muxed') && !r.error);
  if (!auto && !sel.height && !sel.id && videos.length > 1)
    sel = { ...sel, id: (await choose(videos.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth).map(r => ({ label: variantLabel({ ...r, codecs: r.codecs }), id: r.id })))).id };
  const picked = DashTools.select(manifest, sel);
  const tracks = [];
  for (const [role, rep] of [['video', picked.video], ['audio', picked.audio]]) {
    if (!rep) continue;
    if (rep.protected) throw protectedError({ summary: 'DASH ContentProtection on the selected representation', systems: [], drm: true });
    log(`${role}: ${rep.id} · ${rep.height ? rep.height + 'p · ' : ''}${rep.codecs} · ${mbps(rep.bandwidth)} · ${rep.segments.addressing}`);
    const container = rep.container === 'webm' ? 'webm' : 'fmp4';
    if (rep.segments.single) {
      const ranged = await rangeSegments(rep.segments.media[0].url);
      tracks.push({ role, container, init: null, segments: ranged.segments, totalBytes: ranged.totalBytes });
    } else tracks.push({ role, container, init: rep.segments.init, segments: rep.segments.media });
  }
  if (!tracks.length) throw E.vgError('No downloadable representations.', 'unsupported');
  if (tracks.length === 1 && picked.audio && !picked.video) setName(withExt(tracks[0].container === 'webm' ? 'webm' : 'm4a'));
  return runTracks(tracks, 'dash');
}
async function chunked() {
  // googlevideo-style streams take the byte range as a URL parameter.
  let size = knownSize;
  if (!size) {
    const probe = await E.fetchBytes(srcUrl, { ...fetchOptions(), range: [0, 0], signal, gate, credentials: 'omit' });
    size = Number((probe.headers.get('content-range') || '').split('/')[1]) || 0;
  }
  if (!size) throw E.vgError('Could not determine the stream size.', 'unsupported');
  const CHUNK = 9 * 1024 * 1024, segments = [];
  for (let s = 0; s < size; s += CHUNK) {
    const u = new URL(srcUrl);
    u.searchParams.set('range', `${s}-${Math.min(s + CHUNK, size) - 1}`);
    segments.push({ url: u.href, range: null });
  }
  const mime = decodeURIComponent(new URL(srcUrl).searchParams.get('mime') || 'video/mp4');
  const container = mime.includes('webm') ? 'webm' : 'raw';
  const context = await prepareStore([{ role: 'main', segments }], 'chunked');
  meter = new E.ProgressMeter({ totalBytes: size, totalUnits: segments.length });
  $('#pause').hidden = false;
  const sink = await downloadTrack({ role: 'main', segments, container }, context);
  $('#pause').hidden = true;
  const ext = mime.includes('webm') ? (mime.startsWith('audio') ? 'weba' : 'webm') : mime.startsWith('audio') ? 'm4a' : 'mp4';
  const blob = await sink.blob(mime);
  if (blob.size !== size) throw E.vgError(`Incomplete stream: ${blob.size} of ${size} bytes.`, 'integrity');
  await save(blob, name.match(/\.\w+$/) ? name : withExt(ext), ext === 'weba' ? 'webm' : ext);
  await cleanup();
}
const extOf = value => (value.match(/\.([a-z0-9]{2,4})$/i)?.[1] || '').toLowerCase();
async function file() {
  setStatus('Downloading file…');
  const ranged = await rangeSegments(srcUrl, knownSize);
  const ext = extOf(name);
  const format = { mp4: 'mp4', m4a: 'mp4', m4v: 'mp4', mov: 'mp4', mp3: 'mp3', webm: 'webm', mkv: 'mkv', ts: 'ts', aac: 'aac' }[ext] || '';
  const context = await prepareStore([{ role: 'main', segments: ranged.segments }], 'file');
  meter = new E.ProgressMeter({ totalBytes: ranged.totalBytes, totalUnits: ranged.segments.length > 1 ? ranged.segments.length : 0 });
  $('#pause').hidden = false;
  const sink = await downloadTrack({ role: 'main', segments: ranged.segments, container: 'raw' }, context);
  $('#pause').hidden = true;
  const blob = await sink.blob();
  if (ranged.totalBytes && blob.size !== ranged.totalBytes) throw E.vgError(`Incomplete file: ${blob.size} of ${ranged.totalBytes} bytes.`, 'integrity');
  await save(blob, name, format);
  await cleanup();
}
async function ts() {
  const ranged = await rangeSegments(srcUrl, knownSize, 64 * 1024 * 1024);
  const tracks = [{ role: 'video', container: 'ts', init: null, segments: ranged.segments, totalBytes: ranged.totalBytes, byteChunks: ranged.segments.length > 1 }];
  return runTracks(tracks, 'ts');
}
async function manifestOnly() {
  setStatus('Checking DASH protection…');
  const { text } = await fetchText(srcUrl);
  if (!/<(?:[\w.-]+:)?MPD\b/i.test(text)) throw E.vgError('Not a DASH manifest.', 'unsupported');
  const drm = DrmTools.dash(text);
  if (drm) throw protectedError(drm);
  log('Saved the DASH manifest only.');
  await save(new Blob([text], { type: 'application/dash+xml' }), withExt('mpd'), 'mpd');
}

async function claim() {
  if (!jobId || !hasRuntime()) {
    try { Object.assign(settings, (await local()?.get('vg_settings'))?.vg_settings || {}); } catch {}
    return null;
  }
  const reply = await chrome.runtime.sendMessage({ cmd: 'scanner.claim', id: jobId });
  if (!reply?.ok) throw E.vgError(reply?.error || 'This download job is no longer active.', 'stale');
  const job = reply.result;
  if (job.item?.selection) selection = { ...job.item.selection, ...selection };
  Object.assign(settings, job.settings || {});
  return job;
}
const hints = {
  expired: 'The link expired. Replay the media on the source page, click Refresh in the popup and retry.',
  auth: 'Sign in or open the source page in this browser profile, replay the media and retry. Video Grabber never bypasses logins.',
  'not-found': 'The resource was removed or the URL is wrong.',
  protected: 'This stream is encrypted/DRM-protected. Video Grabber does not acquire licenses or keys.',
  unsupported: 'This streaming configuration is not supported.',
  network: 'A network problem interrupted the download. Retry from the popup; completed segments resume when possible.',
  http: 'The server kept failing. Retry later; completed segments resume when possible.',
  integrity: 'The downloaded data was incomplete or invalid; nothing was reported as successful.'
};

(async () => {
  try {
    await claim();
    settings.concurrency = Math.max(1, Math.min(8, Number(settings.concurrency) || 4));
    settings.retries = Math.max(0, Math.min(10, Number(settings.retries) ?? 4));
    $('#cancel').hidden = false;
    let result;
    if (mode === 'hls') result = await hls();
    else if (mode === 'dash') result = await dash();
    else if (mode === 'chunked') result = await chunked();
    else if (mode === 'ts') result = await ts();
    else if (mode === 'file') result = await file();
    else if (mode === 'manifest') result = await manifestOnly();
    else throw E.vgError('Unknown mode.', 'unsupported');
    finished = true;
    $('#pause').hidden = true; $('#cancel').hidden = true;
    if (result !== 'fallback') setStatus('Done ✓ The file is in your downloads. You can close this tab.');
    document.title = 'Done – ' + name;
    await report('complete', true);
  } catch (e) {
    finished = true;
    $('#pause').hidden = true; $('#cancel').hidden = true;
    if (e?.code === 'stale') { setStatus(e.message); log('Start the download again from the Video Grabber popup.'); document.title = 'Inactive – ' + name; return; }
    if (cancelled || E.isAbort(e)) {
      await cleanup();
      setStatus('Cancelled');
      document.title = 'Cancelled – ' + name;
      await report('cancelled', true);
      return;
    }
    const message = String(e?.message || e);
    const isProtected = e?.code === 'protected' || message.startsWith('Protected stream:');
    errorCode = isProtected ? 'protected' : e?.code || 'error';
    if (isProtected) await cleanup();
    setStatus('Failed: ' + message);
    log(hints[errorCode] || 'If the link expired, reload the video page, play it again and retry from the popup.');
    document.title = 'Failed – ' + name;
    await report(isProtected ? 'protected' : 'failed', true);
  }
})();
