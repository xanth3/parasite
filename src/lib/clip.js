// Non-destructive clipping via ffmpeg stream copy.
// Extracting a 30s slice from a 50GB file takes ~1s because we never
// re-encode: just remux from the nearest keyframe to the out point.
//
// Vertical reframe export uses a fresh encode (required to crop+scale)
// but only for the tiny clip — still fast.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegStatic, args);
    let stderr = '';
    p.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      // ffmpeg prints time= in stderr; forward as a coarse progress signal.
      const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && onProgress) {
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(sec);
      }
    });
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// Fast, lossless slice via stream copy.
async function ghostClip({ sourcePath, outDir, inSec, outSec, suffix }) {
  const ext = path.extname(sourcePath) || '.mp4';
  const base = path.basename(sourcePath, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${base}-clip-${suffix || stamp}${ext}`);
  fs.mkdirSync(outDir, { recursive: true });

  // -ss before -i => fast seek (keyframe-aligned). Good enough for clip farming.
  // -avoid_negative_ts make_zero keeps timestamps sane.
  const args = [
    '-y',
    '-ss', fmtTime(inSec),
    '-to', fmtTime(outSec),
    '-i', sourcePath,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outPath
  ];
  await runFfmpeg(args);
  return outPath;
}

// Re-encode + crop to 1080x1920 vertical, given a normalized crop rect
// {x, y, w, h} where each value is 0..1 relative to the source frame.
async function verticalReframe({ sourcePath, outDir, inSec, outSec, crop, onProgress }) {
  const ext = '.mp4';
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${base}-vertical-${stamp}${ext}`);
  fs.mkdirSync(outDir, { recursive: true });

  const cropExpr = `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`;
  const scaleExpr = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2';

  const args = [
    '-y',
    '-ss', fmtTime(inSec),
    '-to', fmtTime(outSec),
    '-i', sourcePath,
    '-vf', `${cropExpr},${scaleExpr}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outPath
  ];
  await runFfmpeg(args, onProgress);
  return outPath;
}

module.exports = { ghostClip, verticalReframe };
