import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import { DIAGNOSTIC_KEY } from '../../src/infrastructure/diagnostics';

// popup.ts 在 import 時即執行 void init()（讀配置 + 讀診斷 + 掛事件）。
// 故測試先用動態 import 載入，再斷言 DOM 結果——驗證「診斷顯示」真實渲染路徑。
const HTML = `
  <h1>AI_Trans</h1>
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
});
