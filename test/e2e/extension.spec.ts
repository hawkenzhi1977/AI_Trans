import { test, expect } from './fixtures';

// 擴充功能 E2E 用例：驗證 content-script 注入並在 Mock YouTube 宿主上啟動字幕流程。
// content-script 在 TEST_PROFILE=1 構建下 match 包含 localhost:8721，故可注入。
// 翻譯引擎：LLM 端點無效 → fetch 失敗 → 降級 MT 兜底 → 覆蓋層顯示源文本（MT 字典部分替換）。

declare global {
  interface Window {
    __mockState(): { playing: boolean; t: number };
    fetchTimedText(id: string, lang: string): {
      events: Array<{ tStartMs: number; dDurationMs: number; segs: Array<{ utf8: string }> }>;
    };
  }
}

test.describe('AI_Trans 擴充功能 E2E', () => {
  test('Mock 宿主頁面加載、播放時鐘推進（擴充已加載）', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    await expect(page.locator('#mock-player')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Mock YouTube');
    const first = await page.evaluate(() => window.__mockState().t);
    await page.waitForTimeout(600);
    const second = await page.evaluate(() => window.__mockState().t);
    expect(second).toBeGreaterThan(first);
  });

  test('帶原生字幕頁面：覆蓋層注入', async ({ page }) => {
    await page.goto('/with-native-captions.html');
    await expect(page.locator('#mock-player')).toBeVisible();

    // content-script 注入後需等待播放器就緒並掛載覆蓋層。
    // 掛載即 attached；內容填充由播放時鐘推進驅動（見下一用例）。
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });

    const overlay = page.locator('.ai-trans-overlay');
    // 覆蓋層掛載於 #mock-player 容器下。
    const parent = await overlay.evaluate((el) => el.parentElement?.id ?? '');
    expect(parent).toBe('mock-player');
  });

  test('帶原生字幕頁面：覆蓋層含字幕文本', async ({ page }) => {
    await page.goto('/with-native-captions.html');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });

    // 等待 segments-ready 後渲染器開始有文本（播放時鐘推進才顯示對應時間窗字幕）。
    // 等待最多 8s 讓時鐘推進到第一個字幕窗（0~2000ms）。
    await expect(page.locator('.ai-trans-overlay')).not.toBeEmpty({ timeout: 8_000 });
  });

  test('timedtext 端點可達並返回 4 行', async ({ page }) => {
    await page.goto('/with-native-captions.html');
    const res = await page.evaluate(() =>
      fetch('/timedtext?lang=en&v=abc123').then((r) => r.json() as Promise<{ events: unknown[] }>)
    );
    expect(Array.isArray(res.events)).toBe(true);
    expect((res.events as unknown[]).length).toBe(4);
  });

  test('暫停後字幕覆蓋層仍掛載', async ({ page }) => {
    await page.goto('/with-native-captions.html');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });
    await page.locator('#btn-pause').click();
    // 暫停後覆蓋層節點不應消失。
    await expect(page.locator('.ai-trans-overlay')).toBeAttached();
  });

  test('[R4] 覆蓋層不重複掛載（restart 不累積 overlay 節點）', async ({ page }) => {
    // H-1/H-2 的可觀測症狀：若 restart 未清理舊訂閱/未複用渲染器，
    // 會殘留多個 .ai-trans-overlay。掛載後應始終恰好一個。
    await page.goto('/with-native-captions.html');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });
    // 讓播放推進一段時間（連續 timeupdate 事件，暴露監聽器累積）。
    await page.waitForTimeout(1500);
    await page.locator('#btn-pause').click();
    await page.locator('#btn-play').click();
    await page.waitForTimeout(500);
    // 全程只應有單一覆蓋層節點。
    await expect(page.locator('.ai-trans-overlay')).toHaveCount(1);
  });
});
