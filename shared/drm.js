// DRM / encryption *detection only*. Nothing here requests licenses, keys or CDM access.
globalThis.DrmTools = (() => {
  const SYSTEMS = {
    'edef8ba979d64acea3c827dcd51d21ed': 'Widevine',
    '9a04f07998404286ab92e65be0885f95': 'PlayReady',
    '79f0049a40188e4fa2d47eac0f1c18f2': 'PlayReady (legacy)',
    '94ce86fb07ff4f43adb893d2fa968ca2': 'FairPlay',
    'e2719d58a985b3c9781ab030af78d30e': 'ClearKey',
    '1077efecc0b24d02ace33c1e52e2fb4b': 'Common PSSH (W3C ClearKey)',
    '3ea8778f77424bf9b18be834b2acbd47': 'ClearKey (DASH-IF)',
    '5e629af538da4063897797ffbd9902d4': 'Marlin',
    '9a27dd82fde247258cbc4234aa06ec09': 'Verimatrix',
    '80a6be7e14484c379e70d5aebe04c8d2': 'Irdeto',
    '644fe7b5260f4fad949a0762ffb054b4': 'CMLA/OMA',
    'f239e769efa348509c16a903c6932efb': 'Adobe Primetime'
  };
  const KEY_SYSTEMS = { 'com.widevine.alpha': 'Widevine', 'com.microsoft.playready': 'PlayReady',
    'com.microsoft.playready.recommendation': 'PlayReady', 'com.youtube.playready': 'PlayReady',
    'com.apple.fps': 'FairPlay', 'com.apple.fps.1_0': 'FairPlay', 'com.apple.fps.2_0': 'FairPlay', 'com.apple.fps.3_0': 'FairPlay',
    'com.apple.streamingkeydelivery': 'FairPlay', 'org.w3.clearkey': 'ClearKey', 'identity': 'AES-128 (clear key)' };
  const uuid = value => String(value || '').toLowerCase().replace(/^urn:uuid:/, '').replace(/[^0-9a-f]/g, '');
  const systemName = id => SYSTEMS[uuid(id)] || KEY_SYSTEMS[String(id || '').toLowerCase()] || '';
  const attr = (line, key) => {
    const match = line.match(new RegExp('(?:[:,]|^)' + key + '=("([^"]*)"|[^,]*)'));
    return match ? (match[2] ?? match[1]).trim() : null;
  };
  // HLS #EXT-X-KEY / #EXT-X-SESSION-KEY analysis.
  function hls(text) {
    const found = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) continue;
      const method = attr(line, 'METHOD') || '';
      if (method === 'NONE') continue;
      const keyformat = attr(line, 'KEYFORMAT') || 'identity';
      const uri = attr(line, 'URI') || '';
      let system = KEY_SYSTEMS[keyformat.toLowerCase()] || systemName(keyformat);
      if (!system && /^skd:/i.test(uri)) system = 'FairPlay';
      if (!system && /^data:.*widevine|edef8ba9/i.test(uri)) system = 'Widevine';
      if (!system && keyformat === 'identity') system = method === 'AES-128' ? 'AES-128 (clear key)' : 'Sample encryption';
      found.push({ method, keyformat, system: system || keyformat });
    }
    if (!found.length) return null;
    const systems = [...new Set(found.map(f => f.system))];
    const drm = systems.some(s => /Widevine|PlayReady|FairPlay/.test(s));
    return { encrypted: true, drm, scheme: 'hls', methods: [...new Set(found.map(f => f.method))], systems,
      summary: (drm ? 'DRM: ' : 'Encrypted HLS: ') + [...new Set(found.map(f => f.method))].join('/') + ' · ' + systems.join(', ') };
  }
  // DASH ContentProtection analysis, from raw text (no XML parsing required).
  function dash(text) {
    const tags = String(text).match(/<(?:[\w.-]+:)?ContentProtection\b[^>]*>/gi) || [];
    if (!tags.length) return null;
    const systems = new Set();
    for (const tag of tags) {
      const scheme = tag.match(/schemeIdUri\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const value = tag.match(/\bvalue\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      if (/mp4protection:2011/i.test(scheme)) systems.add('CENC' + (value ? ' (' + value + ')' : ''));
      else systems.add(systemName(scheme) || scheme || 'unknown');
    }
    const list = [...systems];
    const drm = list.some(s => /Widevine|PlayReady|FairPlay|Marlin|Verimatrix|Irdeto|Primetime|CMLA/.test(s));
    return { encrypted: true, drm: drm || list.some(s => s.startsWith('CENC')), scheme: 'dash', systems: list,
      summary: 'DASH ContentProtection · ' + list.join(', ') };
  }
  // pssh boxes inside EME initData or MP4 init segments.
  function psshSystems(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    const out = new Set();
    for (let i = 0; i + 32 <= data.length; i++) {
      if (data[i + 4] !== 0x70 || data[i + 5] !== 0x73 || data[i + 6] !== 0x73 || data[i + 7] !== 0x68) continue; // 'pssh'
      const id = [...data.subarray(i + 12, i + 28)].map(b => b.toString(16).padStart(2, '0')).join('');
      out.add(SYSTEMS[id] || 'unknown system ' + id);
    }
    return [...out];
  }
  function combine(...results) {
    const list = results.filter(Boolean);
    if (!list.length) return null;
    return { encrypted: true, drm: list.some(r => r.drm), systems: [...new Set(list.flatMap(r => r.systems || []))],
      summary: list.map(r => r.summary).join(' · ') };
  }
  // Short label shown in the popup.
  function label(info) {
    if (!info) return '';
    const named = info.systems.filter(s => !/^CENC/.test(s));
    const shown = named.length ? named : info.systems;
    return (info.drm ? 'DRM-protected' : 'Encrypted') + (shown.length ? ' (' + shown.join(', ') + ')' : '');
  }
  return { SYSTEMS, KEY_SYSTEMS, systemName, hls, dash, psshSystems, combine, label };
})();
