const $ = s => document.querySelector(s);
const CFG = globalThis.VG_CONFIG || { enableYouTube: true };
let tab;

const fmtSize = n => !n ? '' : n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
const fmtDur = s => !s ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const sanitize = s => (s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'video';
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

function extFor(item) {
  const m = (item.mime || '').toLowerCase();
  if (item.kind === 'hls') return 'ts';
  if (m.includes('audio/mp4')) return 'm4a';
  if (m.includes('audio/webm')) return 'weba';
  if (m.includes('audio/mpeg')) return 'mp3';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4')) return item.track === 'a' ? 'm4a' : 'mp4';
  try { return new URL(item.url).pathname.match(/\.([a-z0-9]{2,4})$/i)?.[1] || 'mp4'; } catch { return 'mp4'; }
}

function pageTitle() {
  return sanitize((tab.title || '').replace(/ - YouTube$/, '').replace(/ • Instagram.*$/, '').replace(/^\(\d+\)\s*/, ''));
}

function fileName(item, base = pageTitle()) {
  const tag = item.quality ? ` [${item.quality}${item.track === 'a' ? ' audio' : ''}]` : item.track === 'a' ? ' [audio]' : '';
  return `${sanitize(base)}${tag}.${extFor(item)}`;
}

// ---------------- runs inside the page ----------------

// Finds direct media links in <video>, <source>, og:video and <a> tags
function scanDom() {
  const out = new Set();
  const add = u => { try { const x = new URL(u, location.href); if (/^https?:$/.test(x.protocol)) out.add(x.href); } catch {} };
  document.querySelectorAll('video, audio').forEach(v => { add(v.currentSrc); add(v.src); });
  document.querySelectorAll('video source, audio source').forEach(s => add(s.src));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').forEach(m => add(m.content));
  document.querySelectorAll('a[href]').forEach(a => { if (/\.(mp4|webm|mov|m4v|mkv|m3u8)(\?|$)/i.test(a.href)) add(a.href); });
  return [...out];
}

// Instagram: finds the post/reel you're looking at and asks Instagram for its full video (with audio) + thumbnail
async function instagramCurrent() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const toId = sc => { let id = 0n; for (const c of sc.slice(0, 11)) id = id * 64n + BigInt(A.indexOf(c)); return id.toString(); };
  const codeRe = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;

  let code = location.pathname.match(codeRe)?.[1];
  if (!code) {
    // Feed / profile modal: take the video closest to the middle of the screen and find its post link
    const cy = innerHeight / 2;
    const vids = [...document.querySelectorAll('video')]
      .map(v => ({ v, r: v.getBoundingClientRect() }))
      .filter(o => o.r.height > 50 && o.r.bottom > 0 && o.r.top < innerHeight)
      .sort((a, b) => Math.abs(a.r.top + a.r.height / 2 - cy) - Math.abs(b.r.top + b.r.height / 2 - cy));
    outer: for (const { v } of vids) {
      for (let el = v, i = 0; el && i < 20; el = el.parentElement, i++) {
        for (const a of el.querySelectorAll?.('a[href]') || []) {
          const m = a.getAttribute('href').match(codeRe);
          if (m) { code = m[1]; break outer; }
        }
      }
    }
  }
  if (!code) return { items: [] };

  const r = await fetch(`/api/v1/media/${toId(code)}/info/`, {
    credentials: 'include',
    headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
  });
  if (!r.ok) return { error: 'Instagram answered HTTP ' + r.status, code, items: [] };
  const item = (await r.json()).items?.[0];
  if (!item) return { items: [] };

  const medias = item.carousel_media?.length ? item.carousel_media : [item];
  const items = [];
  medias.forEach((m, i) => {
    if (!m.video_versions?.length) return;
    const versions = [...new Map(m.video_versions.map(v => [v.width + 'x' + v.height, v])).values()]
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .map(v => ({ url: v.url, w: v.width, h: v.height }));
    items.push({
      code, part: medias.length > 1 ? i + 1 : 0,
      user: item.user?.username || '',
      caption: (item.caption?.text || '').split('\n')[0].slice(0, 100),
      duration: m.video_duration || item.video_duration || 0,
      thumb: m.image_versions2?.candidates?.[0]?.url || '',
      versions
    });
  });
  return { items };
}

// ---------------- popup ----------------

// Load remote thumbnails through the extension (avoids hotlink blocking on CDNs)
async function loadThumb(img, url) {
  try {
    const blob = await (await fetch(url)).blob();
    img.src = URL.createObjectURL(blob);
  } catch { img.src = url; }
}

function openPreview(src, poster) {
  const ov = $('#preview');
  const v = ov.querySelector('video');
  v.poster = poster || '';
  v.src = src;
  ov.hidden = false;
  v.play().catch(() => {});
}
$('#preview').onclick = e => {
  if (e.target.tagName === 'VIDEO') return;
  const v = $('#preview video'); v.pause(); v.removeAttribute('src'); v.load(); $('#preview').hidden = true;
};

// Build a card: thumbnail (click = preview) + info + quality picker + buttons
function card({ thumbUrl, thumbFromVideo, previewUrl, badge, title, meta, options, audio, onDownload, note }) {
  const li = document.createElement('li');
  li.className = 'card';
  li.innerHTML = `
    <div class="thumb"><img alt=""><video muted preload="none" playsinline></video><span class="play">▶</span><span class="dur"></span></div>
    <div class="info">
      <div class="row"><span class="badge"></span><span class="title"></span></div>
      <div class="meta"></div>
      <select class="q" hidden></select>
      <div class="actions"><button class="dl">Download</button><button class="ghost aud" hidden>Audio</button><button class="ghost copy">Copy URL</button></div>
      <div class="status"></div>
    </div>`;
  const img = li.querySelector('img'), vid = li.querySelector('.thumb video');
  li.querySelector('.badge').textContent = badge;
  li.querySelector('.title').textContent = title;
  li.querySelector('.meta').textContent = meta;
  if (note) li.querySelector('.dur').textContent = note;
  else li.querySelector('.dur').hidden = true;

  if (thumbUrl) { vid.remove(); loadThumb(img, thumbUrl); }
  else if (thumbFromVideo) {
    img.remove();
    // first frame of the actual video as thumbnail, loaded only when visible
    new IntersectionObserver((ents, obs) => {
      if (ents[0].isIntersecting) { vid.preload = 'metadata'; vid.src = thumbFromVideo + '#t=0.5'; obs.disconnect(); }
    }).observe(li);
    vid.onerror = () => li.querySelector('.thumb').classList.add('none');
  } else { img.remove(); vid.remove(); li.querySelector('.thumb').classList.add('none'); }

  const sel = li.querySelector('.q');
  if (options.length > 1) {
    sel.hidden = false;
    options.forEach((o, i) => sel.add(new Option(o.label, i)));
  }
  const current = () => options[sel.value || 0];

  const thumb = li.querySelector('.thumb');
  if (previewUrl || thumbFromVideo) thumb.onclick = () => openPreview(previewUrl || current().item.url, img.src);
  else thumb.classList.add('noplay');

  const status = li.querySelector('.status');
  const run = async (btn, item, name) => {
    btn.disabled = true; status.className = 'status'; status.textContent = 'Starting…';
    const res = await onDownload(item, name);
    status.className = 'status ' + (res.ok ? 'ok' : 'err');
    status.textContent = res.ok ? (res.msg || 'Download started ✓') : 'Failed: ' + res.error;
    btn.disabled = false;
  };
  const dl = li.querySelector('.dl');
  if (current().disabled) { dl.disabled = true; dl.title = current().disabled; }
  dl.onclick = () => run(dl, current().item, current().name);

  if (audio) {
    const ab = li.querySelector('.aud');
    ab.hidden = false;
    ab.onclick = () => run(ab, audio.item, audio.name);
  }
  li.querySelector('.copy').onclick = async e => {
    await navigator.clipboard.writeText(current().item.url);
    e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy URL'), 1200);
  };
  return li;
}

async function startDownload(item, name) {
  const isTs = /\.ts$/i.test(name) || (item.mime || '').split(';')[0] === 'video/mp2t';
  if (item.kind === 'hls' || item.kind === 'chunked' || isTs) {
    const p = new URLSearchParams({ mode: isTs && item.kind === 'file' ? 'ts' : item.kind, url: item.url, name, size: item.size || 0 });
    chrome.tabs.create({ url: 'downloader.html?' + p });
    return { ok: true, msg: 'Opened download tab ✓' };
  }
  return chrome.runtime.sendMessage({ cmd: 'download', url: item.url, filename: name });
}

function groupStreams(items) {
  const groups = new Map();
  for (const it of items) {
    const g = it.group || it.key;
    if (!groups.has(g)) groups.set(g, { id: g, items: [], ts: 0 });
    const grp = groups.get(g);
    grp.items.push(it);
    grp.ts = Math.max(grp.ts, it.ts || 0);
  }
  return [...groups.values()].sort((a, b) => b.ts - a.ts);
}

function streamCard(grp, ytId) {
  const byQuality = (a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0) || (b.size || 0) - (a.size || 0);
  const videos = grp.items.filter(i => i.track !== 'a').sort(byQuality);
  const audios = grp.items.filter(i => i.track === 'a').sort(byQuality);
  const main = videos[0] || audios[0];
  const isYt = grp.id === 'yt';
  const list = videos.length ? videos : audios;

  const options = list.map(it => ({
    item: it,
    name: fileName(it),
    label: [it.quality || (it.track === 'a' ? 'Audio' : 'Video'), it.track === 'v' && isYt ? 'video only' : it.track === 'av' ? 'with audio' : '', fmtSize(it.size)].filter(Boolean).join(' · '),
    disabled: it.kind === 'dash' ? 'DASH manifests need yt-dlp or ffmpeg' : ''
  }));
  const badge = { hls: 'HLS', dash: 'DASH' }[main.kind] || (isYt ? 'YouTube' : main.track === 'a' ? 'Audio' : extFor(main).toUpperCase());
  const title = isYt ? pageTitle() : main.label;
  const hasSepAudio = videos.length && audios.length;

  return card({
    thumbUrl: isYt && ytId ? `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` : '',
    thumbFromVideo: !isYt && main.kind === 'file' ? main.url : '',
    badge, title,
    meta: [main.host, options.length === 1 ? fmtSize(main.size) : `${options.length} qualities`, hasSepAudio ? 'no sound in video, use Audio' : ''].filter(Boolean).join(' · '),
    note: fmtDur(main.duration),
    options,
    audio: hasSepAudio ? { item: audios[0], name: fileName(audios[0]) } : null,
    onDownload: startDownload
  });
}

function section(title, collapsible, count) {
  const wrap = document.createElement(collapsible ? 'details' : 'div');
  wrap.className = 'section';
  const h = document.createElement(collapsible ? 'summary' : 'h3');
  h.textContent = count != null ? `${title} (${count})` : title;
  const ul = document.createElement('ul');
  wrap.append(h, ul);
  $('#list').appendChild(wrap);
  return ul;
}

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#list').innerHTML = '';
  const host = hostOf(tab.url);
  const isIg = /(^|\.)instagram\.com$/.test(host);
  const isYt = /(^|\.)youtube\.com$|youtu\.be$/.test(host);

  // 1) Instagram: the post you're looking at, as one full video with audio
  let igItems = [], igError = '';
  if (isIg) {
    $('#count').textContent = 'Looking up post…';
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: instagramCurrent });
      igItems = res.result?.items || [];
      igError = res.result?.error || '';
    } catch (e) { igError = String(e.message || e); }
  }

  // 2) Everything sniffed from the network + DOM
  let items = await chrome.runtime.sendMessage({ cmd: 'list', tabId: tab.id }) || [];
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanDom });
    const known = new Set(items.map(i => i.url.split('?')[0]));
    for (const r of results) for (const url of r.result || []) {
      const k = url.split('?')[0];
      if (known.has(k)) continue;
      known.add(k);
      const hls = /\.m3u8(\?|$)/i.test(url);
      items.push({ key: url, url, kind: hls ? 'hls' : 'file', label: hls ? 'HLS stream (.m3u8)' : 'Video on page',
                   host: hostOf(url), size: 0, ts: 1, track: 'v' });
    }
  } catch { /* chrome:// pages etc. can't be scripted */ }
  const groups = groupStreams(items);

  // Tip bar
  const tip = $('#tip');
  tip.hidden = true;
  if (isYt && !CFG.enableYouTube) {
    tip.hidden = false;
    tip.textContent = 'YouTube downloads aren\'t available in the Chrome Web Store version of this extension.';
    items = [];
    groups.length = 0;
  } else if (isYt) {
    tip.hidden = false;
    tip.innerHTML = 'YouTube sends video and audio separately. Download both, then merge them: <code>ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4</code>. ' +
      'If nothing appears, use <b>Copy yt-dlp command</b>.';
  } else if (isIg && igError) {
    tip.hidden = false;
    tip.textContent = `Couldn't look up this post (${igError}). Showing detected streams instead. Make sure you're logged in.`;
  }

  // Render
  if (igItems.length) {
    const ul = section('This post', false);
    for (const it of igItems) {
      const base = `${it.user ? it.user + ' - ' : ''}${it.code}${it.part ? '_' + it.part : ''}`;
      ul.appendChild(card({
        thumbUrl: it.thumb,
        previewUrl: it.versions[0].url,
        badge: 'MP4',
        title: it.caption || (it.user ? '@' + it.user : 'Instagram video') + (it.part ? ` · part ${it.part}` : ''),
        meta: ['@' + it.user, 'video + audio'].filter(Boolean).join(' · '),
        note: fmtDur(it.duration),
        options: it.versions.map(v => ({ item: { url: v.url }, name: sanitize(base) + (v === it.versions[0] ? '' : ` [${v.h}p]`) + '.mp4', label: `${v.w}×${v.h}` })),
        onDownload: startDownload
      }));
    }
  }

  if (groups.length) {
    const ytId = isYt ? (new URL(tab.url).searchParams.get('v') || tab.url.match(/(?:shorts|youtu\.be)\/([\w-]{11})/)?.[1]) : null;
    const collapse = igItems.length > 0;
    const ul = section(collapse ? 'Other detected videos' : 'Detected videos', collapse, groups.length);
    if (!collapse && groups.length > 1 && groups[0].ts > 1) ul.parentElement.querySelector('h3').textContent += ' · most recently played first';
    groups.forEach(g => ul.appendChild(streamCard(g, ytId)));
  }

  const total = igItems.length + groups.length;
  $('#count').textContent = total ? `${total} video${total > 1 ? 's' : ''}` : '';
  $('#empty').hidden = total > 0;
}

$('#refresh').onclick = load;
$('#clear').onclick = async () => { await chrome.runtime.sendMessage({ cmd: 'clear', tabId: tab.id }); load(); };
if (!CFG.enableYouTube) $('#ytdlp').hidden = true;
$('#ytdlp').onclick = async e => {
  await navigator.clipboard.writeText(`yt-dlp "${tab.url}"`);
  e.target.textContent = 'Copied ✓';
  setTimeout(() => (e.target.textContent = 'Copy yt-dlp command'), 1400);
};

load();
