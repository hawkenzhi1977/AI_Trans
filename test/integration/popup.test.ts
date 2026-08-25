import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import { DIAGNOSTIC_KEY } from '../../src/infrastructure/diagnostics';

// popup.ts 在 import 時即執行 void init()（讀配置 + 讀診斷 + 掛事件）。
// 故測試先用動態 import 載入，再斷言 DOM 結果——驗證「診斷顯示」真實渲染路徑。
const HTML = `
  <h1>AI_Trans</h1>
  <div class="line" id="enable-toggle-line" style="display: flex; align-items: center; gap: 8px;">
    <input type="checkbox" id="enable-toggle" style="width: auto;" />
    <label for="enable-toggle" style="margin: 0; font-weight: 500;">啟用翻譯字幕</label>
  </div>
  <div class="line" id="status-translation">翻譯: —</div>
  <div class="line" id="status-asr">ASR: —</div>
  <div class="line" id="status-lang">目標語言: —</div>
  <div class="line" id="status-diagnostic">最近失敗: —</div>
  <div class="line" id="status-connection">連接測試: —</div>
  <div class="actions">
    <button id="btn-test">測試連接</button>
    <button id="btn-options">設定</button>
  </div>
  <div class="actions">
    <button id="btn-asr">啟用 ASR</button>
    <button id="btn-reload">重新載入頁面</button>
  </div>
`;

async function loadPopup(): Promise<void> {
  // 每次重置模塊緩存，確保 popup.ts 的頂層 void init() 在新 DOM 上重新執行。
  vi.resetModules();
  // 確保配置與診斷準備就緒後再 import，避免競態。
  await chrome.storage.local.set({
    engineConfig: {
      translation: { type: 'local', model: 'qwen', endpoint: 'http://127.0.0.1:59999/v1', fallbackType: 'mt' },
      asr: { type: 'local-whisper', modelTier: 'base' },
      targetLang: 'zh-Hant',
      displayMode: 'bilingual',
      performanceProfile: 'balanced',
    },
  });
  await import('../../src/runtime/popup/popup');
  // 等 init 的異步鏈完成。
  await new Promise((r) => setTimeout(r, 20));
}

describe('popup 診斷顯示', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('有診斷記錄時顯示「最近失敗」行與原因', async () => {
    await chrome.storage.local.set({
      [DIAGNOSTIC_KEY]: {
        kind: 'degraded',
        message: 'primary failed: TypeError: Failed to fetch',
        timestamp: '2026-08-05T00:00:00Z',
      },
    });
    await loadPopup();

    const el = document.getElementById('status-diagnostic');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('最近失敗');
    expect(el!.textContent).toContain('TypeError: Failed to fetch');
    expect(el!.style.display).not.toBe('none');
    expect(el!.classList.contains('warn')).toBe(true);
  });

  it('無診斷記錄時常駐顯示「最近失敗: 無」（不再整行隱藏）', async () => {
    await loadPopup();

    const el = document.getElementById('status-diagnostic');
    expect(el!.textContent).toBe('最近失敗: 無');
    expect(el!.style.display).not.toBe('none');
    expect(el!.classList.contains('warn')).toBe(false);
  });

  it('點擊「測試連接」顯示結果（成功標綠）', async () => {
    // 用假 fetch 直接返回成功響應。
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ping' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await loadPopup();
    document.getElementById('btn-test')!.click();
    await new Promise((r) => setTimeout(r, 20));

    const el = document.getElementById('status-connection')!;
    expect(el.textContent).toContain('連接測試: 端點可達');
    expect(el.classList.contains('ok')).toBe(true);
  });

  it('狀態行渲染正確（翻譯/ASR/語言）', async () => {
    await loadPopup();

    expect(document.getElementById('status-translation')!.textContent).toBe('翻譯: 本地模型 (qwen)');
    expect(document.getElementById('status-asr')!.textContent).toBe('ASR: 本地 Whisper (base)');
    expect(document.getElementById('status-lang')!.textContent).toContain('目標語言: zh-Hant');
  });

  it('配置讀取失敗 → 顯示錯誤狀態而非空白（§5.6 不靜默）', async () => {
    // 讓 storage.get 拋錯，模擬存儲不可用。
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage unavailable')
    );
    await loadPopup();

    const diagEl = document.getElementById('status-diagnostic')!;
    expect(diagEl.textContent).toContain('配置讀取失敗');
    expect(diagEl.textContent).toContain('storage unavailable');
    expect(diagEl.classList.contains('warn')).toBe(true);
    // 其他元素仍可用（不整頁空白）
    expect(document.getElementById('btn-test')).not.toBeNull();
  });

  it('重新載入：無活動 tab 時顯示反饋而非無聲無反應（§5.6）', async () => {
    (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await loadPopup();
    document.getElementById('btn-reload')!.click();
    await new Promise((r) => setTimeout(r, 20));

    const el = document.getElementById('status-connection')!;
    expect(el.textContent).toContain('重新載入: 未找到活動標籤頁');
    expect(el.classList.contains('warn')).toBe(true);
  });

  it('重新載入：有活動 tab → 調用 tabs.reload 並清空狀態', async () => {
    const reloadSpy = vi.spyOn(chrome.tabs, 'reload');
    (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 42 }]);
    await loadPopup();
    document.getElementById('btn-reload')!.click();
    await new Promise((r) => setTimeout(r, 20));

    expect(reloadSpy).toHaveBeenCalledWith(42);
    const el = document.getElementById('status-connection')!;
    expect(el.textContent).not.toContain('未找到');
  });
});

// M2-26：popup init watchdog（§5.6「字幕沒出來」可追溯）——用 fake timers 驅動 slow/timeout。
describe('popup init watchdog（M2-26）', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('init 快速完成（stopInitWatchdog）→ 不觸發 slow/timeout 診斷', async () => {
    const { _testExports } = await import('../../src/runtime/popup/popup');
    vi.useFakeTimers();
    _testExports.resetWatchdogForTest();
    _testExports.startInitWatchdog();
    _testExports.stopInitWatchdog(); // 模擬 init 在 3s 內完成
    await vi.advanceTimersByTimeAsync(15000); // 即使超過 10s 也不 fire

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    expect(stored[DIAGNOSTIC_KEY]).toBeUndefined();
  });

  it('init >3s → popup-init-slow 診斷（message 含 exceeded 3s）', async () => {
    const { _testExports } = await import('../../src/runtime/popup/popup');
    vi.useFakeTimers();
    _testExports.resetWatchdogForTest();
    _testExports.startInitWatchdog();
    await vi.advanceTimersByTimeAsync(3500); // 觸發 slow（未到 10s timeout）

    const rec = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as { lastDiagnostic: { kind: string; message: string } };
    expect(rec.lastDiagnostic.kind).toBe('error');
    expect(rec.lastDiagnostic.message).toContain('popup init exceeded 3s');
  });

  it('init >10s → slow(3s) 與 timeout(10s) 皆記錄，最終落 timeout（後寫覆蓋）', async () => {
    const { _testExports } = await import('../../src/runtime/popup/popup');
    vi.useFakeTimers();
    _testExports.resetWatchdogForTest();
    _testExports.startInitWatchdog();
    await vi.advanceTimersByTimeAsync(10500); // slow（3s）先寫、timeout（10s）後寫覆蓋

    const rec = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as { lastDiagnostic: { kind: string; message: string } };
    expect(rec.lastDiagnostic.kind).toBe('error');
    // 最終落的是 timeout（更嚴重、後寫覆蓋 slow）。
    expect(rec.lastDiagnostic.message).toContain('popup init did not complete within 10s');
  });

  it('stopInitWatchdog 後即使時間推進也不 fire（計時器已清除）', async () => {
    const { _testExports } = await import('../../src/runtime/popup/popup');
    vi.useFakeTimers();
    _testExports.resetWatchdogForTest();
    _testExports.startInitWatchdog();
    await vi.advanceTimersByTimeAsync(1000); // 未達 3s
    _testExports.stopInitWatchdog(); // init 在 1s 完成
    await vi.advanceTimersByTimeAsync(20000); // 推進超過 slow/timeout 門檻

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    expect(stored[DIAGNOSTIC_KEY]).toBeUndefined();
  });
});
