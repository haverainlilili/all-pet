const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  // 主进程 → 渲染层：宠物素材与监控快照
  onPet: (cb) => ipcRenderer.on('pet', (_e, payload) => cb(payload)),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  onWatchError: (cb) => ipcRenderer.on('watch-error', (_e, msg) => cb(msg)),
  onDebugBubble: (cb) => ipcRenderer.on('debug-bubble', (_e, payload) => cb(payload)),

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

  // 气泡尺寸（渲染层 → 主进程，用于按 AppKit 三阶段宽高调整窗口）
  resizeForBubble: (width, height) => ipcRenderer.invoke('pets:resizeBubble', width, height),
  onCollapseBubble: (cb) => ipcRenderer.on('collapse-bubble', () => cb()),

  // 气泡交互 + 精灵拖动
  launchPlatform: (platform) => ipcRenderer.invoke('pets:launchPlatform', platform),
  dismissTask: (id) => ipcRenderer.invoke('pets:dismissTask', id),
  dismissPlatform: (platform) => ipcRenderer.invoke('pets:dismissPlatform', platform),
  dragStart: (x, y) => ipcRenderer.invoke('pets:dragStart', x, y),
  dragMove: (x, y) => ipcRenderer.invoke('pets:dragMove', x, y),
  dragEnd: () => ipcRenderer.invoke('pets:dragEnd')
})
