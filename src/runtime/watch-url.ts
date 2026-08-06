/**
 * YouTube watch 頁 URL 判斷（M1-47 抽出為純函式供單元測試）。
 *
 * 背景：Chrome 會話恢復時 tab 先以首頁 URL（如 `https://www.youtube.com/?feature=ytca`）
 * 出現，YouTube 之後才以 SPA pushState 導航到 `/watch?v=…`。content-script 若把首頁
 * URL 交給 orchestrator，會觸發「no platform adapter matches」降級。因此判斷當前 URL
 * 是否為可處理的 watch 頁：非 watch 頁時 content-script 靜默等待 SPA 導航。
 */

/** YouTube 可處理的 watch 頁：hostname 為 youtube.com 且 pathname 為 /watch 且帶 v 參數。 */
const YT_HOST_RE = /^(www\.)?youtube\.com$/;

/** 是否為 YouTube watch 頁（含視頻）。mock 宿主（localhost）放寬為任意路徑（E2E）。 */
export function isWatchPage(url: string): boolean {
  try {
    const u = new URL(url);
    if (YT_HOST_RE.test(u.hostname)) {
      return u.pathname === '/watch' && u.searchParams.has('v');
    }
    // mock 宿主：localhost 一律視為可處理頁（E2E 由 platformWatchRe 匹配，無 /watch 路徑）。
    return u.hostname === 'localhost';
  } catch {
    return false;
  }
}
