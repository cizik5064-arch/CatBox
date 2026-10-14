const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catbox', {
  getChannels: () => ipcRenderer.invoke('get-channels'),
  resolveStream: (channelId) => ipcRenderer.invoke('resolve-stream', channelId),
  onChannelsLoaded: (callback) => {
    ipcRenderer.on('channels-loaded', (event, channels) => callback(channels));
  },
  criticalError: (title, message) => ipcRenderer.send('critical-error', title, message),
  quit: () => ipcRenderer.send('quit-app'),
});
