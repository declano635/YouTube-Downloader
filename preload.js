const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // File operations
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  
  // Authentication
  startAuth: () => ipcRenderer.send('start-auth'),
  onAuthSuccess: (callback) => {
    ipcRenderer.on('auth-success', (_, data) => callback(data));
  },
  onAuthError: (callback) => {
    ipcRenderer.on('auth-error', (_, error) => callback(error));
  },
  
  // WebSocket operations
  connectWebSocket: () => ipcRenderer.send('connect-websocket'),
  disconnectWebSocket: () => ipcRenderer.send('disconnect-websocket'),
  onWebSocketMessage: (callback) => {
    ipcRenderer.on('websocket-message', (_, data) => callback(data));
  },
  onWebSocketError: (callback) => {
    ipcRenderer.on('websocket-error', (_, error) => callback(error));
  },
  onWebSocketClose: (callback) => {
    ipcRenderer.on('websocket-close', () => callback());
  },
  
  // Download operations
  startDownload: () => ipcRenderer.send('start-download'),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (_, data) => callback(data));
  },
  onDownloadError: (callback) => {
    ipcRenderer.on('download-error', (_, error) => callback(error));
  },
  
  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('auth-success');
    ipcRenderer.removeAllListeners('auth-error');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('download-error');
    ipcRenderer.removeAllListeners('websocket-message');
    ipcRenderer.removeAllListeners('websocket-error');
    ipcRenderer.removeAllListeners('websocket-close');
  }
});
