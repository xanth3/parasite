// Record Stream tab. Channel picker, start/stop recording, live chat
// heatmap + live transcript.

const $ = (sel, root = document) => root.querySelector(sel);

let selected = null;
let _toast;
let liveBuckets = [];

export async function mountRecord({ toast }) {
  _toast = toast;

  // Render channel cards from settings (twitch has defaults)
  const settings = await window.api.getSettings();
  renderServiceChannels('twitch', settings.streamTargets?.twitch || ['zackrawrr', 'lirik']);
  renderServiceChannels('kick', settings.streamTargets?.kick || []);

  // Wire "+ Add" buttons
  document.querySelectorAll('#tab-record .add-channel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.service;
      const name = prompt(`Add a ${service} channel:`);
      if (!name) return;
      const s = await window.api.getSettings();
      const existing = s.streamTargets?.[service] || [];
      const next = [...new Set([...existing, name.trim()])].filter(Boolean);
      await window.api.setSettings({ streamTargets: { ...s.streamTargets, [service]: next } });
      renderServiceChannels(service, next);
    });
  });

  $('#btn-record-start').addEventListener('click', onStart);
  $('#btn-record-stop').addEventListener('click',  onStop);

  // Live transcript
  const body = $('#transcript-body');
  window.api.whisper.onLine(({ text }) => {
    if (body.firstElementChild?.tagName === 'EM') body.innerHTML = '';
    const line = document.createElement('div');
    line.textContent = text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  });

  // Live heatmap
  window.api.heatmap.onUpdate((snap) => {
    liveBuckets = snap.buckets || [];
    $('#live-heatmap-status').textContent = `${liveBuckets.length} bucket${liveBuckets.length === 1 ? '' : 's'}`;
    drawLiveHeatmap();
  });
  new ResizeObserver(drawLiveHeatmap).observe($('#live-heatmap'));

  // Reflect hotkey in the hint
  $('#mark-hotkey-display').textContent = settings.hotkeys?.markClip || 'Control+Shift+X';
}

function renderServiceChannels(service, channels) {
  const host = $(service === 'twitch' ? '#twitch-channels' : '#kick-channels');
  host.innerHTML = '';
  for (const ch of channels) {
    if (!ch) continue;
    const b = document.createElement('button');
    b.className = 'channel';
    b.textContent = ch;
    b.dataset.service = service;
    b.dataset.channel = ch;
    b.addEventListener('click', () => choose(service, ch));
    host.appendChild(b);
  }
}

function choose(service, channel) {
  selected = { service, channel };
  document.querySelectorAll('#tab-record .channel').forEach((c) => c.classList.remove('selected'));
  document.querySelector(`#tab-record .channel[data-service="${service}"][data-channel="${channel}"]`)?.classList.add('selected');
  $('#recording-target').textContent = `${service} / ${channel}`;
}

async function onStart() {
  if (!selected) { _toast('Pick a channel first.', 'error'); return; }
  try {
    const res = await window.api.obs.startRecord(selected);
    $('#btn-record-start').hidden = true;
    $('#btn-record-stop').hidden = false;
    $('#record-state').className = 'state state-recording';
    $('#record-state').textContent = '● Recording';
    $('#transcript-status').textContent = 'listening…';
    $('#live-heatmap-status').textContent = 'waiting for chat…';
    liveBuckets = [];
    drawLiveHeatmap();
    _toast(`Recording ${selected.service}/${selected.channel} → ${res.outputDir}`, 'success');
  } catch (e) {
    _toast('Failed to start recording: ' + e.message, 'error');
  }
}

async function onStop() {
  try {
    const res = await window.api.obs.stopRecord();
    $('#btn-record-start').hidden = false;
    $('#btn-record-stop').hidden = true;
    $('#record-state').className = 'state state-idle';
    $('#record-state').textContent = 'Idle';
    $('#transcript-status').textContent = '—';
    _toast(res.savedPath ? `Saved: ${res.savedPath}` : 'Recording stopped.', 'success');
  } catch (e) {
    _toast('Failed to stop: ' + e.message, 'error');
  }
}

function drawLiveHeatmap() {
  const c = $('#live-heatmap');
  const rect = c.getBoundingClientRect();
  c.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
  c.height = Math.floor(60 * devicePixelRatio);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!liveBuckets.length) return;
  const max = Math.max(1, ...liveBuckets.map((b) => b.v));
  const total = liveBuckets.length;
  const colW = c.width / Math.max(30, total); // reserve minimum width
  liveBuckets.forEach((b, i) => {
    const h = (b.v / max) * c.height;
    const grd = ctx.createLinearGradient(0, c.height, 0, c.height - h);
    grd.addColorStop(0, '#ed4245');
    grd.addColorStop(1, '#faa61a');
    ctx.fillStyle = grd;
    ctx.fillRect(i * colW, c.height - h, Math.max(1, colW - 1), h);
  });
}
