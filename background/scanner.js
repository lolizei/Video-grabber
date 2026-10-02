// Dedicated scanner state and durable download queue. All mutations are serialized.
globalThis.MediaScanner = (() => {
  const tabQueues = new Map();
  const referrers = new Map();
  const navigationTimes = new Map();
  const LIMIT = 200, CONCURRENCY = 3;
  let jobsQueue = Promise.resolve();
  const key = tabId => 'scanner_tab_' + tabId;
  const blank = () => ({ pageUrl: '', entries: {}, blobs: 0 });
  const allowed = (url, pageUrl = '') => CFG.enableYouTube || ![url, pageUrl].some(value => {
    try { return /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com)$/.test(new URL(value).hostname); } catch { return false; }
  });
  function serial(tabId, fn) {
    const next = (tabQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
      const state = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || blank();
      const result = await fn(state);
      await chrome.storage.session.set({ [key(tabId)]: state });
      return result;
    });
    tabQueues.set(tabId, next);
    next.finally(() => { if (tabQueues.get(tabId) === next) tabQueues.delete(tabId); }).catch(() => {});
    return next;
  }
  function put(state, item) {
    const old = state.entries[item.url];
    state.entries[item.url] = { ...old, ...item, size: item.size || old?.size || 0,
      mime: item.mime || old?.mime || '', filename: old?.mime && !item.mime ? old.filename : item.filename,
      referrer: item.referrer || old?.referrer || state.pageUrl, seen: Date.now() };
    const urls = Object.keys(state.entries).sort((a, b) => state.entries[b].seen - state.entries[a].seen);
    for (const url of urls.slice(LIMIT)) delete state.entries[url];
  }
  function classifyRequest(details) {
    if (!allowed(details.url, details.initiator)) return null;
    try {
      if (new URL(details.url).hostname.endsWith('.googlevideo.com')) {
        const stream = classify(details);
        if (!stream || stream.kind !== 'chunked') return null;
        const item = MediaTools.classify(stream.url, [{ name: 'content-type', value: stream.mime }]);
        return item ? { ...item, mode: 'chunked', size: stream.size, filename: 'YouTube ' + stream.quality + '.' + (stream.mime.includes('webm') ? 'webm' : stream.track === 'a' ? 'm4a' : 'mp4') } : null;
      }
    } catch { return null; }
    const item = MediaTools.classify(details.url, details.responseHeaders);
    if (!item) return null;
    return item;
  }
  async function observe(details) {
    if (details.tabId < 0 || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 300) return;
    const item = classifyRequest(details);
    if (!item) return;
    const referrer = referrers.get(details.requestId) || '';
    await serial(details.tabId, state => {
      if (details.timeStamp < (navigationTimes.get(details.tabId) || 0)) return;
      put(state, { ...item, frameId: details.frameId, referrer });
    });
  }
  async function navigate(tabId, pageUrl, force = false) {
    await serial(tabId, state => {
      if (force || state.pageUrl !== pageUrl) Object.assign(state, blank(), { pageUrl });
    });
  }
  async function dom(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !allowed(sender.url || '', sender.tab.url || '')) return;
    return serial(tabId, state => {
      if (sender.frameId === 0) {
        if (state.pageUrl && state.pageUrl !== sender.url) return; // stale document message
        state.pageUrl = sender.url;
      }
      for (const value of (msg.urls || []).slice(0, LIMIT)) {
        if (!allowed(value.url, sender.tab.url)) continue;
        let item = classifyRequest({ url: value.url, method: 'GET', responseHeaders: [] });
        if (!item && value.hint && MediaTools.httpUrl(value.url)) {
          const url = MediaTools.httpUrl(value.url);
          const basename = new URL(url).pathname.split('/').pop();
          item = { url, type: value.hint, kind: value.hint, filename: MediaTools.filename(basename || 'media'), size: 0, mime: '', domain: new URL(url).hostname };
          if (/\.ts$/i.test(basename)) item.mode = 'ts';
        }
        if (item) put(state, { ...item, frameId: sender.frameId, referrer: sender.url });
      }
      state.blobs = Math.max(state.blobs, Number(msg.blobs) || 0);
    });
  }
  async function refresh(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/dom-scan.js'] });
      const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.VGDomScan?.() });
      const tab = await chrome.tabs.get(tabId);
      await navigate(tabId, tab.url);
      for (const result of results) if (result.result) await dom(result.result, { tab, frameId: result.frameId, url: result.result.pageUrl });
      await serial(tabId, state => {
        for (const entry of Object.values(state.entries)) if (entry.protection?.status === 'unknown') delete entry.protection;
      });
    } catch { /* Restricted pages have no script access; network results still work. */ }
  }
  async function fetchMedia(url, item = {}, options = {}) {
    if (!MediaTools.httpUrl(url)) throw new Error('Only HTTP(S) URLs can be fetched.');
    let original;
    try {
      const response = await fetch(url, { credentials: 'include', ...options, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response;
    } catch (error) { original = error; }
    if (item.tabId !== undefined) {
      try {
        const result = await chrome.tabs.sendMessage(item.tabId, { cmd: 'scanner.pageFetch', url,
          referrer: item.referrer, range: options.headers?.Range }, { frameId: item.frameId || 0 });
        if (result?.ok) {
          const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
          const response = new Response(bytes, { status: result.status, headers: result.headers });
          Object.defineProperty(response, 'url', { value: result.url });
          return response;
        }
        if (result?.error) throw new Error(result.error);
      } catch (error) {
        throw new Error(original.message + '; page fallback: ' + error.message + '. Reload the source page if the URL expired.');
      }
    }
    throw original;
  }
  async function inspect(tabId, url) {
    const item = await serial(tabId, state => state.entries[url]);
    if (!item || item.type !== 'playlist') throw new Error('Playlist is no longer on this page.');
    const seen = new Set();
    let encrypted = false;
    async function walk(next, depth) {
      if (seen.has(next)) return null;
      if (depth > 5 || seen.size >= 50) throw new Error('Playlist inspection limit reached.');
      seen.add(next);
      const response = await fetchMedia(next, { ...item, tabId });
      const text = await response.text();
      if (item.kind === 'hls' && !text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist.');
      if (item.kind === 'dash' && !/<(?:[\w.-]+:)?MPD\b/i.test(text)) throw new Error('Not a DASH manifest.');
      const reason = PlaylistTools.protection(text);
      if (reason) return reason;
      if (/#EXT-X-(?:SESSION-)?KEY:.*METHOD=AES-128/.test(text)) encrypted = true;
      for (const child of PlaylistTools.children(text, response.url || next)) {
        const reason = await walk(child, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
    let protection;
    try {
      const reason = await walk(url, 0);
      protection = { status: reason ? 'protected' : 'clear', reason: reason || (encrypted ? 'AES-128' : '') };
    } catch (error) { protection = { status: 'unknown', reason: error.message }; }
    await serial(tabId, state => { if (state.entries[url]) state.entries[url].protection = protection; });
    return protection;
  }

  function jobs(fn) {
    const result = jobsQueue.catch(() => {}).then(async () => {
      const list = (await chrome.storage.session.get('scanner_jobs')).scanner_jobs || [];
      const result = await fn(list);
      // Keep active jobs, plus the most recent 100 finished jobs.
      const active = list.filter(j => ['queued', 'running'].includes(j.status));
      const finished = list.filter(j => !['queued', 'running'].includes(j.status)).slice(-100);
      await chrome.storage.session.set({ scanner_jobs: [...finished, ...active] });
      return result;
    });
    jobsQueue = result;
    return result;
  }
  async function launch(job) {
    job.status = 'running'; job.attempts = (job.attempts || 0) + 1;
    job.progress = 0; job.message = 'Starting…';
    try {
      if (job.item.type === 'playlist' || job.item.mode || job.pageFallback) {
        const mode = job.rawPlaylist ? 'raw-playlist' : job.item.kind === 'dash' ? 'manifest' : job.item.kind === 'hls' ? 'hls' : job.item.mode || 'file';
        const params = new URLSearchParams({ mode, url: job.item.url, name: job.item.filename,
          size: job.item.size || 0, job: job.id, sourceTab: job.tabId,
          frame: job.item.frameId || 0, referrer: job.item.referrer || '', auto: '1' });
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') + '?' + params, active: false });
        job.workerTab = tab.id;
        job.message = 'Downloading in a tab…';
      } else {
        // Catch login/error pages before handing a direct file to Chrome downloads.
        // Some signed CDNs disallow HEAD; a failed probe leaves the normal GET path available.
        let probe;
        try { probe = await fetch(job.item.url, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(10000) }); } catch {}
        if (probe?.ok && /^(text\/html|application\/(json|xhtml\+xml)|image\/)/i.test(probe.headers.get('content-type') || '')) {
          throw new Error('The URL returned a page or error document instead of media. Reload the source page and retry.');
        }
        job.downloadId = await chrome.downloads.download({ url: job.item.url,
          filename: MediaTools.filename(job.item.filename), conflictAction: 'uniquify' });
        job.message = 'Downloading…';
      }
    } catch (error) {
      job.status = 'failed'; job.message = error.message || String(error);
    }
  }
  async function pump(list) {
    let active = list.filter(j => j.status === 'running').length;
    for (const job of list) {
      if (active >= CONCURRENCY) break;
      if (job.status !== 'queued') continue;
      await launch(job);
      if (job.status === 'running') active++;
    }
  }
  async function enqueue(tabId, urls, rawPlaylist = false) {
    const items = await serial(tabId, state => urls.slice(0, LIMIT).map(url => state.entries[url]).filter(Boolean));
    return jobs(async list => {
      const ids = [];
      for (const item of items) {
        if (!allowed(item.url, item.referrer) || (item.protection?.status === 'protected' && !rawPlaylist)) continue;
        if (rawPlaylist && item.type !== 'playlist') continue;
        const existing = list.find(j => j.tabId === tabId && j.item.url === item.url && ['queued', 'running'].includes(j.status));
        if (existing) { ids.push(existing.id); continue; }
        const job = { id: crypto.randomUUID(), tabId, item, rawPlaylist, status: 'queued', attempts: 0, progress: 0, message: 'Queued' };
        list.push(job); ids.push(job.id);
      }
      await pump(list);
      return ids;
    });
  }
  async function downloadChanged(delta) {
    await jobs(async list => {
      const job = list.find(j => j.downloadId === delta.id && j.status === 'running');
      if (!job || !delta.state) return;
      if (delta.state.current === 'complete') { job.status = 'complete'; job.progress = 1; job.message = 'Downloaded ✓'; }
      else if (delta.state.current === 'interrupted') {
        const [download] = await chrome.downloads.search({ id: delta.id });
        const reason = delta.error?.current || download?.error || 'Download interrupted';
        if (reason === 'SERVER_FORBIDDEN' && !job.pageFallback) {
          job.pageFallback = true; job.status = 'queued'; delete job.downloadId;
        } else if (/^(NETWORK_|SERVER_FAILED|SERVER_UNAVAILABLE)/.test(reason) && job.attempts < 3) {
          job.status = 'queued'; delete job.downloadId;
        } else { job.status = 'failed'; job.message = reason + '. Refresh or reload the source page and retry.'; }
      }
      await pump(list);
    });
  }
  async function progress(msg, sender) {
    return jobs(async list => {
      const job = list.find(j => j.id === msg.id && j.workerTab === sender.tab?.id && j.status === 'running');
      if (!job) return;
      job.progress = Math.max(0, Math.min(1, Number(msg.progress) || 0));
      job.message = String(msg.message || '').slice(0, 500);
      if (['complete', 'failed', 'protected'].includes(msg.status)) job.status = msg.status;
      await pump(list);
    });
  }
  async function snapshot(tabId) {
    const state = await serial(tabId, state => structuredClone(state));
    const taskList = await jobs(async list => {
      for (const job of list.filter(j => j.status === 'running')) {
        try {
          if (job.downloadId !== undefined) {
            const [download] = await chrome.downloads.search({ id: job.downloadId });
            if (!download) { job.status = 'failed'; job.message = 'Download no longer exists.'; }
            else if (download.state === 'complete') { job.status = 'complete'; job.progress = 1; job.message = 'Downloaded ✓'; }
            else if (download.state === 'interrupted') { job.status = 'failed'; job.message = download.error || 'Interrupted'; }
            else { job.progress = download.totalBytes > 0 ? download.bytesReceived / download.totalBytes : 0; job.message = download.totalBytes > 0 ? `Downloading · ${Math.round(job.progress * 100)}%` : `Downloading · ${download.bytesReceived} bytes`; }
          } else if (job.workerTab !== undefined) await chrome.tabs.get(job.workerTab);
          else { job.status = 'failed'; job.message = 'Download was interrupted before it started. Retry.'; }
        } catch { job.status = 'failed'; job.message = 'Download tab was closed. Retry.'; }
      }
      await pump(list);
      return structuredClone(list.filter(j => j.tabId === tabId));
    });
    return { items: Object.values(state.entries).sort((a, b) => b.seen - a.seen), blobs: state.blobs, jobs: taskList };
  }

  const filter = { urls: ['http://*/*', 'https://*/*'] };
  chrome.webRequest.onSendHeaders.addListener(details => {
    if (details.tabId < 0) return;
    referrers.set(details.requestId, MediaTools.header(details.requestHeaders, 'referer'));
    if (referrers.size > 500) referrers.delete(referrers.keys().next().value);
  }, filter, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onHeadersReceived.addListener(details => { observe(details).catch(console.error); }, filter, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(details => { referrers.delete(details.requestId); }, filter);
  chrome.webRequest.onErrorOccurred.addListener(details => { referrers.delete(details.requestId); }, filter);
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    navigationTimes.set(details.tabId, details.timeStamp);
    navigate(details.tabId, details.url, true).catch(console.error);
  }, { ...filter, types: ['main_frame'] });
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) navigate(tabId, info.url).catch(console.error); });
  chrome.tabs.onRemoved.addListener(tabId => {
    serial(tabId, state => Object.assign(state, blank())).then(() => chrome.storage.session.remove(key(tabId))).catch(console.error);
    navigationTimes.delete(tabId);
    jobs(async list => {
      for (const job of list) {
        if (job.status === 'running' && job.workerTab === tabId) { job.status = 'failed'; job.message = 'Download tab was closed.'; }
        if (job.status === 'queued' && job.tabId === tabId) { job.status = 'failed'; job.message = 'Source tab was closed.'; }
      }
      await pump(list);
    }).catch(console.error);
  });
  chrome.downloads.onChanged.addListener(delta => { downloadChanged(delta).catch(console.error); });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg.cmd?.startsWith('scanner.')) return;
    (async () => {
      if (msg.cmd === 'scanner.dom') return dom(msg, sender);
      if (msg.cmd === 'scanner.list') return snapshot(msg.tabId);
      if (msg.cmd === 'scanner.refresh') { await refresh(msg.tabId); return snapshot(msg.tabId); }
      if (msg.cmd === 'scanner.clear') return serial(msg.tabId, state => { state.entries = {}; state.blobs = 0; });
      if (msg.cmd === 'scanner.inspect') return inspect(msg.tabId, msg.url);
      if (msg.cmd === 'scanner.download') return enqueue(msg.tabId, msg.urls || [], msg.rawPlaylist === true);
      if (msg.cmd === 'scanner.progress') return progress(msg, sender);
      if (msg.cmd === 'scanner.fetch') {
        const response = await fetchMedia(msg.url, { tabId: msg.tabId, frameId: msg.frameId, referrer: msg.referrer }, { headers: msg.range ? { Range: msg.range } : {} });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { data: btoa(binary), url: response.url, headers: [...response.headers], status: response.status };
      }
    })().then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
    return true;
  });
  return { classifyRequest, snapshot, navigate, dom, inspect, enqueue };
})();
