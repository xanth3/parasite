// Secure bridge between renderer and main.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Nudge the renderer to honour GPU-accelerated scrolling for long lists.
try { webFrame.setVisualZoomLevelLimits(1, 1); } catch {}

const api = {
  // Settings
  getSettings:      ()          => ipcRenderer.invoke('settings:get'),
  setSettings:      (patch)     => ipcRenderer.invoke('settings:set', patch),
  pickVideoFolder:  ()          => ipcRenderer.invoke('settings:pickFolder'),
  openExternal:     (url)       => ipcRenderer.invoke('open:external', url),

  // Library
  listLibrary:      ()          => ipcRenderer.invoke('library:list'),
  revealInFolder:   (p)         => ipcRenderer.invoke('library:reveal', p),
  renameFile:       (p, n)      => ipcRenderer.invoke('library:rename', p, n),
  deleteFile:       (p)         => ipcRenderer.invoke('library:delete', p),
  flagsForVideo:    (p)         => ipcRenderer.invoke('library:flags', p),
  loadHeatmap:      (p)         => ipcRenderer.invoke('library:heatmap', p),
  onLibraryChange:  (cb)        => ipcRenderer.on('library:changed', () => cb()),
  onFlagCaptured:   (cb)        => ipcRenderer.on('flag:captured',   (_e, p) => cb(p)),

  // Clip extraction
  clip: {
    ghost:          (p)         => ipcRenderer.invoke('clip:ghost', p),
    vertical:       (p)         => ipcRenderer.invoke('clip:vertical', p),
    onProgress:     (cb)        => ipcRenderer.on('clip:progress', (_e, p) => cb(p))
  },

  // Drive
  drive: {
    status:         ()          => ipcRenderer.invoke('drive:status'),
    startAuth:      ()          => ipcRenderer.invoke('drive:startAuth'),
    completeAuth:   (code)      => ipcRenderer.invoke('drive:completeAuth', code),
    disconnect:     ()          => ipcRenderer.invoke('drive:disconnect'),
    upload:         (p)         => ipcRenderer.invoke('drive:upload', p),
    onProgress:     (cb)        => ipcRenderer.on('drive:progress', (_e, p) => cb(p))
  },

  // OBS + recording
  obs: {
    status:         ()          => ipcRenderer.invoke('obs:status'),
    connect:        ()          => ipcRenderer.invoke('obs:connect'),
    disconnect:     ()          => ipcRenderer.invoke('obs:disconnect'),
    startRecord:    (p)         => ipcRenderer.invoke('record:start', p),
    stopRecord:     ()          => ipcRenderer.invoke('record:stop')
  },

  // Chat heatmap live updates
  heatmap: {
    onUpdate:       (cb)        => ipcRenderer.on('heatmap:update', (_e, p) => cb(p))
  },

  // Whisper / transcription
  whisper: {
    test:           ()          => ipcRenderer.invoke('whisper:test'),
    toggle:         (enabled)   => ipcRenderer.invoke('whisper:toggle', enabled),
    onLine:         (cb)        => ipcRenderer.on('transcript:line', (_e, p) => cb(p))
  },

  // Direct export (one-off)
  export: {
    run:            (p)         => ipcRenderer.invoke('export:run', p),
    onProgress:     (cb)        => ipcRenderer.on('export:progress', (_e, p) => cb(p))
  },

  // Batch queue
  queue: {
    enqueue:        (row)       => ipcRenderer.invoke('queue:enqueue', row),
    list:           ()          => ipcRenderer.invoke('queue:list'),
    clearDone:      ()          => ipcRenderer.invoke('queue:clearDone'),
    onUpdate:       (cb)        => ipcRenderer.on('queue:update',   (_e, p) => cb(p)),
    onProgress:     (cb)        => ipcRenderer.on('queue:progress', (_e, p) => cb(p))
  },

  // Crash
  crash: {
    last:           ()          => ipcRenderer.invoke('crash:lastReport'),
    simulate:       ()          => ipcRenderer.invoke('crash:simulate')
  }
};

contextBridge.exposeInMainWorld('api', api);
