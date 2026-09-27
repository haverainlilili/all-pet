'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('allpetMenu', {
  state: () => ipcRenderer.invoke('tray-panel:state'),
  action: (action, value) => ipcRenderer.invoke('tray-panel:action', action, value),
  layout: expanded => ipcRenderer.invoke('tray-panel:layout', expanded),
  close: () => ipcRenderer.invoke('tray-panel:close'),
  onState: callback => ipcRenderer.on('tray-panel:state', (_event, state) => callback(state))
})
