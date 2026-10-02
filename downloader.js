// Runs in an extension tab: downloads HLS playlists (segment by segment) and
// range-chunked streams (YouTube), then saves the result as one file.

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const srcUrl = params.get('url');
let name = MediaTools.filename(params.get('name') || 'video.mp4');
const knownSize = Number(params.get('size')) || 0;
const jobId = params.get('job');
const sourceTab = params.has('sourceTab') ? Number(params.get('sourceTab')) : undefined;
let jobProgress = 0, jobMessage = 'Starting…', lastReport = 0;
async function report(status = 'running', force = false) {
  if (!jobId || (!force && Date.now() - lastReport < 300)) return;
  lastReport = Date.now();
  try {
    await chrome.runtime.sendMessage({ cmd: 'scanner.progress', id: jobId, status, progress: jobProgress, message: jobMessage });
  } catch { /* A page reload can temporarily restart the service worker. */ }
}

const fmt = n => n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : (n / (1 << 20)).toFixed(1) + ' MB';
const log = m => { $('#log').textContent += m + '\n'; };
const setStatus = m => { $('#status').textContent = m; jobMessage = m; report(); };
const setProgress = (frac, text) => {
  $('#bar').style.width = Math.min(100, frac * 100).toFixed(1) + '%';
  $('#progress').textContent = text || '';
  jobProgress = frac;
  if (text) jobMessage = text;
  report();
};
$('#name').textContent = name;
document.title = 'Downloading – ' + name;

async function fetchRetry(url, opts = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      let r;
      try {
        r = await fetch(url, { credentials: 'include', ...opts, signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (error) {
        if (sourceTab === undefined) throw error;
        const reply = await chrome.runtime.sendMessage({ cmd: 'scanner.fetch', tabId: sourceTab,
          frameId: Number(params.get('frame')) || 0, referrer: params.get('referrer'), url, range: opts.headers?.Range });
        if (!reply?.ok) throw new Error(reply?.error || error.message);
        const result = reply.result;
        r = new Response(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), { status: result.status, headers: result.headers });
        Object.defineProperty(r, 'url', { value: result.url });
      }
      if (opts.headers?.Range && r.status !== 206) throw new Error('Server ignored the requested byte range.');
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 600 * i));
    }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return out;
}

async function save(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
    setStatus('Saving file…');
    await new Promise((resolve, reject) => {
      const changed = delta => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(changed);
          if (delta.state.current === 'complete') resolve();
          else reject(new Error('File download was interrupted.'));
        }
      };
      chrome.downloads.onChanged.addListener(changed);
      chrome.downloads.search({ id }).then(items => {
        if (items[0]) changed({ id, state: { current: items[0].state } });
      }, error => {
        chrome.downloads.onChanged.removeListener(changed);
        reject(error);
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  setProgress(1, fmt(blob.size));
  setStatus('Done ✓ The file is in your downloads. You can close this tab.');
  document.title = 'Done – ' + name;
}

function convertTs(parts) {
  setStatus('Download finished. Converting to MP4…');
  setProgress(0, 'Converting…');
  return new Promise((resolve, reject) => {
    const worker = new Worker('ts-converter.js');
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) setProgress(data.progress, `Converting · ${Math.round(data.progress * 100)}%`);
      if (data.blob || data.error) {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.blob);
      }
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || 'MP4 conversion failed.'));
    };
    // Keep originals available for a TS fallback if conversion fails.
    worker.postMessage(parts);
  });
}

async function saveTs(parts) {
  let blob;
  try {
    blob = await convertTs(parts);
  } catch (error) {
    log('MP4 conversion failed: ' + error.message + ' Saving the original TS file instead.');
    name = name.replace(/\.[^/.]+$/, '') + '.ts';
    $('#name').textContent = name;
    await save(new Blob(parts, { type: 'video/mp2t' }));
    setStatus('Saved the original TS file. MP4 conversion failed; see the details below.');
    return;
  }
  name = name.replace(/\.[^/.]+$/, '') + '.mp4';
  $('#name').textContent = name;
  await save(blob);
}

// ---------------- range-chunked (YouTube googlevideo) ----------------
async function chunked() {
  const CHUNK = 9 * 1024 * 1024;
  let size = knownSize;
  const u = new URL(srcUrl);
  if (!size) {
    const r = await fetchRetry(srcUrl, { headers: { Range: 'bytes=0-0' } });
    size = Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
  }
  if (!size) throw new Error('Could not determine the stream size.');

  const ranges = [];
  for (let s = 0; s < size; s += CHUNK) ranges.push([s, Math.min(s + CHUNK, size) - 1]);
  let done = 0;
  setStatus(`Downloading ${ranges.length} chunks…`);
  const parts = await pool(ranges, 3, async ([a, b]) => {
    const cu = new URL(u);
    cu.searchParams.set('range', `${a}-${b}`);
    const buf = await (await fetchRetry(cu.toString(), { credentials: 'omit' })).arrayBuffer();
    done += buf.byteLength;
    setProgress(done / size, `${fmt(done)} / ${fmt(size)}`);
    return buf;
  });
  const mime = decodeURIComponent(u.searchParams.get('mime') || 'video/mp4');
  await save(new Blob(parts, { type: mime }));
}

// ---------------- HLS ----------------
const attr = PlaylistTools.attr;

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (!lines[j]) continue;
      const bw = Number(attr(l, 'BANDWIDTH')) || 0;
      const res = attr(l, 'RESOLUTION');
      out.push({ url: new URL(lines[j].trim(), base).href, bw,
                 label: `${res ? res.split('x')[1] + 'p' : 'Stream'} · ${(bw / 1e6).toFixed(1)} Mbps`,
                 hasSeparateAudio: !!attr(l, 'AUDIO') });
    } else if (l.startsWith('#EXT-X-MEDIA') && attr(l, 'TYPE') === 'AUDIO' && attr(l, 'URI')) {
      out.push({ url: new URL(attr(l, 'URI'), base).href, bw: -1, audio: true,
                 label: `Audio · ${attr(l, 'NAME') || attr(l, 'LANGUAGE') || 'track'}` });
    }
  }
  return out.sort((a, b) => b.bw - a.bw);
}

const parseMedia = PlaylistTools.parseMedia;

function chooseVariant(variants) {
  return new Promise(resolve => {
    setStatus('Choose a quality:');
    const ul = $('#variants');
    ul.hidden = false;
    variants.forEach((v, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = v.label + (v.hasSeparateAudio ? ' (video only, audio listed separately)' : '');
      const b = document.createElement('button');
      b.textContent = i === 0 ? 'Download (best)' : 'Download';
      b.onclick = () => { ul.hidden = true; resolve(v); };
      li.append(span, b);
      ul.appendChild(li);
    });
  });
}

async function hls() {
  let url = srcUrl;
  let text;
  for (let depth = 0; ; depth++) {
    if (depth > 5) throw new Error('Too many nested playlists.');
    const response = await fetchRetry(url);
    url = response.url || url;
    text = (await response.text()).trim();
    if (!text.startsWith('#EXTM3U')) throw new Error('Not a valid HLS playlist.');
    const protectedBy = PlaylistTools.protection(text);
    if (protectedBy) throw new Error('Protected stream: ' + protectedBy);
    if (!text.includes('#EXT-X-STREAM-INF')) break;
    const variants = parseMaster(text, url);
    if (!variants.length) throw new Error('Playlist contains no variants.');
    const v = variants.length === 1 || params.get('auto') === '1' ? variants[0] : await chooseVariant(variants);
    if (v.audio) name = name.replace(/\.\w+$/, ' [audio].ts');
    if (v.hasSeparateAudio) log('This variant has a separate audio playlist. This download contains video only; download the audio playlist separately.');
    url = v.url;
  }

  const { segs, init, ended } = parseMedia(text, url);
  if (!segs.length) throw new Error('Playlist contains no segments.');
  if (!ended) log('Note: this looks like a live stream. Only the segments currently listed will be saved.');

  const fmp4 = !!init || /\.(m4s|mp4|cmfv)(\?|$)/i.test(segs[0].url);
  if (fmp4) name = name.replace(/\.[^/.]+$/, '') + '.mp4';
  $('#name').textContent = name;

  const fetchBytes = async (target, options = {}) => {
    for (let attempt = 1; ; attempt++) {
      try { return await (await fetchRetry(target, options, 1)).arrayBuffer(); }
      catch (error) {
        if (attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 600 * attempt));
      }
    }
  };
  const get = async s => {
    const opts = s.range ? { headers: { Range: `bytes=${s.range[0]}-${s.range[1]}` } } : {};
    return fetchBytes(s.url, opts);
  };

  setStatus(`Downloading ${segs.length} segments…`);
  let done = 0, bytes = 0;
  const parts = await pool(segs, 3, async s => {
    const b = await get(s);
    done++; bytes += b.byteLength;
    setProgress(done / segs.length, `${done} / ${segs.length} segments · ${fmt(bytes)}`);
    return b;
  });
  if (init) parts.unshift(await get(init));
  if (fmp4) await save(new Blob(parts, { type: 'video/mp4' }));
  else await saveTs(parts);
}

async function direct() {
  setStatus(mode === 'manifest' ? 'Checking DASH protection…' : 'Downloading file…');
  const response = await fetchRetry(srcUrl);
  if (mode === 'manifest') {
    const text = await response.text();
    if (!/<(?:[\w.-]+:)?MPD\b/i.test(text)) throw new Error('Not a DASH manifest.');
    const protectedBy = PlaylistTools.protection(text);
    if (protectedBy) throw new Error('Protected stream: ' + protectedBy);
    log('Saved the DASH manifest only. DASH audio/video assembly is not supported.');
    await save(new Blob([text], { type: 'application/dash+xml' }));
    return;
  }
  if (/^(text\/html|application\/(json|xhtml\+xml)|image\/)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('The URL returned a page or error document instead of media.');
  }
  const size = Number(response.headers.get('content-length')) || 0;
  const parts = [];
  let bytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); bytes += value.byteLength;
    setProgress(size ? bytes / size : 0, size ? `${fmt(bytes)} / ${fmt(size)}` : fmt(bytes));
  }
  await save(new Blob(parts, { type: response.headers.get('content-type') || 'application/octet-stream' }));
}

(async () => {
  try {
    if (mode === 'hls') await hls();
    else if (mode === 'chunked') await chunked();
    else if (mode === 'ts') await saveTs([await (await fetchRetry(srcUrl)).arrayBuffer()]);
    else if (mode === 'file' || mode === 'manifest') await direct();
    else throw new Error('Unknown mode.');
    await report('complete', true);
  } catch (e) {
    setStatus('Failed: ' + (e.message || e));
    log('If the link expired, reload the video page, play it again and retry from the popup.');
    document.title = 'Failed – ' + name;
    await report(String(e.message).startsWith('Protected stream:') ? 'protected' : 'failed', true);
  }
})();
