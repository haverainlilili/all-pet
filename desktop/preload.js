const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  // 主进程 → 渲染层：宠物素材与监控快照
  onPet: (cb) => ipcRenderer.on('pet', (_e, payload) => cb(payload)),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  onWatchError: (cb) => ipcRenderer.on('watch-error', (_e, msg) => cb(msg)),

  // 宠物管理（渲染层 → 主进程）
  listPets: () => ipcRenderer.invoke('pets:list'),
  setPet: (id) => ipcRenderer.invoke('pets:set', id),
  deletePet: (id) => ipcRenderer.invoke('pets:delete', id),
  importPet: () => ipcRenderer.invoke('pets:import'),
  installPet: (source) => ipcRenderer.invoke('pets:install', source),
  onPetsChanged: (cb) => ipcRenderer.on('pets-changed', () => cb()),

  // 宠物大小
  getScale: () => ipcRenderer.invoke('pets:getScale'),
  setScale: (delta) => ipcRenderer.invoke('pets:setScale', delta),
  onScaleChanged: (cb) => ipcRenderer.on('pet-scale', (_e, scale) => cb(scale)),

  // 气泡高度（渲染层 → 主进程，用于窗口高度对齐）
  resizeForBubble: (height) => ipcRenderer.invoke('pets:resizeBubble', height)
})
