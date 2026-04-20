// Batch queue processor. Runs one job at a time in the background so the
// UI stays responsive. State is persisted in SQLite — if the app closes
// mid-upload, the queue resumes on next launch.

const db = require('./db');
const drive = require('./drive');
const exporters = require('./export');

let running = false;
let stopped = false;
let settingsStore = null;
let emitter = null;

function start({ store, emit }) {
  settingsStore = store;
  emitter = emit;
  stopped = false;
  tick();
}

function stop() { stopped = true; }

async function tick() {
  if (running || stopped) return;
  const job = db.nextPendingQueueJob();
  if (!job) return;
  running = true;
  db.updateQueue(job.id, { status: 'running', progress: 0 });
  emitter?.('queue:update', { id: job.id });

  const params = safeJson(job.params_json);
  try {
    await runJob(job, params);
    db.updateQueue(job.id, { status: 'done', progress: 1 });
  } catch (e) {
    db.updateQueue(job.id, { status: 'error', error: e.message });
    console.error('[queue] job failed:', e.message);
  } finally {
    running = false;
    emitter?.('queue:update', { id: job.id });
    // Process next one after a tiny yield so UI can repaint
    setTimeout(tick, 100);
  }
}

async function runJob(job, params) {
  const filePath = job.item_path || job.video_path;
  if (!filePath) throw new Error('This queue item no longer has a playable media file.');

  const onProgress = (p) => {
    db.updateQueue(job.id, { progress: Math.max(0, Math.min(1, p.pct || 0)) });
    emitter?.('queue:progress', { id: job.id, pct: p.pct });
  };

  switch (job.action) {
    case 'drive':
      return drive.uploadWithProgress(settingsStore, filePath, onProgress);
    case 'youtube':
    case 'tiktok':
    case 'instagram':
    case 'twitter':
      return exporters.run(job.action, {
        filePath,
        title: params.title,
        description: params.description,
        tags: params.tags,
        credentials: settingsStore.get(`exports.${job.action}`),
        onProgress
      });
    default:
      throw new Error(`Unknown queue action: ${job.action}`);
  }
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function kick() { if (!running) tick(); }

module.exports = { start, stop, kick };
