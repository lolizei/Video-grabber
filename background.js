// Video Grabber – background service worker
// Watches network responses per tab and records anything that looks like a video/audio file or stream.

importScripts('config.js');
const CFG = globalThis.VG_CONFIG || { enableYouTube: true };

const MEDIA_EXT = /\.(mp4|webm|mkv|mov|m4v|flv|avi|ogv|3gp|mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|m4f)(\?|#|$)/i;
const MAX_PER_TAB = 150;

// YouTube itag -> [label, kind]  (kind: v = video only, a = audio only, av = muxed)
const ITAGS = {
  18: ['360p', 'av'], 22: ['720p', 'av'],
  160: ['144p', 'v'], 133: ['240p', 'v'], 134: ['360p', 'v'], 135: ['480p', 'v'], 136: ['720p', 'v'],
  137: ['1080p', 'v'], 264: ['1440p', 'v'], 266: ['2160p', 'v'], 298: ['720p60', 'v'], 299: ['1080p60', 'v'],
  278: ['144p', 'v'], 242: ['240p', 'v'], 243: ['360p', 'v'], 244: ['480p', 'v'], 247: ['720p', 'v'],
  248: ['1080p', 'v'], 271: ['1440p', 'v'], 313: ['2160p', 'v'], 302: ['720p60', 'v'], 303: ['1080p60', 'v'],
  308: ['1440p60', 'v'], 315: ['2160p60', 'v'],
  394: ['144p', 'v'], 395: ['240p', 'v'], 396: ['360p', 'v'], 397: ['480p', 'v'], 398: ['720p', 'v'],
  399: ['1080p', 'v'], 400: ['1440p', 'v'], 401: ['2160p', 'v'],
  139: ['48k', 'a'], 140: ['128k', 'a'], 141: ['256k', 'a'], 249: ['50k', 'a'], 250: ['70k', 'a'], 251: ['160k', 'a']
};

// ---------- per-tab storage (memory + storage.session so it survives worker restarts) ----------
const cache = new Map(); // tabId -> Promise<object>

function getList(tabId) {
  if (!cache.has(tabId)) {
    const key = 'tab_' + tabId;
    cache.set(tabId, chrome.storage.session.get(key).then(o => o[key] || {}));
  }
  return cache.get(tabId);
}

async function saveList(tabId, list) {
  await chrome.storage.session.set({ ['tab_' + tabId]: list });
  const n = new Set(Object.values(list).map(e => e.group || e.key)).size; // count videos, not tracks
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e5484d' });
}

async function addMedia(tabId, entry) {
  const list = await getList(tabId);
  const existing = list[entry.key];
  if (existing) {
    // keep the freshest URL (signed URLs expire) and the best size info
    existing.url = entry.url;
    existing.size = entry.size || existing.size;
    existing.ts = entry.ts;
  } else {
    const keys = Object.keys(list);
    if (keys.length >= MAX_PER_TAB) {
      const oldest = keys.sort((a, b) => list[a].ts - list[b].ts)[0];
      delete list[oldest];
    }
    list[entry.key] = entry;
  }
  await saveList(tabId, list);
}

async function clearTab(tabId, forget = true) {
  const recoveryKey = 'recovery_' + tabId;
  if (forget) {
    await chrome.storage.session.remove(recoveryKey);
  } else {
    // A playing stream may make no more requests for its manifest or buffered file.
    // Keep its detected URLs until navigation so Refresh can discover it again.
    const previous = (await chrome.storage.session.get(recoveryKey))[recoveryKey] || {};
    const recovery = { ...previous, ...await getList(tabId) };
    const keys = Object.keys(recovery).sort((a, b) => recovery[b].ts - recovery[a].ts);
    for (const key of keys.slice(MAX_PER_TAB)) delete recovery[key];
    await chrome.storage.session.set({ [recoveryKey]: recovery });
  }
  cache.set(tabId, Promise.resolve({}));
  await chrome.storage.session.remove('tab_' + tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

// ---------- classification ----------
function header(headers, name) {
  const h = headers?.find(h => h.name.toLowerCase() === name);
  return h ? h.value : '';
}

function totalSize(headers) {
  const range = header(headers, 'content-range'); // bytes 0-999/12345
  const m = range.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, 'content-length'));
  return len > 0 ? len : 0;
}

function decodeEfg(s) {
  if (!s) return null;
  try { return JSON.parse(atob(decodeURIComponent(s).replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

function classify(details) {
  let u;
  try { u = new URL(details.url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (details.method && details.method !== 'GET') return null;

  const ct = header(details.responseHeaders, 'content-type').toLowerCase();
  const size = totalSize(details.responseHeaders);
  const base = { ts: Date.now(), mime: ct.split(';')[0], size, host: u.hostname };

  // YouTube: googlevideo.com/videoplayback  -> strip range params, dedupe by itag
  if (u.hostname.endsWith('googlevideo.com') && u.pathname.includes('/videoplayback')) {
    if (!CFG.enableYouTube) return null;
    if (ct.includes('ump') || u.searchParams.has('sabr')) return null; // SABR/UMP streams can't be fetched directly
    const itag = Number(u.searchParams.get('itag'));
    if (!itag) return null;
    ['range', 'rn', 'rbuf', 'ump', 'srfvp', 'alr'].forEach(p => u.searchParams.delete(p));
    const mime = decodeURIComponent(u.searchParams.get('mime') || base.mime);
    const clen = Number(u.searchParams.get('clen')) || 0;
    const [q, kind] = ITAGS[itag] || [`itag ${itag}`, mime.startsWith('audio') ? 'a' : 'v'];
    const what = kind === 'a' ? 'audio only' : kind === 'v' ? 'video only' : 'video + audio';
    return { ...base, key: 'yt:' + itag, group: 'yt', kind: 'chunked', url: u.toString(), mime, size: clen || size,
             label: `YouTube ${q} · ${what}`, track: kind, quality: q };
  }

  // Instagram / Facebook CDN: strip byte-range params to get the full file, and group all
  // quality/audio tracks of the same video together using the asset id inside the "efg" param.
  if (/(fbcdn\.net|cdninstagram\.com)$/.test(u.hostname) && (ct.startsWith('video/') || ct.startsWith('audio/') || MEDIA_EXT.test(u.pathname))) {
    const efg = decodeEfg(u.searchParams.get('efg'));
    const tag = String(efg?.vencode_tag || '').toLowerCase();
    const track = ct.startsWith('audio/') || tag.includes('audio') ? 'a' : 'v';
    const asset = efg?.xpv_asset_id || efg?.video_id;
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    return { ...base, key: u.origin + u.pathname, group: asset ? 'ig:' + asset : u.origin + u.pathname,
             kind: 'file', url: u.toString(), size, duration: Number(efg?.duration_s) || 0,
             label: track === 'a' ? 'Instagram/Facebook audio' : 'Instagram/Facebook video', track };
  }

  if (ct.includes('mpegurl') || HLS_EXT.test(u.pathname)) {
    return { ...base, key: u.origin + u.pathname, kind: 'hls', url: details.url, label: 'HLS stream (.m3u8)' };
  }
  if (ct.includes('dash+xml') || DASH_EXT.test(u.pathname)) {
    return { ...base, key: u.origin + u.pathname, kind: 'dash', url: details.url, label: 'DASH manifest (.mpd)' };
  }
  if (SEGMENT_EXT.test(u.pathname) || ct === 'video/mp2t' || ct.includes('iso.segment')) return null; // stream pieces

  const isMediaType = ct.startsWith('video/') || ct.startsWith('audio/');
  const isMediaExt = MEDIA_EXT.test(u.pathname) && (!ct || ct.includes('octet-stream') || isMediaType);
  if (!isMediaType && !isMediaExt) return null;
  if (size && size < 30 * 1024) return null; // skip tiny blips / beacons

  let file = '';
  try { file = decodeURIComponent(u.pathname.split('/').pop() || ''); } catch {}
  return { ...base, key: u.origin + u.pathname, kind: 'file', url: details.url,
           label: file && file.length < 80 ? file : (base.mime || 'Media file'), track: ct.startsWith('audio/') ? 'a' : 'v' };
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const entry = classify(details);
    if (entry) addMedia(details.tabId, entry);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// Reset the list when the tab navigates to a new page (incl. SPA navigations like YouTube/Instagram)
const lastUrl = new Map();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  // Instagram/Facebook preload the next reels before the URL changes, so don't wipe on their
  // in-app navigation; the popup sorts by what played most recently instead.
  if (/(^|\.)(instagram|facebook)\.com$/.test((() => { try { return new URL(info.url).hostname; } catch { return ''; } })())
      && lastUrl.has(tabId) && /instagram|facebook/.test(lastUrl.get(tabId))) { lastUrl.set(tabId, info.url); return; }
  const clean = s => { try { const u = new URL(s); return u.origin + u.pathname + (u.hostname.includes('youtube') ? u.search : ''); } catch { return s; } };
  const now = clean(info.url);
  if (lastUrl.has(tabId) && lastUrl.get(tabId) !== now) clearTab(tabId);
  lastUrl.set(tabId, now);
});
chrome.tabs.onRemoved.addListener(tabId => { clearTab(tabId); lastUrl.delete(tabId); cache.delete(tabId); });

// ---------- messages from popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.cmd === 'list') {
      const list = await getList(msg.tabId);
      const recovery = (await chrome.storage.session.get('recovery_' + msg.tabId))['recovery_' + msg.tabId] || {};
      for (const [key, entry] of Object.entries(recovery)) {
        if (!list[key]) list[key] = entry;
      }
      // Resource Timing also finds requests made before the popup was opened,
      // including HLS manifests hidden behind a blob: player URL.
      for (const url of msg.resourceUrls || []) {
        const entry = classify({ url, method: 'GET', responseHeaders: [] });
        if (entry && !list[entry.key]) list[entry.key] = { ...entry, ts: 1 };
      }
      const keys = Object.keys(list).sort((a, b) => list[b].ts - list[a].ts);
      for (const key of keys.slice(MAX_PER_TAB)) delete list[key];
      await saveList(msg.tabId, list);
      reply(Object.values(list).sort((a, b) => b.ts - a.ts));
    } else if (msg.cmd === 'clear') {
      await clearTab(msg.tabId, false);
      reply(true);
    } else if (msg.cmd === 'download') {
      try {
        const id = await chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' });
        reply({ ok: true, id });
      } catch (e) {
        reply({ ok: false, error: String(e.message || e) });
      }
    }
  })();
  return true;
});
