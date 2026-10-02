// Keep conversion off the UI thread. mux.js remuxes H.264/AAC without re-encoding.
importScripts('vendor/mux.min.js');

function checkCodecs(bytes) {
  // Reject unsupported PMT tracks instead of silently dropping their audio/video.
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47 || !(bytes[offset + 1] & 0x40)) continue;
    const control = (bytes[offset + 3] >> 4) & 3;
    if (!(control & 1)) continue;
    let start = offset + 4;
    if (control & 2) start += 1 + bytes[start];
    if (start >= offset + 188) continue;
    start += 1 + bytes[start]; // PSI pointer field
    if (start + 12 > offset + 188 || bytes[start] !== 2) continue;
    const end = start + 3 + (((bytes[start + 1] & 15) << 8) | bytes[start + 2]) - 4;
    if (end > offset + 188) throw new Error('This stream has a complex track table that cannot be converted.');
    let track = start + 12 + (((bytes[start + 10] & 15) << 8) | bytes[start + 11]);
    while (track + 5 <= end) {
      const type = bytes[track];
      if (![0x1b, 0x0f, 0x15].includes(type)) {
        throw new Error('This stream uses a codec other than H.264/AAC.');
      }
      track += 5 + (((bytes[track + 3] & 15) << 8) | bytes[track + 4]);
    }
  }
}

self.onmessage = ({ data: parts }) => {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  const output = [];
  transmuxer.on('data', segment => {
    if (!output.length) output.push(segment.initSegment);
    output.push(segment.data);
  });
  try {
    for (let i = 0; i < parts.length; i++) {
      const bytes = new Uint8Array(parts[i]);
      checkCodecs(bytes);
      transmuxer.push(bytes);
      transmuxer.flush();
      self.postMessage({ progress: (i + 1) / parts.length });
    }
    if (!output.length) throw new Error('No supported H.264/AAC media was found.');
    self.postMessage({ blob: new Blob(output, { type: 'video/mp4' }) });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  } finally {
    transmuxer.dispose();
  }
};
