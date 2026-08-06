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

  test('[M1-43] 捕獲鏈路：播放器請求被攔截複用，擴充自身不 fetch（pot 繞過）', async ({ page }) => {
    // 背景：真實 YouTube 的 timedtext 帶 pot 防護，擴充直接 fetch 拿不到字幕。
    // 修復：MAIN world 攔截器捕獲播放器自身（XHR）的字幕請求，擴充複用該響應。
    // 驗證：(1) 播放器 XHR 發起的 /timedtext 請求計數 = 1（僅播放器自己發）；
    //        (2) 擴充字幕正常顯示（說明複用了捕獲響應而非自己 fetch——若擴充也 fetch，
    //            計數會 ≥ 2）。
    await page.goto('/with-native-captions.html');

    // 清零計數，避免前序測試（smoke/其他用例）的 timedtext 請求累計干擾。
    await page.evaluate(() =>
      fetch('/__mock-caption-request-count/reset').then((r) => r.json())
    );

    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });

    // 字幕文本出現（複用捕獲響應後管線成功）。
    await expect(page.locator('.ai-trans-overlay')).not.toBeEmpty({ timeout: 8_000 });

    // 讀取服務端 timedtext 請求計數：應恰好 1（僅 mock 播放器的 XHR）。
    // 若擴充自己 fetch，計數會是 2。
    const { count } = await page.evaluate(() =>
      fetch('/__mock-caption-request-count').then((r) => r.json() as Promise<{ count: number }>)
    );
    expect(count).toBe(1);
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

  test('配置變更經 chrome.storage.onChanged 觸發熱重啟，覆蓋層不累積', async ({ page, context }) => {
    // 模擬 Options 頁保存配置（寫 chrome.storage.local）。content-script 監聽 onChanged，
    // 應觸發 restart 而非殘留多個覆蓋層或崩潰——驗證跨上下文熱重載鏈路。
    // 注意：chrome.storage 僅在擴充上下文可用（頁面主世界無），故經 service worker 寫入。
    await page.goto('/with-native-captions.html?v=abc123');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });

    // 取得擴充 service worker（MV3 background）。可能尚未啟動，等待其出現。
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');

    // 在 service worker 上下文寫入 engineConfig（等價 Options 保存），觸發 storage.onChanged。
    // 重要：端點必須是絕不可達的假端口，禁止指向真實本地服務（127.0.0.1:8000 等）——
    // 否則測試會真實請求開發機上的 omlx 等服務，污染日誌與診斷。
    await sw.evaluate(() => {
      return new Promise<void>((resolve) => {
        chrome.storage.local.set(
          {
            engineConfig: {
              translation: { type: 'local', model: 'test-hot-reload', endpoint: 'http://127.0.0.1:59999/v1', fallbackType: 'mt' },
              asr: { type: 'local-whisper', modelTier: 'base' },
              targetLang: 'zh-Hant',
              displayMode: 'bilingual',
              performanceProfile: 'balanced',
            },
          },
          () => resolve()
        );
      });
    });

    // 熱重啟後覆蓋層應重新掛載且仍恰好一個（restart 清理舊訂閱 + 複用渲染器）。
    await page.waitForTimeout(1500);
    await expect(page.locator('.ai-trans-overlay')).toHaveCount(1);
    await expect(page.locator('.ai-trans-overlay')).toBeAttached();
  });

  test('[M1-45] SPA 換視頻後字幕重新出現（舊視頻捕獲不誤用，新捕獲生效）', async ({ page }) => {
    // 場景重現：用戶反饋「首次成功一次，換視頻後永久失敗」。
    // 機制：YouTube 換視頻為 SPA（pushState），content-script 不重載——
    // 修復後 content-script 偵測 URL v 參數變化 → 熱重啟字幕管線 → 新播放器發新請求
    // → 捕獲（含新 videoId）→ 複用成功。
    await page.goto('/with-native-captions.html?v=abc123');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });
    await expect(page.locator('.ai-trans-overlay')).not.toBeEmpty({ timeout: 8_000 });

    // 清零計數：記錄換視頻後新播放器的請求次數。
    await page.evaluate(() =>
      fetch('/__mock-caption-request-count/reset').then((r) => r.json())
    );

    // 模擬 SPA 換視頻：pushState 到新 v，並派發 popstate 兜底。
    await page.evaluate(() => {
      history.pushState({}, '', '/with-native-captions.html?v=videoB');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // content-script 偵測 v 變化 → restart → 新播放器請求 → 字幕重新出現。
    await expect(page.locator('.ai-trans-overlay')).not.toBeEmpty({ timeout: 10_000 });

    // 覆蓋層不累積（restart 清理舊訂閱）。
    await expect(page.locator('.ai-trans-overlay')).toHaveCount(1);
  });

  test('[TC-F11] 翻譯降級時寫入 lastDiagnostic 診斷記錄（用戶可查失敗原因）', async ({ page, context }) => {
    // Mock 宿主上 LLM 端點不可達（無網/無 key）→ fetch 失敗 → 管線降級 MT →
    // content-script.onEvent 應把降級原因持久化到 chrome.storage.local['lastDiagnostic']。
    // 這是「字幕沒出來」時用戶能在 popup 看到具體原因的數據來源。
    await page.goto('/with-native-captions.html');
    await expect(page.locator('.ai-trans-overlay')).toBeAttached({ timeout: 10_000 });

    // 取得擴充 service worker，經其讀取 chrome.storage.local（頁面主世界無 chrome）。
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');

    // 等待降級發生並輪詢診斷記錄寫入（翻譯在播放時鐘推進、字幕就緒後觸發）。
    await expect
      .poll(
        async () =>
          sw.evaluate(
            () =>
              new Promise<string | undefined>((resolve) => {
                chrome.storage.local.get('lastDiagnostic', (r) => {
                  const rec = r.lastDiagnostic as { message?: string } | undefined;
                  resolve(rec?.message);
                });
              })
          ),
        { timeout: 10_000 }
      )
      .toBeTruthy();
  });
});
