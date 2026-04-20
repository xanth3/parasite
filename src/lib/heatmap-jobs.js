const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const db = require('./db');
const {
  HeatmapAccumulator,
  normalizeImportedPayload,
  heatmapPathForMedia,
  formatShortDuration
} = require('./heatmap-core');
const { extractTwitchVodId, iterateTwitchVodComments } = require('./twitch-vod');

let running = false;
let stopped = false;
let emit = null;
let settingsStore = null;
let libraryRoot = null;
const controllers = new Map();

function start({ appDataDir, store, emit: emitEvent }) {
  stopped = false;
  emit = emitEvent;
  settingsStore = store;
  libraryRoot = path.join(appDataDir, 'library-items');
  fs.mkdirSync(libraryRoot, { recursive: true });
  db.resetRunningHeatmapJobs();
  kick();
}

function stop() {
  stopped = true;
  controllers.clear();
}

function kick() {
  if (!running && !stopped) setTimeout(tick, 0);
}

async function buildFromTwitch({ itemId, vodInput }) {
  const item = db.getItemById(itemId);
  if (!item) throw new Error('Library item not found.');
  const latestJob = db.latestHeatmapJobForItem(itemId);
  if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'running')) {
    throw new Error('A heatmap build is already in progress for this item.');
  }
  const vodId = extractTwitchVodId(vodInput);

  const job = db.createHeatmapJob({
    item_id: itemId,
    kind: 'build-heatmap',
    source_kind: 'twitch',
    checkpoint_json: JSON.stringify({
      vodInput,
      vodId,
      cursor: null,
      lastOffsetSec: 0,
      accumulator: null,
      durationSec: item.duration || null
    })
  });
  kick();
  return { jobId: job.job_id };
}

async function importNormalized({ jsonPath }) {
  const raw = await fsp.readFile(jsonPath, 'utf8');
  const normalized = normalizeImportedPayload(JSON.parse(raw));
  const item = db.createImportItem({
    name: normalized.title || path.basename(jsonPath, path.extname(jsonPath)),
    duration: normalized.durationSec,
    category: categoryForDuration(normalized.durationSec),
    playback_error: 'No media attached.',
    source_kind: normalized.source.kind || 'manual',
    source_service: normalized.source.service || null,
    source_vod_id: normalized.source.vodId || null,
    source_channel: normalized.source.channel || null
  });

  const itemDir = ensureItemDir(item.item_id);
  const importPayloadPath = path.join(itemDir, 'input.normalized.json');
  await fsp.writeFile(importPayloadPath, JSON.stringify(normalized, null, 2), 'utf8');
  db.updateItem(item.item_id, { import_payload_path: importPayloadPath });

  const job = db.createHeatmapJob({
    item_id: item.item_id,
    kind: 'build-heatmap',
    source_kind: 'manual-import',
    checkpoint_json: JSON.stringify({
      importPayloadPath,
      index: 0,
      accumulator: null,
      durationSec: normalized.durationSec
    })
  });
  kick();
  return { itemId: item.item_id, jobId: job.job_id };
}

function cancel(jobId) {
  const job = db.getHeatmapJob(jobId);
  if (!job) throw new Error('Heatmap job not found.');

  if (job.status === 'pending') {
    db.cancelPendingHeatmapJob(jobId);
    emit?.('heatmap:progress', {
      jobId,
      itemId: job.item_id,
      status: 'cancelled',
      progress: job.progress,
      label: 'Cancelled.'
    });
    emit?.('library:changed');
    return { cancelled: true };
  }

  const controller = controllers.get(jobId);
  if (controller) {
    controller.cancelled = true;
    db.updateHeatmapJob(jobId, { progress_label: 'Cancelling...' });
  }
  return { cancelled: true };
}

async function tick() {
  if (running || stopped) return;
  const job = db.nextPendingHeatmapJob();
  if (!job) return;

  running = true;
  const controller = { cancelled: false };
  controllers.set(job.job_id, controller);
  db.updateHeatmapJob(job.job_id, { status: 'running' });

  try {
    if (job.source_kind === 'twitch') await runTwitchJob(job, controller);
    else if (job.source_kind === 'manual-import') await runManualImportJob(job, controller);
    else throw new Error(`Unsupported heatmap source: ${job.source_kind}`);
  } catch (error) {
    if (controller.cancelled || error.message === 'Heatmap build cancelled.') {
      db.updateHeatmapJob(job.job_id, {
        status: 'cancelled',
        progress_label: 'Cancelled.'
      });
      emit?.('heatmap:progress', {
        jobId: job.job_id,
        itemId: job.item_id,
        status: 'cancelled',
        progress: job.progress,
        label: 'Cancelled.'
      });
    } else {
      db.updateHeatmapJob(job.job_id, {
        status: 'error',
        error: error.message,
        progress_label: error.message
      });
      emit?.('heatmap:error', {
        jobId: job.job_id,
        itemId: job.item_id,
        status: 'error',
        error: error.message
      });
    }
    emit?.('library:changed');
  } finally {
    controllers.delete(job.job_id);
    running = false;
    if (!stopped) setTimeout(tick, 25);
  }
}

async function runManualImportJob(job, controller) {
  const item = db.getItemById(job.item_id);
  if (!item?.import_payload_path) throw new Error('Imported chat payload is missing.');

  const checkpoint = safeJson(job.checkpoint_json);
  const normalized = normalizeImportedPayload(JSON.parse(await fsp.readFile(item.import_payload_path, 'utf8')));
  const accumulator = HeatmapAccumulator.fromCheckpoint(checkpoint.accumulator);
  let index = Number(checkpoint.index || 0);

  while (index < normalized.messages.length) {
    if (!db.getItemById(job.item_id) || !db.getHeatmapJob(job.job_id)) {
      throw new Error('Heatmap build cancelled.');
    }
    if (controller.cancelled) throw new Error('Heatmap build cancelled.');
    const end = Math.min(normalized.messages.length, index + 1000);
    for (let cursor = index; cursor < end; cursor++) {
      const message = normalized.messages[cursor];
      accumulator.addMessage(message.offsetSec, message.text);
    }
    index = end;

    const progress = Math.min(0.99, index / normalized.messages.length);
    const label = `Scoring imported chat... ${index}/${normalized.messages.length}`;
    db.updateHeatmapJob(job.job_id, {
      progress,
      progress_label: label,
      checkpoint_json: JSON.stringify({
        ...checkpoint,
        importPayloadPath: item.import_payload_path,
        index,
        accumulator: accumulator.serializeCheckpoint(),
        durationSec: normalized.durationSec
      })
    });
    emit?.('heatmap:progress', {
      jobId: job.job_id,
      itemId: job.item_id,
      status: 'running',
      progress,
      label
    });
    await yieldToEventLoop();
  }

  const heatmapPath = await writeHeatmapForItem(item, accumulator.snapshot({
    durationSec: normalized.durationSec,
    source: normalized.source,
    title: normalized.title || item.name
  }));

  db.updateItem(item.item_id, {
    heatmap_path: heatmapPath,
    duration: normalized.durationSec,
    category: categoryForDuration(normalized.durationSec),
    source_kind: normalized.source.kind || item.source_kind || 'manual',
    source_service: normalized.source.service || item.source_service || null,
    source_vod_id: normalized.source.vodId || item.source_vod_id || null,
    source_channel: normalized.source.channel || item.source_channel || null
  });
  db.updateHeatmapJob(job.job_id, {
    status: 'done',
    progress: 1,
    progress_label: 'Heatmap ready.',
    checkpoint_json: JSON.stringify({
      importPayloadPath: item.import_payload_path,
      index: normalized.messages.length,
      accumulator: accumulator.serializeCheckpoint(),
      durationSec: normalized.durationSec
    })
  });
  emit?.('heatmap:finished', {
    jobId: job.job_id,
    itemId: job.item_id,
    status: 'done',
    progress: 1,
    label: 'Heatmap ready.',
    heatmapPath
  });
  emit?.('library:changed');
}

async function runTwitchJob(job, controller) {
  const item = db.getItemById(job.item_id);
  if (!item) throw new Error('Library item not found.');

  const checkpoint = safeJson(job.checkpoint_json);
  const vodId = extractTwitchVodId(checkpoint.vodId || checkpoint.vodInput);
  const accumulator = HeatmapAccumulator.fromCheckpoint(checkpoint.accumulator);
  const durationSec = Number(checkpoint.durationSec || item.duration || 0) || null;
  let cursor = checkpoint.cursor || null;
  let lastOffsetSec = Number(checkpoint.lastOffsetSec || 0);

  const publishProgress = (offsetSec, nextCursor, hasNextPage) => {
    if (!db.getItemById(job.item_id) || !db.getHeatmapJob(job.job_id)) {
      throw new Error('Heatmap build cancelled.');
    }
    const progress = durationSec ? Math.min(0.99, offsetSec / durationSec) : 0;
    const label = durationSec
      ? `Fetching chat... ${formatShortDuration(offsetSec)} / ${formatShortDuration(durationSec)}`
      : `Fetching chat... ${formatShortDuration(offsetSec)}`;
    db.updateHeatmapJob(job.job_id, {
      progress,
      progress_label: label,
      checkpoint_json: JSON.stringify({
        vodId,
        vodInput: checkpoint.vodInput || vodId,
        cursor: hasNextPage ? nextCursor : null,
        lastOffsetSec: offsetSec,
        accumulator: accumulator.serializeCheckpoint(),
        durationSec
      })
    });
    emit?.('heatmap:progress', {
      jobId: job.job_id,
      itemId: job.item_id,
      status: 'running',
      progress,
      label
    });
  };

  for await (const message of iterateTwitchVodComments({
    vodId,
    cursor,
    offsetSec: lastOffsetSec,
    isCancelled: () => controller.cancelled,
    onPage: ({ cursor: nextCursor, lastOffsetSec: nextOffsetSec, hasNextPage }) => {
      cursor = nextCursor;
      lastOffsetSec = nextOffsetSec;
      publishProgress(lastOffsetSec, cursor, hasNextPage);
    }
  })) {
    accumulator.addMessage(message.offsetSec, message.text);
  }

  if (controller.cancelled) throw new Error('Heatmap build cancelled.');
  if (!db.getItemById(job.item_id) || !db.getHeatmapJob(job.job_id)) {
    throw new Error('Heatmap build cancelled.');
  }

  const resolvedDurationSec = durationSec || Math.max(item.duration || 0, lastOffsetSec || 0);
  const heatmapPath = await writeHeatmapForItem(item, accumulator.snapshot({
    durationSec: resolvedDurationSec,
    source: {
      kind: 'twitch',
      service: 'twitch',
      vodId,
      channel: item.source_channel || null
    },
    title: item.name
  }));

  db.updateItem(item.item_id, {
    heatmap_path: heatmapPath,
    duration: resolvedDurationSec || item.duration,
    category: categoryForDuration(resolvedDurationSec || item.duration),
    source_kind: item.source_kind || 'twitch',
    source_service: 'twitch',
    source_vod_id: vodId
  });
  db.updateHeatmapJob(job.job_id, {
    status: 'done',
    progress: 1,
    progress_label: 'Heatmap ready.',
    checkpoint_json: JSON.stringify({
      vodId,
      vodInput: checkpoint.vodInput || vodId,
      cursor: null,
      lastOffsetSec,
      accumulator: accumulator.serializeCheckpoint(),
      durationSec: resolvedDurationSec
    })
  });
  emit?.('heatmap:finished', {
    jobId: job.job_id,
    itemId: job.item_id,
    status: 'done',
    progress: 1,
    label: 'Heatmap ready.',
    heatmapPath
  });
  emit?.('library:changed');
}

async function writeHeatmapForItem(item, payload) {
  const finalPath = item.path
    ? heatmapPathForMedia(item.path)
    : path.join(ensureItemDir(item.item_id), 'heatmap.parasite.json');
  const tempPath = `${finalPath}.tmp`;
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tempPath, finalPath);
  return finalPath;
}

function ensureItemDir(itemId) {
  const itemDir = path.join(libraryRoot, String(itemId));
  fs.mkdirSync(itemDir, { recursive: true });
  return itemDir;
}

function categoryForDuration(durationSec) {
  const threshold = Number(settingsStore?.get('clipThresholdMinutes') || 30) * 60;
  return Number(durationSec || 0) >= threshold ? 'unedited' : 'clips';
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  start,
  stop,
  kick,
  buildFromTwitch,
  importNormalized,
  cancel
};
