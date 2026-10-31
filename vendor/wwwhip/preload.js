const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('wwwhip:whip-crack'),
  hideOverlay: () => ipcRenderer.send('wwwhip:hide-overlay'),
  disarmWhip: () => ipcRenderer.send('wwwhip:disarm-whip'),
  strikeImpact: id => ipcRenderer.send('wwwhip:strike-impact', id),
  onStatus: (fn) => ipcRenderer.on('wwwhip:whip-status', (_event, status) => fn(status)),
  onAutomaticStrike: (fn) => ipcRenderer.on('wwwhip:auto-strike', (_event, data) => fn(data)),
  onConfigure: (fn) => ipcRenderer.on('wwwhip:configure-whip', (_event, data) => fn(data)),
  onSpawnWhip: (fn) => ipcRenderer.on('wwwhip:spawn-whip', (_event, position) => fn(position)),
  onDropWhip: (fn) => ipcRenderer.on('wwwhip:drop-whip', () => fn()),
  onStopWhip: (fn) => ipcRenderer.on('wwwhip:stop-whip', () => fn()),
});
