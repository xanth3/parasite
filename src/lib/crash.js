// Crash handler.
// - Enables Electron's built-in minidump crash reporter.
// - Catches main-process uncaughtException / unhandledRejection.
// - On fatal error, opens a dedicated crash.html window with a friendly
//   summary + hidden full report and a "Send Feedback" button that opens
//   the user's mail client with everything pre-filled.

const { app, BrowserWindow, crashReporter, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let crashLogDir = null;

function install({ appDataDir }) {
  crashLogDir = path.join(appDataDir, 'crashes');
  fs.mkdirSync(crashLogDir, { recursive: true });

  // Native crashes (renderer/main process segfaults) → minidumps.
  crashReporter.start({
    productName: 'Parasite',
    submitURL: '',                // local-only; we don't POST from here
    uploadToServer: false,
    compress: true,
    ignoreSystemCrashHandler: false
  });

  process.on('uncaughtException', (err) => fatal('uncaughtException', err));
  process.on('unhandledRejection', (err) => fatal('unhandledRejection', err));

  ipcMain.handle('crash:lastReport', () => readLatestReport());
  ipcMain.handle('crash:list', () => listReports());
}

function fatal(kind, err) {
  const report = buildReport(kind, err);
  const file = path.join(crashLogDir, `crash-${Date.now()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); } catch {}
  openCrashWindow(file);
}

function buildReport(kind, err) {
  return {
    kind,
    message: err?.message || String(err),
    stack:   err?.stack || '',
    when:    new Date().toISOString(),
    app:     { name: 'Parasite', version: app.getVersion?.() || 'unknown' },
    env: {
      platform: process.platform,
      arch:     process.arch,
      node:     process.versions?.node,
      electron: process.versions?.electron,
      os:       `${os.type()} ${os.release()}`,
      ram:      Math.round(os.totalmem() / (1024 ** 3)) + ' GB'
    },
    guess: guessCause(err)
  };
}

// A best-effort "what probably happened" based on stack signatures. No
// heavy lifting — just string matching so the user sees something more
// useful than "undefined is not a function".
function guessCause(err) {
  const msg = (err?.message || '') + '\n' + (err?.stack || '');
  if (/ECONN|ENOTFOUND|socket hang up/i.test(msg))
    return 'Network hiccup talking to Drive / a social platform. Retrying usually works.';
  if (/ENOENT/i.test(msg))
    return 'Parasite tried to read a file that was moved or deleted. Check the Library folder for missing videos.';
  if (/EACCES|EPERM/i.test(msg))
    return 'Windows denied access to a file. Confirm Parasite has permission to the Library folder.';
  if (/whisper/i.test(msg))
    return 'The Whisper model failed to run. First use downloads the model — make sure you have disk space and try Settings → Run self-test.';
  if (/obs|ws:\/\/localhost:4455/i.test(msg))
    return 'OBS WebSocket disconnected. In OBS, re-enable Tools → WebSocket Server Settings.';
  if (/ffmpeg|ffprobe/i.test(msg))
    return 'A video file could not be probed or sliced. It may be corrupt or still being written.';
  return 'Unexpected error. The report below has the full stack.';
}

function listReports() {
  if (!fs.existsSync(crashLogDir)) return [];
  return fs.readdirSync(crashLogDir).filter((f) => f.endsWith('.json')).sort().reverse();
}

function readLatestReport() {
  const files = listReports();
  if (!files.length) return null;
  const file = path.join(crashLogDir, files[0]);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function openCrashWindow(reportFile) {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    title: 'Parasite — Crash Report',
    backgroundColor: '#202225',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'crash.html'));
}

module.exports = { install, buildReport, readLatestReport, listReports };
