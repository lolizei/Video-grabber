// CDN identification, signed/expiring URL analysis, deduplication keys and HTTP failure
// classification. Pure functions shared by the service worker, pages and tests.
globalThis.CdnTools = (() => {
  const HOSTS = [
    [/(^|\.)cloudfront\.net$/, 'Amazon CloudFront'], [/(^|\.)amazonaws\.com$/, 'Amazon S3'],
    [/(^|\.)(akamaized|akamaihd|akamai|akamaitechnologies|edgesuite|edgekey)\.net$/, 'Akamai'],
    [/(^|\.)(fastly\.net|fastlylb\.net|freetls\.fastly\.net)$/, 'Fastly'],
    [/(^|\.)googlevideo\.com$/, 'Google Video'], [/(^|\.)(fbcdn\.net|cdninstagram\.com)$/, 'Meta CDN'],
    [/(^|\.)(b-cdn\.net|bunnycdn\.com|mediadelivery\.net)$/, 'Bunny CDN'], [/(^|\.)(llnwd\.net|llnw\.net|lldns\.net)$/, 'Limelight/Edgio'],
    [/(^|\.)(edgecastcdn\.net|systemcdn\.net)$/, 'Edgio'], [/(^|\.)azureedge\.net$/, 'Azure CDN'],
    [/(^|\.)(streaming\.media\.azure\.net)$/, 'Azure Media Services'], [/(^|\.)stream\.mux\.com$/, 'Mux'],
    [/(^|\.)(vimeocdn\.com)$/, 'Vimeo CDN'], [/(^|\.)(brightcove\.(com|net)|boltdns\.net)$/, 'Brightcove'],
    [/(^|\.)(kaltura\.com|kaltura\.org)$/, 'Kaltura'], [/(^|\.)(jwpcdn\.com|jwplatform\.com|jwpsrv\.com)$/, 'JW Player'],
    [/(^|\.)(cloudflarestream\.com|videodelivery\.net)$/, 'Cloudflare Stream'], [/(^|\.)r2\.dev$/, 'Cloudflare R2'],
    [/(^|\.)(gcore\.com|gcdn\.co)$/, 'Gcore'], [/(^|\.)(cdn77\.org|cdn77\.com)$/, 'CDN77'], [/(^|\.)(twimg\.com)$/, 'Twitter/X CDN'],
    [/(^|\.)storage\.googleapis\.com$/, 'Google Cloud Storage']
  ];
  const lower = headers => Object.fromEntries((headers || []).map(h => [String(h.name).toLowerCase(), String(h.value ?? '')]));
  function identify(url, headers = []) {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const h = lower(headers);
    let provider = HOSTS.find(([re]) => re.test(host))?.[1] || '';
    if (!provider) {
      if (h['x-amz-cf-id'] || /cloudfront/i.test(h.via || '')) provider = 'Amazon CloudFront';
      else if (h['cf-ray']) provider = 'Cloudflare';
      else if (h['x-served-by'] && /cache-/.test(h['x-served-by']) || h['x-fastly-request-id']) provider = 'Fastly';
      else if (/akamai/i.test(h.server || '') || h['akamai-grn'] || h['x-akamai-transformed']) provider = 'Akamai';
      else if (h['x-bunnycdn-request-id'] || /bunnycdn/i.test(h.server || '')) provider = 'Bunny CDN';
      else if (/ECAcc|ECS/.test(h.server || '')) provider = 'Edgio';
      else if (h['x-cache'] || h['x-cdn']) provider = h['x-cdn'] || 'CDN';
    }
    return { host, provider };
  }

  // Parameters that carry a signature/expiry. Generic names like "token" are deliberately
  // excluded so unrelated query strings keep separate rows.
  const SIGNATURE_PARAMS = new Set(['signature', 'x-amz-signature', 'x-amz-credential', 'x-amz-date', 'x-amz-expires',
    'x-amz-security-token', 'x-amz-signedheaders', 'x-amz-algorithm', 'key-pair-id', 'policy', 'expires', 'hdnts', 'hdnea',
    '__token__', 'sig', 'expire', 'x-goog-signature', 'x-goog-expires', 'x-goog-date', 'x-goog-credential', 'x-goog-algorithm',
    'x-goog-signedheaders', 'googleaccessid', 'se', 'sp', 'sv', 'sr', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'st', 'md5', 'e',
    'oh', 'oe', '_nc_sid', '_nc_ohc', '_nc_ht', 'efg', 'lmt', 'ei', 'ip', 'ipbits', 'initcwndbps', 'mh', 'mm', 'mn', 'ms', 'mv', 'mvi',
    'pl', 'lsparams', 'lsig', 'sparams', 'requiressl', 'vprv', 'xpc', 'txp', 'c', 'n', 'rqh', 'pcm2', 'bui', 'spc', 'vprv', 'svpuc',
    'wowzatokenendtime', 'wowzatokenstarttime', 'wowzatokenhash', 'hmac', 'auth_key', 'exp', 'validto', 'validfrom']);
  // Range/session params that never identify a different resource.
  const TRANSIENT_PARAMS = new Set(['range', 'rn', 'rbuf', 'bytestart', 'byteend', 'cpn', 'cver', '_', 'alr', 'srfvp', 'ump', 'pot']);
  const num = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
  function signedInfo(url) {
    let u;
    try { u = new URL(url); } catch { return { signed: false }; }
    const p = new Map([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    let provider = '', expiresAt = 0;
    if (p.has('x-amz-signature')) {
      provider = 'AWS SigV4';
      const date = p.get('x-amz-date') || '';
      const m = date.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
      if (m && num(p.get('x-amz-expires'))) expiresAt = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) + num(p.get('x-amz-expires')) * 1000;
    } else if (p.has('x-goog-signature')) {
      provider = 'Google Cloud signed URL';
      const m = (p.get('x-goog-date') || '').match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
      if (m && num(p.get('x-goog-expires'))) expiresAt = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) + num(p.get('x-goog-expires')) * 1000;
    } else if (p.has('key-pair-id') && (p.has('signature') || p.has('policy'))) {
      provider = 'CloudFront signed URL';
      if (num(p.get('expires'))) expiresAt = num(p.get('expires')) * 1000;
      else if (p.has('policy')) {
        try { const policy = JSON.parse(atob(p.get('policy').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/')));
          expiresAt = num(policy?.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime']) * 1000; } catch {}
      }
    } else if (p.has('hdnts') || p.has('hdnea') || p.has('__token__')) {
      provider = 'Akamai token';
      const token = p.get('hdnts') || p.get('hdnea') || p.get('__token__');
      const m = token.match(/(?:^|~)exp=(\d+)/);
      if (m) expiresAt = Number(m[1]) * 1000;
    } else if (/(^|\.)googlevideo\.com$/.test(u.hostname) && p.has('expire')) {
      provider = 'Google Video';
      expiresAt = num(p.get('expire')) * 1000;
    } else if (p.has('se') && p.has('sig') && p.has('sv')) {
      provider = 'Azure SAS';
      const t = Date.parse(p.get('se'));
      if (Number.isFinite(t)) expiresAt = t;
    } else if (p.has('oe') && p.has('oh')) {
      provider = 'Meta CDN';
      expiresAt = parseInt(p.get('oe'), 16) * 1000 || 0;
    } else if (p.has('wowzatokenhash')) {
      provider = 'Wowza token';
      expiresAt = num(p.get('wowzatokenendtime')) * 1000;
    } else if (p.has('md5') && (p.has('expires') || p.has('e'))) {
      provider = 'Secure link';
      expiresAt = num(p.get('expires') || p.get('e')) * 1000;
    } else if (p.has('expires') && (p.has('signature') || p.has('sig') || p.has('hmac'))) {
      provider = 'Signed URL';
      expiresAt = num(p.get('expires')) * 1000;
    } else if (p.has('exp') && (p.has('sig') || p.has('hmac') || p.has('signature'))) {
      provider = 'Signed URL';
      expiresAt = num(p.get('exp')) * 1000;
    }
    // Some services use milliseconds already.
    if (expiresAt > 1e14) expiresAt = Math.floor(expiresAt / 1000);
    return provider ? { signed: true, provider, expiresAt: expiresAt || 0 } : { signed: false };
  }
  const isExpired = (info, now = Date.now()) => !!(info?.expiresAt && info.expiresAt <= now);
  // Identity used to merge rows: path plus identifying query params; signature/range params dropped.
  function dedupKey(url) {
    let u;
    try { u = new URL(url); } catch { return String(url); }
    u.hash = '';
    const signed = signedInfo(url).signed;
    const keep = [...u.searchParams].filter(([k]) => {
      const key = k.toLowerCase();
      if (TRANSIENT_PARAMS.has(key)) return false;
      return !(signed && SIGNATURE_PARAMS.has(key));
    }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const query = new URLSearchParams(keep).toString();
    return u.origin.toLowerCase() + u.pathname + (query ? '?' + query : '');
  }

  // Map HTTP results to user-facing categories.
  function classifyFailure({ status = 0, url = '', contentType = '', error = '' } = {}) {
    const signed = signedInfo(url);
    const expired = isExpired(signed);
    if (/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) return { code: 'auth', retryable: false,
      message: 'The server returned a web page instead of media (login, consent or error page). Open the source page, sign in if needed, replay and retry.' };
    if (status === 401) return { code: 'auth', retryable: false, message: 'HTTP 401: authentication is required. Sign in on the source site; Video Grabber does not bypass logins.' };
    if (status === 403) return expired || signed.signed
      ? { code: 'expired', retryable: false, message: `HTTP 403: the signed ${signed.provider || 'CDN'} URL ${expired ? 'has expired' : 'was rejected (expired or bound to another session)'}. Replay the media and Refresh to capture a fresh URL.` }
      : { code: 'auth', retryable: false, message: 'HTTP 403: access denied by the server (authentication, geo or referrer restriction).' };
    if (status === 404 || status === 410) return expired || signed.signed
      ? { code: 'expired', retryable: false, message: `HTTP ${status}: the URL expired or was removed. Replay the media and Refresh.` }
      : { code: 'not-found', retryable: false, message: `HTTP ${status}: the media no longer exists at this URL.` };
    if (status === 416) return { code: 'http', retryable: false, message: 'HTTP 416: the requested byte range is not available.' };
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return { code: 'http', retryable: true, message: `HTTP ${status}: temporary server error.` };
    if (status >= 400) return { code: 'http', retryable: false, message: `HTTP ${status}.` };
    if (expired) return { code: 'expired', retryable: false, message: 'The signed URL has expired. Replay the media and Refresh.' };
    return { code: 'network', retryable: true, message: error || 'Network error.' };
  }
  return { identify, signedInfo, isExpired, dedupKey, classifyFailure, SIGNATURE_PARAMS };
})();
