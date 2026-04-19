// Live Whisper transcription worker.
//
// Strategy for real-time transcription:
//  1. Capture the default input device as a WAV stream (ffmpeg).
//  2. Slice the stream into ~5s rolling chunks written to a temp file.
//  3. Run whisper-node against each chunk as it closes.
//  4. Emit each decoded line to the renderer and append to a .txt file.
//
// The whisper-node package uses whisper.cpp under the hood and runs fully
// offline. First run will download the selected model (e.g. base.en).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let ffProc = null;
let chunkTimer = null;
let sessionDir = null;
let transcriptFile = null;
let rollingIndex = 0;
let lastChunkPath = null;
let opts = null;

// whisper-node is loaded lazily so users can run the app without having
// downloaded the model until they flip the setting on.
let whisperNode = null;
function getWhisper() {
  if (!whisperNode) {
    try { whisperNode = require('whisper-node'); }
    catch (e) { throw new Error('whisper-node is not installed. Run `npm install` and retry.'); }
  }
  return whisperNode;
}

async function selfTest() {
  try {
    getWhisper();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function startLive({ label, outputDir, model, onLine }) {
  stopLive();
  opts = { label, outputDir, model: model || 'base.en', onLine };
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parasite-whisper-'));
  transcriptFile = path.join(outputDir, `${label}-${Date.now()}-transcript.txt`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(transcriptFile, `# Transcript for ${label}\n# Started ${new Date().toISOString()}\n\n`);

  // Start capturing default audio input to stdout as raw PCM, while also
  // writing rolling 5s WAV segments we can feed to whisper.cpp.
  // On Windows ffmpeg supports "dshow" for audio devices; we default to
  // the system default (audio=default) which works for most setups.
  const device = process.platform === 'win32' ? 'audio=default' : 'default';
  const format = process.platform === 'win32' ? 'dshow' : 'pulse';

  const args = [
    '-f', format, '-i', device,
    '-ac', '1', '-ar', '16000',
    '-f', 'segment', '-segment_time', '5',
    '-reset_timestamps', '1',
    '-c:a', 'pcm_s16le',
    path.join(sessionDir, 'chunk-%04d.wav')
  ];

  ffProc = spawn(ffmpegStatic, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  ffProc.on('error', (err) => {
    console.error('[whisper] ffmpeg failed to start:', err.message);
  });
  ffProc.stderr.on('data', () => { /* swallow verbose ffmpeg logs */ });

  chunkTimer = setInterval(processNextChunk, 1000);
}

async function processNextChunk() {
  if (!sessionDir) return;
  const nextPath = path.join(sessionDir, `chunk-${String(rollingIndex).padStart(4, '0')}.wav`);
  // Skip the very latest file (ffmpeg may still be writing); only process
  // a chunk once the *next* one exists.
  const peekPath = path.join(sessionDir, `chunk-${String(rollingIndex + 1).padStart(4, '0')}.wav`);
  if (!fs.existsSync(peekPath)) return;
  if (!fs.existsSync(nextPath)) {
    rollingIndex += 1;
    return;
  }
  rollingIndex += 1;
  lastChunkPath = nextPath;

  try {
    const whisper = getWhisper();
    const transcript = await whisper.whisper(nextPath, {
      modelName: opts.model,
      whisperOptions: { language: 'auto', gen_file_txt: false }
    });
    if (Array.isArray(transcript)) {
      for (const line of transcript) {
        const text = typeof line === 'string' ? line : line.speech || line.text || '';
        if (!text.trim()) continue;
        fs.appendFileSync(transcriptFile, text + '\n');
        opts.onLine?.(text);
      }
    }
  } catch (e) {
    console.error('[whisper] chunk failed:', e.message);
  } finally {
    // Keep temp usage bounded — delete the chunk after processing.
    try { fs.unlinkSync(nextPath); } catch {}
  }
}

function stopLive() {
  if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
  if (ffProc) { try { ffProc.kill('SIGINT'); } catch {} ffProc = null; }
  if (sessionDir) {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    sessionDir = null;
  }
  transcriptFile = null;
  rollingIndex = 0;
  lastChunkPath = null;
  opts = null;
}

module.exports = { startLive, stopLive, selfTest };
