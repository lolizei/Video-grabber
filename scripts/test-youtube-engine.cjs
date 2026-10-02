// YouTube engine repair: itag/mime classification for new formats, multi-language audio,
// player-metadata sources, playback-configuration diagnostics (UMP/SABR, cipher, DRM, login,
// live HLS) and "never report success without a valid output".
const assert = require('node:assert/strict');
const H = require('./lib/harness.cjs');
const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

(async () => {
  const tab = { id: 5, url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Video - YouTube' };
  const tabs = new Map([[5, tab]]);
  let page = {};
  const bg = H.loadBackground({ tabs });
  bg.chrome.scripting.executeScript = async options => {
    if (options.world === 'MAIN') {
      const world = H.vm.createContext({ URL, location: { href: tab.url, pathname: new URL(tab.url).pathname },
        window: { ytInitialPlayerResponse: page.initial, ytplayer: page.ytplayer }, document: { getElementById: id => page.players?.[id] || null, querySelector: () => null } });
      return [{ result: H.vm.runInContext('(' + options.func.toString() + ')()', world) }];
    }
    return [{ frameId: 0, result: { urls: page.resources || [], blobs: 0, players: 1 } }];
  };
  const classify = details => bg.context.classify({ method: 'GET', responseHeaders: [], ...details });
  const gv = (itag, extra = '') => `https://rr1.googlevideo.com/videoplayback?itag=${itag}&expire=${Math.floor(Date.now() / 1000) + 3600}&clen=10${extra}`;
  const tracks = async () => (await bg.request('youtube.tracks', { tabId: 5 }));
  const reset = () => bg.context.clearTab(5);

  await H.check('unknown/new itags classify by the mime parameter (audio is never mistaken for video)', () => {
    const a599 = classify({ url: gv(599, '&mime=audio%2Fmp4') });
    assert.equal(a599.track, 'a'); assert.equal(a599.quality, '30k');
    const unknownAudio = classify({ url: gv(9001, '&mime=audio%2Fwebm') });
    assert.equal(unknownAudio.track, 'a');
    const unknownVideo = classify({ url: gv(9002, '&mime=video%2Fmp4'), quality: '1080p50' });
    assert.equal(unknownVideo.track, 'v'); assert.equal(unknownVideo.quality, '1080p50');
    assert.equal(classify({ url: gv(774, '&mime=audio%2Fwebm') }).track, 'a');
    assert.equal(classify({ url: gv(399, '&mime=video%2Fmp4&range=0-100') }).url.includes('range='), false);
  });
  await H.check('multi-language and DRC audio renditions stay distinct; original non-DRC audio is preferred', () => {
    const en = classify({ url: gv(140, '&mime=audio%2Fmp4&xtags=acont%3Doriginal%3Alang%3Den') });
    const de = classify({ url: gv(140, '&mime=audio%2Fmp4&xtags=acont%3Ddubbed%3Alang%3Dde') });
    const drc = classify({ url: gv(140, '&mime=audio%2Fmp4&xtags=acont%3Doriginal%3Adrc%3D1%3Alang%3Den') });
    assert.notEqual(en.key, de.key); assert.notEqual(en.key, drc.key);
    assert.equal(de.audioTrack, 'de'); assert.equal(en.original, true); assert.equal(drc.drc, true);
    const video = classify({ url: gv(137, '&mime=video%2Fmp4') });
    const pick = bg.context.YouTubeTools.chooseTracks([video, de, drc, en], 'mp4', '1080p');
    assert.equal(pick.audio.key, en.key);
    assert.equal(bg.context.YouTubeTools.chooseTracks([de, en], 'mp3').audio.key, en.key);
  });
  await H.check('expired track URLs are skipped and reported', () => {
    const old = classify({ url: gv(140, '&mime=audio%2Fmp4').replace(/expire=\d+/, 'expire=1000') });
    assert.throws(() => bg.context.YouTubeTools.chooseTracks([old], 'mp3'), /expired/);
  });
  const response = (streamingData, extra = {}) => ({ videoDetails: { videoId: 'abcdefghijk', ...extra.details }, playabilityStatus: { status: 'OK', ...extra.play }, streamingData });
  await H.check('player metadata: the current player wins over a stale initial response from a previous video', async () => {
    await reset();
    page = { initial: { videoDetails: { videoId: 'PREVIOUS000' }, streamingData: { adaptiveFormats: [{ url: gv(18, '&mime=video%2Fmp4'), mimeType: 'video/mp4' }] } },
      players: { movie_player: { getPlayerResponse: () => response({ adaptiveFormats: [
        { url: gv(137, '&mime=video%2Fmp4'), mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p', contentLength: '10', width: 1920, height: 1080 },
        { url: gv(140, '&mime=audio%2Fmp4&xtags=acont%3Doriginal%3Alang%3Den'), mimeType: 'audio/mp4', contentLength: '10', audioTrack: { displayName: 'English original', audioIsDefault: true } }] }) } } };
    const result = await tracks();
    assert.equal(result.items.length, 2); assert.equal(result.debug.metadataSource, 'movie_player'); assert.equal(result.debug.config, 'direct');
    const audio = result.items.find(i => i.track === 'a');
    assert.equal(audio.audioTrack, 'English original'); assert.equal(audio.original, true);
    assert.equal(result.items.find(i => i.track === 'v').codecs, 'avc1.640028');
  });
  await H.check('Shorts/embed URLs resolve the video id', async () => {
    await reset();
    tab.url = 'https://www.youtube.com/shorts/abcdefghijk';
    page = { players: { 'shorts-player': { getPlayerResponse: () => response({ formats: [{ url: gv(18, '&mime=video%2Fmp4'), mimeType: 'video/mp4', qualityLabel: '360p' }] }) } } };
    const result = await tracks();
    assert.equal(result.items.length, 1); assert.equal(result.debug.metadataSource, 'shorts-player');
    tab.url = 'https://www.youtube.com/watch?v=abcdefghijk';
  });
  const diagnosis = [
    ['UMP/SABR server-driven playback', response({ serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback?sabr=1', adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4' }] }), 'sabr', /UMP\/SABR/],
    ['signature-ciphered formats', response({ adaptiveFormats: [{ signatureCipher: 's=x&url=y' }, { signatureCipher: 's=z&url=w' }] }), 'ciphered', /signature/],
    ['DRM-licensed video', response({ licenseInfos: [{}], adaptiveFormats: [{ url: gv(137), drmFamilies: ['WIDEVINE'] }] }), 'drm', /DRM-protected/],
    ['sign-in/age restricted video', response({}, { play: { status: 'LOGIN_REQUIRED', reason: { simpleText: 'Sign in to confirm your age' } } }), 'login-required', /does not bypass/],
    ['unplayable video', response({}, { play: { status: 'UNPLAYABLE', reason: 'Video unavailable' } }), 'unplayable', /Video unavailable/],
    ['upcoming premiere', response({}, { details: { isUpcoming: true } }), 'upcoming', /upcoming/]];
  for (const [label, data, config, pattern] of diagnosis) {
    await H.check(`diagnostics: ${label} → "${config}" with an explanation and no tracks`, async () => {
      await reset();
      page = { players: { movie_player: { getPlayerResponse: () => data } } };
      const result = await tracks();
      assert.equal(result.items.length, 0); assert.equal(result.debug.config, config); assert.match(result.debug.configMessage, pattern);
    });
  }
  await H.check('live streams hand their HLS manifest to the Media Scanner', async () => {
    await reset();
    page = { players: { movie_player: { getPlayerResponse: () => response({ hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/x/file/index.m3u8', serverAbrStreamingUrl: 'x' }, { details: { isLive: true } }) } } };
    const result = await tracks();
    assert.equal(result.debug.config, 'live-hls'); assert.equal(result.debug.hlsManifest, true);
    const snap = await bg.request('scanner.list', { tabId: 5 });
    assert(snap.items.some(i => i.kind === 'hls' && i.domain === 'manifest.googlevideo.com'));
  });
  await H.check('network UMP/SABR (POST) responses are diagnosed, never classified as tracks', async () => {
    await reset();
    page = { players: {} };
    bg.fire('onHeadersReceived', { tabId: 5, url: gv(137, '&ump=1&mime=video%2Fmp4'), method: 'POST', statusCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/vnd.yt-ump' }] });
    await H.settle(50);
    const result = await tracks();
    assert.equal(result.items.length, 0); assert.equal(result.debug.config, 'sabr'); assert.equal(result.debug.unsupportedHits, 1);
  });

  // youtube/download.js: invalid conversion output must never be saved or reported as complete.
  await H.check('conversion output that is not a valid MP4 fails instead of being saved', async () => {
    const nodes = Object.fromEntries(['status', 'bar', 'progress', 'cancel', 'name', 'log', 'stages', 'diagnostics', 'copy'].map(id => ['#' + id, { style: {}, textContent: '', replaceChildren() {} }]));
    const reports = [], saved = [];
    const job = { id: 'y', status: 'running', title: 'T', output: 'mp4', bitrate: 192, tracks: { video: { url: gv(137, '&mime=video%2Fmp4'), size: 4, mime: 'video/mp4' }, audio: { url: gv(140, '&mime=audio%2Fmp4'), size: 4, mime: 'audio/mp4' } } };
    const ctx = H.vm.createContext({ console, URL: class extends URL { static createObjectURL() { return 'blob:x'; } static revokeObjectURL() {} }, URLSearchParams, Blob, Response, DOMException, AbortController, AbortSignal,
      setTimeout, clearTimeout, Uint8Array, Date, TextDecoder, TextEncoder, location: { search: '?job=y' }, VG_CONFIG: { ENABLE_YOUTUBE: true },
      document: { querySelector: s => nodes[s], createElement: () => ({}) },
      chrome: { runtime: { onMessage: H.event(), async sendMessage(m) { reports.push(m); } }, storage: { session: { async get() { return { youtube_job: job }; } } },
        downloads: { async download(o) { saved.push(o); return 1; }, async cancel() {}, onChanged: H.event(), async search() { return [{ state: 'complete' }]; } } },
      async fetch() { return new Response(new Uint8Array([1, 2, 3, 4])); },
      Worker: class { postMessage() { queueMicrotask(() => this.onmessage({ data: { type: 'done', data: new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]).buffer } })); } terminate() {} } });
    for (const f of ['shared/media.js', 'shared/cdn.js', 'shared/drm.js', 'shared/mp4.js', 'shared/download-engine.js', 'shared/youtube.js', 'youtube/download.js']) H.vm.runInContext(H.read(f), ctx);
    for (let i = 0; i < 50 && !/Failed|Done/.test(nodes['#status'].textContent); i++) await H.settle(10);
    assert.equal(saved.length, 0);
    assert.match(nodes['#status'].textContent, /Failed at "Saving completed file": Converted output is invalid/);
    assert.equal(reports.at(-1).status, 'failed');
  });
  await H.check('conversion plan copies H.264/VP9/AV1 video and AAC audio; Opus is encoded to AAC', () => {
    const plan = tracks => bg.context.YouTubeTools.conversionPlan({ tracks }).description;
    assert.equal(plan({ video: { mime: 'video/webm', codecs: 'vp9' }, audio: { mime: 'audio/webm', codecs: 'opus' } }), 'copy video · encode AAC audio');
    assert.equal(plan({ video: { mime: 'video/mp4', codecs: 'av01.0.08M.08' }, audio: { mime: 'audio/mp4', codecs: 'mp4a.40.2' } }), 'copy video · copy AAC audio');
    assert.equal(plan({ video: { mime: 'video/3gpp' }, audio: { mime: 'audio/mp4' } }), 'encode H.264 · copy AAC audio');
    const args = bg.context.YouTubeTools.args({ output: 'mp4', tracks: { video: { mime: 'video/webm' }, audio: { mime: 'audio/webm' } } });
    assert(args.join(' ').includes('-c:v copy') && !args.includes('libx264'));
  });
  await H.check('MP3 frame verification reads the real bitrate (after ID3 tags)', () => {
    const frame = rateIndex => [0xff, 0xfb, rateIndex << 4, 0x64];
    assert.equal(bg.context.YouTubeTools.mp3Info(Uint8Array.from([...frame(9), 0, 0])).bitrate, 128);
    const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)];
    assert.equal(bg.context.YouTubeTools.mp3Info(Uint8Array.from([...id3, ...frame(14)])).bitrate, 320);
    assert.equal(bg.context.YouTubeTools.mp3Info(Uint8Array.from([0, 1, 2, 3])).ok, false);
  });
  await H.check('diagnostic URLs keep only itag/mime/clen: no signatures, tokens or IPs', () => {
    const redacted = bg.context.MediaTools.redactUrl('https://rr1---sn-x.googlevideo.com/videoplayback?expire=1&ei=abc&ip=1.2.3.4&itag=140&mime=audio%2Fmp4&clen=99&sig=SECRET&lsig=L&pot=TOKEN&n=NN');
    assert.match(redacted, /itag=140/); assert.match(redacted, /clen=99/);
    assert(!/SECRET|TOKEN|1\.2\.3\.4|ei=|n=NN|expire/.test(redacted), redacted);
  });
  await H.check('formats listed without any URL are explained as UMP/SABR-only', async () => {
    await reset();
    page = { players: { movie_player: { getPlayerResponse: () => response({ adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4' }, { itag: 140, mimeType: 'audio/mp4' }] }) } } };
    const result = await tracks();
    assert.equal(result.items.length, 0); assert.equal(result.debug.config, 'sabr'); assert.equal(result.debug.urlLess, 2);
    assert.match(result.debug.configMessage, /without any download URL|UMP\/SABR/);
  });
  await H.check('background refuses "complete" when the saved file is missing or empty', async () => {
    const job = { id: 'j1', status: 'running', workerTab: 77, title: 'T', output: 'mp3' };
    await bg.chrome.storage.session.set({ youtube_job: job });
    const downloadId = await bg.chrome.downloads.download({ url: 'blob:x', filename: 'x.mp3' });
    Object.assign(bg.chrome.downloads.items.get(downloadId), { state: 'complete', fileSize: 0, bytesReceived: 0, exists: true });
    await bg.request('youtube.progress', { id: 'j1', status: 'complete', progress: 1, message: 'Done', downloadId }, { tab: { id: 77 } });
    const stored = (await bg.chrome.storage.session.get('youtube_job')).youtube_job;
    assert.equal(stored.status, 'failed'); assert.match(stored.message, /empty/);
  });
  H.summary('YouTube itag/mime classification, audio-track selection, metadata sources, configuration diagnostics, live HLS hand-off, output validation');
})().catch(error => { console.error(error); process.exitCode = 1; });
