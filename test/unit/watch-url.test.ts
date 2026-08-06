import { describe, it, expect } from 'vitest';
import { isWatchPage } from '../../src/runtime/watch-url';

// isWatchPage 純函式單元測試（M1-47）。
// 背景：Chrome 會話恢復時 tab 先以首頁 URL 出現，YouTube 之後才 SPA 導航到 /watch。
// content-script 用此判斷決定是否把 URL 交給 orchestrator——非 watch 頁靜默等待。

describe('isWatchPage（M1-47 URL 判斷）', () => {
  it('watch 頁：https://www.youtube.com/watch?v=abc 返回 true', () => {
    expect(isWatchPage('https://www.youtube.com/watch?v=abc')).toBe(true);
  });

  it('watch 頁：無 www 前綴同樣匹配', () => {
    expect(isWatchPage('https://youtube.com/watch?v=abc')).toBe(true);
  });

  it('watch 頁：帶額外查詢參數仍匹配', () => {
    expect(isWatchPage('https://www.youtube.com/watch?v=abc&t=10s')).toBe(true);
  });

  it('非 watch 頁：首頁 URL（會話恢復場景）返回 false', () => {
    expect(isWatchPage('https://www.youtube.com/?feature=ytca')).toBe(false);
  });

  it('非 watch 頁：shorts / watch 無 v 參數返回 false', () => {
    expect(isWatchPage('https://www.youtube.com/shorts/abc')).toBe(false);
    expect(isWatchPage('https://www.youtube.com/watch')).toBe(false);
  });

  it('非 watch 頁：其他 hostname 返回 false', () => {
    expect(isWatchPage('https://example.com/watch?v=abc')).toBe(false);
  });

  it('mock 宿主：localhost（任意路徑）返回 true（E2E）', () => {
    expect(isWatchPage('http://localhost:8721/with-native-captions.html')).toBe(true);
  });

  it('非法 URL 返回 false（不拋錯）', () => {
    expect(isWatchPage('not-a-url')).toBe(false);
  });
});
