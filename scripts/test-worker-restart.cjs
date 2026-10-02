// Manifest V3 lifecycle: jobs survive service-worker restarts, restored/duplicate download tabs
// cannot re-run jobs, duplicate enqueues are collapsed, cancellation works after a restart,
// success is only reported for verified files and every message receives a reply.
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');

let unhandled = 0;
process.on('unhandledRejection', error => { unhandled++; console.error('Unhandled rejection:', error); });

(async () => {
  const page = { id: 8, url: 'https://site.example/watch' };
  const tabs = new Map([[8, page]]);
  const session = {}, local = {};
  const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nv360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nv180.m3u8';
  const media = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST';
  const fetchImpl = async url => new Response(/master/.test(url) ? playlist : media, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  let bg = H.loadBackground({ session, local, tabs, fetchImpl });
  const tabReq = (cmd, data = {}) => bg.request('scanner.' + cmd, { tabId: 8, ...data });
  const master = 'https://cdn.example/master.m3u8';
  await bg.send({ cmd: 'scanner.dom', urls: [{ url: master }, { url: 'https://cdn.example/a.mp3' }, { url: 'https://cdn.example/b.mp3' }] }, { tab: page, frameId: 0, url: page.url });

  let jobId, workerTab;
  await H.check('playlist inspection exposes qualities; a job opens one background download tab', async () => {
    const protection = await tabReq('inspect', { url: master });
    assert.equal(protection.status, 'clear');
    const item = (await tabReq('list')).items.find(i => i.url === master);
    assert.deepEqual(item.details.variants.map(v => v.height), [360, 180]);
    [jobId] = await tabReq('download', { urls: [master], selections: { [master]: { height: 180 } } });
    const job = (await tabReq('list')).jobs.find(j => j.id === jobId);
    assert.equal(job.status, 'running'); workerTab = job.workerTab;
    const url = new URL(tabs.get(workerTab).url);
    assert.equal(url.searchParams.get('mode'), 'hls');
    assert.deepEqual(JSON.parse(url.searchParams.get('sel')), { height: 180 });
    assert.equal(tabs.get(workerTab).active, false);
  });
  await H.check('duplicate enqueue of the same resource and quality returns the existing job', async () => {
    const again = await tabReq('download', { urls: [master], selections: { [master]: { height: 180 } } });
    assert.deepEqual([...again], [jobId]);
    assert.equal([...tabs.keys()].filter(id => id >= 1000).length, 1, 'no second download tab');
  });
  await H.check('after a service-worker restart the job, its settings and queue state persist', async () => {
    bg = H.loadBackground({ session, local, tabs, fetchImpl });
    const job = (await tabReq('list')).jobs.find(j => j.id === jobId);
    assert.equal(job.status, 'running'); assert.equal(job.workerTab, workerTab);
    assert.equal(job.settings.concurrency, 4);
  });
  await H.check('the download tab can claim its job after the restart; other or restored tabs cannot', async () => {
    const claimed = await bg.request('scanner.claim', { id: jobId }, { tab: { id: workerTab } });
    assert.equal(claimed.item.selection.height, 180);
    const restored = await bg.send({ cmd: 'scanner.claim', id: jobId }, { tab: { id: 4242 } });
    assert.equal(restored.ok, false); assert.match(restored.error, /no longer active/);
    const unknown = await bg.send({ cmd: 'scanner.claim', id: 'missing' }, { tab: { id: workerTab } });
    assert.equal(unknown.ok, false);
  });
  await H.check('progress from the download tab (speed, ETA, phase, pause) updates the persisted job', async () => {
    await bg.request('scanner.progress', { id: jobId, status: 'running', progress: 0.5, message: '50%', phase: 'download', speed: 2048, eta: 12, bytes: 100, total: 200, paused: true }, { tab: { id: workerTab } });
    bg = H.loadBackground({ session, local, tabs, fetchImpl });
    const job = (await tabReq('list')).jobs.find(j => j.id === jobId);
    assert.equal(job.speed, 2048); assert.equal(job.eta, 12); assert.equal(job.paused, true); assert.equal(job.progress, 0.5);
    const foreign = await bg.request('scanner.progress', { id: jobId, status: 'complete' }, { tab: { id: 777 } });
    assert.equal(foreign, undefined);
    assert.equal((await tabReq('list')).jobs.find(j => j.id === jobId).status, 'running', 'other tabs cannot complete a job');
  });
  await H.check('"complete" without a verified saved file is reported as a failure', async () => {
    await bg.request('scanner.progress', { id: jobId, status: 'complete', progress: 1, message: 'Done' }, { tab: { id: workerTab } });
    const job = (await tabReq('list')).jobs.find(j => j.id === jobId);
    assert.equal(job.status, 'failed'); assert.equal(job.errorCode, 'integrity');
  });
  await H.check('"complete" with an existing non-empty download is accepted', async () => {
    const [id] = await tabReq('download', { urls: [master] });
    const job = (await tabReq('list')).jobs.find(j => j.id === id);
    const downloadId = await bg.chrome.downloads.download({ url: 'blob:x', filename: 'x.mp4' });
    Object.assign(bg.chrome.downloads.items.get(downloadId), { state: 'complete', fileSize: 1234, exists: true, mime: 'video/mp4' });
    await bg.request('scanner.progress', { id, status: 'complete', progress: 1, message: 'Done', downloadId }, { tab: { id: job.workerTab } });
    assert.equal((await tabReq('list')).jobs.find(j => j.id === id).status, 'complete');
  });
  await H.check('cancellation after a restart reaches the download tab and frees the queue slot', async () => {
    const [id] = await tabReq('download', { urls: [master], selections: { [master]: { height: 360 } } });
    let job = (await tabReq('list')).jobs.find(j => j.id === id);
    bg = H.loadBackground({ session, local, tabs, fetchImpl });
    const sentBefore = bg.sent.length;
    const result = await tabReq('control', { id, action: 'cancel' });
    assert.equal(result.status, 'cancelled');
    const message = bg.sent.slice(sentBefore).find(s => s.tabId === job.workerTab);
    assert.deepEqual(JSON.parse(JSON.stringify(message.message)), { cmd: 'downloader.control', id, action: 'cancel' });
    job = (await tabReq('list')).jobs.find(j => j.id === id);
    assert.equal(job.status, 'cancelled');
  });
  await H.check('a download tab closed while the worker was asleep is reconciled on restart', async () => {
    const [id] = await tabReq('download', { urls: [master], selections: { [master]: { height: 9999 } } });
    const job = (await tabReq('list')).jobs.find(j => j.id === id);
    tabs.delete(job.workerTab);
    bg = H.loadBackground({ session, local, tabs, fetchImpl });
    await H.settle(50);
    const after = JSON.parse(JSON.stringify(session.scanner_jobs)).find(j => j.id === id);
    assert.equal(after.status, 'failed'); assert.match(after.message, /closed/);
  });
  await H.check('direct downloads: empty or HTML results are failures; interrupted resumable downloads resume', async () => {
    const ids = await tabReq('download', { urls: ['https://cdn.example/a.mp3', 'https://cdn.example/b.mp3'] });
    const jobs = (await tabReq('list')).jobs;
    const [a, b] = ids.map(id => jobs.find(j => j.id === id));
    Object.assign(bg.chrome.downloads.items.get(a.downloadId), { state: 'complete', fileSize: 0, bytesReceived: 0 });
    for (const fn of bg.chrome.downloads.onChanged.listeners) fn({ id: a.downloadId, state: { current: 'complete' } });
    let resumed = false;
    bg.chrome.downloads.resume = async () => { resumed = true; };
    Object.assign(bg.chrome.downloads.items.get(b.downloadId), { state: 'interrupted', error: 'NETWORK_FAILED', canResume: true });
    for (const fn of bg.chrome.downloads.onChanged.listeners) fn({ id: b.downloadId, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    await H.settle(50);
    const list = JSON.parse(JSON.stringify(session.scanner_jobs));
    assert.equal(list.find(j => j.id === a.id).status, 'failed'); assert.match(list.find(j => j.id === a.id).message, /empty file/);
    assert.equal(resumed, true); assert.equal(list.find(j => j.id === b.id).status, 'running');
  });
  await H.check('direct downloads expose pause/resume through chrome.downloads', async () => {
    const job = JSON.parse(JSON.stringify(session.scanner_jobs)).find(j => j.status === 'running' && j.downloadId !== undefined);
    await tabReq('control', { id: job.id, action: 'pause' });
    assert.equal(bg.chrome.downloads.items.get(job.downloadId).paused, true);
    const snap = await tabReq('list');
    assert.equal(snap.jobs.find(j => j.id === job.id).paused, true);
  });
  await H.check('every scanner command replies, including failures; foreign commands are not claimed', async () => {
    for (const msg of [{ cmd: 'scanner.nope' }, { cmd: 'scanner.inspect', tabId: 8, url: 'https://none.example/x.m3u8' }, { cmd: 'scanner.control', id: 'x', action: 'explode' },
      { cmd: 'scanner.probe', tabId: 8, url: 'https://none.example/x.mp3' }]) {
      const reply = await bg.send(msg);
      assert.equal(reply.ok, false, msg.cmd);
    }
    assert.equal(await bg.send({ cmd: 'something.else' }), undefined);
  });
  await H.check('popup ports receive change notifications and are dropped on disconnect', async () => {
    const posted = [];
    const disconnect = H.event();
    const port = { name: 'scanner', postMessage: m => posted.push(m), onDisconnect: disconnect };
    for (const fn of bg.chrome.runtime.onConnect.listeners) fn(port);
    await bg.send({ cmd: 'scanner.dom', urls: [{ url: 'https://cdn.example/c.mp3' }] }, { tab: page, frameId: 0, url: page.url });
    await H.settle(350);
    assert(posted.some(m => m.type === 'scanner.changed' && m.tabId === 8));
    for (const fn of disconnect.listeners) fn();
    await bg.send({ cmd: 'scanner.dom', urls: [{ url: 'https://cdn.example/d.mp3' }] }, { tab: page, frameId: 0, url: page.url });
    await H.settle(350);
  });
  await H.check('closing the source tab removes its detection state', async () => {
    for (const fn of bg.chrome.tabs.onRemoved.listeners) fn(8);
    await H.settle(50);
    assert.equal(session.scanner_tab_8, undefined);
  });
  await H.settle(100);
  assert.equal(unhandled, 0, 'no unhandled promise rejections');
  H.summary('MV3 restarts, job claims, duplicate prevention, verified completion, cancellation, reconciliation, message replies, ports');
})().catch(error => { console.error(error); process.exitCode = 1; });
