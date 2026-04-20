const { contextBridge, ipcRenderer, webFrame } = require('electron');

try { webFrame.setVisualZoomLevelLimits(1, 1); } catch {}

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickVideoFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  refreshLibrary: () => ipcRenderer.invoke('library:refresh'),
  revealInFolder: (itemId) => ipcRenderer.invoke('library:reveal', itemId),
  renameItem: (itemId, newName) => ipcRenderer.invoke('library:rename', itemId, newName),
  deleteItem: (itemId) => ipcRenderer.invoke('library:delete', itemId),
  flagsForItem: (itemId) => ipcRenderer.invoke('library:flags', itemId),
  loadHeatmap: (itemId) => ipcRenderer.invoke('library:loadHeatmap', itemId),
  onLibraryChange: (callback) => ipcRenderer.on('library:changed', () => callback()),
  onFlagCaptured: (callback) => ipcRenderer.on('flag:captured', (_event, payload) => callback(payload)),

  heatmap: {
    buildFromTwitch: (payload) => ipcRenderer.invoke('heatmap:buildFromTwitch', payload),
    pickImportFile: () => ipcRenderer.invoke('heatmap:pickImportFile'),
    importNormalized: (payload) => ipcRenderer.invoke('heatmap:importNormalized', payload),
    cancel: (jobId) => ipcRenderer.invoke('heatmap:cancel', jobId),
    onUpdate: (callback) => ipcRenderer.on('heatmap:update', (_event, payload) => callback(payload)),
    onProgress: (callback) => ipcRenderer.on('heatmap:progress', (_event, payload) => callback(payload)),
    onFinished: (callback) => ipcRenderer.on('heatmap:finished', (_event, payload) => callback(payload)),
    onError: (callback) => ipcRenderer.on('heatmap:error', (_event, payload) => callback(payload))
  },

  clip: {
    ghost: (payload) => ipcRenderer.invoke('clip:ghost', payload),
    vertical: (payload) => ipcRenderer.invoke('clip:vertical', payload),
    onProgress: (callback) => ipcRenderer.on('clip:progress', (_event, payload) => callback(payload))
  },

  drive: {
    status: () => ipcRenderer.invoke('drive:status'),
    startAuth: () => ipcRenderer.invoke('drive:startAuth'),
    disconnect: () => ipcRenderer.invoke('drive:disconnect'),
    upload: (filePath) => ipcRenderer.invoke('drive:upload', filePath),
    onProgress: (callback) => ipcRenderer.on('drive:progress', (_event, payload) => callback(payload))
  },

  obs: {
    status: () => ipcRenderer.invoke('obs:status'),
    connect: () => ipcRenderer.invoke('obs:connect'),
    disconnect: () => ipcRenderer.invoke('obs:disconnect'),
    startRecord: (payload) => ipcRenderer.invoke('record:start', payload),
    stopRecord: () => ipcRenderer.invoke('record:stop')
  },

  whisper: {
    test: () => ipcRenderer.invoke('whisper:test'),
    toggle: (enabled) => ipcRenderer.invoke('whisper:toggle', enabled),
    onLine: (callback) => ipcRenderer.on('transcript:line', (_event, payload) => callback(payload))
  },

  export: {
    run: (payload) => ipcRenderer.invoke('export:run', payload),
    onProgress: (callback) => ipcRenderer.on('export:progress', (_event, payload) => callback(payload))
  },

  queue: {
    enqueue: (row) => ipcRenderer.invoke('queue:enqueue', row),
    list: () => ipcRenderer.invoke('queue:list'),
    clearDone: () => ipcRenderer.invoke('queue:clearDone'),
    onUpdate: (callback) => ipcRenderer.on('queue:update', (_event, payload) => callback(payload)),
    onProgress: (callback) => ipcRenderer.on('queue:progress', (_event, payload) => callback(payload))
  },

  crash: {
    last: () => ipcRenderer.invoke('crash:lastReport'),
    simulate: () => ipcRenderer.invoke('crash:simulate')
  },

  isDev: process.argv.includes('--dev'),
  dev: {
    injectHeatmap: (itemId) => ipcRenderer.invoke('dev:injectHeatmap', itemId)
  }
};

contextBridge.exposeInMainWorld('api', api);
