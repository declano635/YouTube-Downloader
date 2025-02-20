const { app, BrowserWindow, ipcMain, dialog, protocol } = require("electron");
const path = require("path");
const { WebSocket } = require('ws');
const axios = require('axios');

let mainWindow;
let authWindow = null;
let ws = null;

// Configure protocol
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    },
  },
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    },
  });

  // Updated CSP headers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://localhost:8000 ws://localhost:8000; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https: http: blob:; " +
          "connect-src 'self' http://localhost:8000 ws://localhost:8000; " +
          "form-action 'self' http://localhost:8000; " +
          "frame-ancestors 'self'"
        ],
        'Cross-Origin-Opener-Policy': ['same-origin-allow-popups'],
        'Cross-Origin-Embedder-Policy': ['credentialless']
      }
    });
  });

  mainWindow.loadFile("index.html");
}

function createAuthWindow() {
  if (authWindow) {
    authWindow.focus();
    return;
  }

  authWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    parent: mainWindow,
    modal: true
  });

  // Fix the cookie handling
  authWindow.webContents.session.webRequest.onBeforeSendHeaders(async (details, callback) => {
    try {
      const cookies = await mainWindow.webContents.session.cookies.get({
        url: 'http://localhost:8000'
      });
      
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'Cookie': cookies.map(c => `${c.name}=${c.value}`).join('; ')
        }
      });
    } catch (error) {
      console.error('Cookie handling error:', error);
      callback({
        requestHeaders: {
          ...details.requestHeaders
        }
      });
    }
  });

  // Synchronize cookies between windows
  authWindow.webContents.session.cookies.on('changed', (event, cookie, cause) => {
    mainWindow.webContents.session.cookies.set({
      url: 'http://localhost:8000',
      name: cookie.name,
      value: cookie.value,
      domain: 'localhost'
    });
  });

  authWindow.loadURL('http://localhost:8000/auth');

  authWindow.webContents.on('will-navigate', (event, url) => {
    handleAuthCallback(url);
  });

  authWindow.webContents.on('did-navigate', (event, url) => {
    handleAuthCallback(url);
  });

  authWindow.on('closed', () => {
    authWindow = null;
  });
}

function handleAuthCallback(url) {
  if (url.startsWith('http://localhost:8000/auth/callback')) {
    const urlObj = new URL(url);
    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    
    if (code) {
      // Get cookies from auth window
      authWindow.webContents.session.cookies.get({
        url: 'http://localhost:8000'
      }).then(cookies => {
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        axios.get(`http://localhost:8000/auth/callback`, {
          params: {
            code: code,
            state: state
          },
          headers: {
            Cookie: cookieHeader
          },
          withCredentials: true
        })
          .then(response => {
            // Ensure cookies are synchronized
            const setCookieHeaders = response.headers['set-cookie'];
            if (setCookieHeaders) {
              setCookieHeaders.forEach(cookieStr => {
                const [name, value] = cookieStr.split(';')[0].split('=');
                mainWindow.webContents.session.cookies.set({
                  url: 'http://localhost:8000',
                  name: name,
                  value: value,
                  domain: 'localhost'
                });
              });
            }
            
            mainWindow.webContents.send('auth-success', response.data);
            if (authWindow) {
              authWindow.close();
              authWindow = null;
            }
          })
          .catch(error => {
            console.error('Auth callback error:', error);
            mainWindow.webContents.send('auth-error', error.message);
            if (authWindow) {
              authWindow.close();
              authWindow = null;
            }
          });
      });
    }
  }
}

// WebSocket connection management
function setupWebSocket() {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket('ws://localhost:8000/progress');
  
  ws.on('open', () => {
    console.log('WebSocket connected');
  });

  ws.on('message', (data) => {
    try {
      const progress = JSON.parse(data.toString());
      if (mainWindow) {
        mainWindow.webContents.send('websocket-message', progress);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (mainWindow) {
      mainWindow.webContents.send('websocket-error', error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected');
    if (mainWindow) {
      mainWindow.webContents.send('websocket-close');
    }
    ws = null;
  });
}

app.whenReady().then(() => {
  protocol.registerFileProtocol("app", (request, callback) => {
    const url = request.url.replace("app://", "");
    callback({ path: path.normalize(`${__dirname}/${url}`) });
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on("start-auth", () => {
  createAuthWindow();
});

ipcMain.on('connect-websocket', () => {
  setupWebSocket();
});

ipcMain.on('disconnect-websocket', () => {
  if (ws) {
    ws.close();
    ws = null;
  }
});

ipcMain.on("start-download", () => {
  // Ensure WebSocket connection is active
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setupWebSocket();
  }
});

// Clean up WebSocket on app quit
app.on('before-quit', () => {
  if (ws) {
    ws.close();
  }
});
