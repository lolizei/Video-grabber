globalThis.PlaylistTools = (() => {
  const attr = (line, key) => {
    const match = line.match(new RegExp('(?:[:,]|^)' + key + '=("([^"]*)"|[^,]*)'));
    return match ? (match[2] ?? match[1]).trim() : null;
  };
  function protection(text) {
    if (/<(?:[\w.-]+:)?ContentProtection\b/i.test(text)) return 'DASH ContentProtection';
    for (const line of text.split(/\r?\n/).map(l => l.trim())) {
      if (!/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) continue;
      const method = attr(line, 'METHOD');
      const format = attr(line, 'KEYFORMAT') || 'identity';
      if (method === 'NONE') continue;
      return method + (format !== 'identity' ? ' · ' + format : '');
    }
    return null;
  }
  function children(text, base) {
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const urls = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        let next = i + 1;
        while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next++;
        if (lines[next]) urls.add(new URL(lines[next], base).href);
      } else if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(lines[i])) {
        const uri = attr(lines[i], 'URI');
        if (uri) urls.add(new URL(uri, base).href);
      }
    }
    return [...urls];
  }
  function iv(value, sequence) {
    const out = new Uint8Array(16);
    let number;
    if (value) {
      if (!/^0x[0-9a-f]{1,32}$/i.test(value)) throw new Error('Invalid AES-128 IV.');
      number = BigInt(value);
    } else number = BigInt(sequence);
    for (let i = 15; i >= 0; i--) { out[i] = Number(number & 255n); number >>= 8n; }
    return out;
  }
  function parseMedia(text, base) {
    const protectedBy = protection(text);
    if (protectedBy) throw new Error('Protected stream: ' + protectedBy);
    const segs = [];
    let init = null, key = null, nextRange = null, lastEnd = 0, lastUrl = '', sequence = 0n;
    const range = spec => {
      const [length, offset] = spec.split('@');
      const size = Number(length);
      const start = offset === undefined ? null : Number(offset);
      if (!Number.isSafeInteger(size) || size <= 0 || (start !== null && (!Number.isSafeInteger(start) || start < 0))) throw new Error('Invalid byte range.');
      return { size, start };
    };
    const encryption = isInit => {
      if (!key) return null;
      if (isInit && !key.iv) throw new Error('An encrypted initialization segment requires an explicit IV.');
      return { url: key.url, iv: iv(key.iv, sequence) };
    };
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const number = l.slice(l.indexOf(':') + 1);
        if (!/^\d+$/.test(number)) throw new Error('Invalid media sequence.');
        sequence = BigInt(number);
      } else if (l.startsWith('#EXT-X-KEY:')) {
        if (attr(l, 'METHOD') === 'NONE') key = null;
        else {
          const uri = attr(l, 'URI');
          if (!uri) throw new Error('AES-128 key URL is missing.');
          key = { url: new URL(uri, base).href, iv: attr(l, 'IV') };
        }
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const uri = attr(l, 'URI');
        if (!uri) throw new Error('Initialization segment URL is missing.');
        const r = attr(l, 'BYTERANGE') ? range(attr(l, 'BYTERANGE')) : null;
        const map = { url: new URL(uri, base).href, range: r ? [r.start ?? 0, (r.start ?? 0) + r.size - 1] : null, encryption: encryption(true) };
        if (init && (init.url !== map.url || JSON.stringify(init.range) !== JSON.stringify(map.range))) throw new Error('Streams with changing initialization segments are not supported.');
        init = map;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) nextRange = range(l.slice(l.indexOf(':') + 1));
      else if (!l.startsWith('#')) {
        const url = new URL(l, base).href;
        let byteRange = null;
        if (nextRange) {
          if (nextRange.start === null && lastUrl !== url) throw new Error('Implicit byte range has no previous segment for this URL.');
          const start = nextRange.start ?? lastEnd;
          byteRange = [start, start + nextRange.size - 1];
          lastEnd = byteRange[1] + 1;
        }
        segs.push({ url, range: byteRange, encryption: encryption(false) });
        lastUrl = url; sequence++; nextRange = null;
      }
    }
    return { segs, init, ended: text.includes('#EXT-X-ENDLIST') };
  }
  return { attr, protection, children, iv, parseMedia };
})();
