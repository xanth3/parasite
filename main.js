// Parasite Electron main process.
// Owns the window lifecycle, filesystem access, SQLite index, recording,
// historical heatmap jobs, exports, Drive, and IPC to the renderer.

const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require('electron');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const Store = require('electron-store');
const chokidar = require('chokidar');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const db = require('./src/lib/db');
const drive = require('./src/lib/drive');
const obs = require('./src/lib/obs');
const whisper = require('./src/lib/whisper');
const exporters = require('./src/lib/export');
const chat = require('./src/lib/chat');
const clip = require('./src/lib/clip');
const queue = require('./src/lib/queue');
const crash = require('./src/lib/crash');
const heatmapJobs = require('./src/lib/heatmap-jobs');
const { BUCKET_MS, heatmapPathForMedia } = require('./src/lib/heatmap-core');

const defaultVideoRoot = path.join(os.homedir(), 'Videos', 'Parasite');
const store = new Store({
  defaults: {
    videoRoot: defaultVideoRoot,
    clipsFolderName: 'Clips',
    unfinishedFolderName: 'Unedited',
    clipThresholdMinutes: 30,
    drive: { enabled: false, defaultFolderId: null, defaultFolderName: 'Parasite Uploads' },
    obs: {
      host: 'localhost',
      port: 4455,
      password: '',
      windowCaptureScene: 'Parasite Stream',
      windowCaptureSource: 'Parasite Window Capture'
    },
    transcription: { enabled: false, model: 'base.en', outputDir: null },
    exports: {
      youtube: { clientId: '', clientSecret: '', refreshToken: '' },
      tiktok: { clientKey: '', clientSecret: '', accessToken: '' },
      instagram: { userId: '', accessToken: '' },
      twitter: { apiKey: '', apiSecret: '', accessToken: '', accessSecret: '' }
    },
    streamTargets: { twitch: ['zackrawrr', 'lirik'], kick: [''] },
    hotkeys: { markClip: 'Control+Shift+X' },
    chatHeatmap: { enabled: true }
  }
});

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v']);

let mainWindow = null;
let libraryWatcher = null;
let refreshIndexPromise = null;
let activeChatRecorder = null;
let activeRecordingStartMs = null;
let activeRecordingChannel = null;
let activeRecordingService = null;

function ensureDirs() {
  const root = store.get('videoRoot');
  const clipsDir = path.join(root, store.get('clipsFolderName'));
  const unfinishedDir = path.join(root, store.get('unfinishedFolderName'));
  for (const dir of [root, clipsDir, unfinishedDir]) fs.mkdirSync(dir, { recursive: true });
  return { root, clipsDir, unfinishedDir };
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      resolve(error || !metadata?.format ? 0 : metadata.format.duration || 0);
    });
  });
}

function inferLegacyRecordingMetadata(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const match = /^(twitch|kick)-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/i.exec(stem);
  if (!match) return null;

  const [, service, channel, year, month, day, hour, minute, second] = match;
  const startedAt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();

  return {
    source_kind: 'recording',
    source_service: service.toLowerCase(),
    source_channel: channel,
    recorded_started_at: Number.isFinite(startedAt) ? startedAt : null
  };
}

async function walkVideos(dir) {
  const entries = await safeReadDir(dir);
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkVideos(fullPath));
      continue;
    }
    if (!VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) continue;
    results.push({
      path: fullPath,
      name: entry.name,
      size: stat.size,
      mtime: stat.mtimeMs
    });
  }
  return results;
}

async function safeReadDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function refreshIndex({ notify = false } = {}) {
  if (refreshIndexPromise) return refreshIndexPromise;

  refreshIndexPromise = (async () => {
    const files = await walkVideos(store.get('videoRoot'));
    const seenPaths = new Set();
    const thresholdSec = Number(store.get('clipThresholdMinutes') || 30) * 60;

    for (const file of files) {
      seenPaths.add(file.path);
      const existing = db.getItemByPath(file.path);
      const legacySource = (!existing?.source_service || !existing?.source_channel || !existing?.recorded_started_at)
        ? inferLegacyRecordingMetadata(file.path)
        : null;
      const changed = !existing || existing.size !== file.size || existing.mtime !== file.mtime || !existing.playback_available;
      const duration = changed ? await probeDuration(file.path) : existing.duration;
      const category = duration >= thresholdSec ? 'unedited' : 'clips';

      db.upsertFileItem({
        path: file.path,
        name: file.name,
        size: file.size,
        mtime: file.mtime,
        duration,
        category,
        probed_at: Date.now(),
        heatmap_path: existing?.heatmap_path || null,
        playback_available: 1,
        playback_error: null,
        source_kind: existing?.source_kind || legacySource?.source_kind || 'file',
        source_service: existing?.source_service || legacySource?.source_service || null,
        source_vod_id: existing?.source_vod_id || null,
        source_channel: existing?.source_channel || legacySource?.source_channel || null,
        recorded_started_at: existing?.recorded_started_at || legacySource?.recorded_started_at || null,
        recorded_finished_at: existing?.recorded_finished_at || null,
        import_payload_path: existing?.import_payload_path || null
      });
    }

    db.markMissingItems(seenPaths);
    if (notify) emit('library:changed');
  })().finally(() => {
    refreshIndexPromise = null;
  });

  return refreshIndexPromise;
}

function startLibraryWatcher() {
  if (libraryWatcher) libraryWatcher.close().catch(() => {});
  const { root } = ensureDirs();
  libraryWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 }
  });
  const handleChange = () => refreshIndex({ notify: true });
  libraryWatcher.on('add', handleChange);
  libraryWatcher.on('change', handleChange);
  libraryWatcher.on('unlink', handleChange);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Parasite',
    backgroundColor: '#202225',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  startLibraryWatcher();
}

function serializeLibraryItem(item, latestJobMap) {
  const heatmapPath = item.heatmap_path && fs.existsSync(item.heatmap_path) ? item.heatmap_path : null;
  const latestJob = latestJobMap.get(item.item_id) || null;
  let heatmapStatus = heatmapPath ? 'ready' : 'missing';
  if (latestJob?.status === 'running' || latestJob?.status === 'pending') heatmapStatus = 'building';
  else if (!heatmapPath && latestJob?.status === 'error') heatmapStatus = 'error';
  else if (!heatmapPath && latestJob?.status === 'cancelled') heatmapStatus = 'cancelled';

  return {
    id: item.item_id,
    path: item.path,
    name: item.name,
    size: item.size,
    mtime: item.mtime,
    duration: item.duration,
    category: item.category,
    playback: {
      available: !!item.playback_available && !!item.path,
      error: item.playback_error || null
    },
    heatmap: {
      status: heatmapStatus,
      path: heatmapPath,
      jobId: latestJob?.job_id || null,
      progress: latestJob?.progress || 0,
      progressLabel: latestJob?.progress_label || null,
      error: latestJob?.error || null
    },
    source: {
      kind: item.source_kind || null,
      service: item.source_service || null,
      vodId: item.source_vod_id || null,
      channel: item.source_channel || null,
      recordedStartedAt: item.recorded_started_at || null,
      recordedFinishedAt: item.recorded_finished_at || null
    }
  };
}

function listSerializedItems() {
  const latestJobMap = new Map(db.listLatestHeatmapJobs().map((job) => [job.item_id, job]));
  return db.listItems().map((item) => serializeLibraryItem(item, latestJobMap));
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const binding = store.get('hotkeys.markClip') || 'Control+Shift+X';
  try {
    const ok = globalShortcut.register(binding, () => {
      const item = activeRecordingStartMs && activeRecordingChannel
        ? findOpenRecordingItem(activeRecordingService, activeRecordingChannel, activeRecordingStartMs)
        : null;
      const id = db.insertFlag({
        item_id: item?.item_id || null,
        channel: activeRecordingChannel,
        created_at: Date.now(),
        offset_ms: activeRecordingStartMs ? Date.now() - activeRecordingStartMs : null,
        note: 'Marked via hotkey'
      });
      emit('flag:captured', { id, when: Date.now() });
    });
    if (!ok) console.error('[hotkey] failed to register', binding);
  } catch (error) {
    console.error('[hotkey] error', error.message);
  }
}

function findOpenRecordingItem(service, channel, startedAt) {
  return db.listItems().find((item) => (
    item.source_service === service &&
    item.source_channel === channel &&
    item.recorded_started_at === startedAt
  ));
}

function humanProgressEvent(job, extra = {}) {
  return {
    jobId: job.job_id,
    itemId: job.item_id,
    status: job.status,
    progress: job.progress,
    label: job.progress_label,
    error: job.error || null,
    ...extra
  };
}

// --- Settings -------------------------------------------------------------

ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:set', async (_event, patch) => {
  for (const [key, value] of Object.entries(patch)) {
    store.set(key, value);
  }
  registerHotkeys();
  startLibraryWatcher();
  await refreshIndex({ notify: true });
  return store.store;
});

ipcMain.handle('settings:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  store.set('videoRoot', result.filePaths[0]);
  await refreshIndex({ notify: true });
  startLibraryWatcher();
  return result.filePaths[0];
});

// --- Library --------------------------------------------------------------

ipcMain.handle('library:list', async () => listSerializedItems());
ipcMain.handle('library:refresh', async () => {
  await refreshIndex({ notify: false });
  return listSerializedItems();
});
ipcMain.handle('library:reveal', (_event, itemId) => {
  const item = db.getItemById(itemId);
  if (!item?.path) return false;
  shell.showItemInFolder(item.path);
  return true;
});
ipcMain.handle('library:rename', async (_event, itemId, newName) => {
  const item = db.getItemById(itemId);
  if (!item?.path) throw new Error('Only media files can be renamed.');
  const directory = path.dirname(item.path);
  const clean = newName.replace(/[\\/:"*?<>|]+/g, '').trim();
  if (!clean) throw new Error('Invalid filename.');
  const ext = path.extname(item.path);
  const finalName = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : `${clean}${ext}`;
  const target = path.join(directory, finalName);
  await fsp.rename(item.path, target);
  db.renameItem(itemId, target, finalName);
  const oldHeatmapPath = item.heatmap_path;
  const nextHeatmapPath = oldHeatmapPath && fs.existsSync(oldHeatmapPath) ? heatmapPathForMedia(target) : null;
  if (nextHeatmapPath && oldHeatmapPath !== nextHeatmapPath) {
    await fsp.rename(oldHeatmapPath, nextHeatmapPath).catch(() => {});
    db.updateItem(itemId, { heatmap_path: nextHeatmapPath });
  }
  emit('library:changed');
  return serializeLibraryItem(db.getItemById(itemId), new Map(db.listLatestHeatmapJobs().map((job) => [job.item_id, job])));
});
ipcMain.handle('library:delete', async (_event, itemId) => {
  const item = db.getItemById(itemId);
  if (!item) return true;
  const activeJob = db.latestHeatmapJobForItem(itemId);
  if (activeJob && (activeJob.status === 'pending' || activeJob.status === 'running')) {
    await heatmapJobs.cancel(activeJob.job_id).catch(() => {});
  }
  const itemDir = path.join(app.getPath('userData'), 'library-items', String(item.item_id));
  if (item.path && fs.existsSync(item.path)) await shell.trashItem(item.path);
  if (item.heatmap_path && fs.existsSync(item.heatmap_path)) await shell.trashItem(item.heatmap_path).catch(() => {});
  if (item.import_payload_path && fs.existsSync(item.import_payload_path)) {
    await shell.trashItem(item.import_payload_path).catch(() => {});
  }
  db.deleteItem(itemId);
  if (fs.existsSync(itemDir)) {
    await fsp.rm(itemDir, { recursive: true, force: true }).catch(() => {});
  }
  emit('library:changed');
  return true;
});
ipcMain.handle('library:flags', (_event, itemId) => db.flagsForItem(itemId));
ipcMain.handle('library:loadHeatmap', (_event, itemId) => {
  const item = db.getItemById(itemId);
  if (!item?.heatmap_path || !fs.existsSync(item.heatmap_path)) return null;
  try {
    return JSON.parse(fs.readFileSync(item.heatmap_path, 'utf8'));
  } catch {
    return null;
  }
});

// --- Heatmap jobs ---------------------------------------------------------

ipcMain.handle('heatmap:buildFromTwitch', async (_event, { itemId, vodInput }) => {
  const result = await heatmapJobs.buildFromTwitch({ itemId, vodInput });
  emit('library:changed');
  return result;
});
ipcMain.handle('heatmap:pickImportFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return result.canceled ? null : result.filePaths[0] || null;
});
ipcMain.handle('heatmap:importNormalized', async (_event, { jsonPath }) => {
  const result = await heatmapJobs.importNormalized({ jsonPath });
  emit('library:changed');
  return result;
});
ipcMain.handle('heatmap:cancel', (_event, jobId) => heatmapJobs.cancel(jobId));

// --- Clip extraction ------------------------------------------------------

ipcMain.handle('clip:ghost', async (_event, { sourcePath, inSec, outSec }) => {
  const { clipsDir } = ensureDirs();
  const output = await clip.ghostClip({ sourcePath, outDir: clipsDir, inSec, outSec });
  await refreshIndex({ notify: true });
  return output;
});
ipcMain.handle('clip:vertical', async (_event, { sourcePath, inSec, outSec, crop }) => {
  const { clipsDir } = ensureDirs();
  const output = await clip.verticalReframe({
    sourcePath,
    outDir: clipsDir,
    inSec,
    outSec,
    crop,
    onProgress: (sec) => emit('clip:progress', { sec })
  });
  await refreshIndex({ notify: true });
  return output;
});

// --- Drive ----------------------------------------------------------------

ipcMain.handle('drive:status', () => drive.status(store));
ipcMain.handle('drive:startAuth', async () => drive.startAuth(store, (url) => shell.openExternal(url)));
ipcMain.handle('drive:disconnect', () => drive.disconnect(store));
ipcMain.handle('drive:upload', async (_event, filePath) => (
  drive.uploadWithProgress(store, filePath, (progress) => emit('drive:progress', { filePath, ...progress }))
));

// --- OBS / recording ------------------------------------------------------

ipcMain.handle('obs:connect', async () => obs.connect(store));
ipcMain.handle('obs:disconnect', async () => obs.disconnect());
ipcMain.handle('obs:status', () => obs.status());

ipcMain.handle('record:start', async (_event, { service, channel }) => {
  const { unfinishedDir } = ensureDirs();
  const result = await obs.startRecordingForChannel(store, { service, channel, outputDir: unfinishedDir });

  activeRecordingStartMs = Date.now();
  activeRecordingChannel = channel;
  activeRecordingService = service;

  if (store.get('chatHeatmap.enabled')) {
    activeChatRecorder = chat.createRecorder({
      service,
      channel,
      onBucketUpdate: (snapshot) => emit('heatmap:update', snapshot)
    });
  }

  if (store.get('transcription.enabled')) {
    whisper.startLive({
      label: `${service}-${channel}`,
      outputDir: store.get('transcription.outputDir') || unfinishedDir,
      model: store.get('transcription.model'),
      onLine: (text) => emit('transcript:line', { text })
    });
  }

  return result;
});

ipcMain.handle('record:stop', async () => {
  const stopResult = await obs.stopRecording();
  whisper.stopLive();

  const recordingStartedAt = activeRecordingStartMs;
  const recordingFinishedAt = Date.now();
  const recordingService = activeRecordingService;
  const recordingChannel = activeRecordingChannel;
  const recorder = activeChatRecorder;

  activeChatRecorder = null;
  activeRecordingStartMs = null;
  activeRecordingChannel = null;
  activeRecordingService = null;

  if (recorder && stopResult?.savedPath) {
    setTimeout(async () => {
      await refreshIndex({ notify: false });
      const item = db.getItemByPath(stopResult.savedPath);
      if (!item) return;

      const heatmapPath = heatmapPathForMedia(stopResult.savedPath);
      recorder.stop({
        heatmapPath,
        meta: {
          durationSec: item.duration || Math.max(1, (recordingFinishedAt - recordingStartedAt) / 1000),
          source: {
            kind: 'recording',
            service: recordingService,
            channel: recordingChannel
          }
        }
      });

      db.updateItem(item.item_id, {
        heatmap_path: heatmapPath,
        source_kind: item.source_kind || 'recording',
        source_service: recordingService,
        source_channel: recordingChannel,
        recorded_started_at: recordingStartedAt,
        recorded_finished_at: recordingFinishedAt
      });

      const orphanFlags = db.recentOrphanFlags(recordingChannel, recordingStartedAt);
      if (orphanFlags.length) {
        db.attachFlagsToItem(orphanFlags.map((flag) => flag.id), item.item_id, recordingStartedAt);
      }
      emit('library:changed');
    }, 2500);
  } else if (recorder) {
    recorder.stop();
  }

  return stopResult;
});

// --- Whisper --------------------------------------------------------------

ipcMain.handle('whisper:test', async () => whisper.selfTest());
ipcMain.handle('whisper:toggle', (_event, enabled) => {
  store.set('transcription.enabled', !!enabled);
  return store.get('transcription.enabled');
});

// --- Export ---------------------------------------------------------------

ipcMain.handle('export:run', async (_event, { platform, filePath, title, description, tags }) => (
  exporters.run(platform, {
    filePath,
    title,
    description,
    tags,
    credentials: store.get(`exports.${platform}`),
    onProgress: (progress) => emit('export:progress', { platform, filePath, ...progress })
  })
));

// --- Queue ----------------------------------------------------------------

ipcMain.handle('queue:enqueue', (_event, row) => {
  const id = db.enqueue(row);
  queue.kick();
  emit('queue:update', { id });
  return id;
});
ipcMain.handle('queue:list', () => db.listQueue());
ipcMain.handle('queue:clearDone', () => db.clearDoneQueue());

// --- Crash / dev ----------------------------------------------------------

ipcMain.handle('crash:simulate', () => {
  throw new Error('Simulated crash from Settings');
});
ipcMain.handle('dev:injectHeatmap', async (_event, itemId) => {
  const item = itemId ? db.getItemById(itemId) : db.listItems().find((row) => row.path);
  if (!item) throw new Error('No library item available.');

  const totalBuckets = Math.ceil((item.duration * 1000) / BUCKET_MS) || 120;
  const buckets = [];
  for (let index = 0; index < totalBuckets; index++) {
    let value = Math.random() * 0.5;
    if (Math.random() < 0.15) value += 3 + Math.random() * 10;
    if (value > 0.2) buckets.push({ t: index * BUCKET_MS, v: Number(value.toFixed(2)) });
  }

  const heatmapData = {
    bucketMs: BUCKET_MS,
    durationSec: item.duration,
    source: { kind: 'dev', service: 'dev', channel: 'fake-test' },
    buckets
  };
  const heatmapPath = item.path ? heatmapPathForMedia(item.path) : path.join(app.getPath('userData'), 'library-items', String(item.item_id), 'heatmap.parasite.json');
  fs.mkdirSync(path.dirname(heatmapPath), { recursive: true });
  fs.writeFileSync(heatmapPath, JSON.stringify(heatmapData, null, 2));
  db.updateItem(item.item_id, { heatmap_path: heatmapPath });
  emit('library:changed');
  return { itemId: item.item_id, name: item.name, heatmapPath, buckets: buckets.length };
});
ipcMain.handle('open:external', (_event, url) => shell.openExternal(url));

// --- App lifecycle --------------------------------------------------------

app.whenReady().then(async () => {
  const appDataDir = app.getPath('userData');
  crash.install({ appDataDir });
  db.init(appDataDir);
  ensureDirs();
  await refreshIndex();
  createWindow();
  registerHotkeys();
  queue.start({ store, emit });
  heatmapJobs.start({ appDataDir, store, emit });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (libraryWatcher) libraryWatcher.close().catch(() => {});
  whisper.stopLive();
  queue.stop();
  heatmapJobs.stop();
  obs.disconnect().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
