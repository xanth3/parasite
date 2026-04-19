// OBS WebSocket integration.
// Assumes OBS Studio 28+ with WebSocket server enabled (Tools > WebSocket Server Settings).
// We drive a pre-made scene containing a Window Capture source, then
// point that source at the stream browser window and start recording.

const path = require('path');
const { spawn } = require('child_process');
const OBSWebSocket = require('obs-websocket-js').default;

const ws = new OBSWebSocket();
let connected = false;
let currentRecordingPath = null;

function status() {
  return { connected, currentRecordingPath };
}

async function connect(store) {
  if (connected) return { connected: true };
  const { host, port, password } = store.get('obs');
  await ws.connect(`ws://${host}:${port}`, password || undefined);
  connected = true;
  ws.on('ConnectionClosed', () => { connected = false; });
  return { connected: true };
}

async function disconnect() {
  if (!connected) return { connected: false };
  try { await ws.disconnect(); } catch {}
  connected = false;
  return { connected: false };
}

function streamUrlFor(service, channel) {
  if (service === 'twitch') return `https://www.twitch.tv/${channel}`;
  if (service === 'kick')   return `https://kick.com/${channel}`;
  throw new Error(`Unsupported service: ${service}`);
}

// Opens the stream URL in the default browser so OBS Window Capture has
// something to grab. OBS handles the actual frame capture — we just tell
// it which source to target and which directory to write to.
function openStreamWindow(service, channel) {
  const url = streamUrlFor(service, channel);
  const opener = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' })
    : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  opener.unref();
  return url;
}

async function startRecordingForChannel(store, { service, channel, outputDir }) {
  await connect(store);
  const { windowCaptureScene } = store.get('obs');

  // Set output directory so OBS writes to our Unedited folder
  await ws.call('SetRecordDirectory', { recordDirectory: outputDir });

  // Activate the configured scene
  try {
    await ws.call('SetCurrentProgramScene', { sceneName: windowCaptureScene });
  } catch (e) {
    throw new Error(
      `OBS scene "${windowCaptureScene}" not found. Create it in OBS with a Window Capture source ` +
      `(see Settings > OBS for the exact names we expect), or update the names in Settings.`
    );
  }

  // Launch the stream URL — user should drag the new browser window onto
  // the Window Capture source the first time. Subsequent runs reuse it.
  const url = openStreamWindow(service, channel);

  // Start recording
  await ws.call('StartRecord');

  // OBS names files with a timestamp pattern; we tag ours by setting the
  // filename format temporarily.
  const safe = `${service}-${channel}-%CCYY-%MM-%DD-%hh-%mm-%ss`;
  try {
    await ws.call('SetProfileParameter', {
      parameterCategory: 'Output',
      parameterName: 'FilenameFormatting',
      parameterValue: safe
    });
  } catch { /* older OBS versions may not accept this */ }

  currentRecordingPath = outputDir;
  return { started: true, outputDir, url };
}

async function stopRecording() {
  if (!connected) return { stopped: false };
  const res = await ws.call('StopRecord');
  const savedPath = res?.outputPath || null;
  currentRecordingPath = null;
  return { stopped: true, savedPath };
}

module.exports = { status, connect, disconnect, startRecordingForChannel, stopRecording };
