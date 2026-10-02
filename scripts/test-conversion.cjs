// Integration check: node scripts/test-conversion.cjs (requires ffmpeg/ffprobe).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-conversion-'));

function convert(parts) {
  let result;
  const context = vm.createContext({ Blob, Uint8Array, console, importScripts() {},
    self: { postMessage(data) { if (data.blob || data.error) result = data; } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/mux.min.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'ts-converter.js'), 'utf8'), context);
  context.self.onmessage({ data: parts });
  return result;
}

(async () => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '1', '-hls_segment_filename', path.join(temp, 'part-%d.ts'),
      path.join(temp, 'input.m3u8')]);
    const parts = fs.readdirSync(temp).filter(name => name.endsWith('.ts')).sort().map(name => {
      const buffer = fs.readFileSync(path.join(temp, name));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    });
    assert(parts.length > 1);
    for (const input of [parts, [Buffer.concat(parts.map(p => Buffer.from(p)))]]) {
      const result = convert(input);
      assert(result.blob, result.error);
      const output = path.join(temp, 'output.mp4');
      fs.writeFileSync(output, Buffer.from(await result.blob.arrayBuffer()));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_name,duration', '-of', 'json', output], { encoding: 'utf8' }));
      assert.deepEqual(probe.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
      assert(probe.streams.every(s => Number(s.duration) >= 3.9 && Number(s.duration) < 4.3));
      execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
    }
    assert(convert([new ArrayBuffer(0)]).error);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440', '-t', '1', '-c:a', 'mp2', '-f', 'mpegts', path.join(temp, 'unsupported.ts')]);
    assert.match(convert([fs.readFileSync(path.join(temp, 'unsupported.ts'))]).error, /codec/);
    console.log('Passed: multi-segment and direct TS conversion, audio/video decoding, empty input, unsupported codec.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
