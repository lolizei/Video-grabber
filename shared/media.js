// Shared by the service worker, popup, and download page; no remote code.
globalThis.MediaTools = (() => {
  const audio = /\.(mp3|m4a|aac|ogg|wav|flac|opus)$/i;
  const video = /\.(mp4|webm|mkv|mov|m4v|flv|avi|ogv|3gp)$/i;
  const mimeExt = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
    'audio/opus': 'opus', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm' };
  const header = (headers, key) => headers?.find(h => h.name.toLowerCase() === key)?.value || '';
  function httpUrl(value) {
    try { const u = new URL(value); if (/^https?:$/.test(u.protocol)) { u.hash = ''; return u.href; } } catch {}
    return null;
  }
  function filename(value, fallback = 'media') {
    let name = String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
      .replace(/\.\.+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 180);
    if (!name) name = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  function classify(url, headers = []) {
    url = httpUrl(url);
    if (!url) return null;
    const u = new URL(url);
    const mime = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
    if (/^(text\/html|application\/(json|xhtml\+xml)|image\/)/.test(mime)) return null;
    // HLS pieces are represented by their playlist, not thousands of tiny files.
    if (/\.(ts|m4s|cmfv|cmfa|m4f)$/i.test(u.pathname) || mime === 'video/mp2t' || mime.includes('iso.segment')) return null;
    let kind;
    if (mime.includes('mpegurl') || /\.m3u8$/i.test(u.pathname)) kind = 'hls';
    else if (mime.includes('dash+xml') || /\.mpd$/i.test(u.pathname)) kind = 'dash';
    else if (mime.startsWith('audio/') || audio.test(u.pathname)) kind = 'audio';
    else if (mime.startsWith('video/') || video.test(u.pathname)) kind = 'video';
    else return null;
    let basename;
    try { basename = decodeURIComponent(u.pathname.split('/').pop()); } catch { basename = u.pathname.split('/').pop(); }
    const ext = kind === 'hls' ? 'm3u8' : kind === 'dash' ? 'mpd' : mimeExt[mime];
    if (ext && !/\.[a-z0-9]{2,5}$/i.test(basename || '')) basename = (basename || 'media') + '.' + ext;
    const range = header(headers, 'content-range').match(/\/(\d+)\s*$/);
    const size = range ? Number(range[1]) : Number(header(headers, 'content-length')) || 0;
    return { url, kind, type: ['hls', 'dash'].includes(kind) ? 'playlist' : kind,
      filename: filename(basename), mime, size: Math.max(0, size), domain: u.hostname };
  }
  return { classify, filename, httpUrl, header };
})();
