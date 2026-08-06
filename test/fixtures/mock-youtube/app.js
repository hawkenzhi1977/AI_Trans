// Mock 播放器：模擬播放時鐘 + 可控播放狀態 + timedtext 字幕端點。
(() => {
  const clockEl = document.getElementById('clock');
  // 視頻文本顯示在獨立 span，避免覆寫 #mock-player 容器（擴充覆蓋層掛載於此）。
  const playerEl = document.getElementById('mock-caption');
  let playing = true;
  let t = 0;

  // 字幕數據：每 2 秒一句。
  const LINES = [
    'Hello and welcome',
    'This is the second line',
    'We are testing subtitles',
    'Translation should appear below',
  ];
  const SEG_MS = 2000;

  function render() {
    const seconds = (t / 1000).toFixed(1);
    if (clockEl) clockEl.textContent = seconds;
    const idx = Math.floor(t / SEG_MS) % LINES.length;
    if (playerEl) playerEl.textContent = LINES[idx];
    // 同步到模擬視頻元素，供擴充 observePlayback 讀取 currentTime/duration。
    const video = document.querySelector('video.html5-main-video');
    if (video) {
      video.currentTime = t / 1000;
      video.duration = (LINES.length * SEG_MS) / 1000;
      // 模擬真實媒體元素行為：currentTime 變化觸發 timeupdate，
      // 供擴充 observePlayback 的事件驅動訂閱收到推進。
      video.dispatchEvent(new Event('timeupdate'));
      syncPlayState(video);
    }
  }

  // HTMLMediaElement.paused 只讀；用 play/pause 反映播放/暫停狀態（忽略無媒體源錯誤）。
  function syncPlayState(video) {
    if (playing) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // 字幕端點：timedtext?v=<id>&lang=en → JSON
  window.fetchTimedText = (id, lang) => {
    return {
      events: LINES.map((text, i) => ({
        tStartMs: i * SEG_MS,
        dDurationMs: SEG_MS,
        segs: [{ utf8: text }],
      })),
      lang,
      videoId: id,
    };
  };

  window.__mockState = () => ({ playing, t });

  // 模擬真實播放器：視頻開始播放時，用 XHR 主動請求字幕軌（與 YouTube 播放器一致）。
  // 供擴充 MAIN world 攔截器捕獲（M1-43：捕獲 → 複用，擴充自身不再 fetch）。
  // 註：XHR 請求 /timedtext 由 serve-mock 端點響應（請求計數由服務端暴露）。
  let captionsRequested = false;
  function requestCaptions() {
    if (captionsRequested) return;
    captionsRequested = true;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/timedtext?lang=en&v=abc123');
      xhr.send();
    } catch (err) {
      // 請求失敗不影響 mock 播放器本身（僅影響擴充捕獲）。
      window.__mockCaptionRequestError = String(err);
    }
  }

  setInterval(() => {
    const prev = playing;
    if (playing) t += 100;
    render();
    // 進入播放態時觸發字幕請求（模擬播放器行為）。
    // 首次（captionsRequested=false）即使一直在播放也觸發，保證 E2E 捕獲鏈路可測。
    if (playing && (!prev || !captionsRequested)) requestCaptions();
  }, 100);

  document.getElementById('btn-play')?.addEventListener('click', () => { playing = true; });
  document.getElementById('btn-pause')?.addEventListener('click', () => { playing = false; });
})();
