# Bundled single-thread FFmpeg WebAssembly core

Package: `@ffmpeg/core` **0.12.10**, distributed through the official npm package.
Files: `ffmpeg-core.js` and `ffmpeg-core.wasm`, copied without modifications from `dist/umd/`.
License: **GPL-2.0-or-later** (see LICENSE and package.json).

Upstream corresponding source, build scripts and dependency versions:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/build

Upstream includes FFmpeg and codec libraries under their respective licenses.
The extension's own source is MIT; the bundled FFmpeg core retains its GPL license.
Keep this notice and license when redistributing the full build and provide corresponding
source as required by that license. The store build excludes this directory.

The worker only loads these local files. No CDN requests or remote code loading occur at runtime.
