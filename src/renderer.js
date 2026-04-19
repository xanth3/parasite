// Renderer — glues the DOM to the preload API.

import { mountLibrary } from './tabs/library.js';
import { mountRecord } from './tabs/record.js';
import { mountSettings } from './tabs/settings.js';
import { mountQueue } from './tabs/queue.js';

const $ = (sel) => document.querySelector(sel);

// Tab switching
const tabs = document.querySelectorAll('.tab');
const navItems = document.querySelectorAll('.nav-item');
navItems.forEach((item) => {
  item.addEventListener('click', () => {
    navItems.forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    const target = item.dataset.tab;
    tabs.forEach((t) => { t.hidden = t.id !== `tab-${target}`; });
  });
});

// Toast helper (shared)
export function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 4000);
}

// Status indicators
async function refreshIndicators() {
  try {
    const drive = await window.api.drive.status();
    $('#drive-indicator').className = 'dot ' + (drive.connected ? 'dot-on' : 'dot-off');
  } catch {}
  try {
    const obs = await window.api.obs.status();
    $('#obs-indicator').className = 'dot ' + (obs.connected ? 'dot-on' : 'dot-off');
  } catch {}
  const settings = await window.api.getSettings();
  $('#whisper-indicator').className = 'dot ' + (settings.transcription?.enabled ? 'dot-on' : 'dot-off');
  $('#chat-indicator').className    = 'dot ' + (settings.chatHeatmap?.enabled   ? 'dot-on' : 'dot-off');
}

// Boot
(async () => {
  await mountSettings({ onChange: refreshIndicators, toast });
  await mountLibrary({ toast });
  await mountRecord({ toast });
  await mountQueue({ toast });
  await refreshIndicators();
  setInterval(refreshIndicators, 5000);

  // Global toast when a flag is captured (any tab)
  window.api.onFlagCaptured(() => toast('Moment flagged.', 'success'));
})();
