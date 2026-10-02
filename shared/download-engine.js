// Download engine used by the extension download page: retrying fetches with exponential
// backoff, pause/cancel, ordered concurrent segment downloads with a bounded reorder window,
// progress/speed/ETA metering and disk-backed (OPFS) temporary storage with checkpoints.
globalThis.DownloadEngine = (() => {
  const DEFAULTS = { concurrency: 4, retries: 4, baseDelay: 500, maxDelay: 15000, timeoutMs: 30000, chunkBytes: 32 * 1024 * 1024 };
  const vgError = (message, code = 'error', extra = {}) => Object.assign(new Error(message), { code, ...extra });
  const aborted = () => new DOMException('Cancelled', 'AbortError');
  const isAbort = error => error?.name === 'AbortError' || error?.code === 'cancelled';
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); reject(aborted()); };
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  function backoff(attempt, { baseDelay = DEFAULTS.baseDelay, maxDelay = DEFAULTS.maxDelay, retryAfter = 0, random = Math.random } = {}) {
    if (retryAfter > 0) return Math.min(60000, retryAfter * 1000);
    const exp = Math.min(maxDelay, baseDelay * 2 ** Math.max(0, attempt - 1));
    return Math.round(exp * (0.75 + random() * 0.5));
  }
  class PauseGate {
    constructor() { this.paused = false; this.waiters = []; }
    pause() { this.paused = true; }
    resume() { this.paused = false; const w = this.waiters; this.waiters = []; w.forEach(fn => fn()); }
    wait(signal) {
      if (!this.paused) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
        const stop = () => { this.waiters = this.waiters.filter(fn => fn !== done); reject(aborted()); };
        if (signal?.aborted) return stop();
        signal?.addEventListener('abort', stop, { once: true });
        this.waiters.push(done);
      });
    }
  }
  // Idle timeout: aborts only when no response/data arrives for timeoutMs. Slow but progressing
  // transfers (throttled CDNs) keep going instead of being restarted from zero.
  function combinedSignal(signal, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(vgError('No data received for ' + Math.round(timeoutMs / 1000) + ' s.', 'timeout')), timeoutMs); };
    arm();
    const stop = () => controller.abort(aborted());
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    return { signal: controller.signal, touch: arm, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); } };
  }
  async function readBody(response, { signal, onBytes, expected = 0, limit = 0 } = {}) {
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      onBytes?.(bytes.length);
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        if (signal?.aborted) throw aborted();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); length += value.length; onBytes?.(value.length);
        if (limit && length > limit) throw vgError('Response exceeds the ' + Math.round(limit / 1048576) + ' MB limit.', 'too-large');
      }
    } catch (error) { reader.cancel().catch(() => {}); throw error; }
    if (expected && length !== expected) throw vgError(`Incomplete response: received ${length} of ${expected} bytes.`, 'incomplete', { retryable: true });
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
  // Fetch one resource with classification, retries and an optional page-context fallback.
  async function fetchBytes(url, options = {}) {
    const { range = null, signal, gate, retries = DEFAULTS.retries, timeoutMs = DEFAULTS.timeoutMs, fetchImpl = globalThis.fetch,
      fallback, onRetry, onBytes, credentials = 'include', expectMedia = true, baseDelay, maxDelay, random } = options;
    let lastError;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      await gate?.wait(signal);
      if (signal?.aborted) throw aborted();
      const { signal: requestSignal, cleanup, touch } = combinedSignal(signal, timeoutMs);
      let response, failure;
      try {
        const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
        try { response = await fetchImpl(url, { credentials, headers, signal: requestSignal }); }
        catch (error) {
          if (signal?.aborted) throw aborted();
          const reason = requestSignal.reason?.code === 'timeout' ? requestSignal.reason.message : (error.message || String(error));
          failure = { status: 0, error: reason, retryable: true, code: 'network' };
        }
        if (response && !failure) {
          const type = response.headers.get('content-type') || '';
          if (!response.ok) failure = { status: response.status, retryAfter: Number(response.headers.get('retry-after')) || 0 };
          else if (expectMedia && /^(text\/html|application\/xhtml\+xml)/i.test(type)) failure = { status: response.status, contentType: type };
          else if (range && response.status !== 206) {
            response.body?.cancel?.().catch(() => {});
            throw vgError('The server ignored the requested byte range (HTTP ' + response.status + ').', 'range', { retryable: false });
          }
          if (failure) response.body?.cancel?.().catch(() => {});
        }
        // Page-context fallback (browser-approved Referer/cookies) for denied or CORS-blocked requests.
        if (failure && fallback && (failure.status === 0 || failure.status === 401 || failure.status === 403)) {
          try {
            const viaPage = await fallback(url, range);
            if (viaPage) { response = viaPage; failure = viaPage.ok ? null : { status: viaPage.status }; }
          } catch (error) { if (isAbort(error)) throw error; failure.fallbackError = error.message; }
        }
        if (!failure) {
          const expected = range ? range[1] - range[0] + 1 : 0;
          const bytes = await readBody(response, { signal: requestSignal, onBytes: n => { touch(); onBytes?.(n); }, expected });
          return { bytes, url: response.url || url, headers: response.headers, status: response.status };
        }
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' && !requestSignal.reason?.code) throw aborted();
        if (error.code === 'range' || error.code === 'too-large') throw error;
        failure = { status: 0, error: requestSignal.reason?.code === 'timeout' ? requestSignal.reason.message : error.message, retryable: error.retryable ?? true };
      } finally { cleanup(); }
      const info = CdnTools.classifyFailure({ status: failure.status, url, contentType: failure.contentType, error: failure.error });
      const retryable = failure.status ? info.retryable : failure.retryable !== false && info.code !== 'expired';
      lastError = vgError(info.message + (failure.fallbackError ? ' (page fallback: ' + failure.fallbackError + ')' : ''), info.code, { status: failure.status, retryable, url });
      if (!retryable || attempt > retries) break;
      const delay = backoff(attempt, { baseDelay, maxDelay, retryAfter: failure.retryAfter, random });
      onRetry?.({ attempt, delay, error: lastError });
      await sleep(delay, signal);
    }
    throw lastError;
  }

  // Throughput/ETA meter over a sliding window.
  class ProgressMeter {
    constructor({ totalBytes = 0, totalUnits = 0, now = () => Date.now(), window = 5000 } = {}) {
      Object.assign(this, { totalBytes, totalUnits, now, window, bytes: 0, units: 0, unitBytes: 0, samples: [], started: now() });
    }
    add(bytes) {
      this.bytes += bytes;
      const t = this.now();
      this.samples.push([t, this.bytes]);
      while (this.samples.length > 2 && t - this.samples[0][0] > this.window) this.samples.shift();
    }
    unit(bytes = 0) { this.units++; this.unitBytes += bytes; }
    get speed() {
      if (this.samples.length < 2) {
        const elapsed = (this.now() - this.started) / 1000;
        return elapsed > 0.25 ? this.bytes / elapsed : 0;
      }
      const [t0, b0] = this.samples[0], [t1, b1] = this.samples.at(-1);
      const t = Math.max(t1, this.now());
      return t > t0 ? (b1 - b0) / ((t - t0) / 1000) : 0;
    }
    get estimatedTotal() {
      if (this.totalBytes) return this.totalBytes;
      if (this.totalUnits && this.units) return this.unitBytes / this.units * this.totalUnits + (this.bytes - this.unitBytes);
      return 0;
    }
    get fraction() {
      if (this.totalUnits) return Math.min(1, this.units / this.totalUnits);
      const total = this.estimatedTotal;
      return total ? Math.min(1, this.bytes / total) : 0;
    }
    get eta() {
      const total = this.estimatedTotal, speed = this.speed;
      if (!total || !speed) return null;
      return Math.max(0, (total - this.bytes) / speed);
    }
    snapshot() { return { bytes: this.bytes, total: Math.round(this.estimatedTotal), speed: Math.round(this.speed), eta: this.eta === null ? null : Math.round(this.eta), fraction: this.fraction, units: this.units, totalUnits: this.totalUnits }; }
  }
  const fmtBytes = n => !n ? '0 B' : n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
  const fmtTime = s => s === null || s === undefined || !Number.isFinite(s) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : Math.round(s) + 's';

  // ---------------- temporary storage ----------------
  class MemorySink {
    constructor() { this.parts = []; this.size = 0; this.kind = 'memory'; this.marks = -1; this.sizes = []; }
    async write(bytes) { this.parts.push(new Blob([bytes])); this.size += bytes.length; this.sizes.push(bytes.length); }
    async verify() { return true; }
    mark(index) { this.marks = index; }
    async commit() {}
    async blob(type = '') { return new Blob(this.parts, { type }); }
    async remove() { this.parts = []; this.size = 0; }
    checkpoint() { return null; }
  }
  // Chunked OPFS storage: each chunk file is committed (closed) once full, so a committed
  // prefix survives tab crashes and can be resumed. Final output is a Blob of disk files.
  class OpfsSink {
    constructor(dir, prefix, options = {}) {
      Object.assign(this, { dir, prefix, chunkBytes: options.chunkBytes || DEFAULTS.chunkBytes, onCommit: options.onCommit,
        chunks: [...(options.resume?.chunks || [])], current: null, currentBytes: 0, currentName: '', kind: 'opfs',
        lastMark: options.resume?.segEnd ?? -1, sizes: [...(options.resume?.sizes || [])] });
      this.size = this.chunks.reduce((s, c) => s + c.bytes, 0);
    }
    async write(bytes) {
      if (!this.current) {
        this.currentName = `${this.prefix}-${String(this.chunks.length).padStart(5, '0')}.part`;
        const handle = await this.dir.getFileHandle(this.currentName, { create: true });
        this.current = await handle.createWritable({ keepExistingData: false });
        this.currentBytes = 0;
      }
      await this.current.write(bytes);
      this.currentBytes += bytes.length; this.size += bytes.length; this.sizes.push(bytes.length);
    }
    // Resumed chunks must still exist with their recorded sizes.
    async verify() {
      try {
        for (const chunk of this.chunks) if ((await (await this.dir.getFileHandle(chunk.name)).getFile()).size !== chunk.bytes) return false;
        return this.sizes.reduce((s, n) => s + n, 0) === this.size;
      } catch { return false; }
    }
    mark(index) { this.lastMark = index; if (this.currentBytes >= this.chunkBytes) return this.commit(); }
    async commit() {
      if (!this.current) return;
      await this.current.close();
      this.chunks.push({ name: this.currentName, bytes: this.currentBytes, segEnd: this.lastMark, writes: this.sizes.length });
      this.current = null; this.currentBytes = 0;
      await this.onCommit?.(this.checkpoint());
    }
    checkpoint() {
      const writes = this.chunks.at(-1)?.writes ?? 0;
      return { chunks: this.chunks.map(c => ({ ...c })), segEnd: this.chunks.at(-1)?.segEnd ?? -1,
        bytes: this.chunks.reduce((s, c) => s + c.bytes, 0), sizes: this.sizes.slice(0, writes) };
    }
    async blob(type = '') {
      await this.commit();
      const files = [];
      for (const chunk of this.chunks) files.push(await (await this.dir.getFileHandle(chunk.name)).getFile());
      return new Blob(files, { type });
    }
    async abort() { try { await this.current?.abort?.(); } catch {} this.current = null; }
    async remove() {
      await this.abort();
      for (const chunk of this.chunks) await this.dir.removeEntry(chunk.name).catch(() => {});
      this.chunks = []; this.size = 0; this.sizes = [];
    }
  }
  const Storage = {
    // Disk-backed storage when the browser provides a working OPFS; null (memory) otherwise.
    // Guarded by a timeout so a browser that blocks storage (privacy settings) never stalls a download.
    async root() {
      if (!globalThis.navigator?.storage?.getDirectory) return null;
      const attempt = (async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('vg-jobs', { create: true });
        const probe = await dir.getFileHandle('.probe', { create: true });
        if (typeof probe.createWritable !== 'function') return null;
        return dir;
      })().catch(() => null);
      return Promise.race([attempt, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
    },
    // Returns { kind, sink(name, resume) , remove() } for one job.
    async open(key, options = {}) {
      const root = await this.root();
      if (!root || options.memory) return { kind: 'memory', sink: () => new MemorySink(), remove: async () => {}, dir: null };
      const dir = await root.getDirectoryHandle(key, { create: true });
      return { kind: 'opfs', dir, sink: (name, resume, onCommit) => new OpfsSink(dir, name, { resume, onCommit, chunkBytes: options.chunkBytes }),
        remove: async () => { await root.removeEntry(key, { recursive: true }).catch(() => {}); } };
    },
    // Remove job folders not in keep (and the leftovers of finished/abandoned jobs).
    async prune(keep = new Set()) {
      const root = await this.root();
      if (!root?.keys) return 0;
      let removed = 0;
      for await (const name of root.keys()) if (!keep.has(name) && name !== '.probe') { await root.removeEntry(name, { recursive: true }).catch(() => {}); removed++; }
      return removed;
    }
  };

  // Download segments concurrently but write them strictly in order. At most `window`
  // segments are held in memory at once, regardless of the stream length.
  async function downloadSegments({ segments, sink, concurrency = DEFAULTS.concurrency, signal, gate, meter, startAt = 0,
    fetchOptions = {}, onSegment, onRetry, transform }) {
    const total = segments.length;
    const window = concurrency + 2; // in-flight plus a small reorder buffer bounds memory
    let next = startAt, writeIndex = startAt, failure = null;
    const pending = new Map();
    let wake = [];
    const notify = () => { const w = wake; wake = []; w.forEach(fn => fn()); };
    const waitForRoom = () => new Promise((resolve, reject) => {
      const check = () => {
        if (failure) return reject(failure);
        if (signal?.aborted) return reject(aborted());
        if (next < writeIndex + window) return resolve();
        wake.push(check);
      };
      check();
    });
    let writing = Promise.resolve();
    const flush = () => {
      writing = writing.then(async () => {
        while (!failure && pending.has(writeIndex)) {
          const data = pending.get(writeIndex);
          pending.delete(writeIndex);
          await sink.write(data);
          await sink.mark(writeIndex);
          onSegment?.(writeIndex, data.length);
          writeIndex++;
          notify();
        }
      }).catch(error => { failure ||= error; notify(); });
      return writing;
    };
    const abortListener = () => notify();
    signal?.addEventListener('abort', abortListener);
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, total - startAt)) }, async () => {
        while (!failure) {
          await waitForRoom();
          if (next >= total) return;
          const index = next++;
          const segment = segments[index];
          try {
            const result = await fetchBytes(segment.url, { ...fetchOptions, range: segment.range, signal, gate,
              onBytes: n => meter?.add(n), onRetry: info => onRetry?.({ ...info, index }) });
            let data = result.bytes;
            if (transform) data = await transform(data, index, result);
            meter?.unit(result.bytes.length);
            pending.set(index, data);
            await flush();
          } catch (error) {
            failure ||= isAbort(error) ? aborted() : Object.assign(error, { segment: index });
            notify();
            throw failure;
          }
        }
      }));
      await writing;
      if (failure) throw failure;
    } catch (error) {
      await writing.catch(() => {});
      throw failure || error;
    } finally {
      signal?.removeEventListener('abort', abortListener);
      pending.clear();
    }
    return { written: writeIndex - startAt };
  }

  // Lightweight format validation of finished outputs.
  async function validateOutput(blob, { format, expectKinds = [] } = {}) {
    if (!blob || !blob.size) return { ok: false, reason: 'The output file is empty.' };
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
    if (/^(<!doctype|<html|<\?xml(?![\s\S]*<MPD))/i.test(new TextDecoder().decode(head.subarray(0, 64)).trimStart()) && format !== 'mpd' && format !== 'm3u8')
      return { ok: false, reason: 'The output is a web page, not media.' };
    if (format === 'mp4' || format === 'm4a') return Mp4Tools.validate(blob, { expectKinds });
    if (format === 'ts') {
      const ok = head[0] === 0x47 && (blob.size < 189 || head[188] === 0x47);
      return ok ? { ok: true } : { ok: false, reason: 'The output is not an MPEG-TS stream.' };
    }
    if (format === 'mp3') {
      const id3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
      const sync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      return id3 || sync ? { ok: true } : { ok: false, reason: 'The output is not an MP3 file.' };
    }
    if (format === 'webm' || format === 'mkv') {
      const ok = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      return ok ? { ok: true } : { ok: false, reason: 'The output is not a WebM/Matroska file.' };
    }
    if (format === 'aac') {
      const ok = (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) || (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33);
      return ok ? { ok: true } : { ok: false, reason: 'The output is not an AAC stream.' };
    }
    return { ok: true };
  }
  async function digest(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return { DEFAULTS, vgError, isAbort, sleep, backoff, PauseGate, fetchBytes, readBody, ProgressMeter, MemorySink, OpfsSink, Storage,
    downloadSegments, validateOutput, digest, fmtBytes, fmtTime };
})();
