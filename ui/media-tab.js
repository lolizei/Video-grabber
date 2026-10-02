(() => {
  const panel = document.querySelector('#media-panel');
  const list = document.querySelector('#media-list');
  const summary = document.querySelector('#media-summary');
  const empty = document.querySelector('#media-empty');
  const diagnostics = document.querySelector('#media-debug');
  const allButton = document.querySelector('#media-download-all');
  const note = document.querySelector('#media-note');
  const filters = [...panel.querySelectorAll('[data-filter]')];
  let active = false, tabId, filter = 'all', snapshot = { items: [], jobs: [] }, generation = 0;
  const inspecting = new Set();
  let loading = false, rescanPending = false;
  const sizes = n => n > 0 ? n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB' : 'Size unknown';
  async function request(cmd, data = {}) {
    const response = await chrome.runtime.sendMessage({ cmd: 'scanner.' + cmd, tabId, ...data });
    if (!response?.ok) throw new Error(response?.error || 'Scanner is unavailable. Reload the extension.');
    return response.result;
  }
  const filtered = () => snapshot.items.filter(item => filter === 'all' || item.type === filter);
  const currentJob = url => [...snapshot.jobs].reverse().find(job => job.item.url === url);
  function render() {
    const items = filtered();
    list.replaceChildren();
    summary.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}${filter !== 'all' ? ' · ' + filter : ''}`;
    empty.hidden = items.length > 0;
    const segmented = snapshot.blobs || snapshot.segments || /(^|\.)(youtube\.com|youtu\.be)$/.test(snapshot.pageHost || '');
    empty.textContent = snapshot.items.length ? 'No items match this filter.' : segmented ? 'This site streams in segments – use the Video Grabber tab' : 'No media detected. Play media or click Refresh to scan links on this page.';
    const info = snapshot.debug || {};
    diagnostics.textContent = `${info.networkHits || 0} network hits, ${info.domHits || 0} DOM hits, tab id ${tabId ?? 'unknown'}${info.scanError ? ' · ' + info.scanError : ''}`;
    diagnostics.hidden = items.length > 0;
    const messages = [];
    if (snapshot.blobs) messages.push('Blob player URLs cannot be downloaded directly. Associated HTTP media or playlists appear here when detected.');
    if (items.some(item => item.kind === 'dash')) messages.push('DASH downloads save the manifest only.');
    if (items.some(item => item.protection?.status === 'protected')) messages.push('Protected – not downloadable');
    note.hidden = !messages.length;
    note.textContent = messages.join(' ');
    allButton.disabled = !items.some(item => item.protection?.status !== 'protected' && !['queued', 'running'].includes(currentJob(item.url)?.status));
    for (const item of items) {
      const job = currentJob(item.url);
      const row = document.createElement('li');
      row.className = 'scanner-item';
      const title = document.createElement('div'); title.className = 'scanner-title';
      const icon = document.createElement('span'); icon.textContent = { audio: '♫', video: '▶', playlist: '☷' }[item.type]; icon.setAttribute('aria-label', item.type);
      const filename = document.createElement('strong'); filename.textContent = item.filename; filename.title = item.filename;
      title.append(icon, filename);
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = `${item.type === 'playlist' ? item.kind.toUpperCase() : item.type} · ${sizes(item.size)} · ${item.domain}`;
      meta.title = item.url;
      const actions = document.createElement('div'); actions.className = 'actions';
      const download = document.createElement('button');
      const protectedItem = item.protection?.status === 'protected' || job?.status === 'protected';
      const busy = ['queued', 'running'].includes(job?.status);
      const checking = item.type === 'playlist' && item.protection?.status !== 'clear';
      download.textContent = protectedItem ? 'Protected – not downloadable' : checking ? 'Checking protection' : job?.status === 'failed' ? 'Retry' : item.kind === 'dash' ? 'Download manifest' : 'Download';
      download.disabled = busy || protectedItem || checking;
      download.onclick = async () => {
        download.disabled = true;
        try { await request('download', { urls: [item.url] }); await load(); }
        catch (error) { status.textContent = error.message; download.disabled = false; }
      };
      const copy = document.createElement('button'); copy.className = 'ghost'; copy.textContent = 'Copy URL';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(item.url); copy.textContent = 'Copied ✓'; }
        catch { status.textContent = 'Could not copy. Try again.'; }
      };
      actions.append(download, copy);
      const status = document.createElement('div'); status.className = 'status'; status.setAttribute('aria-live', 'polite');
      if (job) { status.textContent = job.message; if (job.status === 'failed' || job.status === 'protected') status.classList.add('err'); }
      else if (protectedItem) { status.textContent = 'Protected · ' + (item.protection?.reason || 'DRM'); status.classList.add('err'); }
      else if (item.type === 'playlist') status.textContent = item.protection?.status === 'clear' ? 'No protection detected' : item.protection?.status === 'unknown' ? 'Protection check failed · ' + item.protection.reason : 'Checking protection…';
      row.append(title, meta, actions, status);
      if (busy) {
        const progress = document.createElement('progress'); progress.max = 1;
        if (job.progress > 0) progress.value = job.progress;
        progress.setAttribute('aria-label', 'Download progress'); row.append(progress);
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
        if (active) render();
      }).catch(error => {
        const current = snapshot.items.find(entry => entry.url === item.url);
        if (current) current.protection = { status: 'unknown', reason: error.message };
      }).finally(() => { inspecting.delete(item.url); if (active) checks(); });
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
  filters.forEach(button => { button.onclick = () => {
    filter = button.dataset.filter;
    filters.forEach(chip => chip.setAttribute('aria-pressed', String(chip === button)));
    render();
  }; });
  allButton.onclick = async () => {
    const urls = filtered().filter(item => item.protection?.status !== 'protected').map(item => item.url);
    allButton.disabled = true;
    try { await request('download', { urls }); await load(); }
    catch (error) { summary.textContent = error.message; }
  };
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
    if (scanner) load(true);
    else window.dispatchEvent(new Event('scanner.videoRefresh'));
  }
  document.querySelector('#media-tab').onclick = () => select(true);
  document.querySelector('#video-tab').onclick = () => select(false);
  window.addEventListener('popup.youtube',()=>{active=false;generation++;});
  const videoRefresh = document.querySelector('#refresh').onclick;
  const videoClear = document.querySelector('#clear').onclick;
  document.querySelector('#refresh').onclick = () => active ? load(true) : videoRefresh();
  document.querySelector('#clear').onclick = async () => {
    if (!active) return videoClear();
    generation++;
    try { await request('clear'); snapshot.items = []; snapshot.blobs = 0; render(); }
    catch (error) { summary.textContent = error.message; }
  };
  setInterval(() => { if (active && !document.hidden) load(); }, 1500);
})();
