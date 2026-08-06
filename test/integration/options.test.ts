import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import type { EngineConfig } from '../../src/domain/models/config';

// options.ts 在 import 時即執行 void init()。測試用動態 import 載入後斷言 DOM。
const HTML = `
  <h1>AI_Trans 設定</h1>
  <select id="translation-type"><option value="mt">傳統 MT</option><option value="cloud-llm">雲端 LLM</option><option value="local">本地</option></select>
  <input id="translation-model" />
  <input id="translation-endpoint" />
  <select id="translation-fallback"><option value="mt">MT</option><option value="none">無</option></select>
  <select id="asr-type"><option value="cloud">雲端</option><option value="local-whisper">本地 Whisper</option></select>
  <select id="asr-tier"><option value="tiny">tiny</option><option value="base">base</option><option value="small">small</option></select>
  <input id="asr-endpoint" />
  <input id="target-lang" />
  <select id="display-mode"><option value="mono">僅譯文</option><option value="bilingual">雙語</option></select>
  <select id="performance-profile"><option value="streaming">streaming</option><option value="balanced">balanced</option><option value="quality">quality</option></select>
  <input id="style-font-size" />
  <input id="style-color" />
  <input id="style-bg" />
  <input id="translation-api-key" />
  <input id="asr-api-key" />
  <span id="status"></span>
  <button id="btn-save">保存</button>
  <button id="btn-reset">重置</button>
`;

const SAVED_CONFIG: EngineConfig = {
  translation: { type: 'mt', model: undefined, endpoint: undefined, fallbackType: 'mt' },
  asr: { type: 'cloud', modelTier: 'base' },
  targetLang: 'zh-Hant',
  displayMode: 'mono',
  performanceProfile: 'balanced',
};

async function loadOptions(): Promise<void> {
  vi.resetModules();
  await import('../../src/runtime/options/options');
  await new Promise((r) => setTimeout(r, 20));
}

describe('Options — §5.6 配置讀取失敗可見', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('正常讀取：表單被填充', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    expect((document.getElementById('translation-type') as HTMLSelectElement).value).toBe('mt');
    expect((document.getElementById('target-lang') as HTMLInputElement).value).toBe('zh-Hant');
  });

  it('配置讀取失敗 → 顯示錯誤狀態且用默認值兜底（不空白）', async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage broken')
    );
    await loadOptions();
    expect(document.getElementById('status')!.textContent).toContain('讀取配置失敗');
    expect(document.getElementById('status')!.textContent).toContain('storage broken');
    // 表單以默認配置填充，頁面仍可用
    expect((document.getElementById('translation-type') as HTMLSelectElement).value).toBe('cloud-llm');
  });

  it('密鑰讀取失敗 → 顯示錯誤狀態但頁面仍可用', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    // store.get() 讀 engineConfig（第一次 get），loadKeysIntoForm 讀 engineConfigKeys（第二次 get）。
    // 讓第二次 get（密鑰讀取）拋錯。
    const getMock = chrome.storage.local.get as ReturnType<typeof vi.fn>;
    getMock
      .mockImplementationOnce(async (keys?: string | string[]) => {
        // 第一次：正常返回配置
        const list = typeof keys === 'string' ? [keys] : keys as string[];
        const out: Record<string, string> = {};
        for (const k of list) out[k] = SAVED_CONFIG as unknown as string;
        return out;
      })
      .mockRejectedValueOnce(new Error('keys unavailable'));
    await loadOptions();
    expect(document.getElementById('status')!.textContent).toContain('讀取密鑰失敗');
    expect(document.getElementById('status')!.textContent).toContain('keys unavailable');
    expect(document.getElementById('btn-save')).not.toBeNull();
  });
});
