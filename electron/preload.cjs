const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stackmate', {
  getConnection: () => ipcRenderer.invoke('stackmate:get-connection'),
  onConnectionChanged: (callback) => {
    const listener = (_event, connection) => callback(connection);
    ipcRenderer.on('stackmate:connection-changed', listener);
    return () => ipcRenderer.removeListener('stackmate:connection-changed', listener);
  },
  setDirty: (dirty) => ipcRenderer.send('stackmate:set-dirty', dirty),
  retryBackend: () => ipcRenderer.invoke('stackmate:retry-backend'),
});
