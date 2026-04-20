// Parasite — Electron main process
// Owns: window lifecycle, filesystem access, SQLite index, Drive OAuth,
// OBS websocket, chat heatmap, Whisper transcription, clip extraction,
// batch queue, global hotkeys, crash reporting, and IPC to the renderer.

// GPU acceleration / smooth-scroll hints must be set before app.ready.
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

// --- Settings store -----------------------------------------------------

const defaultVideoRoot = path.join(os.homedir(), 'Videos', 'Parasite');
const store = new Store({
  defaults: {
    videoRoot: defaultVideoRoot,
    clipsFolderName: 'Clips',
    unfinishedFolderName: 'Unedited',
    clipThresholdMinutes: 30,
    drive: { enabled: false, defaultFolderId: null, defaultFolderName: 'Parasite Uploads' },
    obs: {
      host: 'localhost', port: 4455, password: '',
      windowCaptureScene: 'Parasite Stream',
      windowCaptureSource: 'Parasite Window Capture'
    },
    transcription: { enabled: false, model: 'base.en', outputDir: null },
    exports: {
      youtube: { clientId: '', clientSecret: '', refreshToken: '' },
      tiktok:  { clientKey: '', clientSecret: '', accessToken: '' },
      instagram: { userId: '', accessToken: '' },
      twitter: { apiKey: '', apiSecret: '', accessToken: '', accessSecret: '' }
    },
    streamTargets: { twitch: ['zackrawrr', 'lirik'], kick: [''] },
    hotkeys: { markClip: 'Control+Shift+X' },
    chatHeatmap: { enabled: true }
  }
});

// --- Library scanning (DB-backed) ---------------------------------------

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v']);

function ensureDirs() {
  const root = store.get('videoRoot');
  const clipsDir = path.join(root, store.get('clipsFolderName'));
  const unDir    = path.join(root, store.get('unfinishedFolderName'));
  for (const d of [root, clipsDir, unDir]) fs.mkdirSync(d, { recursive: true });
  return { root, clipsDir, unDir };
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => resolve(err || !meta?.format ? 0 : meta.format.duration || 0));
  });
}

async function walkVideos(dir) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...await walkVideos(full)); continue; }
    if (!VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fsp.stat(full);
    out.push({ path: full, name: entry.name, size: stat.size, mtime: stat.mtimeMs });
  }
  return out;
}

// Incremental index: only re-probe files whose size/mtime changed since
// the last scan. Full rescan would hit every file with ffprobe.
async function refreshIndex() {
  const files = await walkVideos(store.get('videoRoot'));
  const thresholdSec = store.get('clipThresholdMinutes') * 60;
  const seen = new Set();

  for (const f of files) {
    seen.add(f.path);
    const existing = db.getVideo(f.path);
    const changed = !existing || existing.size !== f.size || existing.mtime !== f.mtime;
    const duration = changed ? await probeDuration(f.path) : existing.duration;
    const category = duration >= thresholdSec ? 'unedited' : 'clips';
    db.upsertVideoRow({
      path: f.path, name: f.name, size: f.size, mtime: f.mtime,
      duration, category, probed_at: Date.now(),
      heatmap_path: existing?.heatmap_path || null
    });
  }

  // Drop rows whose files disappeared.
  for (const row of db.listVideos()) {
    if (!seen.has(row.path)) db.deleteVideo(row.path);
  }
}

// --- Window -------------------------------------------------------------

let mainWindow = null;
let libraryWatcher = null;
let activeChatRecorder = null;
let activeRecordingStartMs = null;
let activeRecordingChannel = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 720,
    title: 'Parasite',
    backgroundColor: '#202225',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // keep uploads/recording smooth when minimized
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  startLibraryWatcher();
}

function startLibraryWatcher() {
  if (libraryWatcher) libraryWatcher.close().catch(() => {});
  const { root } = ensureDirs();
  libraryWatcher = chokidar.watch(root, {
    ignoreInitial: true, depth: 4,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 }
  });
  const notify = async () => {
    await refreshIndex();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
  };
  libraryWatcher.on('add', notify).on('unlink', notify).on('change', notify);
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --- IPC: settings ------------------------------------------------------

ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:set', (_e, patch) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  registerHotkeys();
  startLibraryWatcher();
  return store.store;
});
ipcMain.handle('settings:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  store.set('videoRoot', res.filePaths[0]);
  await refreshIndex();
  startLibraryWatcher();
  return res.filePaths[0];
});

// --- IPC: library -------------------------------------------------------

ipcMain.handle('library:list', async () => {
  await refreshIndex();
  const rows = db.listVideos();
  return rows.map((r) => ({
    path: r.path, name: r.name, size: r.size, mtime: r.mtime,
    duration: r.duration, category: r.category, heatmap_path: r.heatmap_path
  }));
});
ipcMain.handle('library:reveal', (_e, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle('library:rename', async (_e, filePath, newName) => {
  const dir = path.dirname(filePath);
  const clean = newName.replace(/[\\/:"*?<>|]+/g, '').trim();
  if (!clean) throw new Error('Invalid filename');
  const ext = path.extname(filePath);
  const finalName = clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
  const target = path.join(dir, finalName);
  await fsp.rename(filePath, target);
  db.renameVideo(filePath, target, finalName);
  return target;
});
ipcMain.handle('library:delete', async (_e, filePath) => {
  await shell.trashItem(filePath);
  db.deleteVideo(filePath);
  return true;
});
ipcMain.handle('library:flags', (_e, filePath) => db.flagsForVideo(filePath));
ipcMain.handle('library:heatmap', (_e, heatmapPath) => {
  if (!heatmapPath || !fs.existsSync(heatmapPath)) return null;
  try { return JSON.parse(fs.readFileSync(heatmapPath, 'utf8')); } catch { return null; }
});

// --- IPC: clip (ghost / vertical) --------------------------------------

ipcMain.handle('clip:ghost', async (_e, { sourcePath, inSec, outSec }) => {
  const { clipsDir } = ensureDirs();
  const out = await clip.ghostClip({ sourcePath, outDir: clipsDir, inSec, outSec });
  await refreshIndex();
  return out;
});
ipcMain.handle('clip:vertical', async (_e, { sourcePath, inSec, outSec, crop }) => {
  const { clipsDir } = ensureDirs();
  const out = await clip.verticalReframe({
    sourcePath, outDir: clipsDir, inSec, outSec, crop,
    onProgress: (sec) => emit('clip:progress', { sec })
  });
  await refreshIndex();
  return out;
});

// --- IPC: drive --------------------------------------------------------

ipcMain.handle('drive:status', () => drive.status(store));
ipcMain.handle('drive:startAuth', async () => drive.startAuth(store, (url) => shell.openExternal(url)));
ipcMain.handle('drive:disconnect', () => drive.disconnect(store));
ipcMain.handle('drive:upload', async (_e, filePath) => {
  return drive.uploadWithProgress(store, filePath, (p) => emit('drive:progress', { filePath, ...p }));
});

// --- IPC: OBS / recording ---------------------------------------------

ipcMain.handle('obs:connect', async () => obs.connect(store));
ipcMain.handle('obs:disconnect', async () => obs.disconnect());
ipcMain.handle('obs:status', () => obs.status());

ipcMain.handle('record:start', async (_e, { service, channel }) => {
  const { root } = ensureDirs();
  const outputDir = path.join(root, store.get('unfinishedFolderName'));
  const result = await obs.startRecordingForChannel(store, { service, channel, outputDir });

  activeRecordingStartMs = Date.now();
  activeRecordingChannel = channel;

  // Chat heatmap
  if (store.get('chatHeatmap.enabled')) {
    const heatmapFile = path.join(outputDir, `heatmap-${service}-${channel}-${Date.now()}.json`);
    activeChatRecorder = chat.createRecorder({
      service, channel, heatmapPath: heatmapFile,
      onBucketUpdate: (snap) => emit('heatmap:update', snap)
    });
    // Stash intended path so we can attach it to the saved video later
    result.heatmapPath = heatmapFile;
  }

  // Live transcription
  if (store.get('transcription.enabled')) {
    whisper.startLive({
      label: `${service}-${channel}`,
      outputDir: store.get('transcription.outputDir') || outputDir,
      model: store.get('transcription.model'),
      onLine: (text) => emit('transcript:line', { text })
    });
  }

  return result;
});

ipcMain.handle('record:stop', async () => {
  const r = await obs.stopRecording();
  whisper.stopLive();

  // Finalize chat heatmap + attach to video row
  if (activeChatRecorder) {
    const heatmapPath = activeChatRecorder.stop();
    if (r?.savedPath) {
      // Wait a beat for the file to settle, then upsert.
      setTimeout(async () => {
        await refreshIndex();
        const row = db.getVideo(r.savedPath);
        if (row) db.upsertVideoRow({ ...row, heatmap_path: heatmapPath });
        // Attach any hotkey flags captured during this recording
        const orphan = db.recentOrphanFlags(activeRecordingChannel, activeRecordingStartMs);
        if (orphan.length) db.attachFlagsToVideo(orphan.map((o) => o.id), r.savedPath, activeRecordingStartMs);
        emit('library:changed');
      }, 2500);
    }
    activeChatRecorder = null;
  }
  activeRecordingStartMs = null;
  activeRecordingChannel = null;
  return r;
});

// --- IPC: whisper ------------------------------------------------------

ipcMain.handle('whisper:test', async () => whisper.selfTest());
ipcMain.handle('whisper:toggle', (_e, enabled) => {
  store.set('transcription.enabled', !!enabled);
  return store.get('transcription.enabled');
});

// --- IPC: export (direct) ----------------------------------------------

ipcMain.handle('export:run', async (_e, { platform, filePath, title, description, tags }) => {
  return exporters.run(platform, {
    filePath, title, description, tags,
    credentials: store.get(`exports.${platform}`),
    onProgress: (p) => emit('export:progress', { platform, filePath, ...p })
  });
});

// --- IPC: queue --------------------------------------------------------

ipcMain.handle('queue:enqueue', (_e, row) => {
  const id = db.enqueue(row);
  queue.kick();
  emit('queue:update', { id });
  return id;
});
ipcMain.handle('queue:list',       ()        => db.listQueue());
ipcMain.handle('queue:clearDone',  ()        => db.clearDoneQueue());

// --- IPC: crash --------------------------------------------------------

ipcMain.handle('crash:simulate',   ()        => { throw new Error('Simulated crash from Settings'); });
ipcMain.handle('open:external',    (_e, url) => shell.openExternal(url));

// --- Global hotkeys ----------------------------------------------------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const binding = store.get('hotkeys.markClip') || 'Control+Shift+X';
  try {
    const ok = globalShortcut.register(binding, () => {
      // Capture a timestamp now. If a recording is active we link it to
      // that session; otherwise it's an "orphan" flag saved by wall-clock.
      const id = db.insertFlag({
        video_path: null,
        channel: activeRecordingChannel,
        created_at: Date.now(),
        offset_ms: activeRecordingStartMs ? Date.now() - activeRecordingStartMs : null,
        note: 'Marked via hotkey'
      });
      emit('flag:captured', { id, when: Date.now() });
    });
    if (!ok) console.error('[hotkey] failed to register', binding);
  } catch (e) {
    console.error('[hotkey] error', e.message);
  }
}

// --- App lifecycle -----------------------------------------------------

app.whenReady().then(async () => {
  crash.install({ appDataDir: app.getPath('userData') });
  db.init(app.getPath('userData'));
  ensureDirs();
  await refreshIndex();
  createWindow();
  registerHotkeys();
  queue.start({ store, emit });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (libraryWatcher) libraryWatcher.close().catch(() => {});
  whisper.stopLive();
  queue.stop();
  obs.disconnect().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
