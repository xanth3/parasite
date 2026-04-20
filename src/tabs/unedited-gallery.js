// Unedited gallery — shows files ≥ 5 GB with full heatmap + video preview.

import { VirtualList } from '../lib-ui/vlist.js';

const $ = (sel, root = document) => root.querySelector(sel);
const FIVE_GB = 5 * 1024 * 1024 * 1024;

let allItems = [];
let currentItemId = null;
let currentItem = null;
let currentHeatmap = null;
let currentBucketLookup = new Map();
let currentHeatmapJob = null;
let selectionToken = 0;
let currentPreviewTimeSec = 0;
let runtimePlaybackError = null;
let vlist = null;
let _toast = () => {};
let isActive = false;

const tl = { detailStartSec: 0, detailWindowSec: 600, drag: null };

// ── Public API ────────────────────────────────────────────────────────────────

export async function mountUneditedGallery({ toast }) {
  _toast = toast;

  $('#btn-pick-unedited-folder').addEventListener('click', async () => {
    const picked = await window.api.pickVideoFolder();
    if (!picked) return;
    $('#set-unedited-root').value = picked;
    // Keep in sync with the general settings videoRoot
    const s = await window.api.getSettings();
    await window.api.setSettings({ ...s, videoRoot: picked });
    if (isActive) await refresh();
  });

  $('#unedited-btn-reset-zoom').addEventListener('click', () => {
    if (currentItem) { initTimelineWindow(currentItem); drawTimelines(); }
  });

  $('#unedited-btn-build-vod').addEventListener('click', onBuildFromTwitch);
  $('#unedited-btn-build-cancel').addEventListener('click', onCancelBuild);
  $('#unedited-btn-import-json').addEventListener('click', onImportNormalized);

  const video = $('#unedited-video-player');
  video.addEventListener('timeupdate', () => {
    currentPreviewTimeSec = video.currentTime || 0;
    drawTimelines();
  });
  video.addEventListener('loadedmetadata', () => {
    runtimePlaybackError = null;
    currentPreviewTimeSec = Math.min(currentPreviewTimeSec, getDuration());
    renderPlaybackState();
    drawTimelines();
  });
  video.addEventListener('error', () => {
    runtimePlaybackError = 'This media file could not be played in the viewer.';
    renderPlaybackState();
    drawTimelines();
  });

  bindTimelineEvents();

  window.api.heatmap.onProgress(onHeatmapProgress);
  window.api.heatmap.onFinished(onHeatmapFinished);
  window.api.heatmap.onError(onHeatmapError);

  window.api.onLibraryChange(() => { if (isActive) refresh(); });

  vlist = new VirtualList({
    viewport: $('#unedited-vlist-viewport'),
    spacer:   $('#unedited-vlist-spacer'),
    rows:     $('#unedited-vlist-rows'),
    rowHeight: 64,
    renderRow: renderItemRow
  });
}

export async function activateUneditedGallery() {
  isActive = true;
  const s = await window.api.getSettings();
  $('#set-unedited-root').value = s.videoRoot || '';
  await refresh();
}

export function deactivateUneditedGallery() {
  isActive = false;
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    allItems = await window.api.listLibrary();
    renderList();
    if (!currentItemId) return;
    const next = allItems.find(i => i.id === currentItemId);
    if (!next) { clearSelection(); return; }
    const reloadHeatmap = next.heatmap.path !== currentItem?.heatmap?.path;
    await syncCurrentItem(next, { reloadHeatmap });
  } catch (err) {
    _toast(`Failed to load unedited gallery: ${err.message}`, 'error');
  }
}

function filteredItems() {
  return allItems.filter(i => i.category === 'unedited' && i.size >= FIVE_GB);
}

function renderList() {
  const list = filteredItems();
  const container = $('#unedited-file-list');
  if (!list.length) {
    container.classList.add('empty-state');
    vlist.setItems([], {});
    return;
  }
  container.classList.remove('empty-state');
  vlist.setItems(list, {});
}

function renderItemRow(item) {
  const row = document.createElement('div');
  row.className = `file-row${currentItemId === item.id ? ' active' : ''}`;
  row.innerHTML = `
    <div class="file-thumb${item.heatmap.status === 'ready' ? ' has-heatmap' : ''}"></div>
    <div class="file-meta">
      <div class="file-name"></div>
      <div class="file-sub"></div>
    </div>
    <div class="file-duration"></div>
  `;
  row.querySelector('.file-thumb').textContent =
    item.heatmap.status === 'ready' ? 'MAP' : item.path ? 'VID' : 'IMP';
  row.querySelector('.file-name').textContent = item.name;
  row.querySelector('.file-sub').textContent =
    `${humanSize(item.size)} • ${humanTime(item.mtime)}` +
    (item.heatmap.status === 'building' ? ' • Building heatmap' : '');
  row.querySelector('.file-duration').textContent = humanDuration(item.duration);
  row.addEventListener('click', () => selectItem(item));
  return row;
}

async function selectItem(item) {
  currentItemId = item.id;
  await syncCurrentItem(item, { reloadHeatmap: true });
  vlist.refresh();
}

async function syncCurrentItem(item, { reloadHeatmap = false } = {}) {
  const token = ++selectionToken;
  currentItem = item;
  currentHeatmapJob = item.heatmap;
  currentPreviewTimeSec = 0;

  $('#unedited-preview-empty').hidden = true;
  $('#unedited-preview-body').hidden = false;

  initTimelineWindow(item);
  hydrateItemMeta(item);
  renderPlaybackState();
  updateBuildCard();

  if (reloadHeatmap) {
    currentHeatmap = item.heatmap.path ? await window.api.loadHeatmap(item.id) : null;
    currentBucketLookup = buildBucketLookup(currentHeatmap);
  }
  if (token !== selectionToken) return;

  loadVideo(item);
  hydrateItemMeta(item);
  renderPlaybackState();
  updateBuildCard();
  drawTimelines();
}

// ── Preview ───────────────────────────────────────────────────────────────────

function hydrateItemMeta(item) {
  $('#unedited-meta-duration').textContent = humanDuration(item.duration || currentHeatmap?.durationSec || 0);
  $('#unedited-meta-size').textContent = humanSize(item.size);
  $('#unedited-meta-mtime').textContent = humanTime(item.mtime);
  $('#unedited-meta-source').textContent = describeSource(item);
  $('#unedited-meta-playback').textContent = describePlayback(item);
  $('#unedited-heatmap-meta').textContent = describeHeatmap(item);
  $('#unedited-heatmap-suggestion').textContent = describeVodSuggestion(item);
}

function describeSource(item) {
  const parts = [];
  if (item.source.service) parts.push(item.source.service);
  if (item.source.channel) parts.push(item.source.channel);
  if (item.source.vodId) parts.push(`VOD ${item.source.vodId}`);
  return parts.length ? parts.join(' • ') : (item.path ? 'Local media' : 'Imported chat');
}

function describePlayback(item) {
  if (runtimePlaybackError) return runtimePlaybackError;
  if (!item.path) return 'Heatmap only';
  if (!item.playback.available) return item.playback.error || 'Unavailable';
  return 'Playable';
}

function describeHeatmap(item) {
  if (currentHeatmap?.buckets?.length) {
    const ms = currentHeatmap.bucketMs || 30000;
    return `${currentHeatmap.buckets.length} active buckets • ${Math.round(ms / 1000)}s resolution`;
  }
  if (item.heatmap.status === 'building') return item.heatmap.progressLabel || 'Building heatmap…';
  if (item.heatmap.status === 'error') return item.heatmap.error || 'Heatmap build failed.';
  if (item.heatmap.status === 'cancelled') return 'Heatmap build cancelled.';
  return 'No heatmap yet.';
}

function describeVodSuggestion(item) {
  if (item.source.vodId) return `Suggested Twitch VOD: https://www.twitch.tv/videos/${item.source.vodId}`;
  if (item.source.service === 'twitch' && item.source.channel && item.source.recordedStartedAt) {
    return `Recorded from twitch/${item.source.channel} on ${new Date(item.source.recordedStartedAt).toLocaleString()}. Paste the matching Twitch VOD URL.`;
  }
  if (item.source.service === 'twitch' && item.source.channel) {
    return `Recorded from twitch/${item.source.channel}. Paste the matching Twitch VOD URL or VOD ID.`;
  }
  return 'Paste a Twitch VOD URL or import normalized chat JSON.';
}

function renderPlaybackState() {
  const banner = $('#unedited-playback-banner');
  const unavailable = $('#unedited-video-unavailable');
  const video = $('#unedited-video-player');
  const hasMedia = !!currentItem?.path && !runtimePlaybackError;
  const errorText = runtimePlaybackError || null;
  banner.hidden = !errorText;
  banner.textContent = errorText || '';
  unavailable.hidden = hasMedia;
  video.hidden = !hasMedia;
}

function loadVideo(item) {
  const video = $('#unedited-video-player');
  if (!item.path) {
    runtimePlaybackError = 'No media attached.';
    video.pause();
    video.removeAttribute('src');
    video.load();
    renderPlaybackState();
    return;
  }
  const src = toFileUrl(item.path);
  if (video.dataset.itemId === String(item.id) && video.src === src) {
    renderPlaybackState();
    return;
  }
  runtimePlaybackError = null;
  video.muted = false;
  video.dataset.itemId = String(item.id);
  video.src = src;
  video.load();
  renderPlaybackState();
}

function updateBuildCard() {
  if (!currentItem) return;
  const card = $('#unedited-heatmap-build-card');
  card.hidden = currentItem.heatmap.status === 'ready';
  $('#unedited-btn-build-vod').disabled = currentItem.heatmap.status === 'building';
  $('#unedited-btn-build-cancel').hidden = currentItem.heatmap.status !== 'building';

  const vodInput = $('#unedited-vod-input');
  if (vodInput.dataset.itemId !== String(currentItem.id)) {
    vodInput.value = currentItem.source.vodId
      ? `https://www.twitch.tv/videos/${currentItem.source.vodId}`
      : '';
    vodInput.dataset.itemId = String(currentItem.id);
  }

  const wrap = $('#unedited-heatmap-job-wrap');
  const label = $('#unedited-heatmap-job-label');
  const bar = $('#unedited-heatmap-job-bar');
  const st = currentItem.heatmap.status;
  if (st === 'building') {
    wrap.hidden = false;
    label.textContent = currentItem.heatmap.progressLabel || 'Building heatmap…';
    bar.style.width = `${Math.round((currentItem.heatmap.progress || 0) * 100)}%`;
  } else if (st === 'error') {
    wrap.hidden = false;
    label.textContent = currentItem.heatmap.error || 'Heatmap build failed.';
    bar.style.width = '0%';
  } else if (st === 'cancelled') {
    wrap.hidden = false;
    label.textContent = 'Heatmap build cancelled.';
    bar.style.width = '0%';
  } else {
    wrap.hidden = true;
    bar.style.width = '0%';
  }
}

function clearSelection() {
  currentItemId = null;
  currentItem = null;
  currentHeatmap = null;
  currentBucketLookup = new Map();
  currentHeatmapJob = null;
  currentPreviewTimeSec = 0;
  runtimePlaybackError = null;
  $('#unedited-preview-empty').hidden = false;
  $('#unedited-preview-body').hidden = true;
}

// ── Timeline ──────────────────────────────────────────────────────────────────

function initTimelineWindow(item) {
  const dur = item.duration || currentHeatmap?.durationSec || 0;
  tl.detailWindowSec = clamp(dur ? Math.min(dur, 600) : 600, 30, Math.max(30, dur || 600));
  tl.detailStartSec = 0;
}

function bindTimelineEvents() {
  const overview = $('#unedited-heatmap-overview');
  const detail = $('#unedited-heatmap-detail');

  overview.addEventListener('click', (e) => {
    const dur = getDuration();
    if (!dur) return;
    const pct = clamp((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width, 0, 1);
    tl.detailStartSec = clamp(pct * dur - tl.detailWindowSec / 2, 0, Math.max(0, dur - tl.detailWindowSec));
    drawTimelines();
  });
  overview.addEventListener('mousemove', (e) => updateTooltip(e, overview, 'overview'));
  overview.addEventListener('mouseleave', hideTooltip);

  detail.addEventListener('mousedown', (e) => {
    const dur = getDuration();
    if (!dur) return;
    if (e.button === 2) {
      tl.drag = { type: 'pan', startX: e.clientX, startSec: tl.detailStartSec };
      return;
    }
    tl.drag = { type: 'seek' };
    seekInDetail(e);
  });
  detail.addEventListener('mousemove', (e) => {
    updateTooltip(e, detail, 'detail');
    if (tl.drag?.type === 'seek') seekInDetail(e);
  });
  detail.addEventListener('mouseleave', hideTooltip);
  detail.addEventListener('wheel', (e) => {
    const dur = getDuration();
    if (!dur) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const center = tl.detailStartSec + pct * tl.detailWindowSec;
    const factor = e.deltaY < 0 ? 0.82 : 1.18;
    const next = clamp(tl.detailWindowSec * factor, 30, Math.max(30, dur));
    tl.detailWindowSec = next;
    tl.detailStartSec = clamp(center - pct * next, 0, Math.max(0, dur - next));
    drawTimelines();
  }, { passive: false });
  detail.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (!tl.drag) return;
    if (tl.drag.type === 'pan') {
      const dur = getDuration();
      if (!dur) return;
      const rect = detail.getBoundingClientRect();
      const secPerPx = tl.detailWindowSec / Math.max(1, rect.width);
      tl.detailStartSec = clamp(
        tl.drag.startSec - (e.clientX - tl.drag.startX) * secPerPx,
        0, Math.max(0, dur - tl.detailWindowSec)
      );
      drawTimelines();
    }
  });
  window.addEventListener('mouseup', () => { tl.drag = null; });
  window.addEventListener('resize', () => drawTimelines());
}

function seekInDetail(e) {
  const rect = $('#unedited-heatmap-detail').getBoundingClientRect();
  const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const sec = tl.detailStartSec + pct * tl.detailWindowSec;
  currentPreviewTimeSec = clamp(sec, 0, getDuration() || 0);
  const video = $('#unedited-video-player');
  if (!video.hidden && video.duration) video.currentTime = currentPreviewTimeSec;
  drawTimelines();
}

function drawTimelines() {
  drawCanvas($('#unedited-heatmap-overview'), { startSec: 0, endSec: getDuration(), detail: false });
  drawCanvas($('#unedited-heatmap-detail'), {
    startSec: tl.detailStartSec,
    endSec: tl.detailStartSec + tl.detailWindowSec,
    detail: true
  });
  updateOverviewWindow();
}

function drawCanvas(canvas, range) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
  const H = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(15,16,20,0.95)';
  ctx.fillRect(0, 0, W, H);

  const dur = getDuration();
  if (!dur) return;

  // Grid
  const span = Math.max(1, range.endSec - range.startSec);
  const step = span > 3600 ? 900 : span > 900 ? 300 : span > 300 ? 60 : 15;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.52)';
  ctx.font = `${11 * window.devicePixelRatio}px Segoe UI`;
  for (let t = Math.ceil(range.startSec / step) * step; t < range.endSec; t += step) {
    const x = ((t - range.startSec) / span) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(fmtTime(t), x + 6, 16 * window.devicePixelRatio);
  }

  // Heatmap bars
  const bucketMs = currentHeatmap?.bucketMs || 30000;
  const buckets = currentHeatmap?.buckets || [];
  const maxV = Math.max(1, ...buckets.map(b => b.v));
  const visStartMs = range.startSec * 1000;
  const visEndMs = range.endSec * 1000;
  for (const b of buckets) {
    if (b.t + bucketMs < visStartMs || b.t > visEndMs) continue;
    const x = ((b.t - visStartMs) / ((visEndMs - visStartMs) || 1)) * W;
    const bw = Math.max(1, (bucketMs / ((visEndMs - visStartMs) || 1)) * W);
    const intensity = b.v / maxV;
    const bh = range.detail ? Math.max(8, intensity * (H - 22)) : H - 8;
    const by = range.detail ? H - bh - 6 : 4;
    const grad = ctx.createLinearGradient(0, by + bh, 0, by);
    grad.addColorStop(0, `rgba(${Math.round(80 + intensity * 170)},74,88,${0.32 + intensity * 0.5})`);
    grad.addColorStop(1, `rgba(255,${Math.round(126 + intensity * 60)},84,${0.5 + intensity * 0.5})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, by, bw, bh);
  }

  // Playhead
  if (currentPreviewTimeSec >= range.startSec && currentPreviewTimeSec <= range.endSec) {
    const x = ((currentPreviewTimeSec - range.startSec) / span) * W;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1, 0, 2, H);
  }
}

function updateOverviewWindow() {
  const dur = getDuration();
  const el = $('#unedited-overview-window');
  if (!dur) { el.style.width = '0'; return; }
  el.style.left = `${(tl.detailStartSec / dur) * 100}%`;
  el.style.width = `${Math.max(1.5, (tl.detailWindowSec / dur) * 100)}%`;
}

function updateTooltip(e, canvas, mode) {
  const dur = getDuration();
  if (!dur) return hideTooltip();
  const rect = canvas.getBoundingClientRect();
  const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const sec = mode === 'overview' ? pct * dur : tl.detailStartSec + pct * tl.detailWindowSec;
  const tooltip = $('#unedited-timeline-tooltip');
  const wrapRect = $('#unedited-timeline-wrap').getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.style.left = `${e.clientX - wrapRect.left}px`;
  tooltip.textContent = `${fmtTime(sec)} • intensity ${getHeatAt(sec).toFixed(2)}`;
}

function hideTooltip() { $('#unedited-timeline-tooltip').hidden = true; }

function getHeatAt(sec) {
  if (!currentHeatmap) return 0;
  const ms = currentHeatmap.bucketMs || 30000;
  return currentBucketLookup.get(Math.floor(sec * 1000 / ms)) || 0;
}

function buildBucketLookup(heatmap) {
  const map = new Map();
  if (!heatmap?.buckets) return map;
  const ms = heatmap.bucketMs || 30000;
  for (const b of heatmap.buckets) map.set(Math.floor(b.t / ms), b.v);
  return map;
}

function getDuration() {
  if (currentItem?.duration) return currentItem.duration;
  if (currentHeatmap?.durationSec) return currentHeatmap.durationSec;
  return $('#unedited-video-player').duration || 0;
}

// ── Heatmap lifecycle events ──────────────────────────────────────────────────

function onHeatmapProgress(event) {
  const item = allItems.find(i => i.id === event.itemId);
  if (!item) return;
  item.heatmap = {
    ...item.heatmap,
    status: event.status === 'cancelled' ? 'cancelled' : 'building',
    jobId: event.jobId,
    progress: event.progress,
    progressLabel: event.label,
    error: event.error || null
  };
  if (currentItemId === event.itemId && currentItem) {
    currentItem.heatmap = item.heatmap;
    currentHeatmapJob = currentItem.heatmap;
    hydrateItemMeta(currentItem);
    updateBuildCard();
  }
  vlist.refresh();
}

async function onHeatmapFinished(event) {
  const item = allItems.find(i => i.id === event.itemId);
  if (item) item.heatmap = { ...item.heatmap, status: 'ready', jobId: event.jobId, progress: 1, error: null };
  if (currentItemId === event.itemId && currentItem) {
    currentItem.heatmap = item?.heatmap || currentItem.heatmap;
    currentHeatmapJob = currentItem.heatmap;
    currentHeatmap = await window.api.loadHeatmap(event.itemId);
    currentBucketLookup = buildBucketLookup(currentHeatmap);
    hydrateItemMeta(currentItem);
    updateBuildCard();
    drawTimelines();
  }
  vlist.refresh();
}

function onHeatmapError(event) {
  const item = allItems.find(i => i.id === event.itemId);
  if (item) item.heatmap = { ...item.heatmap, status: 'error', error: event.error, progress: 0 };
  if (currentItemId === event.itemId && currentItem) {
    currentItem.heatmap = item?.heatmap || currentItem.heatmap;
    currentHeatmapJob = currentItem.heatmap;
    hydrateItemMeta(currentItem);
    updateBuildCard();
  }
  vlist.refresh();
}

async function onBuildFromTwitch() {
  if (!currentItem) return;
  const vodInput = ($('#unedited-vod-input').value || '').trim() || currentItem.source.vodId || '';
  if (!vodInput) { _toast('Paste a Twitch VOD URL or numeric VOD ID first.', 'error'); return; }
  try {
    const result = await window.api.heatmap.buildFromTwitch({ itemId: currentItem.id, vodInput });
    currentItem.heatmap = { ...currentItem.heatmap, status: 'building', jobId: result.jobId, progress: 0, progressLabel: 'Queued heatmap build…' };
    currentHeatmapJob = currentItem.heatmap;
    updateBuildCard();
    vlist.refresh();
  } catch (err) {
    _toast(`Heatmap build failed to start: ${err.message}`, 'error');
  }
}

async function onCancelBuild() {
  const jobId = currentHeatmapJob?.jobId;
  if (!jobId) return;
  try {
    await window.api.heatmap.cancel(jobId);
    _toast('Cancelling heatmap build…', 'info');
  } catch (err) {
    _toast(`Failed to cancel: ${err.message}`, 'error');
  }
}

async function onImportNormalized() {
  try {
    const jsonPath = await window.api.heatmap.pickImportFile();
    if (!jsonPath) return;
    const result = await window.api.heatmap.importNormalized({ jsonPath });
    await refresh();
    const item = allItems.find(i => i.id === result.itemId);
    if (item) await selectItem(item);
    _toast('Imported chat JSON and started the heatmap build.', 'success');
  } catch (err) {
    _toast(`Import failed: ${err.message}`, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function humanSize(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  return mb > 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function humanTime(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }

function fmtTime(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function toFileUrl(p) { return encodeURI(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`); }
