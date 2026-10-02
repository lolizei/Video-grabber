(() => {
  if (globalThis.VGDomScan) return;
  const extensions = /\.(mp3|m4a|aac|ogg|wav|flac|opus|mp4|webm|m3u8|mpd)(?:[?#]|$)/i;
  function collect() {
    const urls = new Map();
    let blobs = 0;
    const add = (value, hint) => {
      if (!value) return;
      try {
        const u = new URL(value, location.href);
        if (u.protocol === 'blob:') { blobs++; return; }
        if (!/^https?:$/.test(u.protocol)) return;
        u.hash = '';
        urls.set(u.href, { url: u.href, hint });
      } catch {}
    };
    document.querySelectorAll('video,audio').forEach(el => {
      const hint = el.tagName === 'AUDIO' ? 'audio' : 'video';
      add(el.currentSrc, hint); add(el.getAttribute('src'), hint);
    });
    document.querySelectorAll('video source,audio source').forEach(el => add(el.getAttribute('src'), el.parentElement.tagName === 'AUDIO' ? 'audio' : 'video'));
    document.querySelectorAll('a[href]').forEach(el => { if (extensions.test(el.href)) add(el.href); });
    performance.getEntriesByType('resource').forEach(entry => { if (extensions.test(entry.name) || /googlevideo\.com\/videoplayback/.test(entry.name)) add(entry.name); });
    return { urls: [...urls.values()], blobs, pageUrl: location.href };
  }
  let timer;
  globalThis.VGDomScan = collect;
  const send = () => chrome.runtime.sendMessage({ cmd: 'scanner.dom', ...collect() }).catch(() => {});
  const schedule = () => { clearTimeout(timer); timer = setTimeout(send, 400); };
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('play', schedule, true);
  try { new PerformanceObserver(schedule).observe({ type: 'resource', buffered: true }); } catch {}
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
  });
  send();
})();
