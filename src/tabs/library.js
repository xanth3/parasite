// Library tab: virtualized list, video preview with chat heatmap scrubber,
// in/out markers + Ghost Clip, 9:16 crop overlay + vertical export, queue,
// rename / upload / export / reveal / delete.

import { VirtualList } from '../lib-ui/vlist.js';

const $ = (sel, root = document) => root.querySelector(sel);

let allFiles = [];
let currentSub = 'clips';
let currentFile = null;
let currentFlags = [];
let currentHeatmap = null;
let inPoint = null;
let outPoint = null;
let vlist = null;
let _toast;
let pendingPlatform = null;

// Normalized 9:16 crop (x, y, w, h) — persists across files.
let crop = { x: 0.275, y: 0, w: 0.45, h: 1.0 };
let cropActive = false;

export async function mountLibrary({ toast }) {
  _toast = toast;

  document.querySelectorAll('#tab-library .sub-tab').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#tab-library .sub-tab').forEach((s) => s.classList.remove('active'));
      el.classList.add('active');
      currentSub = el.dataset.sub;
      renderList();
    });
  });

  $('#search').addEventListener('input', renderList);
  $('#refresh').addEventListener('click', refresh);
  $('#open-folder').addEventListener('click', async () => {
    if (allFiles[0]) await window.api.revealInFolder(allFiles[0].path);
    else _toast('Library is empty.', 'info');
  });

  $('#filename-save').addEventListener('click', onRename);
  $('#btn-reveal').addEventListener('click', () => currentFile && window.api.revealInFolder(currentFile.path));
  $('#btn-delete').addEventListener('click', onDelete);
  $('#btn-upload').addEventListener('click', onUpload);
  $('#btn-queue-add').addEventListener('click', () => {
    if (!currentFile) return;
    enqueueAction('drive', {});
  });

  // Export menu
  const exportMenu = $('#export-menu');
  $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; });
  document.addEventListener('click', () => { exportMenu.hidden = true; });
  exportMenu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); onExportChoose(b.dataset.platform); });
  });
  $('#export-confirm').addEventListener('click', () => onExportFinalize(false));
  $('#export-queue').addEventListener('click',   () => onExportFinalize(true));
  $('#export-cancel').addEventListener('click',  () => { $('#export-title-wrap').hidden = true; pendingPlatform = null; });

  // Clip controls
  $('#btn-mark-in').addEventListener('click',  () => setInOut('in'));
  $('#btn-mark-out').addEventListener('click', () => setInOut('out'));
  $('#btn-ghost-clip').addEventListener('click', onGhostClip);
  $('#btn-vertical').addEventListener('click',   onToggleVertical);

  // Video + scrub
  const video = $('#video-player');
  video.addEventListener('timeupdate', updateScrubHead);
  video.addEventListener('loadedmetadata', () => {
    drawHeatmap();
    renderInOutBand();
    renderFlags();
  });
  $('#scrub-track').addEventListener('click', onScrubClick);
  $('#heatmap-canvas').addEventListener('click', onHeatmapClick);

  // Crop drag
  initCropDrag();

  // Live progress listeners
  window.api.drive.onProgress((p) => showProgress(`Uploading to Drive… ${Math.round(p.pct * 100)}%`, p.pct, p.done));
  window.api.export.onProgress((p) => showProgress(`Exporting to ${p.platform}… ${Math.round(p.pct * 100)}%`, p.pct, p.done));
  window.api.clip.onProgress(({ sec }) => showProgress(`Encoding vertical clip… ${sec.toFixed(1)}s rendered`, 0.5, false));
  window.api.onLibraryChange(() => refresh());
  window.api.onFlagCaptured(() => { if (currentFile) loadFlags(currentFile.path); _toast('Flagged this moment.', 'success'); });

  // Initialize the virtualized list
  vlist = new VirtualList({
    viewport: $('#vlist-viewport'),
    spacer: $('#vlist-spacer'),
    rows: $('#vlist-rows'),
    rowHeight: 60,
    renderRow: renderFileRow
  });

  await refresh();
}

async function refresh() {
  try {
    allFiles = await window.api.listLibrary();
    renderList();
  } catch (e) { _toast(`Failed to list library: ${e.message}`, 'error'); }
}

function filtered() {
  const q = ($('#search').value || '').trim().toLowerCase();
  return allFiles.filter((f) => f.category === currentSub && (!q || f.name.toLowerCase().includes(q)));
}

function renderList() {
  const list = filtered();
  const container = $('#file-list');
  if (!list.length) {
    container.classList.add('empty-state');
    $('#vlist-empty').textContent = `No ${currentSub === 'clips' ? 'clips (under 30 min)' : 'unedited (30 min+)'} yet.`;
    vlist.setItems([]);
    return;
  }
  container.classList.remove('empty-state');
  vlist.setItems(list);
}

function renderFileRow(f, index) {
  const row = document.createElement('div');
  row.className = 'file-row' + (currentFile?.path === f.path ? ' active' : '');
  row.innerHTML = `
    <div class="file-thumb">${f.heatmap_path ? '🔥' : '🎞'}</div>
    <div class="file-meta">
      <div class="file-name"></div>
      <div class="file-sub"></div>
    </div>
    <div class="file-duration"></div>
  `;
  row.querySelector('.file-name').textContent = f.name;
  row.querySelector('.file-sub').textContent = `${humanSize(f.size)} • ${humanTime(f.mtime)}`;
  row.querySelector('.file-duration').textContent = humanDuration(f.duration);
  row.addEventListener('click', () => select(f));
  return row;
}

function humanDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
               : `${m}:${String(s).padStart(2,'0')}`;
}
function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}
function humanTime(ms) { return new Date(ms).toLocaleString(); }

async function select(file) {
  currentFile = file;
  inPoint = null; outPoint = null; currentHeatmap = null; currentFlags = [];
  $('#preview .preview-empty').hidden = true;
  $('#preview .preview-body').hidden = false;

  const video = $('#video-player');
  video.src = 'file:///' + file.path.replace(/\\/g, '/').replace(/^\/+/, '');
  video.load();

  $('#filename-input').value = file.name;
  $('#meta-duration').textContent = humanDuration(file.duration);
  $('#meta-size').textContent = humanSize(file.size);
  $('#meta-mtime').textContent = humanTime(file.mtime);
  $('#meta-category').textContent = file.category === 'clips' ? 'Clip' : 'Unedited';
  $('#in-time').textContent = '—';
  $('#out-time').textContent = '—';

  vlist.refresh();

  if (file.heatmap_path) currentHeatmap = await window.api.loadHeatmap(file.heatmap_path);
  await loadFlags(file.path);
  drawHeatmap();
  renderInOutBand();
  renderFlags();
}

async function loadFlags(p) {
  currentFlags = await window.api.flagsForVideo(p) || [];
  renderFlags();
}

// ------ Scrub / heatmap rendering ------

function drawHeatmap() {
  const canvas = $('#heatmap-canvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
  canvas.height = Math.floor(28 * window.devicePixelRatio);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const duration = $('#video-player').duration;
  if (!duration) return;

  if (!currentHeatmap || !currentHeatmap.buckets?.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const max = Math.max(1, ...currentHeatmap.buckets.map((b) => b.v));
  const bucketMs = currentHeatmap.bucketMs || 30000;
  const totalBuckets = Math.ceil((duration * 1000) / bucketMs);
  const colW = canvas.width / totalBuckets;
  for (const b of currentHeatmap.buckets) {
    const idx = Math.floor(b.t / bucketMs);
    if (idx < 0 || idx >= totalBuckets) continue;
    const intensity = b.v / max;
    ctx.fillStyle = heatColor(intensity);
    ctx.fillRect(idx * colW, 0, Math.max(1, colW), canvas.height);
  }
}

function heatColor(t) {
  // 0 = dark, 1 = red. Simple linear.
  const r = Math.round(80 + t * 175);
  const g = Math.round(50 + (1 - t) * 60);
  const b = Math.round(60 + (1 - t) * 60);
  return `rgba(${r}, ${g}, ${b}, ${0.3 + t * 0.7})`;
}

function updateScrubHead() {
  const video = $('#video-player');
  if (!video.duration) return;
  const pct = video.currentTime / video.duration;
  $('#scrub-played').style.width = `${pct * 100}%`;
  $('#scrub-head').style.left = `${pct * 100}%`;
}

function renderInOutBand() {
  const band = $('#scrub-inout');
  const video = $('#video-player');
  if (inPoint == null || outPoint == null || !video.duration) { band.hidden = true; return; }
  const a = (inPoint / video.duration) * 100;
  const b = (outPoint / video.duration) * 100;
  band.hidden = false;
  band.style.left = `${Math.min(a, b)}%`;
  band.style.width = `${Math.abs(b - a)}%`;
}

function renderFlags() {
  const wrap = $('#scrub-flags');
  wrap.innerHTML = '';
  const video = $('#video-player');
  if (!video.duration) return;
  for (const f of currentFlags) {
    if (f.offset_ms == null) continue;
    const pct = (f.offset_ms / 1000) / video.duration;
    if (pct < 0 || pct > 1) continue;
    const el = document.createElement('div');
    el.className = 'scrub-flag';
    el.style.left = `${pct * 100}%`;
    el.title = f.note || 'Flagged';
    wrap.appendChild(el);
  }
}

function onScrubClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const v = $('#video-player');
  if (v.duration) v.currentTime = pct * v.duration;
}
function onHeatmapClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const v = $('#video-player');
  if (v.duration) v.currentTime = pct * v.duration;
}

// ------ In/Out + Ghost clip ------

function setInOut(which) {
  const t = $('#video-player').currentTime;
  if (which === 'in')  { inPoint  = t; $('#in-time').textContent  = humanDuration(t); }
  if (which === 'out') { outPoint = t; $('#out-time').textContent = humanDuration(t); }
  renderInOutBand();
}

async function onGhostClip() {
  if (!currentFile) return;
  if (inPoint == null || outPoint == null || outPoint <= inPoint) {
    _toast('Mark In and Out first (In < Out).', 'error'); return;
  }
  try {
    showProgress(`Snipping clip (stream copy)…`, 0.2, false);
    const out = await window.api.clip.ghost({ sourcePath: currentFile.path, inSec: inPoint, outSec: outPoint });
    showProgress('Clip saved.', 1, true);
    _toast(`Saved: ${out.split(/[/\\]/).pop()}`, 'success');
  } catch (e) {
    showProgress('', 0, true);
    _toast('Ghost clip failed: ' + e.message, 'error');
  }
}

// ------ 9:16 overlay + vertical export ------

function onToggleVertical() {
  cropActive = !cropActive;
  $('#crop-overlay').hidden = !cropActive;
  if (cropActive) positionCropBox();
}

function positionCropBox() {
  const overlay = $('#crop-overlay');
  const video = $('#video-player');
  const box = $('#crop-box');
  const vw = video.clientWidth, vh = video.clientHeight;
  overlay.style.width = `${vw}px`;
  overlay.style.height = `${vh}px`;
  box.style.width  = `${crop.w * vw}px`;
  box.style.height = `${crop.h * vh}px`;
  box.style.left   = `${crop.x * vw}px`;
  box.style.top    = `${crop.y * vh}px`;
}

function initCropDrag() {
  const box = $('#crop-box');
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  box.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = parseFloat(box.style.left || 0);
    startTop  = parseFloat(box.style.top || 0);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const video = $('#video-player');
    const vw = video.clientWidth, vh = video.clientHeight;
    const newLeft = Math.max(0, Math.min(vw - box.offsetWidth,  startLeft + (e.clientX - startX)));
    const newTop  = Math.max(0, Math.min(vh - box.offsetHeight, startTop  + (e.clientY - startY)));
    box.style.left = `${newLeft}px`;
    box.style.top  = `${newTop}px`;
    crop.x = newLeft / vw;
    crop.y = newTop / vh;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('resize', () => { if (cropActive) positionCropBox(); });
}

// ------ Rename / delete / upload ------

async function onRename() {
  if (!currentFile) return;
  const newName = $('#filename-input').value.trim();
  if (!newName) return;
  try {
    const newPath = await window.api.renameFile(currentFile.path, newName);
    _toast('Renamed.', 'success');
    currentFile = { ...currentFile, path: newPath, name: newPath.split(/[/\\]/).pop() };
    await refresh();
  } catch (e) { _toast('Rename failed: ' + e.message, 'error'); }
}
async function onDelete() {
  if (!currentFile) return;
  if (!confirm(`Move "${currentFile.name}" to Trash?`)) return;
  try {
    await window.api.deleteFile(currentFile.path);
    currentFile = null;
    $('#preview .preview-empty').hidden = false;
    $('#preview .preview-body').hidden = true;
    await refresh();
  } catch (e) { _toast('Delete failed: ' + e.message, 'error'); }
}
async function onUpload() {
  if (!currentFile) return;
  try {
    showProgress('Uploading to Drive…', 0, false);
    const res = await window.api.drive.upload(currentFile.path);
    showProgress('Uploaded.', 1, true);
    _toast(`Uploaded: ${res.name}`, 'success');
  } catch (e) {
    showProgress('', 0, true);
    _toast('Upload failed: ' + e.message, 'error');
  }
}

// ------ Export ------

function onExportChoose(platform) {
  pendingPlatform = platform;
  $('#export-title-wrap').hidden = false;
  $('#export-title').value = suggestHook(currentFile?.name || '');
  $('#export-title').focus();
  $('#export-useinout').checked = platform === 'tiktok' && inPoint != null && outPoint != null;
}
function suggestHook(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_\-]/g, ' ');
  const punchy = ['UNBELIEVABLE:', 'INSANE:', 'HE LOST IT:', 'WORST MISTAKE EVER:', 'THIS WENT TOO FAR:'];
  return `${punchy[Math.floor(Math.random() * punchy.length)]} ${base}`;
}

async function onExportFinalize(asQueue) {
  if (!currentFile || !pendingPlatform) return;
  const title = $('#export-title').value.trim();
  const useInOut = $('#export-useinout').checked;
  $('#export-title-wrap').hidden = true;
  const platform = pendingPlatform;
  pendingPlatform = null;

  try {
    let sourcePath = currentFile.path;
    // For TikTok vertical we auto-reframe + stream-copy-or-encode the In→Out region
    if (platform === 'tiktok') {
      if (!useInOut || inPoint == null || outPoint == null) {
        _toast('TikTok export needs an In/Out range.', 'error'); return;
      }
      showProgress('Reframing to 9:16…', 0.1, false);
      sourcePath = await window.api.clip.vertical({
        sourcePath: currentFile.path, inSec: inPoint, outSec: outPoint, crop
      });
      showProgress('Vertical clip ready. Uploading…', 0.5, false);
    } else if (useInOut && inPoint != null && outPoint != null) {
      showProgress('Snipping clip…', 0.1, false);
      sourcePath = await window.api.clip.ghost({ sourcePath: currentFile.path, inSec: inPoint, outSec: outPoint });
    }

    if (asQueue) {
      await window.api.queue.enqueue({
        video_path: sourcePath, action: platform,
        params: { title, description: title, tags: [] }
      });
      _toast(`Queued for ${platform}.`, 'success');
      showProgress('', 0, true);
      return;
    }

    showProgress(`Exporting to ${platform}…`, 0.6, false);
    const res = await window.api.export.run({
      platform, filePath: sourcePath, title, description: title, tags: []
    });
    showProgress('Done.', 1, true);
    _toast(`Published to ${platform}: ${res.url || res.id}`, 'success');
  } catch (e) {
    showProgress('', 0, true);
    _toast(`Export failed: ${e.message}`, 'error');
  }
}

async function enqueueAction(action, params) {
  if (!currentFile) return;
  await window.api.queue.enqueue({ video_path: currentFile.path, action, params });
  _toast(`Queued: ${action}`, 'success');
}

function showProgress(label, pct, done) {
  const wrap = $('#progress-wrap');
  wrap.hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-bar').style.width = `${Math.round((pct || 0) * 100)}%`;
  if (done) setTimeout(() => { wrap.hidden = true; }, 1500);
}
