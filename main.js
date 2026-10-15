const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const { parseChannels } = require('./lib/channels');

// === Load .env (no external dependency) ===
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // strip optional quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (e) {
    console.error('Failed to load .env:', e.message);
  }
}
loadEnvFile();

let mainWindow = null;
let channels = [];
let currentChannelIndex = 0;

/**
 * Critical error → ntfy (topic from env, never hardcoded).
 * NTFY_TOPIC — only the topic name, e.g. my-secret-topic
 * or NTFY_URL — full URL https://ntfy.sh/my-secret-topic
 * If neither is set, notifications are skipped.
 */
function notifyCritical(title, message) {
  const topicRaw = (process.env.NTFY_TOPIC || '').trim();
  const urlRaw = (process.env.NTFY_URL || '').trim();

  let hostname = 'ntfy.sh';
  let topicPath = '';

  if (urlRaw) {
    try {
      const u = new URL(urlRaw);
      hostname = u.hostname;
      topicPath = u.pathname; // includes leading /
      if (!topicPath || topicPath === '/') return;
    } catch {
      return;
    }
  } else if (topicRaw) {
    // allow "topic" or "/topic"
    topicPath = topicRaw.startsWith('/') ? topicRaw : '/' + topicRaw;
  } else {
    // not configured — silent skip
    return;
  }

  const body = `${title}\n\n${message}\n\nTime: ${new Date().toISOString()}`;
  const req = https.request(
    {
      hostname,
      path: topicPath,
      method: 'POST',
      headers: {
        Title: 'CatBox Critical',
        Priority: 'high',
        Tags: 'warning,tv',
        'Content-Type': 'text/plain',
      },
    },
    () => {
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
  console.error('Unhandled Rejection', reason);
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
    const secondary = displays.find((d) => d.id !== screen.getPrimaryDisplay().id);
    return secondary || displays[0];
  }
  return displays[0];
}

// === Focus keep (secondary monitor / Windows steals focus) ===
let isQuitting = false;
let focusTimer = null;

function forceFocus() {
  if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.focus();
    }
  } catch (_) {}
}

function registerGlobalKeys() {
  const { globalShortcut } = require('electron');
  const send = (payload) => {
    forceFocus();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-key', payload);
    }
  };

  const bindings = [
    ['Up', { key: 'ArrowUp' }],
    ['Down', { key: 'ArrowDown' }],
    ['Escape', { key: 'Escape' }],
    ['Return', { key: 'Enter' }],
    ['Space', { key: ' ' }],
  ];
  for (let d = 0; d <= 9; d++) {
    bindings.push([String(d), { key: String(d) }]);
  }

  for (const [accel, payload] of bindings) {
    try {
      globalShortcut.register(accel, () => send(payload));
    } catch (e) {
      console.warn('globalShortcut failed for', accel, e.message);
    }
  }
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
    skipTaskbar: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('blur', () => {
    if (isQuitting) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => forceFocus(), 80);
  });

  mainWindow.once('ready-to-show', () => {
    forceFocus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      * { cursor: none !important; }
      body.mouse-active * { cursor: default !important; }
    `);
    forceFocus();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools({ mode: 'right' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('channels-loaded', channels);
  });
}

const ytdlpCache = new Map();
const YTDLP_CACHE_MS = 5 * 60 * 1000;

function runYtDlp(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || String(err)).trim();
          reject(new Error(msg.slice(0, 400) || 'yt-dlp failed'));
          return;
        }
        const url = (stdout || '')
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('http'))
          .pop();
        if (url) resolve(url);
        else reject(new Error('yt-dlp returned empty URL'));
      }
    );
  });
}

async function getYtDlpUrl(link) {
  const cached = ytdlpCache.get(link);
  if (cached && Date.now() - cached.at < YTDLP_CACHE_MS) {
    return cached.url;
  }

  const bins =
    process.platform === 'win32'
      ? ['yt-dlp.exe', 'yt-dlp', 'youtube-dl.exe', 'youtube-dl']
      : ['yt-dlp', 'youtube-dl'];

  const formatAttempts = [
    ['-g', '-f', 'best[protocol^=m3u8]/best[ext=mp4]/best/best', '--no-warnings', '--no-check-certificates', '--no-playlist', link],
    ['-g', '-f', 'b', '--no-warnings', '--no-check-certificates', '--no-playlist', link],
    ['-g', '--no-warnings', '--no-check-certificates', '--no-playlist', link],
  ];

  let lastErr = null;
  for (const bin of bins) {
    for (const args of formatAttempts) {
      try {
        const url = await runYtDlp(bin, args);
        ytdlpCache.set(link, { url, at: Date.now() });
        return url;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('yt-dlp failed');
}

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
    return { error: e.message || 'Failed to resolve stream', name: ch.name, id: ch.id };
  }
});

ipcMain.on('critical-error', (event, title, message) => {
  notifyCritical(title, message);
});

ipcMain.on('quit-app', () => {
  isQuitting = true;
  try {
    require('electron').globalShortcut.unregisterAll();
  } catch (_) {}
  app.quit();
});

ipcMain.on('request-focus', () => {
  forceFocus();
});

app.whenReady().then(() => {
  createWindow();
  registerGlobalKeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else forceFocus();
  });
});

app.on('will-quit', () => {
  isQuitting = true;
  try {
    require('electron').globalShortcut.unregisterAll();
  } catch (_) {}
});

app.on('window-all-closed', () => {
  isQuitting = true;
  try {
    require('electron').globalShortcut.unregisterAll();
  } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});
