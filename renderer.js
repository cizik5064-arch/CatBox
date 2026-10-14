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
  let isResolving = false;

  // ========== DOM ==========
  const startScreen = document.getElementById('start-screen');
  const playerScreen = document.getElementById('player-screen');
  const btnWatch = document.getElementById('btn-watch');
  const video = document.getElementById('video');
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

  function destroyHls() {
    if (hls) {
      try {
        hls.destroy();
      } catch (_) {}
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
  }

  function playUrl(url) {
    destroyHls();
    hideError();

    const isHls = url.includes('.m3u8') || url.includes('m3u8') || url.includes('application/vnd.apple.mpegurl');

    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error('HLS fatal error', data);
          showError('Не удалось воспроизвести поток');
          // Not sending to ntfy — ordinary stream problem
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
      // Safari / native HLS or progressive
      video.src = url;
      video.play().catch(() => {
        showError('Не удалось начать воспроизведение');
      });
    } else {
      showError('Формат потока не поддерживается');
    }
  }

  async function switchToIndex(index, showList = true) {
    if (!channels.length || isResolving) return;
    if (index < 0) index = channels.length - 1;
    if (index >= channels.length) index = 0;

    currentIndex = index;
    const ch = channels[currentIndex];

    // Update list highlight
    renderChannelList();
    if (showList) {
      showChannelList();
    }

    // Brief info
    showChannelInfo(ch);

    // Resolve & play
    isResolving = true;
    hideError();

    try {
      const result = await window.catbox.resolveStream(ch.id);
      if (result.error) {
        showError(result.error.includes('yt-dlp') || result.error.includes('youtube-dl')
          ? 'Не удалось получить поток (yt-dlp)'
          : 'Поток недоступен');
        isResolving = false;
        return;
      }
      playUrl(result.url);
    } catch (e) {
      console.error(e);
      showError('Ошибка переключения канала');
      // Only real unexpected errors go to ntfy
      if (window.catbox && window.catbox.criticalError) {
        window.catbox.criticalError('Switch Error', e.stack || e.message);
      }
    } finally {
      isResolving = false;
    }
  }

  function renderChannelList() {
    channelListInner.innerHTML = '';
    channels.forEach((ch, i) => {
      const item = document.createElement('div');
      item.className = 'ch-item' + (i === currentIndex ? ' active' : '');
      item.innerHTML = `<span class="ch-num">${ch.id}</span><span class="ch-name">${escapeHtml(ch.name)}</span>`;
      channelListInner.appendChild(item);
    });

    // Scroll active into view
    const active = channelListInner.querySelector('.ch-item.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"');
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

  // ========== Number input ==========
  function onDigit(d) {
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
        // if not found — just disappear, as requested
      }
    }, 3000);
  }

  // ========== Keyboard ==========
  function onKeyDown(e) {
    // Ignore if on start screen
    if (startScreen.classList.contains('active')) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startPlayer();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        switchToIndex(currentIndex - 1, true);
        break;
      case 'ArrowDown':
        e.preventDefault();
        switchToIndex(currentIndex + 1, true);
        break;
      case 'Escape':
        e.preventDefault();
        // Optional: return to start or quit
        // For now just quit on long press? Simple: quit
        if (window.catbox) window.catbox.quit();
        break;
      default:
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          onDigit(e.key);
        }
        break;
    }
  }

  // ========== Mouse cursor auto-hide ==========
  function onMouseMove() {
    document.body.classList.add('mouse-active');
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => {
      document.body.classList.remove('mouse-active');
    }, 2500);
  }

  // ========== Start player ==========
  function startPlayer() {
    startScreen.classList.remove('active');
    playerScreen.classList.add('active');

    if (channels.length === 0) {
      showError('Нет каналов в potocs.json');
      return;
    }

    // Auto-play first channel
    switchToIndex(0, false);
  }

  // ========== Init ==========
  async function init() {
    // Load channels
    try {
      if (window.catbox) {
        channels = await window.catbox.getChannels();
        window.catbox.onChannelsLoaded((chs) => {
          channels = chs || [];
        });
      }
    } catch (e) {
      console.error('Failed to load channels', e);
    }

    btnWatch.addEventListener('click', startPlayer);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousemove', onMouseMove);

    // Video error handler (ordinary, not critical)
    video.addEventListener('error', () => {
      if (video.error) {
        showError('Ошибка видео');
      }
    });

    // Global error → ntfy only for unexpected
    window.addEventListener('error', (ev) => {
      if (window.catbox) {
        window.catbox.criticalError('Renderer Error', ev.message + '\n' + (ev.filename || '') + ':' + (ev.lineno || ''));
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
