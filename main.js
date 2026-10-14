const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const { parseChannels } = require('./lib/channels');

let mainWindow = null;
let channels = [];
let currentChannelIndex = 0;

// === NTFY critical error reporting ===
function notifyCritical(title, message) {
  const body = `${title}\n\n${message}\n\nTime: ${new Date().toISOString()}`;
  const req = https.request(
    {
      hostname: 'ntfy.sh',
      path: '/tvssboxxeedbydontart',
      method: 'POST',
      headers: {
        'Title': 'CatBox Critical',
        'Priority': 'high',
        'Tags': 'warning,tv',
        'Content-Type': 'text/plain',
      },
    },
    (res) => {
      // ignore response
    }
  );
  req.on('error', () => {});
  req.write(body);
  req.end();
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  notifyCritical('Uncaught Exception', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  notifyCritical('Unhandled Rejection', String(reason));
});

// === Load potocs.json ===
function loadChannels() {
  const jsonPath = path.join(__dirname, 'potocs.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('potocs.json not found!');
    notifyCritical('Startup Error', 'potocs.json not found next to main.js');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return parseChannels(raw);
  } catch (e) {
    console.error('Failed to parse potocs.json', e);
    notifyCritical('Startup Error', 'Failed to parse potocs.json: ' + e.message);
    return [];
  }
}

// === Choose display (prefer secondary) ===
function getTargetDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    // Prefer non-primary
    const secondary = displays.find((d) => d.id !== screen.getPrimaryDisplay().id);
    return secondary || displays[0];
  }
  return displays[0];
}

// === Create window ===
function createWindow() {
  channels = loadChannels();
  if (channels.length === 0) {
    console.error('No channels loaded');
  }

  const display = getTargetDisplay();
  const { x, y, width, height } = display.bounds;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for some media
    },
  });

  // Hide cursor by default (CSS will also do it)
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      * { cursor: none !important; }
      body.mouse-active * { cursor: default !important; }
    `);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools only in dev
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Send channels to renderer when ready
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('channels-loaded', channels);
  });
}

// === yt-dlp helper ===
function getYtDlpUrl(link) {
  return new Promise((resolve, reject) => {
    // Prefer yt-dlp, fallback to youtube-dl
    const tryBin = (bin) => {
      execFile(
        bin,
        ['-g', '-f', 'best[protocol^=m3u8]/best/best', '--no-warnings', '--no-check-certificates', link],
        { timeout: 25000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            if (bin === 'yt-dlp') {
              tryBin('youtube-dl');
            } else {
              reject(new Error(stderr || err.message));
            }
            return;
          }
          const url = (stdout || '').trim().split('\n').filter(Boolean).pop();
          if (url && (url.startsWith('http') || url.startsWith('https'))) {
            resolve(url);
          } else {
            reject(new Error('yt-dlp returned empty URL'));
          }
        }
      );
    };
    tryBin('yt-dlp');
  });
}

// === IPC ===
ipcMain.handle('get-channels', () => channels);

ipcMain.handle('resolve-stream', async (event, channelId) => {
  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return { error: 'Channel not found' };

  try {
    if (ch.source === 'ytdlp') {
      const directUrl = await getYtDlpUrl(ch.link);
      return { url: directUrl, type: 'direct', name: ch.name, id: ch.id };
    }
    return { url: ch.link, type: 'direct', name: ch.name, id: ch.id };
  } catch (e) {
    // Not a critical error (bad link / geo / temporary) — just return error to UI
    return { error: e.message || 'Failed to resolve stream', name: ch.name, id: ch.id };
  }
});

ipcMain.on('critical-error', (event, title, message) => {
  notifyCritical(title, message);
});

ipcMain.on('quit-app', () => {
  app.quit();
});

// === App lifecycle ===
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
