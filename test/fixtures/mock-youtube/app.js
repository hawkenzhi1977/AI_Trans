// Mock 播放器：模擬播放時鐘 + 可控播放狀態 + timedtext 字幕端點。
(() => {
  const clockEl = document.getElementById('clock');
  const playerEl = document.getElementById('mock-player');
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
