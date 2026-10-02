// Media discovery engine and durable download queue. All per-tab mutations are serialized
// and persisted in chrome.storage.session so they survive service-worker restarts.
globalThis.MediaScanner = (() => {
  const tabQueues = new Map();
  const referrers = new Map();
  const redirects = new Map(); // requestId -> [original url, ...hops]
  const responseMeta = new Map(); // requestId -> { cdn }
  const navigationTimes = new Map();
  const ports = new Set();
  const LIMIT = 200, CONCURRENCY = 3, MAP_LIMIT = 500;
  let jobsQueue = Promise.resolve();
  const key = tabId => 'scanner_tab_' + tabId;
  const blank = () => ({ pageUrl: '', entries: {}, blobs: 0, networkHits: 0, domHits: 0, playerHits: 0, segments: 0,
    segmentHosts: {}, redirectHits: 0, scanError: '', eme: null, revision: 0 });
  const debug = (...values) => { if (CFG.DEBUG) console.log('[Media Scanner]', ...values); };
  const allowed = (url, pageUrl = '') => CFG.enableYouTube || ![url, pageUrl].some(value => {
    try { return /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com)$/.test(new URL(value).hostname); } catch { return false; }
  });
  const hostOf = value => { try { return new URL(value).hostname; } catch { return ''; } };
  const bounded = (map, keyValue, value) => { map.set(keyValue, value); if (map.size > MAP_LIMIT) map.delete(map.keys().next().value); };
  const entryKey = item => item.key || CdnTools.dedupKey(item.originUrl || item.url);
  const findEntry = (state, url) => state.entries[url] || state.entries[CdnTools.dedupKey(url)] ||
    Object.values(state.entries).find(entry => entry.url === url || entry.originUrl === url) || null;

  // ---- live UI updates over ports (no "receiving end does not exist" errors) ----
  const pendingNotify = new Map();
  function notify(tabId) {
    if (!ports.size || pendingNotify.has(tabId)) return;
    pendingNotify.set(tabId, setTimeout(() => {
      pendingNotify.delete(tabId);
      for (const port of ports) { try { port.postMessage({ type: 'scanner.changed', tabId }); } catch { ports.delete(port); } }
    }, 250));
  }
  chrome.runtime.onConnect?.addListener(port => {
    if (port.name !== 'scanner') return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
  });

  function serial(tabId, fn, { changed = true } = {}) {
    const next = (tabQueues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
      const state = { ...blank(), ...((await chrome.storage.session.get(key(tabId)))[key(tabId)] || {}) };
      const before = state.revision;
      const result = await fn(state);
      if (changed) state.revision = before + 1;
      await chrome.storage.session.set({ [key(tabId)]: state });
      if (changed) notify(tabId);
      return result;
    });
    tabQueues.set(tabId, next);
    next.finally(() => { if (tabQueues.get(tabId) === next) tabQueues.delete(tabId); }).catch(() => {});
    return next;
  }
  function put(state, item) {
    const id = entryKey(item);
    const old = state.entries[id];
    // The page's stable link to media we already resolved through a redirect: keep the resolved CDN URL.
    if (old?.originUrl && !item.originUrl && item.url === old.originUrl)
      item = { ...item, url: old.url, originUrl: old.originUrl, redirects: old.redirects, mime: old.mime, filename: old.filename, cdn: old.cdn, size: item.size || old.size };
    const fresh = !old || item.url !== old.url;
    const signed = CdnTools.signedInfo(item.url);
    state.entries[id] = { ...old, ...item, key: id, size: item.size || old?.size || 0,
      mime: item.mime || old?.mime || '', filename: old?.mime && !item.mime ? old.filename : item.filename,
      referrer: item.referrer || old?.referrer || state.pageUrl, pageUrl: state.pageUrl || old?.pageUrl || '',
      pageHost: hostOf(state.pageUrl || old?.pageUrl || item.referrer || item.initiator || ''),
      cdn: item.cdn?.provider ? item.cdn : old?.cdn || CdnTools.identify(item.url), signed: signed.signed ? signed : undefined,
      firstSeen: old?.firstSeen || Date.now(), seen: Date.now(),
      refreshedAt: old && fresh ? Date.now() : old?.refreshedAt, probe: fresh ? undefined : old?.probe,
      details: item.details || old?.details, protection: item.protection || old?.protection, selection: old?.selection,
      source: old?.source && item.source === 'dom' ? old.source : item.source || old?.source };
    if (old && fresh && old.signed && !CdnTools.isExpired(signed)) debug('refreshed signed URL', id);
    const ids = Object.keys(state.entries).sort((a, b) => state.entries[b].seen - state.entries[a].seen);
    for (const stale of ids.slice(LIMIT)) delete state.entries[stale];
  }
  function classifyRequest(details) {
    if (!allowed(details.url, details.initiator)) return null;
    try {
      const parsed = new URL(details.url);
      if (parsed.hostname.endsWith('.googlevideo.com') && parsed.pathname.includes('/videoplayback')) {
        const stream = classify(details);
        if (!stream || stream.kind !== 'chunked') return null;
        const item = MediaTools.classify(stream.url, [{ name: 'content-type', value: stream.mime }]);
        return item ? { ...item, mode: 'chunked', size: stream.size, quality: stream.quality, track: stream.track,
          filename: 'YouTube ' + stream.quality + '.' + (stream.mime.includes('webm') ? 'webm' : stream.track === 'a' ? 'm4a' : 'mp4') } : null;
      }
    } catch { return null; }
    return MediaTools.classify(details.url, details.responseHeaders);
  }
  const SEGMENT = /\.(ts|m4s|cmfv|cmfa|m4f|aac)(?:[?#]|$)/i;
  async function observe(details) {
    if (details.tabId < 0 || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 300) return;
    const item = classifyRequest(details);
    const chain = redirects.get(details.requestId);
    redirects.delete(details.requestId);
    if (!item) {
      if (SEGMENT.test(details.url) || /video\/mp2t|iso\.segment/.test(MediaTools.header(details.responseHeaders, 'content-type'))) {
        const host = hostOf(details.url);
        await serial(details.tabId, state => {
          state.segments = (state.segments || 0) + 1;
          state.segmentHosts[host] = (state.segmentHosts[host] || 0) + 1;
        }, { changed: false });
      }
      return;
    }
    const referrer = referrers.get(details.requestId) || '';
    const cdn = CdnTools.identify(details.url, details.responseHeaders);
    await serial(details.tabId, state => {
      if (details.timeStamp < (navigationTimes.get(details.tabId) || 0)) return;
      const extra = { frameId: details.frameId, referrer, cdn, initiator: details.documentUrl || details.initiator || '' };
      if (chain?.length) {
        // Key redirected media by its stable original URL; download the final CDN URL.
        extra.originUrl = chain[0];
        extra.key = CdnTools.dedupKey(chain[0]);
        extra.redirects = chain.length;
        state.redirectHits = (state.redirectHits || 0) + 1;
      }
      put(state, { ...item, ...extra, source: 'network' });
      state.networkHits = (state.networkHits || 0) + 1;
      debug('network hit', details.tabId, item.type, item.domain, cdn.provider);
    });
  }
  async function navigate(tabId, pageUrl, force = false) {
    await serial(tabId, state => {
      if (force || state.pageUrl !== pageUrl) Object.assign(state, blank(), { pageUrl, revision: state.revision });
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
        if (item) put(state, { ...item, frameId: sender.frameId, referrer: sender.url, domSource: true, source: value.source || 'dom' });
      }
      state.blobs = Math.max(state.blobs, Number(msg.blobs) || 0);
      if (msg.eme) mergeEme(state, msg.eme);
      state.domHits = Object.values(state.entries).filter(entry => entry.domSource).length;
      state.playerHits = Object.values(state.entries).filter(entry => entry.source === 'player' || entry.source === 'script').length;
      debug('DOM scan', tabId, state.domHits);
    });
  }
  function mergeEme(state, eme) {
    const current = state.eme || { events: 0, systems: [], initDataTypes: [], mediaKeys: 0 };
    current.events = Math.max(current.events, Number(eme.events) || 0);
    current.mediaKeys = Math.max(current.mediaKeys, Number(eme.mediaKeys) || 0);
    current.systems = [...new Set([...current.systems, ...(eme.systems || []).map(String)])].slice(0, 10);
    current.initDataTypes = [...new Set([...current.initDataTypes, ...(eme.initDataTypes || []).map(String)])].slice(0, 5);
    state.eme = current.events || current.mediaKeys ? current : null;
  }
  // Read URLs that common JavaScript players already expose. Runs in the page's main world,
  // reads only properties/getters, never changes player state.
  function playerProbe() {
    const urls = new Set();
    const add = value => { if (typeof value === 'string' && /^https?:/i.test(value)) urls.add(value); };
    const sources = list => (Array.isArray(list) ? list : []).forEach(s => add(s?.file || s?.src || s));
    try { if (typeof jwplayer === 'function') { const p = jwplayer(); sources(p?.getPlaylist?.()?.flatMap(i => [i.file, ...(i.sources || [])])); add(p?.getPlaylistItem?.()?.file); } } catch {}
    try { for (const p of Object.values(globalThis.videojs?.getPlayers?.() || {})) { add(p?.currentSrc?.()); sources(p?.currentSources?.()); } } catch {}
    try { for (const name of ['player', 'hls', 'dashPlayer', 'shakaPlayer', 'flowplayerInstance', 'plyr']) {
      const p = globalThis[name];
      if (!p || typeof p !== 'object') continue;
      add(p.url); add(p.src); add(p.source); add(p.getSource?.()); add(p.getAssetUri?.()); add(p.getManifestUri?.());
    } } catch {}
    try { document.querySelectorAll('video').forEach(v => { add(v.currentSrc); }); } catch {}
    return [...urls].slice(0, 50);
  }
  async function refresh(tabId) {
    const tab = await chrome.tabs.get(tabId);
    await navigate(tabId, tab.url);
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/dom-scan.js'] });
      const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.VGDomScan?.() });
      for (const result of results) if (result.result) await dom(result.result, { tab, frameId: result.frameId, url: result.result.pageUrl });
      try {
        const probes = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: playerProbe });
        for (const probe of probes || []) {
          const urls = (probe.result || []).map(url => ({ url, source: 'player' }));
          if (urls.length) await dom({ urls }, { tab, frameId: probe.frameId, url: probe.documentUrl || tab.url });
        }
      } catch (error) { debug('player probe failed', error.message); }
      await serial(tabId, state => {
        state.scanError = results.some(result => result.result) ? '' : 'DOM scan returned no frame results.';
        for (const entry of Object.values(state.entries)) if (entry.protection?.status === 'unknown') delete entry.protection;
      });
    } catch (error) {
      debug('DOM scan failed', tabId, error.message);
      await serial(tabId, state => { state.scanError = error.message; });
    }
    // Rebuild from the working detector when the scanner missed earlier requests.
    const detected = await getList(tabId);
    await serial(tabId, state => {
      for (const entry of Object.values(detected)) {
        const item = classifyRequest({ url: entry.url, method: 'GET', responseHeaders: entry.mime ? [{ name: 'content-type', value: entry.mime }] : [] });
        if (item && !findEntry(state, item.url)) {
          put(state, { ...item, size: entry.size, referrer: tab.url, source: 'network' });
          state.networkHits = (state.networkHits || 0) + 1;
        }
      }
    });
  }
  async function fetchMedia(url, item = {}, options = {}) {
    if (!MediaTools.httpUrl(url)) throw new Error('Only HTTP(S) URLs can be fetched.');
    let original;
    try {
      const response = await fetch(url, { credentials: 'include', ...options, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Object.assign(new Error(CdnTools.classifyFailure({ status: response.status, url }).message), { status: response.status });
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
        throw Object.assign(new Error(original.message + '; page fallback: ' + error.message + '. Reload the source page if the URL expired.'), { status: original.status });
      }
    }
    throw original;
  }
  const statusOf = (error, url) => {
    const info = CdnTools.classifyFailure({ status: error.status || 0, url, error: error.message });
    return error.status ? info.code : CdnTools.isExpired(CdnTools.signedInfo(url)) ? 'expired' : 'error';
  };
  // Inspect a playlist: protection, qualities, audio tracks, segment CDN hosts.
  async function inspect(tabId, url) {
    const item = await serial(tabId, state => findEntry(state, url), { changed: false });
    if (!item || item.type !== 'playlist') throw new Error('Playlist is no longer on this page.');
    if (item.kind === 'mss' || item.kind === 'hds') {
      const protection = { status: 'unsupported', reason: item.kind === 'mss' ? 'Microsoft Smooth Streaming is not supported.' : 'Adobe HDS is not supported.' };
      await serial(tabId, state => { const e = findEntry(state, url); if (e) e.protection = protection; });
      return protection;
    }
    const seen = new Set();
    let details = null, drm = null, itemStatus = 'available';
    async function fetchText(next) {
      const response = await fetchMedia(next, { ...item, tabId });
      return { text: await response.text(), url: response.url || next };
    }
    async function walk(next, depth) {
      if (seen.has(next)) return null;
      if (depth > 5 || seen.size >= 50) throw new Error('Playlist inspection limit reached.');
      seen.add(next);
      const { text, url: finalUrl } = await fetchText(next);
      if (item.kind === 'hls' && !text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist.');
      if (item.kind === 'dash' && !/<(?:[\w.-]+:)?MPD\b/i.test(text)) throw new Error('Not a DASH manifest.');
      const reason = PlaylistTools.protection(text);
      if (reason) { drm = item.kind === 'dash' ? DrmTools.dash(text) : DrmTools.hls(text); return reason; }
      if (item.kind === 'dash') {
        try {
          const manifest = DashTools.parse(text, finalUrl);
          const hosts = new Set(manifest.representations.flatMap(r => (r.segments?.media || []).slice(0, 3).map(s => hostOf(s.url))));
          details = { ...DashTools.summary(manifest), live: manifest.live, duration: manifest.duration, periods: manifest.periods,
            segmentHosts: [...hosts].filter(Boolean), warning: manifest.warning,
            unsupported: manifest.representations.every(r => r.error) ? manifest.representations[0]?.error : '' };
        } catch (error) { details = { error: error.message }; }
        return null;
      }
      if (depth === 0 && HlsTools.isMaster(text)) {
        const master = HlsTools.parseMaster(text, finalUrl);
        details = { ...HlsTools.summary(master), segmentHosts: [] };
      }
      if (!HlsTools.isMaster(text)) {
        try {
          const media = HlsTools.parseMedia(text, finalUrl);
          details ||= { variants: [], audio: [] };
          details.container ||= media.container; details.live ??= media.live;
          details.duration ||= Math.round(media.duration);
          details.segments ||= media.segments.length;
          details.segmentHosts = [...new Set([...(details.segmentHosts || []), ...media.segments.slice(0, 3).map(s => hostOf(s.url))])];
        } catch (error) { if (error.code !== 'protected') details = { ...(details || {}), error: error.message }; }
      }
      // Inspect the best variant and every audio rendition, not every quality.
      const children = PlaylistTools.children(text, finalUrl);
      const master = HlsTools.isMaster(text) ? HlsTools.parseMaster(text, finalUrl) : null;
      const ordered = master ? [...new Set([master.variants[0]?.url, ...master.audio.map(a => a.url), ...children].filter(Boolean))] : children;
      for (const childUrl of ordered) {
        const reason = await walk(childUrl, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
    let protection;
    try {
      const reason = await walk(item.url, 0);
      protection = { status: reason ? 'protected' : 'clear', reason: reason || '' };
      if (drm) { protection.drm = drm; protection.label = DrmTools.label(drm); }
      if (!reason && details?.unsupported) protection = { status: 'unsupported', reason: details.unsupported };
    } catch (error) {
      itemStatus = statusOf(error, item.url);
      protection = { status: 'unknown', reason: error.message, code: itemStatus };
    }
    await serial(tabId, state => {
      const entry = findEntry(state, url);
      if (!entry) return;
      entry.protection = protection;
      if (details) entry.details = details;
      entry.status = itemStatus;
    });
    return protection;
  }
  // Lightweight availability/size probe for direct files (1-byte range request).
  async function probe(tabId, url) {
    const item = await serial(tabId, state => findEntry(state, url), { changed: false });
    if (!item || item.type === 'playlist') throw new Error('Media is no longer on this page.');
    let result;
    try {
      const response = await fetchMedia(item.url, { ...item, tabId }, { headers: { Range: 'bytes=0-0' } });
      const type = response.headers.get('content-type') || '';
      const total = Number((response.headers.get('content-range') || '').split('/')[1]) || (response.status === 200 ? Number(response.headers.get('content-length')) || 0 : 0);
      response.body?.cancel?.().catch(() => {});
      if (/^(text\/html|application\/xhtml)/i.test(type)) result = { status: 'auth', reason: CdnTools.classifyFailure({ contentType: type }).message };
      else result = { status: 'available', size: total, ranges: response.status === 206, cdn: CdnTools.identify(response.url || item.url, [...response.headers].map(([name, value]) => ({ name, value }))) };
    } catch (error) {
      const code = statusOf(error, item.url);
      result = { status: code, reason: error.message };
    }
    result.checkedAt = Date.now();
    await serial(tabId, state => {
      const entry = findEntry(state, url);
      if (!entry) return;
      entry.probe = result; entry.status = result.status;
      if (result.size) entry.size = result.size;
      if (result.cdn?.provider) entry.cdn = result.cdn;
    });
    return result;
  }

  // ---------------- jobs ----------------
  function jobs(fn) {
    const result = jobsQueue.catch(() => {}).then(async () => {
      const list = (await chrome.storage.session.get('scanner_jobs')).scanner_jobs || [];
      const before = JSON.stringify(list.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)]));
      const result = await fn(list);
      // Keep active jobs, plus the most recent 100 finished jobs.
      const active = list.filter(j => ['queued', 'running'].includes(j.status));
      const finished = list.filter(j => !['queued', 'running'].includes(j.status)).slice(-100);
      await chrome.storage.session.set({ scanner_jobs: [...finished, ...active] });
      if (JSON.stringify(list.map(j => [j.id, j.status, Math.round((j.progress || 0) * 100)])) !== before)
        for (const tabId of new Set(list.map(j => j.tabId))) notify(tabId);
      return result;
    });
    jobsQueue = result;
    return result;
  }
  async function settings() {
    try { return { concurrency: 4, retries: 4, ...((await chrome.storage.local.get('vg_settings')).vg_settings || {}) }; }
    catch { return { concurrency: 4, retries: 4 }; }
  }
  const needsTab = item => item.type === 'playlist' || item.mode;
  async function launch(job) {
    job.status = 'running'; job.attempts = (job.attempts || 0) + 1;
    job.progress = 0; job.message = 'Starting…'; job.paused = false;
    delete job.speed; delete job.eta; delete job.errorCode;
    try {
      let url = job.item.url;
      // Expired signed URL with a stable pre-redirect origin: let the CDN issue a fresh one.
      if (job.item.originUrl && CdnTools.isExpired(CdnTools.signedInfo(url))) url = job.item.originUrl;
      if (needsTab(job.item) || job.pageFallback) {
        const mode = job.item.kind === 'dash' ? 'dash' : job.item.kind === 'hls' ? 'hls' : job.item.mode || 'file';
        const params = new URLSearchParams({ mode, url, name: job.item.filename,
          size: job.item.size || 0, job: job.id, sourceTab: job.tabId,
          frame: job.item.frameId || 0, referrer: job.item.referrer || '', auto: '1', sel: JSON.stringify(job.item.selection || {}) });
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') + '?' + params, active: false });
        job.workerTab = tab.id;
        job.message = 'Downloading in a tab…';
        job.lastProgressAt = Date.now();
      } else {
        // Catch login/error pages before handing a direct file to Chrome downloads.
        // Some signed CDNs disallow HEAD; a failed probe leaves the normal GET path available.
        let probe;
        try { probe = await fetch(url, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(10000) }); } catch {}
        if (probe?.ok && /^(text\/html|application\/(json|xhtml\+xml)|image\/)/i.test(probe.headers.get('content-type') || '')) {
          throw Object.assign(new Error('The URL returned a page or error document instead of media. Reload the source page and retry.'), { code: 'auth' });
        }
        if (probe && !probe.ok && [401, 403, 404, 410].includes(probe.status)) {
          const info = CdnTools.classifyFailure({ status: probe.status, url });
          if (info.code === 'expired' || info.code === 'not-found') throw Object.assign(new Error(info.message), { code: info.code });
        }
        job.downloadId = await chrome.downloads.download({ url,
          filename: MediaTools.filename(job.item.filename), conflictAction: 'uniquify' });
        job.message = 'Downloading…';
        job.lastBytes = 0; job.lastTime = Date.now();
      }
    } catch (error) {
      job.status = 'failed'; job.message = error.message || String(error); job.errorCode = error.code || 'error';
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
  const selectionKey = item => item.key + '|' + JSON.stringify(item.selection || {});
  async function enqueue(tabId, urls, selections = {}) {
    for (const url of urls) {
      const item = await serial(tabId, state => findEntry(state, url), { changed: false });
      if (item?.type === 'playlist' && item.protection?.status !== 'clear') {
        const protection = await inspect(tabId, url);
        if (protection.status !== 'clear') continue;
      }
    }
    const items = await serial(tabId, state => urls.slice(0, LIMIT).map(url => {
      const entry = findEntry(state, url);
      if (entry && selections[url]) entry.selection = selections[url];
      return entry ? structuredClone(entry) : null;
    }).filter(Boolean));
    const config = await settings();
    return jobs(async list => {
      const ids = [];
      for (const item of items) {
        if (!allowed(item.url, item.referrer) || (item.type === 'playlist' && item.protection?.status !== 'clear')) continue;
        // One active job per resource+quality, even across popup reopenings or double clicks.
        const existing = list.find(j => j.tabId === tabId && selectionKey(j.item) === selectionKey(item) && ['queued', 'running'].includes(j.status));
        if (existing) { ids.push(existing.id); continue; }
        const job = { id: crypto.randomUUID(), tabId, item, status: 'queued', attempts: 0, progress: 0, message: 'Queued',
          settings: { concurrency: config.concurrency, retries: config.retries }, created: Date.now() };
        list.push(job); ids.push(job.id);
      }
      await pump(list);
      return ids;
    });
  }
  // A finished Chrome download is only "complete" when a non-empty media file exists.
  async function verifyDownload(id) {
    const [download] = await chrome.downloads.search({ id });
    if (!download) return 'Download no longer exists.';
    if (download.state !== 'complete') return '';
    if (download.exists === false) return 'The downloaded file was moved or deleted.';
    const bytes = download.fileSize > 0 ? download.fileSize : download.bytesReceived;
    if (bytes !== undefined && bytes <= 0) return 'The server sent an empty file.';
    if (/^(text\/html|application\/xhtml)/i.test(download.mime || '')) return 'The server sent a web page instead of media.';
    return null;
  }
  async function downloadChanged(delta) {
    await jobs(async list => {
      const job = list.find(j => j.downloadId === delta.id && j.status === 'running');
      if (!job) return;
      if (delta.paused) job.paused = !!delta.paused.current;
      if (!delta.state) return;
      if (delta.state.current === 'complete') {
        const problem = await verifyDownload(delta.id).catch(error => error.message);
        if (problem) { job.status = 'failed'; job.message = problem + ' Refresh or reload the source page and retry.'; job.errorCode = 'integrity'; }
        else { job.status = 'complete'; job.progress = 1; job.message = 'Downloaded ✓'; }
      } else if (delta.state.current === 'interrupted') {
        const [download] = await chrome.downloads.search({ id: delta.id });
        const reason = delta.error?.current || download?.error || 'Download interrupted';
        if (reason === 'USER_CANCELED') { job.status = 'cancelled'; job.message = 'Cancelled'; }
        else if (reason === 'SERVER_FORBIDDEN' && !job.pageFallback) {
          job.pageFallback = true; job.status = 'queued'; delete job.downloadId;
        } else if (/^(NETWORK_|SERVER_FAILED|SERVER_UNAVAILABLE)/.test(reason) && job.attempts < 3) {
          if (download?.canResume && chrome.downloads.resume) {
            // Partial-download recovery: continue from the bytes already on disk.
            try { await chrome.downloads.resume(delta.id); job.attempts++; job.message = 'Resuming after ' + reason + '…'; return; } catch {}
          }
          job.status = 'queued'; delete job.downloadId;
        } else {
          job.status = 'failed';
          job.errorCode = /FORBIDDEN|UNAUTHORIZED/.test(reason) ? 'auth' : /BAD_CONTENT|NO_FILE/.test(reason) ? 'expired' : 'error';
          job.message = reason + '. ' + (job.errorCode === 'expired' ? 'The URL may have expired. ' : '') + 'Refresh or reload the source page and retry.';
        }
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
      if (Number(msg.bytes) !== job.bytes || job.phase !== msg.phase) job.lastProgressAt = Date.now();
      job.phase = String(msg.phase || 'download').slice(0, 20);
      job.paused = !!msg.paused;
      job.speed = Number(msg.speed) || 0; job.eta = msg.eta === null || msg.eta === undefined ? null : Number(msg.eta);
      job.bytes = Number(msg.bytes) || 0; job.total = Number(msg.total) || 0;
      if (msg.errorCode) job.errorCode = String(msg.errorCode).slice(0, 20);
      if (msg.downloadId !== undefined) job.savedDownloadId = msg.downloadId;
      if (msg.status === 'complete') {
        // Never report success without a saved, non-empty file.
        const problem = job.savedDownloadId !== undefined ? await verifyDownload(job.savedDownloadId).catch(error => error.message) : 'No saved file was reported.';
        if (problem) { job.status = 'failed'; job.message = problem; job.errorCode = 'integrity'; }
        else { job.status = 'complete'; job.progress = 1; }
      } else if (['failed', 'protected', 'cancelled'].includes(msg.status)) job.status = msg.status;
      await pump(list);
    });
  }
  async function claim(msg, sender) {
    return jobs(async list => {
      const job = list.find(j => j.id === msg.id);
      if (!job || job.status !== 'running' || job.workerTab !== sender.tab?.id)
        throw new Error('This download job is no longer active (it may have been restored from an earlier session or already finished).');
      if (job.claimed && job.claimed !== sender.tab.id) throw new Error('This download job is already being processed in another tab.');
      job.claimed = sender.tab.id;
      return structuredClone(job);
    });
  }
  async function control(msg) {
    const action = msg.action;
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Unknown action.');
    const job = await jobs(async list => {
      const job = list.find(j => j.id === msg.id);
      if (!job) throw new Error('Job not found.');
      if (job.status === 'queued' && action === 'cancel') { job.status = 'cancelled'; job.message = 'Cancelled'; }
      return structuredClone(job);
    });
    if (job.status !== 'running') return job;
    if (job.downloadId !== undefined) {
      if (action === 'pause') await chrome.downloads.pause(job.downloadId);
      else if (action === 'resume') await chrome.downloads.resume(job.downloadId);
      else await chrome.downloads.cancel(job.downloadId);
    } else if (job.workerTab !== undefined) {
      try { await chrome.tabs.sendMessage(job.workerTab, { cmd: 'downloader.control', id: job.id, action }); }
      catch (error) { if (action !== 'cancel') throw new Error('The download tab is not responding: ' + error.message); }
    }
    return jobs(async list => {
      const current = list.find(j => j.id === msg.id);
      if (!current) return null;
      if (action === 'cancel') {
        current.status = 'cancelled'; current.message = 'Cancelled';
        await pump(list);
      } else { current.paused = action === 'pause'; current.message = action === 'pause' ? 'Paused' : 'Resuming…'; }
      return structuredClone(current);
    });
  }
  async function snapshot(tabId) {
    const state = await serial(tabId, state => structuredClone(state), { changed: false });
    const taskList = await jobs(async list => {
      for (const job of list.filter(j => j.status === 'running')) {
        try {
          if (job.downloadId !== undefined) {
            const [download] = await chrome.downloads.search({ id: job.downloadId });
            if (!download) { job.status = 'failed'; job.message = 'Download no longer exists.'; }
            else if (download.state === 'complete') {
              const problem = await verifyDownload(job.downloadId);
              if (problem) { job.status = 'failed'; job.message = problem; job.errorCode = 'integrity'; }
              else { job.status = 'complete'; job.progress = 1; job.message = 'Downloaded ✓'; }
            }
            else if (download.state === 'interrupted') { job.status = download.error === 'USER_CANCELED' ? 'cancelled' : 'failed'; job.message = download.error || 'Interrupted'; }
            else {
              const now = Date.now();
              const received = download.bytesReceived || 0;
              if (job.lastTime && now > job.lastTime) {
                const instant = (received - (job.lastBytes || 0)) / ((now - job.lastTime) / 1000);
                job.speed = job.speed ? Math.round(job.speed * 0.6 + instant * 0.4) : Math.round(instant);
              }
              if (received !== job.lastBytes || !job.lastChange) job.lastChange = now;
              job.lastBytes = received; job.lastTime = now;
              job.paused = !!download.paused;
              job.bytes = received; job.total = download.totalBytes > 0 ? download.totalBytes : 0;
              job.progress = job.total ? received / job.total : 0;
              const end = download.estimatedEndTime ? Date.parse(download.estimatedEndTime) : NaN;
              job.eta = Number.isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : job.total && job.speed > 0 ? Math.round((job.total - received) / job.speed) : null;
              const waitingForDialog = !received && !download.filename;
              const stalled = !job.paused && now - job.lastChange > 60000;
              job.message = job.paused ? 'Paused'
                : waitingForDialog ? 'Waiting for you to choose where to save the file (check for a Save dialog behind this window).'
                : stalled ? `No data received for ${Math.round((now - job.lastChange) / 1000)} s – the server may be throttling or blocking this download. Cancel and retry, or replay the media and Refresh.`
                : job.total ? `Downloading · ${Math.round(job.progress * 100)}%` : `Downloading · ${received} bytes`;
            }
          } else if (job.workerTab !== undefined) {
            await chrome.tabs.get(job.workerTab);
            const quiet = Date.now() - (job.lastProgressAt || Date.now());
            if (!job.paused && quiet > 60000 && !/^No progress/.test(job.message || ''))
              job.message = `No progress for ${Math.round(quiet / 1000)} s – open the "Downloading" tab for details. The server may be throttling or blocking this stream. ` + (job.message || '');
          }
          else { job.status = 'failed'; job.message = 'Download was interrupted before it started. Retry.'; }
        } catch { job.status = 'failed'; job.message = 'Download tab was closed. Retry resumes completed segments when possible.'; }
      }
      await pump(list);
      return structuredClone(list.filter(j => j.tabId === tabId));
    });
    const now = Date.now();
    const items = Object.values(state.entries).sort((a, b) => b.seen - a.seen).map(item => {
      if (item.signed?.expiresAt && item.signed.expiresAt <= now && !item.originUrl) item.status = 'expired';
      return item;
    });
    return { items, blobs: state.blobs, segments: state.segments, eme: state.eme, pageUrl: state.pageUrl, revision: state.revision,
      debug: { networkHits: state.networkHits || 0, domHits: state.domHits || 0, playerHits: state.playerHits || 0, redirectHits: state.redirectHits || 0,
        segmentHosts: Object.keys(state.segmentHosts || {}).slice(0, 5), tabId, scanError: state.scanError || '' }, jobs: taskList };
  }
  // Recover jobs after a service-worker restart: reconcile running jobs and continue the queue.
  async function recover() {
    await jobs(async list => {
      for (const job of list.filter(j => j.status === 'running' && j.workerTab !== undefined && j.downloadId === undefined)) {
        try { await chrome.tabs.get(job.workerTab); } catch { job.status = 'failed'; job.message = 'Download tab was closed. Retry resumes completed segments when possible.'; }
      }
      await pump(list);
    });
  }

  const filter = { urls: ['http://*/*', 'https://*/*'] };
  chrome.webRequest.onSendHeaders.addListener(details => {
    if (details.tabId < 0) return;
    bounded(referrers, details.requestId, MediaTools.header(details.requestHeaders, 'referer'));
  }, filter, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onBeforeRedirect?.addListener(details => {
    if (details.tabId < 0 || !details.redirectUrl) return;
    const chain = redirects.get(details.requestId) || [details.url];
    chain.push(details.redirectUrl);
    bounded(redirects, details.requestId, chain.slice(-10));
  }, filter);
  chrome.webRequest.onHeadersReceived.addListener(details => { observe(details).catch(console.error); }, filter, ['responseHeaders']);
  const forget = details => { referrers.delete(details.requestId); redirects.delete(details.requestId); responseMeta.delete(details.requestId); };
  chrome.webRequest.onCompleted.addListener(forget, filter);
  chrome.webRequest.onErrorOccurred.addListener(forget, filter);
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    navigationTimes.set(details.tabId, details.timeStamp);
    navigate(details.tabId, details.url, true).catch(console.error);
  }, { ...filter, types: ['main_frame'] });
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) navigate(tabId, info.url).catch(console.error); });
  chrome.tabs.onRemoved.addListener(tabId => {
    serial(tabId, state => Object.assign(state, blank())).then(() => chrome.storage.session.remove(key(tabId))).catch(console.error);
    navigationTimes.delete(tabId);
    clearTimeout(pendingNotify.get(tabId)); pendingNotify.delete(tabId);
    jobs(async list => {
      for (const job of list) {
        if (job.status === 'running' && job.workerTab === tabId) { job.status = 'failed'; job.message = 'Download tab was closed. Retry resumes completed segments when possible.'; }
        if (job.status === 'queued' && job.tabId === tabId) { job.status = 'failed'; job.message = 'Source tab was closed.'; }
      }
      await pump(list);
    }).catch(console.error);
  });
  chrome.downloads.onChanged.addListener(delta => { downloadChanged(delta).catch(console.error); });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg?.cmd?.startsWith('scanner.')) return;
    (async () => {
      if (msg.cmd === 'scanner.dom') return dom(msg, sender);
      if (msg.cmd === 'scanner.eme') { if (sender.tab?.id !== undefined) await serial(sender.tab.id, state => mergeEme(state, msg)); return true; }
      if (msg.cmd === 'scanner.list') return snapshot(msg.tabId);
      if (msg.cmd === 'scanner.refresh') { await refresh(msg.tabId); return snapshot(msg.tabId); }
      if (msg.cmd === 'scanner.clear') return serial(msg.tabId, state => Object.assign(state, blank(), { pageUrl: state.pageUrl, revision: state.revision }));
      if (msg.cmd === 'scanner.inspect') return inspect(msg.tabId, msg.url);
      if (msg.cmd === 'scanner.probe') return probe(msg.tabId, msg.url);
      if (msg.cmd === 'scanner.download') return enqueue(msg.tabId, msg.urls || [], msg.selections || {});
      if (msg.cmd === 'scanner.progress') return progress(msg, sender);
      if (msg.cmd === 'scanner.claim') return claim(msg, sender);
      if (msg.cmd === 'scanner.control') return control(msg);
      if (msg.cmd === 'scanner.settings') {
        if (msg.settings) {
          const value = { concurrency: Math.max(1, Math.min(8, Number(msg.settings.concurrency) || 4)), retries: Math.max(0, Math.min(10, Number(msg.settings.retries) ?? 4)) };
          await chrome.storage.local.set({ vg_settings: value });
        }
        return settings();
      }
      if (msg.cmd === 'scanner.fetch') {
        const response = await fetchMedia(msg.url, { tabId: msg.tabId, frameId: msg.frameId, referrer: msg.referrer }, { headers: msg.range ? { Range: msg.range } : {} });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { data: btoa(binary), url: response.url, headers: [...response.headers], status: response.status };
      }
      throw new Error('Unknown scanner command: ' + msg.cmd);
    })().then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
    return true;
  });
  recover().catch(console.error);
  return { classifyRequest, snapshot, navigate, dom, inspect, probe, enqueue, recover, control };
})();
