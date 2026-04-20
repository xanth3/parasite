import { VirtualList } from '../lib-ui/vlist.js';

const $ = (selector, root = document) => root.querySelector(selector);

let allItems = [];
let currentSub = 'clips';
let currentItemId = null;
let currentItem = null;
let currentFlags = [];
let currentHeatmap = null;
let currentBucketLookup = new Map();
let currentHeatmapJob = null;
let inPoint = null;
let outPoint = null;
let pendingPlatform = null;
let vlist = null;
let _toast = () => {};
let selectionToken = 0;
let currentPreviewTimeSec = 0;
let runtimePlaybackError = null;

let crop = { x: 0.275, y: 0, w: 0.45, h: 1.0 };
let cropActive = false;

const timeline = {
  detailStartSec: 0,
  detailWindowSec: 600,
  drag: null
};

export async function mountLibrary({ toast }) {
  _toast = toast;

  document.querySelectorAll('#tab-library .sub-tab').forEach((button) => {
    button.addEventListener('click', () => {
      setCurrentSub(button.dataset.sub, { resetScroll: true });
    });
  });

  $('#search').addEventListener('input', () => renderList({ resetScroll: true }));
  $('#refresh').addEventListener('click', () => refresh({ rescan: true }));
  $('#open-folder').addEventListener('click', async () => {
    if (!currentItem) return _toast('Select a library item first.', 'info');
    const opened = await window.api.revealInFolder(currentItem.id);
    if (!opened) _toast('This item has no media file to reveal.', 'info');
  });

  $('#import-json').addEventListener('click', onImportNormalized);
  $('#preview-import-json').addEventListener('click', onImportNormalized);
  $('#btn-import-json-inline').addEventListener('click', onImportNormalized);
  $('#btn-build-vod').addEventListener('click', onBuildFromTwitch);
  $('#btn-build-cancel').addEventListener('click', onCancelHeatmapBuild);
  $('#btn-reset-zoom').addEventListener('click', resetTimelineWindow);

  $('#filename-save').addEventListener('click', onRename);
  $('#btn-reveal').addEventListener('click', () => currentItem && window.api.revealInFolder(currentItem.id));
  $('#btn-delete').addEventListener('click', onDelete);
  $('#btn-upload').addEventListener('click', onUpload);
  $('#btn-queue-add').addEventListener('click', () => {
    if (!currentItem) return;
    enqueueAction('drive', {});
  });

  const exportMenu = $('#export-menu');
  $('#btn-export').addEventListener('click', (event) => {
    event.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; });
  exportMenu.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onExportChoose(button.dataset.platform);
    });
  });
  $('#export-confirm').addEventListener('click', () => onExportFinalize(false));
  $('#export-queue').addEventListener('click', () => onExportFinalize(true));
  $('#export-cancel').addEventListener('click', () => {
    $('#export-title-wrap').hidden = true;
    pendingPlatform = null;
  });

  $('#btn-mark-in').addEventListener('click', () => setInOut('in'));
  $('#btn-mark-out').addEventListener('click', () => setInOut('out'));
  $('#btn-ghost-clip').addEventListener('click', onGhostClip);
  $('#btn-vertical').addEventListener('click', onToggleVertical);

  const video = $('#video-player');
  video.addEventListener('timeupdate', () => {
    currentPreviewTimeSec = video.currentTime || 0;
    drawTimelines();
  });
  video.addEventListener('loadedmetadata', () => {
    runtimePlaybackError = null;
    currentPreviewTimeSec = Math.min(currentPreviewTimeSec, getDurationSec());
    renderPlaybackState();
    drawTimelines();
  });
  video.addEventListener('error', () => {
    runtimePlaybackError = 'This media file could not be played in the library viewer.';
    renderPlaybackState();
    drawTimelines();
  });

  bindTimelineEvents();
  initCropDrag();

  window.api.drive.onProgress((progress) => showProgress(`Uploading to Drive… ${Math.round(progress.pct * 100)}%`, progress.pct, progress.done));
  window.api.export.onProgress((progress) => showProgress(`Exporting to ${progress.platform}… ${Math.round(progress.pct * 100)}%`, progress.pct, progress.done));
  window.api.clip.onProgress(({ sec }) => showProgress(`Encoding vertical clip… ${sec.toFixed(1)}s rendered`, 0.5, false));
  window.api.onLibraryChange(() => refresh({ rescan: false, preserveScroll: true }));
  window.api.onFlagCaptured(() => {
    if (currentItem) loadFlags(currentItem.id);
    _toast('Flag captured.', 'success');
  });
  window.api.heatmap.onProgress(onHeatmapProgress);
  window.api.heatmap.onFinished(onHeatmapFinished);
  window.api.heatmap.onError(onHeatmapError);

  vlist = new VirtualList({
    viewport: $('#vlist-viewport'),
    spacer: $('#vlist-spacer'),
    rows: $('#vlist-rows'),
    rowHeight: 64,
    renderRow: renderItemRow
  });

  await refresh({ rescan: false, preserveScroll: true });
}

async function refresh({ rescan = false, preserveScroll = true } = {}) {
  try {
    const loader = rescan ? window.api.refreshLibrary : window.api.listLibrary;
    allItems = await loader();
    renderList({ resetScroll: !preserveScroll });

    if (!currentItemId) return;
    const nextItem = allItems.find((item) => item.id === currentItemId);
    if (!nextItem) return clearSelection();

    const shouldReloadHeatmap = nextItem.heatmap.path !== currentItem?.heatmap?.path || nextItem.id !== currentItem?.id;
    const shouldReloadFlags = true;
    await syncCurrentItem(nextItem, { preserveMarkers: true, shouldReloadHeatmap, shouldReloadFlags, keepTimeline: true });
  } catch (error) {
    _toast(`Failed to refresh library: ${error.message}`, 'error');
  }
}

function setCurrentSub(nextSub, { resetScroll = false } = {}) {
  currentSub = nextSub;
  document.querySelectorAll('#tab-library .sub-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.sub === nextSub);
  });
  renderList({ resetScroll });
}

function filteredItems() {
  const query = ($('#search').value || '').trim().toLowerCase();
  return allItems.filter((item) => item.category === currentSub && (!query || item.name.toLowerCase().includes(query)));
}

function renderList({ resetScroll = false } = {}) {
  const list = filteredItems();
  const container = $('#file-list');
  if (!list.length) {
    container.classList.add('empty-state');
    $('#vlist-empty').textContent = `No ${currentSub === 'clips' ? 'clips' : 'unedited items'} yet.`;
    vlist.setItems([], { resetScroll });
    return;
  }

  container.classList.remove('empty-state');
  vlist.setItems(list, { resetScroll });
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

  const thumb = row.querySelector('.file-thumb');
  thumb.textContent = item.heatmap.status === 'ready' ? 'MAP' : item.path ? 'VID' : 'IMP';
  row.querySelector('.file-name').textContent = item.name;
  row.querySelector('.file-sub').textContent = `${humanSize(item.size)} • ${humanTime(item.mtime)}${item.heatmap.status === 'building' ? ' • Building heatmap' : ''}`;
  row.querySelector('.file-duration').textContent = humanDuration(item.duration);
  row.addEventListener('click', () => selectItem(item));
  return row;
}

async function selectItem(item) {
  if (item.category !== currentSub) setCurrentSub(item.category, { resetScroll: false });
  currentItemId = item.id;
  await syncCurrentItem(item, {
    preserveMarkers: false,
    shouldReloadHeatmap: true,
    shouldReloadFlags: true,
    keepTimeline: false
  });
  vlist.refresh();
}

async function syncCurrentItem(item, options) {
  const token = ++selectionToken;
  currentItem = item;
  currentHeatmapJob = item.heatmap;

  if (!options.preserveMarkers) {
    inPoint = null;
    outPoint = null;
    currentPreviewTimeSec = 0;
  }

  $('#preview .preview-empty').hidden = true;
  $('#preview .preview-body').hidden = false;

  if (!options.keepTimeline) initializeTimelineWindow(item);
  hydrateItemMeta(item);
  renderPlaybackState();
  updateBuildCard();
  updateActionAvailability();

  if (options.shouldReloadHeatmap) {
    currentHeatmap = item.heatmap.path ? await window.api.loadHeatmap(item.id) : null;
    currentBucketLookup = buildBucketLookup(currentHeatmap);
  }
  if (options.shouldReloadFlags) currentFlags = await window.api.flagsForItem(item.id) || [];
  if (token !== selectionToken) return;

  loadVideoForItem(item);
  hydrateItemMeta(item);
  renderPlaybackState();
  updateBuildCard();
  updateActionAvailability();
  drawTimelines();
}

async function loadFlags(itemId) {
  currentFlags = await window.api.flagsForItem(itemId) || [];
  drawTimelines();
}

function hydrateItemMeta(item) {
  $('#filename-input').value = item.name;
  $('#meta-duration').textContent = humanDuration(item.duration || currentHeatmap?.durationSec || 0);
  $('#meta-size').textContent = humanSize(item.size);
  $('#meta-mtime').textContent = humanTime(item.mtime);
  $('#meta-category').textContent = item.category === 'clips' ? 'Clip' : 'Unedited';
  $('#meta-source').textContent = describeSource(item);
  $('#meta-playback').textContent = describePlayback(item);
  $('#in-time').textContent = inPoint == null ? '—' : humanDuration(inPoint);
  $('#out-time').textContent = outPoint == null ? '—' : humanDuration(outPoint);
  $('#heatmap-meta').textContent = describeHeatmap(item);
  $('#heatmap-suggestion').textContent = describeVodSuggestion(item);
}

function describeSource(item) {
  const parts = [];
  if (item.source.service) parts.push(item.source.service);
  if (item.source.channel) parts.push(item.source.channel);
  if (item.source.vodId) parts.push(`VOD ${item.source.vodId}`);
  if (!parts.length) return item.path ? 'Local media' : 'Imported chat';
  return parts.join(' • ');
}

function describePlayback(item) {
  if (runtimePlaybackError) return runtimePlaybackError;
  if (!item.path) return 'Heatmap only';
  if (!item.playback.available) return item.playback.error || 'Unavailable';
  return 'Playable';
}

function describeHeatmap(item) {
  if (currentHeatmap?.buckets?.length) {
    const bucketCount = currentHeatmap.buckets.length;
    const bucketMs = currentHeatmap.bucketMs || 30000;
    return `${bucketCount} active buckets • ${Math.round(bucketMs / 1000)}s resolution`;
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

function updateActionAvailability() {
  const hasMedia = !!currentItem?.path && currentItem.playback.available && !runtimePlaybackError;
  $('#filename-input').disabled = !currentItem?.path;
  $('#filename-save').disabled = !currentItem?.path;
  $('#btn-reveal').disabled = !currentItem?.path;
  $('#btn-upload').disabled = !hasMedia;
  $('#btn-export').disabled = !hasMedia;
  $('#btn-queue-add').disabled = !hasMedia;
  $('#btn-mark-in').disabled = !hasMedia;
  $('#btn-mark-out').disabled = !hasMedia;
  $('#btn-ghost-clip').disabled = !hasMedia;
  $('#btn-vertical').disabled = !hasMedia;
}

function renderPlaybackState() {
  const banner = $('#playback-banner');
  const videoUnavailable = $('#video-unavailable');
  const hasMedia = !!currentItem?.path && currentItem.playback.available && !runtimePlaybackError;
  const errorText = runtimePlaybackError || currentItem?.playback?.error || null;

  banner.hidden = !errorText;
  banner.textContent = errorText || '';
  videoUnavailable.hidden = hasMedia;
  $('#video-player').hidden = !hasMedia;
}

function loadVideoForItem(item) {
  const video = $('#video-player');
  const canPlay = !!item.path && item.playback.available;
  if (!canPlay) {
    runtimePlaybackError = item.playback.error || (item.path ? 'Media playback is unavailable.' : 'No media attached.');
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
  video.dataset.itemId = String(item.id);
  video.src = src;
  video.load();
  renderPlaybackState();
}

function initializeTimelineWindow(item) {
  const duration = item.duration || currentHeatmap?.durationSec || 0;
  timeline.detailWindowSec = clamp(duration ? Math.min(duration, 600) : 600, 30, Math.max(30, duration || 600));
  timeline.detailStartSec = 0;
}

function resetTimelineWindow() {
  if (!currentItem) return;
  initializeTimelineWindow(currentItem);
  drawTimelines();
}

function bindTimelineEvents() {
  const overview = $('#heatmap-overview');
  const detail = $('#heatmap-detail');

  overview.addEventListener('click', onOverviewClick);
  overview.addEventListener('mousemove', (event) => updateTooltipFromCanvas(event, overview, 'overview'));
  overview.addEventListener('mouseleave', hideTimelineTooltip);

  detail.addEventListener('mousedown', onDetailMouseDown);
  detail.addEventListener('mousemove', (event) => updateTooltipFromCanvas(event, detail, 'detail'));
  detail.addEventListener('mouseleave', hideTimelineTooltip);
  detail.addEventListener('wheel', onDetailWheel, { passive: false });
  detail.addEventListener('contextmenu', (event) => event.preventDefault());

  window.addEventListener('mousemove', onGlobalPointerMove);
  window.addEventListener('mouseup', onGlobalPointerUp);
}

function onOverviewClick(event) {
  const duration = getDurationSec();
  if (!duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const pct = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const centerSec = pct * duration;
  timeline.detailStartSec = clamp(centerSec - timeline.detailWindowSec / 2, 0, Math.max(0, duration - timeline.detailWindowSec));
  drawTimelines();
}

function onDetailMouseDown(event) {
  const duration = getDurationSec();
  if (!duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const pct = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  if (event.button === 2) {
    timeline.drag = { type: 'pan', startX: event.clientX, startStartSec: timeline.detailStartSec };
    return;
  }
  timeline.drag = { type: 'seek' };
  seekWithinDetailLane(pct);
}

function onGlobalPointerMove(event) {
  if (!timeline.drag) return;
  const duration = getDurationSec();
  if (!duration) return;
  const detail = $('#heatmap-detail');
  const rect = detail.getBoundingClientRect();

  if (timeline.drag.type === 'seek') {
    const pct = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    seekWithinDetailLane(pct);
    return;
  }

  if (timeline.drag.type === 'pan') {
    const deltaX = event.clientX - timeline.drag.startX;
    const secPerPixel = timeline.detailWindowSec / Math.max(1, rect.width);
    timeline.detailStartSec = clamp(
      timeline.drag.startStartSec - deltaX * secPerPixel,
      0,
      Math.max(0, duration - timeline.detailWindowSec)
    );
    drawTimelines();
  }
}

function onGlobalPointerUp() {
  timeline.drag = null;
}

function onDetailWheel(event) {
  const duration = getDurationSec();
  if (!duration) return;
  event.preventDefault();

  const rect = event.currentTarget.getBoundingClientRect();
  const pct = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const centerSec = timeline.detailStartSec + pct * timeline.detailWindowSec;
  const factor = event.deltaY < 0 ? 0.82 : 1.18;
  const nextWindow = clamp(timeline.detailWindowSec * factor, 30, Math.max(30, duration));
  timeline.detailWindowSec = nextWindow;
  timeline.detailStartSec = clamp(centerSec - pct * nextWindow, 0, Math.max(0, duration - nextWindow));
  drawTimelines();
}

function seekWithinDetailLane(pct) {
  const targetSec = timeline.detailStartSec + pct * timeline.detailWindowSec;
  updatePreviewTime(targetSec);
}

function updatePreviewTime(targetSec) {
  const duration = getDurationSec();
  currentPreviewTimeSec = clamp(targetSec, 0, duration || 0);
  const video = $('#video-player');
  if (!video.hidden && video.duration) {
    video.currentTime = currentPreviewTimeSec;
  }
  drawTimelines();
}

function drawTimelines() {
  drawTimelineCanvas($('#heatmap-overview'), { startSec: 0, endSec: getDurationSec(), detail: false });
  drawTimelineCanvas($('#heatmap-detail'), {
    startSec: timeline.detailStartSec,
    endSec: timeline.detailStartSec + timeline.detailWindowSec,
    detail: true
  });
  updateOverviewWindow();
}

function drawTimelineCanvas(canvas, windowRange) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
  const height = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(15, 16, 20, 0.95)';
  ctx.fillRect(0, 0, width, height);

  const duration = getDurationSec();
  if (!duration) return;

  drawTimelineGrid(ctx, width, height, windowRange.startSec, windowRange.endSec);

  const bucketMs = currentHeatmap?.bucketMs || 30000;
  const buckets = currentHeatmap?.buckets || [];
  const maxValue = Math.max(1, ...buckets.map((bucket) => bucket.v));
  const visibleStartMs = windowRange.startSec * 1000;
  const visibleEndMs = windowRange.endSec * 1000;

  for (const bucket of buckets) {
    const bucketStartMs = bucket.t;
    const bucketEndMs = bucket.t + bucketMs;
    if (bucketEndMs < visibleStartMs || bucketStartMs > visibleEndMs) continue;

    const x = ((bucketStartMs - visibleStartMs) / (visibleEndMs - visibleStartMs || 1)) * width;
    const w = Math.max(1, (bucketMs / (visibleEndMs - visibleStartMs || 1)) * width);
    const intensity = bucket.v / maxValue;
    const h = windowRange.detail ? Math.max(8, intensity * (height - 22)) : height - 8;
    const y = windowRange.detail ? height - h - 6 : 4;

    const gradient = ctx.createLinearGradient(0, y + h, 0, y);
    gradient.addColorStop(0, `rgba(${Math.round(80 + intensity * 170)}, 74, 88, ${0.32 + intensity * 0.5})`);
    gradient.addColorStop(1, `rgba(255, ${Math.round(126 + intensity * 60)}, 84, ${0.5 + intensity * 0.5})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);
  }

  drawMarkerBand(ctx, width, height, windowRange.startSec, windowRange.endSec);
}

function drawTimelineGrid(ctx, width, height, startSec, endSec) {
  const duration = Math.max(1, endSec - startSec);
  const gridStepSec = duration > 3600 ? 900 : duration > 900 ? 300 : duration > 300 ? 60 : 15;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
  ctx.font = `${11 * window.devicePixelRatio}px Segoe UI`;

  const firstTick = Math.ceil(startSec / gridStepSec) * gridStepSec;
  for (let tick = firstTick; tick < endSec; tick += gridStepSec) {
    const pct = (tick - startSec) / duration;
    const x = pct * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(formatTimelineTime(tick), x + 6, 16 * window.devicePixelRatio);
  }
}

function drawMarkerBand(ctx, width, height, startSec, endSec) {
  const duration = Math.max(0.001, endSec - startSec);
  const drawAt = (sec) => ((sec - startSec) / duration) * width;

  if (inPoint != null && outPoint != null) {
    const startX = drawAt(Math.min(inPoint, outPoint));
    const endX = drawAt(Math.max(inPoint, outPoint));
    ctx.fillStyle = 'rgba(255, 223, 92, 0.18)';
    ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);
  }

  for (const flag of currentFlags) {
    if (flag.offset_ms == null) continue;
    const sec = flag.offset_ms / 1000;
    if (sec < startSec || sec > endSec) continue;
    const x = drawAt(sec);
    ctx.fillStyle = '#f0b232';
    ctx.fillRect(x - 1, 2, 2, height - 4);
  }

  const currentSec = getCurrentTimeSec();
  if (currentSec >= startSec && currentSec <= endSec) {
    const x = drawAt(currentSec);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1, 0, 2, height);
  }
}

function updateOverviewWindow() {
  const duration = getDurationSec();
  const windowEl = $('#overview-window');
  if (!duration) {
    windowEl.style.width = '0';
    return;
  }
  windowEl.style.left = `${(timeline.detailStartSec / duration) * 100}%`;
  windowEl.style.width = `${Math.max(1.5, (timeline.detailWindowSec / duration) * 100)}%`;
}

function updateTooltipFromCanvas(event, canvas, mode) {
  const duration = getDurationSec();
  if (!duration) return hideTimelineTooltip();
  const rect = canvas.getBoundingClientRect();
  const pct = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const sec = mode === 'overview' ? pct * duration : timeline.detailStartSec + pct * timeline.detailWindowSec;
  const tooltip = $('#timeline-tooltip');
  const wrapRect = $('#timeline-wrap').getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.style.left = `${event.clientX - wrapRect.left}px`;
  tooltip.textContent = `${formatTimelineTime(sec)} • intensity ${getHeatmapValueAt(sec).toFixed(2)}`;
}

function hideTimelineTooltip() {
  $('#timeline-tooltip').hidden = true;
}

function getHeatmapValueAt(sec) {
  if (!currentHeatmap) return 0;
  const bucketMs = currentHeatmap.bucketMs || 30000;
  const bucketIndex = Math.floor((sec * 1000) / bucketMs);
  return currentBucketLookup.get(bucketIndex) || 0;
}

function buildBucketLookup(heatmap) {
  const lookup = new Map();
  if (!heatmap?.buckets) return lookup;
  const bucketMs = heatmap.bucketMs || 30000;
  for (const bucket of heatmap.buckets) {
    lookup.set(Math.floor(bucket.t / bucketMs), bucket.v);
  }
  return lookup;
}

function getDurationSec() {
  if (currentItem?.duration) return currentItem.duration;
  if (currentHeatmap?.durationSec) return currentHeatmap.durationSec;
  return $('#video-player').duration || 0;
}

function getCurrentTimeSec() {
  const video = $('#video-player');
  if (!video.hidden && Number.isFinite(video.currentTime)) return video.currentTime || currentPreviewTimeSec;
  return currentPreviewTimeSec;
}

function setInOut(which) {
  const current = getCurrentTimeSec();
  if (which === 'in') inPoint = current;
  if (which === 'out') outPoint = current;
  hydrateItemMeta(currentItem);
  drawTimelines();
}

async function onGhostClip() {
  if (!currentItem?.path) return;
  if (inPoint == null || outPoint == null || outPoint <= inPoint) {
    _toast('Mark In and Out first with In before Out.', 'error');
    return;
  }
  try {
    showProgress('Snipping clip (stream copy)…', 0.2, false);
    const output = await window.api.clip.ghost({ sourcePath: currentItem.path, inSec: inPoint, outSec: outPoint });
    showProgress('Clip saved.', 1, true);
    _toast(`Saved: ${output.split(/[/\\]/).pop()}`, 'success');
  } catch (error) {
    showProgress('', 0, true);
    _toast(`Ghost clip failed: ${error.message}`, 'error');
  }
}

function onToggleVertical() {
  cropActive = !cropActive;
  $('#crop-overlay').hidden = !cropActive;
  if (cropActive) positionCropBox();
}

function positionCropBox() {
  const overlay = $('#crop-overlay');
  const video = $('#video-player');
  const box = $('#crop-box');
  const width = video.clientWidth;
  const height = video.clientHeight;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  box.style.width = `${crop.w * width}px`;
  box.style.height = `${crop.h * height}px`;
  box.style.left = `${crop.x * width}px`;
  box.style.top = `${crop.y * height}px`;
}

function initCropDrag() {
  const box = $('#crop-box');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  box.addEventListener('mousedown', (event) => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = parseFloat(box.style.left || 0);
    startTop = parseFloat(box.style.top || 0);
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const video = $('#video-player');
    const width = video.clientWidth;
    const height = video.clientHeight;
    const nextLeft = Math.max(0, Math.min(width - box.offsetWidth, startLeft + (event.clientX - startX)));
    const nextTop = Math.max(0, Math.min(height - box.offsetHeight, startTop + (event.clientY - startY)));
    box.style.left = `${nextLeft}px`;
    box.style.top = `${nextTop}px`;
    crop.x = nextLeft / width;
    crop.y = nextTop / height;
  });

  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('resize', () => {
    if (cropActive) positionCropBox();
    drawTimelines();
  });
}

async function onRename() {
  if (!currentItem?.path) return;
  const newName = $('#filename-input').value.trim();
  if (!newName) return;
  try {
    const updatedItem = await window.api.renameItem(currentItem.id, newName);
    _toast('Renamed.', 'success');
    await refresh({ rescan: false, preserveScroll: true });
    const item = allItems.find((entry) => entry.id === updatedItem.id);
    if (item) await selectItem(item);
  } catch (error) {
    _toast(`Rename failed: ${error.message}`, 'error');
  }
}

async function onDelete() {
  if (!currentItem) return;
  const message = currentItem.path
    ? `Move "${currentItem.name}" to Trash?`
    : `Remove "${currentItem.name}" from the library?`;
  if (!window.confirm(message)) return;

  try {
    await window.api.deleteItem(currentItem.id);
    clearSelection();
    await refresh({ rescan: false, preserveScroll: true });
  } catch (error) {
    _toast(`Delete failed: ${error.message}`, 'error');
  }
}

function clearSelection() {
  currentItemId = null;
  currentItem = null;
  currentFlags = [];
  currentHeatmap = null;
  currentBucketLookup = new Map();
  currentHeatmapJob = null;
  currentPreviewTimeSec = 0;
  $('#vod-input').value = '';
  $('#vod-input').dataset.itemId = '';
  $('#preview .preview-empty').hidden = false;
  $('#preview .preview-body').hidden = true;
}

async function onUpload() {
  if (!currentItem?.path) return;
  try {
    showProgress('Uploading to Drive…', 0, false);
    const response = await window.api.drive.upload(currentItem.path);
    showProgress('Uploaded.', 1, true);
    _toast(`Uploaded: ${response.name}`, 'success');
  } catch (error) {
    showProgress('', 0, true);
    _toast(`Upload failed: ${error.message}`, 'error');
  }
}

function onExportChoose(platform) {
  pendingPlatform = platform;
  $('#export-title-wrap').hidden = false;
  $('#export-title').value = suggestHook(currentItem?.name || '');
  $('#export-title').focus();
  $('#export-useinout').checked = platform === 'tiktok' && inPoint != null && outPoint != null;
}

function suggestHook(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
  const hooks = ['UNBELIEVABLE:', 'HE LOST IT:', 'THIS WENT SIDEWAYS:', 'INSANE REACTION:', 'WORST MISTAKE EVER:'];
  return `${hooks[Math.floor(Math.random() * hooks.length)]} ${base}`;
}

async function onExportFinalize(asQueue) {
  if (!currentItem?.path || !pendingPlatform) return;
  const title = $('#export-title').value.trim();
  const useInOut = $('#export-useinout').checked;
  $('#export-title-wrap').hidden = true;

  const platform = pendingPlatform;
  pendingPlatform = null;

  try {
    let sourcePath = currentItem.path;
    if (platform === 'tiktok') {
      if (!useInOut || inPoint == null || outPoint == null) {
        _toast('TikTok export needs an In and Out range.', 'error');
        return;
      }
      showProgress('Reframing to 9:16…', 0.1, false);
      sourcePath = await window.api.clip.vertical({
        sourcePath: currentItem.path,
        inSec: inPoint,
        outSec: outPoint,
        crop
      });
      showProgress('Vertical clip ready. Uploading…', 0.5, false);
    } else if (useInOut && inPoint != null && outPoint != null) {
      showProgress('Snipping clip…', 0.1, false);
      sourcePath = await window.api.clip.ghost({ sourcePath: currentItem.path, inSec: inPoint, outSec: outPoint });
    }

    if (asQueue) {
      await window.api.queue.enqueue({
        item_id: sourcePath === currentItem.path ? currentItem.id : null,
        video_path: sourcePath,
        action: platform,
        params: { title, description: title, tags: [] }
      });
      _toast(`Queued for ${platform}.`, 'success');
      showProgress('', 0, true);
      return;
    }

    showProgress(`Exporting to ${platform}…`, 0.6, false);
    const response = await window.api.export.run({
      platform,
      filePath: sourcePath,
      title,
      description: title,
      tags: []
    });
    showProgress('Done.', 1, true);
    _toast(`Published to ${platform}: ${response.url || response.id}`, 'success');
  } catch (error) {
    showProgress('', 0, true);
    _toast(`Export failed: ${error.message}`, 'error');
  }
}

async function enqueueAction(action, params) {
  if (!currentItem) return;
  await window.api.queue.enqueue({
    item_id: currentItem.id,
    video_path: currentItem.path,
    action,
    params
  });
  _toast(`Queued: ${action}`, 'success');
}

async function onBuildFromTwitch() {
  if (!currentItem) return;
  const vodInput = ($('#vod-input').value || '').trim() || currentItem.source.vodId || '';
  if (!vodInput) {
    _toast('Paste a Twitch VOD URL or numeric VOD ID first.', 'error');
    return;
  }

  try {
    const result = await window.api.heatmap.buildFromTwitch({ itemId: currentItem.id, vodInput });
    currentHeatmapJob = { ...currentItem.heatmap, status: 'building', jobId: result.jobId, progress: 0, progressLabel: 'Queued heatmap build…' };
    updateBuildCard();
    await refresh({ rescan: false, preserveScroll: true });
  } catch (error) {
    _toast(`Heatmap build failed to start: ${error.message}`, 'error');
  }
}

async function onImportNormalized() {
  try {
    const jsonPath = await window.api.heatmap.pickImportFile();
    if (!jsonPath) return;
    const result = await window.api.heatmap.importNormalized({ jsonPath });
    await refresh({ rescan: false, preserveScroll: true });
    const item = allItems.find((entry) => entry.id === result.itemId);
    if (item) await selectItem(item);
    _toast('Imported chat JSON and started the heatmap build.', 'success');
  } catch (error) {
    _toast(`Import failed: ${error.message}`, 'error');
  }
}

async function onCancelHeatmapBuild() {
  const jobId = currentHeatmapJob?.jobId;
  if (!jobId) return;
  try {
    await window.api.heatmap.cancel(jobId);
    _toast('Cancelling heatmap build…', 'info');
    await refresh({ rescan: false, preserveScroll: true });
  } catch (error) {
    _toast(`Failed to cancel heatmap build: ${error.message}`, 'error');
  }
}

function onHeatmapProgress(event) {
  patchItemHeatmap(event.itemId, {
    status: event.status === 'cancelled' ? 'cancelled' : 'building',
    jobId: event.jobId,
    progress: event.progress,
    progressLabel: event.label,
    error: event.error || null
  });
}

async function onHeatmapFinished(event) {
  patchItemHeatmap(event.itemId, {
    status: 'ready',
    jobId: event.jobId,
    progress: 1,
    progressLabel: event.label,
    error: null
  });
  await refresh({ rescan: false, preserveScroll: true });
}

async function onHeatmapError(event) {
  patchItemHeatmap(event.itemId, {
    status: 'error',
    jobId: event.jobId,
    error: event.error,
    progressLabel: event.error,
    progress: 0
  });
  await refresh({ rescan: false, preserveScroll: true });
}

function patchItemHeatmap(itemId, patch) {
  const item = allItems.find((entry) => entry.id === itemId);
  if (item) item.heatmap = { ...item.heatmap, ...patch };
  if (currentItemId !== itemId || !currentItem) return;
  currentItem.heatmap = { ...currentItem.heatmap, ...patch };
  currentHeatmapJob = currentItem.heatmap;
  hydrateItemMeta(currentItem);
  updateBuildCard();
  vlist.refresh();
}

function updateBuildCard() {
  if (!currentItem) return;
  const card = $('#heatmap-build-card');
  const showCard = currentItem.heatmap.status !== 'ready';
  card.hidden = !showCard;

  $('#btn-build-vod').disabled = currentItem.heatmap.status === 'building';
  $('#btn-build-cancel').hidden = currentItem.heatmap.status !== 'building';
  const vodInput = $('#vod-input');
  if (vodInput.dataset.itemId !== String(currentItem.id)) {
    vodInput.value = currentItem.source.vodId
      ? `https://www.twitch.tv/videos/${currentItem.source.vodId}`
      : '';
    vodInput.dataset.itemId = String(currentItem.id);
  }

  const wrap = $('#heatmap-job-wrap');
  const label = $('#heatmap-job-label');
  const bar = $('#heatmap-job-bar');
  if (currentItem.heatmap.status === 'building') {
    wrap.hidden = false;
    label.textContent = currentItem.heatmap.progressLabel || 'Building heatmap…';
    bar.style.width = `${Math.round((currentItem.heatmap.progress || 0) * 100)}%`;
  } else if (currentItem.heatmap.status === 'error') {
    wrap.hidden = false;
    label.textContent = currentItem.heatmap.error || 'Heatmap build failed.';
    bar.style.width = '0%';
  } else if (currentItem.heatmap.status === 'cancelled') {
    wrap.hidden = false;
    label.textContent = 'Heatmap build cancelled.';
    bar.style.width = '0%';
  } else {
    wrap.hidden = true;
    bar.style.width = '0%';
  }
}

function showProgress(label, pct, done) {
  const wrap = $('#progress-wrap');
  wrap.hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-bar').style.width = `${Math.round((pct || 0) * 100)}%`;
  if (done) setTimeout(() => { wrap.hidden = true; }, 1500);
}

function humanDuration(sec) {
  const safe = Math.max(0, Math.floor(Number(sec || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function humanSize(bytes) {
  const megabytes = Number(bytes || 0) / (1024 * 1024);
  return megabytes > 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${megabytes.toFixed(1)} MB`;
}

function humanTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function formatTimelineTime(sec) {
  const total = Math.max(0, Math.floor(sec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFileUrl(filePath) {
  return encodeURI(`file:///${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`);
}
