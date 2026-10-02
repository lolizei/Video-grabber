(() => {
  // Reinjection must replace handlers from an invalidated extension context.
  try { globalThis.VGDomCleanup?.(); } catch {}
  const extensions = /\.(mp3|m4a|aac|ogg|wav|flac|opus|mp4|webm|m3u8|mpd|m4v|mov)(?:[?#]|$)/i;
  const SCRIPT_URL = /https?:(?:\\?\/|\\u002[fF]){2}[^"'\s<>()\\]*?(?:\\?\/|\\u002[fF])?[^"'\s<>()]*?\.(?:m3u8|mpd|mp4|webm|m4a|mp3|aac|ogg|opus|flac|wav|m4v|mov)(?:\?(?:[^"'\s<>\\]|\\u0026|\\\/)*)?(?=["'\s<>\\]|$)/gi;
  const unescape = value => value.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  // EME detection only: count `encrypted` events and read key-system IDs from their init data.
  const eme = { events: 0, systems: new Set(), initDataTypes: new Set() };
  const SYSTEM_IDS = { edef8ba979d64acea3c827dcd51d21ed: 'Widevine', '9a04f07998404286ab92e65be0885f95': 'PlayReady',
    '94ce86fb07ff4f43adb893d2fa968ca2': 'FairPlay', e2719d58a985b3c9781ab030af78d30e: 'ClearKey', '1077efecc0b24d02ace33c1e52e2fb4b': 'ClearKey' };
  function psshSystems(buffer) {
    const out = [];
    try {
      const b = new Uint8Array(buffer);
      for (let i = 0; i + 28 <= b.length; i++) {
        if (b[i + 4] !== 0x70 || b[i + 5] !== 0x73 || b[i + 6] !== 0x73 || b[i + 7] !== 0x68) continue;
        const id = [...b.subarray(i + 12, i + 28)].map(x => x.toString(16).padStart(2, '0')).join('');
        out.push(SYSTEM_IDS[id] || 'system ' + id.slice(0, 8));
      }
    } catch {}
    return out;
  }
  const onEncrypted = event => {
    eme.events++;
    if (event.initDataType) eme.initDataTypes.add(String(event.initDataType));
    if (/^(sinf|skd)$/i.test(event.initDataType || '')) eme.systems.add('FairPlay');
    for (const system of psshSystems(event.initData || new ArrayBuffer(0))) eme.systems.add(system);
    chrome.runtime.sendMessage({ cmd: 'scanner.eme', ...emeState() }).catch(() => {});
  };
  const emeState = () => ({ events: eme.events, systems: [...eme.systems], initDataTypes: [...eme.initDataTypes],
    mediaKeys: [...document.querySelectorAll('video,audio')].filter(el => { try { return !!el.mediaKeys; } catch { return false; } }).length });
  function collect() {
    const urls = new Map();
    let blobs = 0;
    const add = (value, hint, source = 'dom') => {
      if (!value) return;
      try {
        const u = new URL(value, location.href);
        if (u.protocol === 'blob:') { blobs++; return; }
        if (!/^https?:$/.test(u.protocol)) return;
        u.hash = '';
        if (!urls.has(u.href)) urls.set(u.href, { url: u.href, hint, source });
      } catch {}
    };
    document.querySelectorAll('video,audio').forEach(el => {
      const hint = el.tagName === 'AUDIO' ? 'audio' : 'video';
      add(el.currentSrc, hint); add(el.getAttribute('src'), hint);
    });
    document.querySelectorAll('video source,audio source').forEach(el => add(el.getAttribute('src'), el.parentElement.tagName === 'AUDIO' ? 'audio' : 'video'));
    document.querySelectorAll('a[href]').forEach(el => { if (extensions.test(el.href)) add(el.href); });
    // Player configuration embedded in markup: meta tags, data attributes, preload links.
    document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[property="og:audio"],meta[name="twitter:player:stream"],meta[itemprop="contentUrl"]')
      .forEach(el => { if (extensions.test(el.content || '')) add(el.content, /audio/.test(el.getAttribute('property') || '') ? 'audio' : undefined, 'player'); });
    document.querySelectorAll('link[rel="preload"][as="video"],link[rel="preload"][as="audio"],link[rel="preload"][as="fetch"]').forEach(el => { if (extensions.test(el.href)) add(el.href, undefined, 'player'); });
    document.querySelectorAll('[data-src],[data-video],[data-video-src],[data-hls],[data-dash],[data-file],[data-stream],[data-url],[data-setup],[data-config],[data-sources]').forEach(el => {
      for (const attr of el.attributes) {
        if (!attr.name.startsWith('data-') || !/m3u8|mpd|mp4|webm|mp3|m4a/i.test(attr.value)) continue;
        if (/^\s*[[{]/.test(attr.value)) { for (const match of unescape(attr.value).matchAll(SCRIPT_URL)) add(unescape(match[0]), undefined, 'player'); }
        else if (extensions.test(attr.value)) add(attr.value, undefined, 'player');
      }
    });
    // Inline scripts and JSON-LD (VideoObject contentUrl) often carry the player source.
    let budget = 2 * 1024 * 1024;
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent || '';
      if (!text || budget <= 0) continue;
      const slice = text.length > budget ? text.slice(0, budget) : text;
      budget -= slice.length;
      if (!/m3u8|mpd|mp4|webm|mp3|m4a/i.test(slice)) continue;
      for (const match of slice.matchAll(SCRIPT_URL)) { add(unescape(match[0]), undefined, 'script'); if (urls.size > 300) break; }
    }
    performance.getEntriesByType('resource').forEach(entry => { if (extensions.test(entry.name) || /googlevideo\.com\/videoplayback/.test(entry.name)) add(entry.name, undefined, 'network'); });
    const state = emeState();
    return { urls: [...urls.values()].slice(0, 300), blobs, pageUrl: location.href, eme: state.events || state.mediaKeys ? state : null };
  }
  let timer;
  globalThis.VGDomScan = collect;
  const send = () => chrome.runtime.sendMessage({ cmd: 'scanner.dom', ...collect() }).catch(() => {});
  const schedule = () => { clearTimeout(timer); timer = setTimeout(send, 400); };
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('play', schedule, true);
  document.addEventListener('encrypted', onEncrypted, true);
  let resources;
  try { resources = new PerformanceObserver(schedule); resources.observe({ type: 'resource', buffered: true }); } catch {}
  const onMessage = (msg, _sender, reply) => {
    if (msg.cmd === 'scanner.collect') { reply(collect()); return; }
    if (msg.cmd !== 'scanner.pageFetch') return;
    (async () => {
      try {
        const url = new URL(msg.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error('Only HTTP(S) media is supported.');
        const options = { credentials: 'include', headers: msg.range ? { Range: msg.range } : {}, signal: AbortSignal.timeout(30000) };
        // The browser enforces the page's CORS and referrer policy.
        if (msg.referrer && new URL(msg.referrer).origin === location.origin) options.referrer = msg.referrer;
        const response = await fetch(url.href, options);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const limit = 32 * 1024 * 1024;
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > limit) { await reader.cancel(); throw new Error('Referrer fallback is limited to 32 MB per request.'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        reply({ ok: true, data: btoa(binary), url: response.url, status: response.status,
          headers: [...response.headers] });
      } catch (error) { reply({ ok: false, error: error.message }); }
    })();
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.VGDomCleanup = () => {
    clearTimeout(timer); mutations.disconnect(); resources?.disconnect();
    document.removeEventListener('loadedmetadata', schedule, true);
    document.removeEventListener('play', schedule, true);
    document.removeEventListener('encrypted', onEncrypted, true);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  };
  send();
})();
