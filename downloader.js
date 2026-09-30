// Runs in an extension tab: downloads HLS playlists (segment by segment) and
// range-chunked streams (YouTube), then saves the result as one file.

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const srcUrl = params.get('url');
let name = params.get('name') || 'video.mp4';
const knownSize = Number(params.get('size')) || 0;

const fmt = n => n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : (n / (1 << 20)).toFixed(1) + ' MB';
const log = m => { $('#log').textContent += m + '\n'; };
const setStatus = m => { $('#status').textContent = m; };
const setProgress = (frac, text) => {
  $('#bar').style.width = Math.min(100, frac * 100).toFixed(1) + '%';
  $('#progress').textContent = text || '';
};
$('#name').textContent = name;
document.title = 'Downloading – ' + name;

async function fetchRetry(url, opts = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { credentials: 'include', ...opts });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 600 * i));
    }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function save(blob) {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
  setProgress(1, fmt(blob.size));
  setStatus('Done ✓ The file is in your downloads. You can close this tab.');
  document.title = 'Done – ' + name;
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
const attr = (line, key) => {
  const m = line.match(new RegExp(key + '=("([^"]*)"|[^,]*)'));
  return m ? (m[2] ?? m[1]) : null;
};

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
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

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let init = null, encrypted = false, nextRange = null, lastEnd = 0;
  const parseRange = (spec, prevEnd) => {
    const [len, off] = spec.split('@').map(Number);
    const start = Number.isFinite(off) ? off : prevEnd;
    return [start, start + len - 1];
  };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-KEY')) {
      const method = attr(l, 'METHOD');
      if (method && method !== 'NONE') encrypted = true;
    } else if (l.startsWith('#EXT-X-MAP')) {
      const br = attr(l, 'BYTERANGE');
      init = { url: new URL(attr(l, 'URI'), base).href, range: br ? parseRange(br, 0) : null };
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      nextRange = parseRange(l.split(':')[1], lastEnd);
    } else if (!l.startsWith('#')) {
      segs.push({ url: new URL(l, base).href, range: nextRange });
      if (nextRange) lastEnd = nextRange[1] + 1;
      nextRange = null;
    }
  }
  return { segs, init, encrypted, ended: text.includes('#EXT-X-ENDLIST') };
}

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
  let text = await (await fetchRetry(url)).text();
  if (!text.startsWith('#EXTM3U')) throw new Error('Not a valid HLS playlist.');

  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMaster(text, url);
    const v = variants.length === 1 ? variants[0] : await chooseVariant(variants);
    if (v.audio) name = name.replace(/\.\w+$/, ' [audio].ts');
    url = v.url;
    text = await (await fetchRetry(url)).text();
  }

  const { segs, init, encrypted, ended } = parseMedia(text, url);
  if (encrypted) throw new Error('This stream is encrypted, so it can\'t be downloaded with this extension.');
  if (!segs.length) throw new Error('Playlist contains no segments.');
  if (!ended) log('Note: this looks like a live stream. Only the segments currently listed will be saved.');

  const fmp4 = !!init || /\.(m4s|mp4|cmfv)(\?|$)/i.test(segs[0].url);
  if (fmp4) name = name.replace(/\.ts$/, '.mp4');
  $('#name').textContent = name;

  const get = async s => {
    const opts = s.range ? { headers: { Range: `bytes=${s.range[0]}-${s.range[1]}` } } : {};
    return (await fetchRetry(s.url, opts)).arrayBuffer();
  };

  setStatus(`Downloading ${segs.length} segments…`);
  let done = 0, bytes = 0;
  const parts = await pool(segs, 6, async s => {
    const b = await get(s);
    done++; bytes += b.byteLength;
    setProgress(done / segs.length, `${done} / ${segs.length} segments · ${fmt(bytes)}`);
    return b;
  });
  if (init) parts.unshift(await get(init));
  await save(new Blob(parts, { type: fmp4 ? 'video/mp4' : 'video/mp2t' }));
  if (!fmp4) log('Saved as MPEG-TS (.ts). It plays in VLC; to convert to .mp4: ffmpeg -i input.ts -c copy output.mp4');
}

(async () => {
  try {
    if (mode === 'hls') await hls();
    else if (mode === 'chunked') await chunked();
    else throw new Error('Unknown mode.');
  } catch (e) {
    setStatus('Failed: ' + (e.message || e));
    log('If the link expired, reload the video page, play it again and retry from the popup.');
    document.title = 'Failed – ' + name;
  }
})();
