'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('allpetMenu', {
  state: () => ipcRenderer.invoke('tray-panel:state'),
  action: (action, value) => ipcRenderer.invoke('tray-panel:action', action, value),
  close: () => ipcRenderer.invoke('tray-panel:close'),
  onState: callback => ipcRenderer.on('tray-panel:state', (_event, state) => callback(state))
})
