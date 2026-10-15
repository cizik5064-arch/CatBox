const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catbox', {
  getChannels: () => ipcRenderer.invoke('get-channels'),
  resolveStream: (channelId) => ipcRenderer.invoke('resolve-stream', channelId),
  onChannelsLoaded: (callback) => {
    ipcRenderer.on('channels-loaded', (event, channels) => callback(channels));
  },
  onGlobalKey: (callback) => {
    ipcRenderer.on('global-key', (event, payload) => callback(payload));
  },
  criticalError: (title, message) => ipcRenderer.send('critical-error', title, message),
  quit: () => ipcRenderer.send('quit-app'),
  requestFocus: () => ipcRenderer.send('request-focus'),
});
