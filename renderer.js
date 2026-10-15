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
  let pendingIndex = null; // queue next channel while resolve is in flight

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
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
      video.src = url;
      video.play().catch(() => {
        showError('Не удалось начать воспроизведение');
      });
    } else {
      showError('Формат потока не поддерживается');
    }
  }

  async function switchToIndex(index, showList = true) {
    if (!channels.length) return;
    if (index < 0) index = channels.length - 1;
    if (index >= channels.length) index = 0;

    if (isResolving) {
      pendingIndex = index;
      currentIndex = index;
      renderChannelList();
      if (showList) showChannelList();
      showChannelInfo(channels[currentIndex]);
      return;
    }

    currentIndex = index;
    pendingIndex = null;
    const ch = channels[currentIndex];

    renderChannelList();
    if (showList) showChannelList();
    showChannelInfo(ch);

    isResolving = true;
    hideError();

    try {
      const result = await window.catbox.resolveStream(ch.id);
      if (pendingIndex !== null && pendingIndex !== currentIndex) {
        const next = pendingIndex;
        pendingIndex = null;
        isResolving = false;
        await switchToIndex(next, showList);
        return;
      }
      if (result.error) {
        const raw = String(result.error || '');
        const isYtdlp =
          raw.toLowerCase().includes('yt-dlp') ||
          raw.toLowerCase().includes('youtube-dl') ||
          ch.source === 'ytdlp';
        showError(
          isYtdlp
            ? 'Не удалось получить поток (yt-dlp). Проверь установку yt-dlp и ссылку.'
            : 'Поток недоступен'
        );
        return;
      }
      playUrl(result.url);
    } catch (e) {
      console.error(e);
      showError('Ошибка переключения канала');
      if (window.catbox && window.catbox.criticalError) {
        window.catbox.criticalError('Switch Error', e.stack || e.message);
      }
    } finally {
      isResolving = false;
      if (pendingIndex !== null) {
        const next = pendingIndex;
        pendingIndex = null;
        switchToIndex(next, showList);
      }
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
