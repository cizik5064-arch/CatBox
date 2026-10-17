const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const { safeParseChannelsJson } = require('./lib/channels');

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
// Returns the parsed channel array, or `null` if the file is missing/unreadable/
// invalid JSON. `null` lets callers distinguish "couldn't parse right now"
// (e.g. file mid-write during a hot-reload) from "legitimately zero channels".
function loadChannelsSafe({ notifyOnError = true } = {}) {
  const jsonPath = path.join(__dirname, 'potocs.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('potocs.json not found!');
    if (notifyOnError) notifyCritical('Startup Error', 'potocs.json not found next to main.js');
    return null;
  }
  const text = fs.readFileSync(jsonPath, 'utf8');
  const result = safeParseChannelsJson(text);
  if (result === null) {
    // Parsing failed — most commonly because the file is being saved by an
    // editor and we read it mid-write (half-written JSON). This is expected
    // and transient: log it quietly, do NOT notify/crash, and let the
    // caller keep using the last-known-good channel list.
    console.warn('potocs.json parse failed (ignored, keeping previous channels)');
  }
  return result;
}

// Startup load: a parse failure here is a real problem (no previous list to
// fall back to), so it's worth the critical notification.
function loadChannels() {
  const result = loadChannelsSafe({ notifyOnError: true });
  return result || [];
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
// Focus is only re-grabbed automatically right after launch/show, or when
// explicitly requested (global hotkey press, renderer mousedown). If the
// user deliberately alt-tabs / clicks another window, we must NOT yank
// focus back — userSwitchedAway tracks that intent.
let isQuitting = false;
let userSwitchedAway = false;

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
    userSwitchedAway = false;
  } catch (_) {}
}

// Explicit focus request (hotkey pressed, user interacted with our window) —
// always clears the "switched away" flag, since this IS the user telling us
// they want to be back on CatBox.
function requestFocusExplicit() {
  userSwitchedAway = false;
  forceFocus();
}

function registerGlobalKeys() {
  const { globalShortcut } = require('electron');
  const send = (payload) => {
    // globalShortcut fires for these keys system-wide, no matter which
    // window the OS currently has focused — including the user's browser,
    // editor, or any other app. We must NOT treat "a bound key was pressed
    // somewhere" as "the user wants CatBox back": that was exactly the bug
    // (Enter/Space pressed in another window was yanking focus to CatBox).
    //
    // Only forward the key / reclaim focus when CatBox is already the
    // foreground window (isFocused()) — i.e. the key really was meant for
    // us. If the user has switched away, we silently do nothing and let
    // the keypress go to whatever app they're actually using.
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) {
      return;
    }
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

  // We intentionally do NOT force focus back on 'blur'. If the window loses
  // focus, it's because either (a) the OS/another app briefly stole it on
  // startup — handled by the initial grabs below — or (b) the user
  // deliberately switched to another window, which we must respect.
  mainWindow.on('blur', () => {
    if (isQuitting) return;
    userSwitchedAway = true;
  });

  mainWindow.on('focus', () => {
    userSwitchedAway = false;
  });

  mainWindow.once('ready-to-show', () => {
    forceFocus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      * { cursor: none !important; }
      body.mouse-active * { cursor: default !important; }
    `);
    // Initial focus grab right after load is fine (app just started, user
    // hasn't switched away from anything yet). Repeated/periodic grabs are
    // removed — see 'blur' handler above.
    if (!userSwitchedAway) forceFocus();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--enable-logging')) {
    // mode: 'undocked' opens DevTools as a separate OS window instead of
    // embedding/splitting it into the main (fullscreen, frameless) window.
    mainWindow.webContents.openDevTools({ mode: 'undocked' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('channels-loaded', channels);
  });
}

// === Hot-reload potocs.json on change ===
// Debounced + resilient: editors often write in multiple steps (truncate,
// then write), so a raw 'change' event can fire while the file is only
// half-written. If parsing fails at that moment we simply skip the reload
// and keep the previous (last-known-good) channel list — we do NOT clear
// channels or show an error, and we log it so it's visible in the console.
let potocsWatcher = null;
let potocsDebounceTimer = null;
const POTOCS_DEBOUNCE_MS = 300;

function handlePotocsChange() {
  clearTimeout(potocsDebounceTimer);
  potocsDebounceTimer = setTimeout(() => {
    const updated = loadChannelsSafe({ notifyOnError: false });
    if (updated === null) {
      // Parse/read failed — almost certainly a mid-write snapshot.
      // Ignore this event entirely; nothing changes.
      console.log('[potocs.json] change detected but file not yet valid JSON — ignoring this event');
      return;
    }
    channels = updated;
    console.log(`[potocs.json] reloaded — ${channels.length} channel(s)`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channels-loaded', channels);
    }
  }, POTOCS_DEBOUNCE_MS);
}

function watchPotocs() {
  const jsonPath = path.join(__dirname, 'potocs.json');
  try {
    if (potocsWatcher) {
      potocsWatcher.close();
      potocsWatcher = null;
    }
    potocsWatcher = fs.watch(jsonPath, { persistent: true }, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        handlePotocsChange();
      }
    });
    potocsWatcher.on('error', (e) => {
      console.warn('potocs.json watcher error (will keep running on next restart):', e.message);
    });
    console.log('[potocs.json] watching for changes:', jsonPath);
  } catch (e) {
    console.warn('Failed to watch potocs.json:', e.message);
  }
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

// Each resolve-stream call runs fully independently — ipcMain.handle already
// dispatches each invocation as its own Promise, so N concurrent channel
// switches naturally resolve/timeout/fail in parallel without blocking one
// another. We additionally cap yt-dlp/network resolution with a per-call
// timeout so a single stuck channel can never hang up a future switch.
const RESOLVE_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

ipcMain.handle('resolve-stream', async (event, channelId) => {
  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return { error: 'Channel not found' };

  try {
    if (ch.source === 'ytdlp') {
      const directUrl = await withTimeout(getYtDlpUrl(ch.link), RESOLVE_TIMEOUT_MS, 'yt-dlp');
      return { url: directUrl, type: 'direct', name: ch.name, id: ch.id };
    }
    return { url: ch.link, type: 'direct', name: ch.name, id: ch.id };
  } catch (e) {
    return { error: e.message || 'Failed to resolve stream', name: ch.name, id: ch.id };
  }
});

// === Persistent last-frame cache (per channel) ===
// Stored as JPEG files under userData/frame-cache/, keyed by channel id, so
// the cache survives app restarts. The renderer grabs a frame via <canvas>
// and sends us the dataURL; we write it to disk. On channel switch, the
// renderer asks for the cached frame to show instead of a black screen while
// the new stream is loading.
function frameCacheDir() {
  const dir = path.join(app.getPath('userData'), 'frame-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function frameCachePath(channelId) {
  return path.join(frameCacheDir(), `ch-${channelId}.jpg`);
}

ipcMain.handle('save-channel-frame', async (event, channelId, dataUrl) => {
  try {
    const match = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
    if (!match) return { ok: false };
    const buf = Buffer.from(match[1], 'base64');
    fs.writeFileSync(frameCachePath(channelId), buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-channel-frame', async (event, channelId) => {
  try {
    const p = frameCachePath(channelId);
    if (!fs.existsSync(p)) return { ok: false };
    const buf = fs.readFileSync(p);
    return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false, error: e.message };
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
  // Renderer only calls this on an actual keydown/mousedown inside our own
  // window, i.e. the user is interacting with CatBox right now — legit to
  // reclaim focus (e.g. after a transient OS focus hiccup).
  requestFocusExplicit();
});

app.whenReady().then(() => {
  createWindow();
  registerGlobalKeys();
  watchPotocs();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else requestFocusExplicit();
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
