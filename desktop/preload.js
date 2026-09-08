const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  // 主进程 → 渲染层：宠物素材与监控快照
  onPet: (cb) => ipcRenderer.on('pet', (_e, payload) => cb(payload)),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  onWatchError: (cb) => ipcRenderer.on('watch-error', (_e, msg) => cb(msg))
})
