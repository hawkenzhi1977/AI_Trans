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

  setInterval(() => {
    if (playing) t += 100;
    render();
  }, 100);

  document.getElementById('btn-play')?.addEventListener('click', () => { playing = true; });
  document.getElementById('btn-pause')?.addEventListener('click', () => { playing = false; });
})();
