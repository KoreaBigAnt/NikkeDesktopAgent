const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  pointerHit: hit => ipcRenderer.send('pet:pointer-hit', hit),
  startDrag: () => ipcRenderer.send('pet:drag-start'),
  moveDrag: () => ipcRenderer.send('pet:drag-move'),
  endDrag: () => ipcRenderer.send('pet:drag-end'),
  zoom: direction => ipcRenderer.send('pet:zoom', direction),
  connect: () => ipcRenderer.invoke('pet:connect'),
  chatSettings: () => ipcRenderer.invoke('pet:chat-settings'),
  setBackend: backend => ipcRenderer.invoke('pet:set-backend', backend),
  saveKey: key => ipcRenderer.invoke('pet:save-key', key),
  openPersona: theme => ipcRenderer.invoke('pet:open-persona', theme),
  persona: () => ipcRenderer.invoke('pet:persona'),
  savePersona: persona => ipcRenderer.invoke('pet:save-persona', persona),
  submit: text => ipcRenderer.invoke('pet:submit', text),
  stop: () => ipcRenderer.invoke('pet:stop'),
  pin: () => ipcRenderer.invoke('pet:pin'),
  hide: () => ipcRenderer.send('pet:hide'),
  close: () => ipcRenderer.send('pet:close'),
  onEvent: listener => ipcRenderer.on('pet:event', (_event, data) => listener(data)),
});
