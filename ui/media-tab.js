(() => {
  const panel = document.querySelector('#media-panel');
  const list = document.querySelector('#media-list');
  const summary = document.querySelector('#media-summary');
  const empty = document.querySelector('#media-empty');
  const diagnostics = document.querySelector('#media-debug');
  const allButton = document.querySelector('#media-download-all');
  const note = document.querySelector('#media-note');
  const concurrency = document.querySelector('#media-concurrency');
  const filters = [...panel.querySelectorAll('[data-filter]')];
  let active = false, tabId, filter = 'all', snapshot = { items: [], jobs: [] }, generation = 0;
  const inspecting = new Set(), probing = new Set(), choices = new Map();
  let loading = false, rescanPending = false, port = null;
  const sizes = n => n > 0 ? n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB' : 'Size unknown';
  const rate = n => n > 0 ? sizes(n) + '/s' : '';
  const eta = s => s === null || s === undefined || !Number.isFinite(s) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m left` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s left` : `${Math.round(s)}s left`;
  const mbps = bw => bw ? (bw / 1e6).toFixed(bw < 1e6 ? 2 : 1) + ' Mbps' : '';
  const hostOf = value => { try { return new URL(value).hostname; } catch { return ''; } };
  async function request(cmd, data = {}) {
    const response = await chrome.runtime.sendMessage({ cmd: 'scanner.' + cmd, tabId, ...data });
    if (!response?.ok) throw new Error(response?.error || 'Scanner is unavailable. Reload the extension.');
    return response.result;
  }
  const filtered = () => snapshot.items.filter(item => filter === 'all' || item.type === filter);
  const currentJob = url => { const key = snapshotKey(url); return [...snapshot.jobs].reverse().find(job => job.item.url === url || (key && job.item.key === key)); };
  const snapshotKey = url => snapshot.items.find(item => item.url === url)?.key;
  // Human explanation of why an item cannot be downloaded (or '' when it can).
  function blocker(item) {
    if (item.protection?.status === 'protected') return 'Protected – not downloadable';
    if (item.protection?.status === 'unsupported') return 'Unsupported format';
    if (item.status === 'expired' && !item.originUrl) return 'Link expired';
    return '';
  }
  function explain(item, job) {
    const p = item.protection;
    if (p?.status === 'protected') return { text: (p.label || 'Protected') + ' · ' + (p.reason || 'DRM') + '. Encrypted media cannot be downloaded; Video Grabber does not request licenses or keys.', err: true };
    if (p?.status === 'unsupported') return { text: p.reason, err: true };
    if (item.status === 'expired') return { text: item.originUrl ? 'Signed link expired; the original URL will be used to get a fresh one.' : 'The signed link expired. Replay the media on the page, then Refresh.', err: !item.originUrl };
    if (item.status === 'auth') return { text: 'Access denied or login page returned. Sign in on the source site and replay the media.', err: true };
    if (item.status === 'not-found') return { text: 'The media no longer exists at this URL.', err: true };
    if (job) return null;
    if (item.type === 'playlist') {
      if (p?.status === 'clear') return { text: 'No encryption detected' + (item.details?.live ? ' · live: only listed segments are saved' : '') + (item.details?.warning ? ' · ' + item.details.warning : '') };
      if (p?.status === 'unknown') return { text: 'Check failed · ' + p.reason, err: true };
      return { text: 'Checking protection…' };
    }
    if (item.signed?.expiresAt) {
      const left = Math.round((item.signed.expiresAt - Date.now()) / 60000);
      return { text: `${item.signed.provider} · expires ${left > 90 ? 'in ' + Math.round(left / 60) + ' h' : left > 0 ? 'in ' + left + ' min' : 'now'}` };
    }
    return null;
  }
  function option(text, value) { const o = document.createElement('option'); o.textContent = text; o.value = value; return o; }
  function qualityControls(item) {
    const d = item.details;
    if (!d || item.type !== 'playlist' || item.protection?.status !== 'clear') return [];
    const out = [];
    const variants = (d.variants || []).filter(v => !v.error);
    const choice = choices.get(item.url) || {};
    if (variants.length > 1) {
      const select = document.createElement('select'); select.className = 'q';
      select.setAttribute('aria-label', 'Quality');
      variants.forEach((v, i) => select.append(option([v.height ? v.height + 'p' : v.audioOnly ? 'Audio only' : 'Stream ' + (i + 1), mbps(v.bandwidth), v.codecs].filter(Boolean).join(' · '),
        JSON.stringify(item.kind === 'dash' ? { id: v.id } : { height: v.height, bandwidth: v.bandwidth }))));
      if (choice.video) select.value = choice.video;
      select.onchange = () => choices.set(item.url, { ...choices.get(item.url), video: select.value });
      out.push(select);
    }
    const audio = (d.audio || []).filter(a => a.url || a.id);
    if (audio.length > 1) {
      const select = document.createElement('select'); select.className = 'q';
      select.setAttribute('aria-label', 'Audio track');
      audio.forEach(a => select.append(option([a.name || a.label || a.lang || a.language || a.id, a.language || a.lang, a.channels ? a.channels + 'ch' : '', a.codec || a.codecs || ''].filter(Boolean).join(' · '),
        item.kind === 'dash' ? a.id : a.url)));
      if (choice.audio) select.value = choice.audio;
      select.onchange = () => choices.set(item.url, { ...choices.get(item.url), audio: select.value });
      out.push(select);
    }
    return out;
  }
  function selectionFor(item) {
    const choice = choices.get(item.url);
    if (!choice) return null;
    const sel = choice.video ? JSON.parse(choice.video) : {};
    if (choice.audio) sel.audio = choice.audio;
    return sel;
  }
  function detailLine(item) {
    const d = item.details || {};
    const parts = [];
    const heights = [...new Set((d.variants || []).map(v => v.height).filter(Boolean))].sort((a, b) => b - a);
    if (heights.length) parts.push(heights.map(h => h + 'p').join(', '));
    const audio = (d.audio || []).map(a => a.name || a.label || a.language || a.lang).filter(Boolean);
    if (audio.length) parts.push('audio: ' + [...new Set(audio)].join(', '));
    const codecs = [...new Set((d.variants || []).flatMap(v => String(v.codecs || '').split(',')).map(c => c.trim().split('.')[0]).filter(Boolean))];
    if (codecs.length) parts.push(codecs.join('/'));
    if (d.duration) parts.push(Math.floor(d.duration / 60) + ':' + String(Math.round(d.duration % 60)).padStart(2, '0'));
    if (d.live) parts.push('live');
    if (d.container) parts.push(d.container === 'fmp4' ? 'fMP4 segments' : d.container === 'ts' ? 'MPEG-TS segments' : d.container);
    if (d.segmentHosts?.length && d.segmentHosts.some(h => h !== item.domain)) parts.push('segments from ' + d.segmentHosts.join(', '));
    if (item.quality) parts.push(item.quality);
    return parts.join(' · ');
  }
  function progressText(job) {
    const parts = [];
    if (job.paused) parts.push('Paused');
    if (job.phase === 'convert') parts.push('Converting ' + Math.round((job.progress || 0) * 100) + '%');
    else if (job.phase === 'saving') parts.push('Saving…');
    else if (job.progress > 0) parts.push(Math.round(job.progress * 100) + '%');
    if (job.bytes) parts.push(sizes(job.bytes) + (job.total ? ' / ' + sizes(job.total) : ''));
    if (!job.paused && job.phase !== 'convert') { if (job.speed) parts.push(rate(job.speed)); if (job.eta !== null && job.eta !== undefined) parts.push(eta(job.eta)); }
    return parts.join(' · ') || job.message;
  }
  function render() {
    const items = filtered();
    list.replaceChildren();
    summary.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}${filter !== 'all' ? ' · ' + filter : ''}`;
    empty.hidden = items.length > 0;
    const segmented = snapshot.blobs || snapshot.segments || /(^|\.)(youtube\.com|youtu\.be)$/.test(snapshot.pageHost || '');
    empty.textContent = snapshot.items.length ? 'No items match this filter.' : snapshot.eme ? 'This page plays encrypted media (EME' + (snapshot.eme.systems?.length ? ': ' + snapshot.eme.systems.join(', ') : '') + '). DRM-protected streams cannot be downloaded.' : segmented ? 'This site streams in segments – use the Video Grabber tab' : 'No media detected. Play media or click Refresh to scan links on this page.';
    const info = snapshot.debug || {};
    diagnostics.textContent = `${info.networkHits || 0} network hits, ${info.domHits || 0} DOM hits${info.playerHits ? ', ' + info.playerHits + ' player/script hits' : ''}${info.redirectHits ? ', ' + info.redirectHits + ' redirects' : ''}${snapshot.segments ? ', ' + snapshot.segments + ' segments' + (info.segmentHosts?.length ? ' from ' + info.segmentHosts.join(', ') : '') : ''}, tab id ${tabId ?? 'unknown'}${info.scanError ? ' · ' + info.scanError : ''}`;
    diagnostics.hidden = items.length > 0;
    const messages = [];
    if (snapshot.eme) messages.push('Encrypted Media Extensions are active on this page' + (snapshot.eme.systems?.length ? ' (' + snapshot.eme.systems.join(', ') + ')' : '') + '. DRM-protected streams cannot be downloaded.');
    if (snapshot.blobs) messages.push('Blob player URLs cannot be downloaded directly. Associated HTTP media or playlists appear here when detected.');
    if (items.some(item => item.protection?.status === 'protected')) messages.push('Protected – not downloadable');
    note.hidden = !messages.length;
    note.textContent = messages.join(' ');
    allButton.disabled = !items.some(item => !blocker(item) && !['queued', 'running'].includes(currentJob(item.url)?.status));
    for (const item of items) {
      const job = currentJob(item.url);
      const row = document.createElement('li');
      row.className = 'scanner-item';
      const title = document.createElement('div'); title.className = 'scanner-title';
      const icon = document.createElement('span'); icon.textContent = { audio: '♫', video: '▶', playlist: '☷' }[item.type] || '•'; icon.setAttribute('aria-label', item.type);
      const filename = document.createElement('strong'); filename.textContent = item.filename; filename.title = item.filename;
      title.append(icon, filename);
      const meta = document.createElement('div'); meta.className = 'meta';
      const cdn = item.cdn?.provider ? `${item.domain} (${item.cdn.provider})` : item.domain;
      const origin = item.pageHost && item.pageHost !== item.domain ? ' · from ' + item.pageHost : '';
      meta.textContent = `${item.type === 'playlist' ? item.kind.toUpperCase() : item.type}${item.mime ? ' · ' + item.mime : ''} · ${sizes(item.size)} · ${cdn}${origin}${item.redirects ? ' · via redirect' : ''}`;
      meta.title = item.url;
      row.append(title, meta);
      const detail = detailLine(item);
      if (detail) { const line = document.createElement('div'); line.className = 'meta'; line.textContent = detail; line.title = detail; row.append(line); }
      const controls = qualityControls(item);
      if (controls.length) { const box = document.createElement('div'); box.className = 'actions'; box.append(...controls); row.append(box); }
      const actions = document.createElement('div'); actions.className = 'actions';
      const status = document.createElement('div'); status.className = 'status'; status.setAttribute('aria-live', 'polite');
      const download = document.createElement('button');
      const blocked = blocker(item) || (job?.status === 'protected' ? 'Protected – not downloadable' : '');
      const busy = ['queued', 'running'].includes(job?.status);
      const checking = item.type === 'playlist' && !item.protection;
      download.textContent = blocked || (checking ? 'Checking protection' : ['failed', 'cancelled'].includes(job?.status) ? 'Retry' : job?.status === 'complete' ? 'Download again' : 'Download');
      download.disabled = busy || !!blocked || checking;
      download.onclick = async () => {
        download.disabled = true;
        try {
          const selection = selectionFor(item);
          await request('download', { urls: [item.url], selections: selection ? { [item.url]: selection } : {} });
          await load();
        } catch (error) { status.textContent = error.message; download.disabled = false; }
      };
      const copy = document.createElement('button'); copy.className = 'ghost'; copy.textContent = 'Copy URL';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(item.url); copy.textContent = 'Copied ✓'; }
        catch { status.textContent = 'Could not copy. Try again.'; }
      };
      actions.append(download, copy);
      if (busy && job.status === 'running') {
        const pause = document.createElement('button'); pause.className = 'ghost'; pause.textContent = job.paused ? 'Resume' : 'Pause';
        pause.onclick = async () => { pause.disabled = true; try { await request('control', { id: job.id, action: job.paused ? 'resume' : 'pause' }); await load(); } catch (error) { status.textContent = error.message; } };
        actions.append(pause);
      }
      if (busy) {
        const stop = document.createElement('button'); stop.className = 'ghost'; stop.textContent = 'Cancel';
        stop.onclick = async () => { stop.disabled = true; try { await request('control', { id: job.id, action: 'cancel' }); await load(); } catch (error) { status.textContent = error.message; } };
        actions.append(stop);
      }
      row.append(actions, status);
      const explanation = explain(item, job);
      if (job) {
        status.textContent = busy ? progressText(job) : job.message;
        if (['failed', 'protected'].includes(job.status)) status.classList.add('err');
        if (job.status === 'complete') status.classList.add('ok');
      } else if (explanation) { status.textContent = explanation.text; if (explanation.err) status.classList.add('err'); }
      if (job && explanation?.err && !busy) status.textContent += ' · ' + explanation.text;
      if (busy) {
        const progress = document.createElement('progress'); progress.max = 1;
        if (job.progress > 0) progress.value = job.progress;
        progress.setAttribute('aria-label', job.phase === 'convert' ? 'Conversion progress' : 'Download progress'); row.append(progress);
      }
      list.append(row);
    }
  }
  async function checks() {
    for (const item of snapshot.items) {
      if (inspecting.size >= 3) break;
      if (item.type !== 'playlist' || item.protection || inspecting.has(item.url)) continue;
      inspecting.add(item.url);
      request('inspect', { url: item.url }).then(result => {
        const current = snapshot.items.find(entry => entry.url === item.url);
        if (current) current.protection = result;
        if (active) load();
      }).catch(error => {
        const current = snapshot.items.find(entry => entry.url === item.url);
        if (current) current.protection = { status: 'unknown', reason: error.message };
      }).finally(() => { inspecting.delete(item.url); if (active) checks(); });
    }
    // Size/availability probes for direct files (1-byte range request each, at most 3 at a time).
    for (const item of snapshot.items) {
      if (probing.size >= 3) break;
      if (item.type === 'playlist' || item.probe || item.mode === 'chunked' || probing.has(item.url) || (item.size && !item.signed)) continue;
      probing.add(item.url);
      request('probe', { url: item.url }).catch(() => {}).finally(() => { if (active) load(); setTimeout(() => probing.delete(item.url), 30000); });
    }
  }
  async function load(rescan = false) {
    if (loading) { rescanPending ||= rescan; return; }
    loading = true;
    let revision = generation;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active page tab is available.');
      if (tabId !== tab.id) { tabId = tab.id; revision = ++generation; rescan = true; }
      const result = await request(rescan ? 'refresh' : 'list');
      if (revision !== generation) return;
      snapshot = { ...result, pageHost: (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })() }; render(); checks();
    } catch (error) {
      summary.textContent = error.message;
      diagnostics.hidden = false; diagnostics.textContent = `${snapshot.debug?.networkHits || 0} network hits, ${snapshot.debug?.domHits || 0} DOM hits, tab id ${tabId ?? 'unknown'} · ${error.message}`;
      if (CFG.DEBUG) console.error('[Media Scanner]', error);
    } finally {
      loading = false;
      if (rescanPending) { rescanPending = false; load(true); }
    }
  }
  // Push updates from the service worker; polling remains as a fallback after worker restarts.
  function connect() {
    if (port || !chrome.runtime.connect) return;
    try {
      port = chrome.runtime.connect({ name: 'scanner' });
      port.onMessage.addListener(message => { if (active && message?.type === 'scanner.changed' && message.tabId === tabId) load(); });
      port.onDisconnect.addListener(() => { port = null; if (active) setTimeout(connect, 1000); });
    } catch { port = null; }
  }
  filters.forEach(button => { button.onclick = () => {
    filter = button.dataset.filter;
    filters.forEach(chip => chip.setAttribute('aria-pressed', String(chip === button)));
    render();
  }; });
  allButton.onclick = async () => {
    const targets = filtered().filter(item => !blocker(item));
    const selections = {};
    for (const item of targets) { const sel = selectionFor(item); if (sel) selections[item.url] = sel; }
    allButton.disabled = true;
    try { await request('download', { urls: targets.map(item => item.url), selections }); await load(); }
    catch (error) { summary.textContent = error.message; }
  };
  if (concurrency) {
    concurrency.onchange = async () => {
      try { await chrome.runtime.sendMessage({ cmd: 'scanner.settings', settings: { concurrency: Number(concurrency.value) } }); } catch {}
    };
  }
  async function loadSettings() {
    if (!concurrency) return;
    try { const reply = await chrome.runtime.sendMessage({ cmd: 'scanner.settings' }); if (reply?.ok) concurrency.value = String(reply.result.concurrency); } catch {}
  }
  function select(scanner) {
    active = scanner;
    panel.hidden = !scanner;
    document.querySelector('#video-panel').hidden = scanner;
    document.querySelector('#ytdlp').hidden = scanner || !CFG.enableYouTube;
    document.querySelector('#count').hidden = scanner;
    for (const [id, selected] of [['media-tab', scanner], ['video-tab', !scanner]]) {
      const button = document.querySelector('#' + id);
      button.setAttribute('aria-selected', String(selected)); button.classList.toggle('ghost', !selected);
    }
    if (scanner) { connect(); loadSettings(); load(true); }
    else window.dispatchEvent(new Event('scanner.videoRefresh'));
  }
  document.querySelector('#media-tab').onclick = () => select(true);
  document.querySelector('#video-tab').onclick = () => select(false);
  window.addEventListener('popup.youtube', () => { active = false; generation++; });
  const videoRefresh = document.querySelector('#refresh').onclick;
  const videoClear = document.querySelector('#clear').onclick;
  document.querySelector('#refresh').onclick = () => active ? load(true) : videoRefresh();
  document.querySelector('#clear').onclick = async () => {
    if (!active) return videoClear();
    generation++;
    try { await request('clear'); snapshot.items = []; snapshot.blobs = 0; snapshot.eme = null; render(); }
    catch (error) { summary.textContent = error.message; }
  };
  setInterval(() => { if (active && !document.hidden) load(); }, 1500);
})();
