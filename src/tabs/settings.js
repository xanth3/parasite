// Settings tab.

const $ = (sel, root = document) => root.querySelector(sel);

let settings = null;
let _onChange;
let _toast;
let _activateUnedited;
let _deactivateUnedited;

export function registerUneditedGallery(activate, deactivate) {
  _activateUnedited = activate;
  _deactivateUnedited = deactivate;
}

export async function mountSettings({ onChange, toast }) {
  _onChange = onChange || (() => {});
  _toast = toast || (() => {});
  settings = await window.api.getSettings();
  hydrate();

  // Sub-tab switching
  document.querySelectorAll('#tab-settings .sub-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.settingsSub;
      document.querySelectorAll('#tab-settings .sub-tab').forEach(b => b.classList.toggle('active', b === btn));
      const showGeneral = sub === 'general';
      $('#settings-panel-general').hidden = !showGeneral;
      $('#settings-panel-unedited').hidden = showGeneral;
      if (showGeneral) {
        _deactivateUnedited?.();
      } else {
        _activateUnedited?.();
      }
    });
  });

  $('#btn-pick-folder').addEventListener('click', async () => {
    const picked = await window.api.pickVideoFolder();
    if (picked) {
      $('#set-video-root').value = picked;
      settings.videoRoot = picked;
    }
  });

  $('#btn-drive-auth').addEventListener('click', onDriveConnect);
  $('#btn-drive-disconnect').addEventListener('click', async () => {
    await window.api.drive.disconnect();
    $('#drive-state').textContent = 'Not connected';
    _onChange();
  });

  $('#btn-obs-connect').addEventListener('click', async () => {
    try {
      await persist();
      await window.api.obs.connect();
      $('#obs-state').textContent = 'Connected ✓';
      _onChange();
    } catch (e) { $('#obs-state').textContent = 'Error: ' + e.message; }
  });

  $('#btn-whisper-test').addEventListener('click', async () => {
    const res = await window.api.whisper.test();
    $('#whisper-state').textContent = res.ok ? 'Ready ✓' : ('Error: ' + res.error);
  });

  $('#set-whisper-enabled').addEventListener('change', async (e) => {
    await window.api.whisper.toggle(e.target.checked);
    _onChange();
  });

  $('#btn-save-settings').addEventListener('click', async () => {
    await persist();
    const saved = $('#settings-saved');
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 1500);
    _onChange();
  });

  $('#btn-crash-test').addEventListener('click', async () => {
    try { await window.api.crash.simulate(); }
    catch (e) { _toast('Simulated crash triggered.', 'info'); }
  });

  if (window.api.isDev) {
    $('#dev-tools-card').hidden = false;
    $('#btn-inject-heatmap').addEventListener('click', async () => {
      const stateEl = $('#inject-heatmap-state');
      try {
        stateEl.textContent = 'Injecting…';
        const res = await window.api.dev.injectHeatmap();
        stateEl.textContent = `Done - ${res.buckets} buckets on "${res.name}". Switch to Library and click the file.`;
      } catch (e) {
        stateEl.textContent = 'Error: ' + e.message;
      }
    });
  }
}

function hydrate() {
  $('#set-video-root').value = settings.videoRoot;
  $('#set-threshold').value = settings.clipThresholdMinutes;

  $('#set-hotkey-mark').value = settings.hotkeys?.markClip || 'Control+Shift+X';
  $('#set-chat-enabled').checked = !!settings.chatHeatmap?.enabled;

  $('#set-drive-client').value = settings.drive?.clientId || '';
  $('#set-drive-secret').value = settings.drive?.clientSecret || '';
  $('#drive-state').textContent = settings.drive?.tokens ? 'Connected ✓' : 'Not connected';

  $('#set-obs-host').value = settings.obs?.host || 'localhost';
  $('#set-obs-port').value = settings.obs?.port || 4455;
  $('#set-obs-pass').value = settings.obs?.password || '';
  $('#set-obs-scene').value = settings.obs?.windowCaptureScene || 'Parasite Stream';
  $('#set-obs-source').value = settings.obs?.windowCaptureSource || 'Parasite Window Capture';

  $('#set-whisper-enabled').checked = !!settings.transcription?.enabled;
  $('#set-whisper-model').value = settings.transcription?.model || 'base.en';

  $('#set-yt-client').value  = settings.exports?.youtube?.clientId || '';
  $('#set-yt-secret').value  = settings.exports?.youtube?.clientSecret || '';
  $('#set-yt-refresh').value = settings.exports?.youtube?.refreshToken || '';

  $('#set-tt-key').value     = settings.exports?.tiktok?.clientKey || '';
  $('#set-tt-secret').value  = settings.exports?.tiktok?.clientSecret || '';
  $('#set-tt-access').value  = settings.exports?.tiktok?.accessToken || '';

  $('#set-ig-user').value    = settings.exports?.instagram?.userId || '';
  $('#set-ig-access').value  = settings.exports?.instagram?.accessToken || '';

  $('#set-tw-key').value           = settings.exports?.twitter?.apiKey || '';
  $('#set-tw-secret').value        = settings.exports?.twitter?.apiSecret || '';
  $('#set-tw-access').value        = settings.exports?.twitter?.accessToken || '';
  $('#set-tw-access-secret').value = settings.exports?.twitter?.accessSecret || '';
}

async function persist() {
  const patch = {
    videoRoot: $('#set-video-root').value,
    clipThresholdMinutes: Number($('#set-threshold').value) || 30,
    hotkeys: { ...settings.hotkeys, markClip: $('#set-hotkey-mark').value.trim() || 'Control+Shift+X' },
    chatHeatmap: { ...settings.chatHeatmap, enabled: $('#set-chat-enabled').checked },
    drive: {
      ...settings.drive,
      clientId:     $('#set-drive-client').value.trim(),
      clientSecret: $('#set-drive-secret').value.trim()
    },
    obs: {
      ...settings.obs,
      host: $('#set-obs-host').value.trim(),
      port: Number($('#set-obs-port').value) || 4455,
      password: $('#set-obs-pass').value,
      windowCaptureScene: $('#set-obs-scene').value.trim(),
      windowCaptureSource: $('#set-obs-source').value.trim()
    },
    transcription: {
      ...settings.transcription,
      enabled: $('#set-whisper-enabled').checked,
      model: $('#set-whisper-model').value
    },
    exports: {
      youtube:   { clientId: $('#set-yt-client').value.trim(), clientSecret: $('#set-yt-secret').value.trim(), refreshToken: $('#set-yt-refresh').value.trim() },
      tiktok:    { clientKey: $('#set-tt-key').value.trim(), clientSecret: $('#set-tt-secret').value.trim(), accessToken: $('#set-tt-access').value.trim() },
      instagram: { userId: $('#set-ig-user').value.trim(), accessToken: $('#set-ig-access').value.trim() },
      twitter:   {
        apiKey: $('#set-tw-key').value.trim(),
        apiSecret: $('#set-tw-secret').value.trim(),
        accessToken: $('#set-tw-access').value.trim(),
        accessSecret: $('#set-tw-access-secret').value.trim()
      }
    }
  };
  settings = await window.api.setSettings(patch);
}

async function onDriveConnect() {
  await persist();
  const stateEl = $('#drive-state');
  try {
    stateEl.textContent = 'Waiting for browser authorization…';
    const res = await window.api.drive.startAuth();
    stateEl.textContent = res.connected ? 'Connected ✓' : 'Auth failed';
    _onChange();
  } catch (e) {
    stateEl.textContent = 'Error: ' + e.message;
  }
}
