(() => {
  'use strict';

  // ========== State ==========
  let channels = [];
  let currentIndex = 0;
  let hls = null;
  let numberBuffer = '';
  let numberTimer = null;
  let listHideTimer = null;
  let infoHideTimer = null;
  let mouseTimer = null;

  const MAX_DIGITS = 4; // limit on how many digits can be typed for channel number entry (keep in sync with lib/channels.js MAX_DIGIT_BUFFER_LENGTH)
  const SWITCH_DEBOUNCE_MS = 1000; // wait before actually loading a stream on rapid channel changes
  const FRAME_CAPTURE_INTERVAL_MS = 4000; // how often we snapshot the currently playing channel
  const HLS_LOAD_TIMEOUT_MS = 10000; // if hls.js hasn't parsed a manifest by then, treat the channel as stuck/timed out

  // Each call to switchToIndex gets a unique, increasing token. Any
  // in-flight work (debounce timer, stream resolve, hls attach) checks its
  // own token against `latestSwitchToken` before touching shared UI state —
  // this is what makes channel switching effectively "multi-threaded":
  // multiple switches can be in flight at once (old one gracefully winding
  // down while the new one loads) and a stuck/timed-out one can never block
  // a later one, because its stale result is simply discarded when it
  // eventually resolves.
  let latestSwitchToken = 0;
  let activePlaybackToken = 0; // token of the switch that currently owns <video>
  let frameCaptureTimer = null;

  // ========== DOM ==========
  const startScreen = document.getElementById('start-screen');
  const playerScreen = document.getElementById('player-screen');
  const btnWatch = document.getElementById('btn-watch');
  const video = document.getElementById('video');
  const frameCacheImg = document.getElementById('frame-cache');
  const captureCanvas = document.getElementById('frame-capture-canvas');
  const loadingSpinner = document.getElementById('loading-spinner');
  const errorOverlay = document.getElementById('error-overlay');
  const errorText = document.getElementById('error-text');
  const channelList = document.getElementById('channel-list');
  const channelListInner = document.getElementById('channel-list-inner');
  const numberInput = document.getElementById('number-input');
  const numberDigits = document.getElementById('number-digits');
  const channelInfo = document.getElementById('channel-info');
  const infoNumber = document.getElementById('info-number');
  const infoName = document.getElementById('info-name');

  // ========== Helpers ==========
  function showError(msg) {
    errorText.textContent = msg || 'Ошибка воспроизведения';
    errorOverlay.classList.remove('hidden');
  }

  function hideError() {
    errorOverlay.classList.add('hidden');
  }

  function showSpinner() {
    loadingSpinner.classList.remove('hidden');
  }

  function hideSpinner() {
    loadingSpinner.classList.add('hidden');
  }

  function showFrameCache(ch) {
    if (!ch || !window.catbox || !window.catbox.getChannelFrame) {
      frameCacheImg.classList.add('hidden');
      return;
    }
    window.catbox
      .getChannelFrame(ch.id)
      .then((res) => {
        if (res && res.ok && res.dataUrl) {
          frameCacheImg.src = res.dataUrl;
          frameCacheImg.classList.remove('hidden');
        } else {
          frameCacheImg.classList.add('hidden');
        }
      })
      .catch(() => frameCacheImg.classList.add('hidden'));
  }

  function hideFrameCache() {
    frameCacheImg.classList.add('hidden');
  }

  // Grab the current <video> frame and persist it (per-channel) so that next
  // time we switch to this channel we can show it instead of a black screen.
  // Survives restarts because main.js writes it to disk (userData).
  function captureCurrentFrame(ch) {
    if (!ch || !window.catbox || !window.catbox.saveChannelFrame) return;
    try {
      if (!video.videoWidth || !video.videoHeight) return;
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const ctx = captureCanvas.getContext('2d');
      ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
      const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.72);
      window.catbox.saveChannelFrame(ch.id, dataUrl).catch(() => {});
    } catch (_) {
      // toDataURL can throw on cross-origin/tainted canvas for some sources — ignore.
    }
  }

  function startFrameCaptureLoop(ch) {
    stopFrameCaptureLoop();
    frameCaptureTimer = setInterval(() => captureCurrentFrame(ch), FRAME_CAPTURE_INTERVAL_MS);
  }

  function stopFrameCaptureLoop() {
    if (frameCaptureTimer) {
      clearInterval(frameCaptureTimer);
      frameCaptureTimer = null;
    }
  }

  // Gracefully (but quickly) tear down the current HLS instance / video
  // element without blocking the caller — this runs fire-and-forget so the
  // next channel's load can start immediately afterwards, in parallel.
  function gracefulStopPlayback() {
    stopFrameCaptureLoop();
    // Hide the old picture immediately (fades out via CSS transition) so we
    // never show a stale frozen frame of the previous channel while the new
    // one is resolving — the cached-frame image + spinner take over instead.
    video.classList.remove('frame-ready');
    const hlsToStop = hls;
    hls = null;
    // destroy() is synchronous in hls.js but we still isolate it so an
    // exception here can never affect the channel now loading.
    if (hlsToStop) {
      Promise.resolve()
        .then(() => {
          try {
            hlsToStop.destroy();
          } catch (_) {}
        })
        .catch(() => {});
    }
    try {
      video.pause();
    } catch (_) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (_) {}
  }

  function playUrl(url, token, ch) {
    hideError();

    const isHls = url.includes('.m3u8') || url.includes('m3u8') || url.includes('application/vnd.apple.mpegurl');

    // Spinner + cached frame are only dismissed once a frame is actually
    // being PAINTED on screen (the 'playing' event — readyState >= 3 and
    // genuinely advancing), not merely once playback was *requested*.
    // MANIFEST_PARSED / play().then() fire well before the first decoded
    // frame reaches the screen, which previously left a black gap between
    // hiding the cached-frame/spinner and the real picture appearing.
    let revealedForToken = false;
    // Each branch (HLS / direct) registers its own stuck-channel timer and
    // assigns its clear-fn here, so revealOnFirstFrame can cancel whichever
    // one is active once a frame genuinely appears.
    let clearStuckGuard = () => {};
    const revealOnFirstFrame = () => {
      if (revealedForToken || token !== latestSwitchToken) return;
      revealedForToken = true;
      clearStuckGuard();
      // Crossfade: fade the real video in first, then drop the cached
      // frame/spinner slightly after so there's never a one-frame gap of
      // black between "cache visible" and "live video visible".
      video.classList.add('frame-ready');
      setTimeout(() => {
        hideSpinner();
        hideFrameCache();
      }, 120);
      startFrameCaptureLoop(ch);
    };
    video.addEventListener('playing', revealOnFirstFrame, { once: true });

    if (isHls && window.Hls && Hls.isSupported()) {
      const instance = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });

      // Guard against a channel that never sends a usable manifest (stuck
      // stream / CDN hanging). Without this, a bad channel's HLS instance
      // would sit attached to <video> forever, waiting for an event that
      // never comes — this is the "channel switching gets stuck behind a
      // timed-out channel" bug. Here, each instance owns its own timer and
      // is destroyed independently of any other in-flight switch.
      let settled = false;
      const stuckTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        video.removeEventListener('playing', revealOnFirstFrame);
        try {
          instance.destroy();
        } catch (_) {}
        if (token !== latestSwitchToken) return; // already superseded — stay silent
        hideSpinner();
        showError('Канал не отвечает (таймаут)');
      }, HLS_LOAD_TIMEOUT_MS);
      clearStuckGuard = () => {
        settled = true;
        clearTimeout(stuckTimer);
      };

      instance.loadSource(url);
      instance.attachMedia(video);

      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (settled) return;
        settled = true;
        clearTimeout(stuckTimer);
        if (token !== latestSwitchToken) {
          // A newer channel switch has already superseded this one —
          // discard quietly instead of starting playback.
          try {
            instance.destroy();
          } catch (_) {}
          return;
        }
        hls = instance;
        activePlaybackToken = token;
        // Do NOT hide spinner/cache here — wait for the 'playing' listener
        // above, which fires only once a frame is genuinely on screen.
        video.play().catch(() => {});
      });

      instance.on(Hls.Events.ERROR, (event, data) => {
        if (token !== latestSwitchToken) return; // stale/superseded — ignore
        if (data.fatal) {
          if (!settled) {
            settled = true;
            clearTimeout(stuckTimer);
            video.removeEventListener('playing', revealOnFirstFrame);
          }
          console.error('HLS fatal error', data);
          hideSpinner();
          showError('Не удалось воспроизвести поток');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
      // Same stuck-channel guard as the HLS branch above, for native/direct
      // playback (e.g. native HLS on some platforms, or a direct mp4/ts URL).
      let settledDirect = false;
      const directStuckTimer = setTimeout(() => {
        if (settledDirect) return;
        settledDirect = true;
        video.removeEventListener('playing', revealOnFirstFrame);
        if (token !== latestSwitchToken) return;
        hideSpinner();
        showError('Канал не отвечает (таймаут)');
      }, HLS_LOAD_TIMEOUT_MS);
      clearStuckGuard = () => {
        settledDirect = true;
        clearTimeout(directStuckTimer);
      };

      video.src = url;
      video
        .play()
        .then(() => {
          if (token !== latestSwitchToken) return;
          activePlaybackToken = token;
          // Do not clear directStuckTimer here: play() resolving only means
          // playback *started*, not that a frame is visible yet — the
          // 'playing' listener (which does clear it, via revealOnFirstFrame
          // below) is still the source of truth for "really on screen".
        })
        .catch(() => {
          settledDirect = true;
          clearTimeout(directStuckTimer);
          if (token !== latestSwitchToken) return;
          hideSpinner();
          showError('Не удалось начать воспроизведение');
        });
    } else {
      hideSpinner();
      showError('Формат потока не поддерживается');
    }
  }

  // Core switch logic. Debounced: on rapid up/down/digit navigation we wait
  // SWITCH_DEBOUNCE_MS before actually resolving/loading anything, so flicking
  // through channels doesn't spam the network. Each call owns its own token,
  // so multiple switches (an old one gracefully stopping, a newer one
  // loading, maybe a stuck timed-out one in between) never block each other —
  // only the latest token is ever allowed to touch <video> / spinner / error UI.
  function switchToIndex(index, showList = true) {
    if (!channels.length) return;
    if (index < 0) index = channels.length - 1;
    if (index >= channels.length) index = 0;

    currentIndex = index;
    const ch = channels[currentIndex];

    // UI that should update immediately, regardless of debounce/network:
    renderChannelList();
    if (showList) showChannelList();
    showChannelInfo(ch);

    const token = ++latestSwitchToken;

    // Show cached last frame + spinner right away so the user never sees a
    // flash of pure black while we wait out the debounce + network.
    showFrameCache(ch);
    showSpinner();
    hideError();

    setTimeout(() => {
      if (token !== latestSwitchToken) return; // superseded before debounce elapsed — drop silently

      // Gracefully stop whatever is currently playing (if anything), then —
      // without waiting on that teardown — kick off loading the new
      // channel immediately afterwards. Teardown and load proceed
      // concurrently.
      gracefulStopPlayback();

      window.catbox
        .resolveStream(ch.id)
        .then((result) => {
          if (token !== latestSwitchToken) return; // a newer switch has already taken over

          if (result.error) {
            const raw = String(result.error || '');
            const isYtdlp =
              raw.toLowerCase().includes('yt-dlp') ||
              raw.toLowerCase().includes('youtube-dl') ||
              ch.source === 'ytdlp';
            const isTimeout = raw.toLowerCase().includes('timeout');
            hideSpinner();
            showError(
              isYtdlp
                ? 'Не удалось получить поток (yt-dlp). Проверь установку yt-dlp и ссылку.'
                : isTimeout
                ? 'Канал не отвечает (таймаут)'
                : 'Поток недоступен'
            );
            return;
          }

          playUrl(result.url, token, ch);
        })
        .catch((e) => {
          if (token !== latestSwitchToken) return;
          console.error(e);
          hideSpinner();
          showError('Ошибка переключения канала');
          if (window.catbox && window.catbox.criticalError) {
            window.catbox.criticalError('Switch Error', (e && e.stack) || (e && e.message) || String(e));
          }
        });
    }, SWITCH_DEBOUNCE_MS);
  }

  function renderChannelList() {
    channelListInner.innerHTML = '';
    channels.forEach((ch, i) => {
      const item = document.createElement('div');
      item.className = 'ch-item' + (i === currentIndex ? ' active' : '');
      item.innerHTML = `<span class="ch-num">${ch.id}</span><span class="ch-name">${escapeHtml(ch.name)}</span>`;
      channelListInner.appendChild(item);
    });

    const active = channelListInner.querySelector('.ch-item.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showChannelList() {
    channelList.classList.add('visible');
    clearTimeout(listHideTimer);
    listHideTimer = setTimeout(() => {
      channelList.classList.remove('visible');
    }, 2000);
  }

  function showChannelInfo(ch) {
    infoNumber.textContent = ch.id;
    infoName.textContent = ch.name;
    channelInfo.classList.remove('hidden');
    clearTimeout(infoHideTimer);
    infoHideTimer = setTimeout(() => {
      channelInfo.classList.add('hidden');
    }, 2500);
  }

  function onDigit(d) {
    if (numberBuffer.length >= MAX_DIGITS) {
      // Hard cap reached — ignore further digits until the buffer commits/resets.
      return;
    }
    numberBuffer += d;
    numberDigits.textContent = numberBuffer;
    numberInput.classList.remove('hidden');

    clearTimeout(numberTimer);
    numberTimer = setTimeout(() => {
      const num = parseInt(numberBuffer, 10);
      numberBuffer = '';
      numberInput.classList.add('hidden');

      if (!isNaN(num)) {
        const idx = channels.findIndex((c) => c.id === num);
        if (idx !== -1) {
          switchToIndex(idx, true);
        }
      }
    }, 3000);
  }

  function handleKey(key) {
    if (window.catbox && window.catbox.requestFocus) {
      window.catbox.requestFocus();
    }

    if (startScreen.classList.contains('active')) {
      if (key === 'Enter' || key === ' ') {
        startPlayer();
      }
      return;
    }

    switch (key) {
      case 'ArrowUp':
        switchToIndex(currentIndex - 1, true);
        break;
      case 'ArrowDown':
        switchToIndex(currentIndex + 1, true);
        break;
      case 'Escape':
        if (window.catbox) window.catbox.quit();
        break;
      default:
        if (/^[0-9]$/.test(key)) {
          onDigit(key);
        }
        break;
    }
  }

  function onKeyDown(e) {
    const key = e.key;
    if (
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === 'Escape' ||
      key === 'Enter' ||
      key === ' ' ||
      /^[0-9]$/.test(key)
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
    handleKey(key);
  }

  function onMouseMove() {
    document.body.classList.add('mouse-active');
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => {
      document.body.classList.remove('mouse-active');
    }, 2500);
  }

  function startPlayer() {
    startScreen.classList.remove('active');
    playerScreen.classList.add('active');

    if (channels.length === 0) {
      showError('Нет каналов в potocs.json');
      return;
    }

    switchToIndex(0, false);
  }

  async function init() {
    try {
      if (window.catbox) {
        channels = await window.catbox.getChannels();
        window.catbox.onChannelsLoaded((chs) => {
          channels = chs || [];
          // If the currently-playing channel id still exists in the
          // refreshed list, keep following it by id (index may have
          // shifted); otherwise leave currentIndex as-is (clamped on next switch).
          if (playerScreen.classList.contains('active') && channels.length) {
            const playingId = channels[currentIndex] ? channels[currentIndex].id : null;
            if (playingId !== null) {
              const idx = channels.findIndex((c) => c.id === playingId);
              if (idx !== -1) currentIndex = idx;
            }
          }
          renderChannelList();
        });
      }
    } catch (e) {
      console.error('Failed to load channels', e);
    }

    btnWatch.addEventListener('click', startPlayer);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousemove', onMouseMove);

    if (window.catbox && window.catbox.onGlobalKey) {
      window.catbox.onGlobalKey((payload) => {
        if (payload && payload.key) handleKey(payload.key);
      });
    }

    document.addEventListener(
      'mousedown',
      () => {
        if (window.catbox && window.catbox.requestFocus) window.catbox.requestFocus();
      },
      true
    );

    video.addEventListener('error', () => {
      if (video.error) {
        hideSpinner();
        showError('Ошибка видео');
      }
    });

    window.addEventListener('error', (ev) => {
      if (window.catbox) {
        window.catbox.criticalError(
          'Renderer Error',
          ev.message + '\n' + (ev.filename || '') + ':' + (ev.lineno || '')
        );
      }
    });

    window.addEventListener('unhandledrejection', (ev) => {
      if (window.catbox) {
        window.catbox.criticalError('Unhandled Rejection', String(ev.reason));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
