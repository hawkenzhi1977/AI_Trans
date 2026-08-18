import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import type { EngineConfig } from '../../src/domain/models/config';

// options.ts 在 import 時即執行 void init()。測試用動態 import 載入後斷言 DOM。
const HTML = `
  <h1>AI_Trans 設定</h1>
  <select id="translation-type"><option value="mt">傳統 MT</option><option value="cloud-llm">雲端 LLM</option><option value="local">本地</option><option value="local-onnx">本地 ONNX</option></select>
  <input id="translation-model" />
  <input id="translation-endpoint" />
  <select id="translation-fallback"><option value="mt">MT</option><option value="local-onnx">本地 ONNX</option><option value="none">無</option></select>
  <select id="asr-type"><option value="cloud">雲端</option><option value="local-whisper">本地 Whisper</option></select>
  <select id="asr-tier"><option value="tiny">tiny</option><option value="base">base</option><option value="small">small</option></select>
  <input id="asr-endpoint" />
  <input id="asr-custom-model" />
  <select id="target-lang"><option value="zh-Hant">中文（繁體）</option><option value="en">English</option><option value="ja">日本語</option></select>
  <select id="display-mode"><option value="mono">僅譯文</option><option value="bilingual">雙語</option></select>
  <select id="performance-profile"><option value="streaming">streaming</option><option value="balanced">balanced</option><option value="quality">quality</option></select>
  <input id="style-font-size" />
  <input id="style-color" />
  <select id="style-bg-preset"><option value="none">無背景</option><option value="gray">半透明灰黑</option><option value="black">半透明黑</option><option value="custom">自定義</option></select>
  <div id="style-bg-custom" style="display:none;">
    <input id="style-bg-color" type="color" value="#202020" />
    <input id="style-bg-opacity" type="range" min="0" max="100" value="70" />
    <span id="style-bg-opacity-val">70</span>
  </div>
  <input type="checkbox" id="dbg-overlay" />
  <input type="checkbox" id="dbg-llm" />
  <input type="checkbox" id="dbg-capture" />
  <input type="checkbox" id="dbg-pipeline" />
  <input type="checkbox" id="dbg-strategy" />
  <input type="checkbox" id="dbg-content" />
  <input type="checkbox" id="dbg-bridge" />
  <input type="checkbox" id="dbg-interceptor" />
  <input id="translation-api-key" />
  <input id="asr-api-key" />
  <input id="local-model-name" disabled />
  <span id="local-model-status-badge">檢測中...</span>
  <div id="local-model-progress-container" style="display:none;">
    <progress id="local-model-progress-bar" value="0" max="100"></progress>
    <span id="local-model-progress-text">0%</span>
    <p id="local-model-progress-detail"></p>
  </div>
  <button id="btn-download-model">下載模型</button>
  <button id="btn-clear-model">清除快取</button>
  <span id="status"></span>
  <button id="btn-save">保存</button>
  <button id="btn-reset">重置</button>
  <footer><span id="version"></span></footer>
`;

const SAVED_CONFIG: EngineConfig = {
  translation: { type: 'mt', model: undefined, endpoint: undefined, fallbackType: 'mt' },
  asr: { type: 'cloud', modelTier: 'base' },
  targetLang: 'zh-Hant',
  displayMode: 'mono',
  performanceProfile: 'balanced',
  debugLog: {
    overlay: false,
    llm: true,
    capture: false,
    pipeline: false,
    strategy: false,
    content: false,
    bridge: false,
    interceptor: false,
  },
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
    expect((document.getElementById('target-lang') as HTMLSelectElement).value).toBe('zh-Hant');
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

describe('Options — M1-51 調試日誌開關區', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('讀取配置後 checkbox 回顯 debugLog 狀態', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    // SAVED_CONFIG.debugLog 僅 llm 開啟
    expect((document.getElementById('dbg-llm') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('dbg-overlay') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('dbg-interceptor') as HTMLInputElement).checked).toBe(false);
  });

  it('保存後 debugLog checkbox 狀態被持久化到配置', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    // 用戶勾選 overlay 與 interceptor
    (document.getElementById('dbg-overlay') as HTMLInputElement).checked = true;
    (document.getElementById('dbg-interceptor') as HTMLInputElement).checked = true;
    (document.getElementById('dbg-llm') as HTMLInputElement).checked = false;
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('engineConfig');
    const saved = (stored as Record<string, unknown>).engineConfig as EngineConfig;
    expect(saved.debugLog.overlay).toBe(true);
    expect(saved.debugLog.interceptor).toBe(true);
    expect(saved.debugLog.llm).toBe(false);
    expect(document.getElementById('status')!.textContent).toContain('配置已保存');
  });

  it('重置默認後全部調試日誌開關歸零（DEBUG_LOG_OFF）', async () => {
    await loadOptions();
    (document.getElementById('dbg-overlay') as HTMLInputElement).checked = true;
    (document.getElementById('btn-reset') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect((document.getElementById('dbg-overlay') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('dbg-llm') as HTMLInputElement).checked).toBe(false);
  });
});

describe('Options — M2 自定義 ASR 模型路徑', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('讀取配置後自定義模型路徑被回填到表單', async () => {
    const configWithCustomModel: EngineConfig = {
      ...SAVED_CONFIG,
      asr: {
        ...SAVED_CONFIG.asr,
        customModelPath: '/path/to/vibevoice',
      },
    };
    await chrome.storage.local.set({ engineConfig: configWithCustomModel });
    await loadOptions();
    expect((document.getElementById('asr-custom-model') as HTMLInputElement).value).toBe('/path/to/vibevoice');
  });

  it('保存後自定義模型路徑被持久化到配置', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    (document.getElementById('asr-custom-model') as HTMLInputElement).value = 'my-custom-model';
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('engineConfig');
    const saved = (stored as Record<string, unknown>).engineConfig as EngineConfig;
    expect(saved.asr.customModelPath).toBe('my-custom-model');
    expect(document.getElementById('status')!.textContent).toContain('配置已保存');
  });

  it('選擇 local-onnx 作為翻譯引擎後保存，type 被持久化', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    (document.getElementById('translation-type') as HTMLSelectElement).value = 'local-onnx';
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('engineConfig');
    const saved = (stored as Record<string, unknown>).engineConfig as EngineConfig;
    expect(saved.translation.type).toBe('local-onnx');
  });
});
