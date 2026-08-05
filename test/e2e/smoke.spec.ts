import { test, expect } from './fixtures';

/**
 * E2E 冒煙：驗證 Mock YouTube 宿主可加載、播放時鐘推進、timedtext 字幕端點可用。
 * 完整的擴充覆蓋層驗證待 content-script 注入邏輯在 M1 收尾後補充。
 */
test.describe('Mock YouTube 宿主', () => {
  test('頁面加載並顯示播放器', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    await expect(page.locator('#mock-player')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Mock YouTube');
  });

  test('播放時鐘隨時間推進', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    const first = await page.evaluate(() => window.__mockState().t);
    await page.waitForTimeout(600);
    const second = await page.evaluate(() => window.__mockState().t);
    expect(second).toBeGreaterThan(first);
  });

  test('timedtext 字幕端點返回 4 行 events', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    const doc = await page.evaluate(() => window.fetchTimedText('abc123', 'en'));
    expect(doc.events).toHaveLength(4);
    expect(doc.events[0].segs[0].utf8).toBe('Hello and welcome');
  });

  test('暫停後時鐘停止', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    await page.locator('#btn-pause').click();
    const a = await page.evaluate(() => window.__mockState().t);
    await page.waitForTimeout(500);
    const b = await page.evaluate(() => window.__mockState().t);
    expect(b).toBe(a);
    expect(await page.evaluate(() => window.__mockState().playing)).toBe(false);
  });

  test('點擊播放恢復時鐘', async ({ page }) => {
    await page.goto('/watch?v=abc123');
    await page.locator('#btn-pause').click();
    const frozen = await page.evaluate(() => window.__mockState().t);
    await page.locator('#btn-play').click();
    await page.waitForTimeout(500);
    const resumed = await page.evaluate(() => window.__mockState().t);
    expect(resumed).toBeGreaterThan(frozen);
    expect(await page.evaluate(() => window.__mockState().playing)).toBe(true);
  });
});
