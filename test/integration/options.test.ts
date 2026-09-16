import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock, dispatchRuntimeMessage } from '../support/setup-dom';
import type { EngineConfig } from '../../src/domain/models/config';

// options.ts 在 import 時即執行 void init()。測試用動態 import 載入後斷言 DOM。
const HTML = `
  <h1>AI_Trans 設定</h1>
  <input type="checkbox" id="enable-toggle" />
  <select id="translation-type"><option value="mt">傳統 MT</option><option value="cloud-llm">雲端 LLM</option><option value="local">本地</option><option value="local-onnx">本地 ONNX</option></select>
  <input id="translation-model" />
  <input id="translation-endpoint" />
  <select id="translation-fallback"><option value="mt">MT</option><option value="local-onnx">本地 ONNX</option><option value="none">無</option></select>
  <select id="local-onnx-chunk-size"><option value="3">3</option><option value="4">4</option><option value="5" selected>5</option></select>
  <p id="local-model-name">onnx-community/Qwen2.5-0.5B-Instruct</p>
  <span id="local-model-size-info">約 150 MB</span>
  <span id="local-model-status-badge">檢測中...</span>
  <div id="local-model-progress-container" style="display:none;">
    <progress id="local-model-progress-bar" value="0" max="100"></progress>
    <span id="local-model-progress-text">0%</span>
    <p id="local-model-progress-detail"></p>
  </div>
  <button id="btn-download-model">下載模型</button>
  <button id="btn-warmup-model">預加載模型</button>
  <button id="btn-clear-model">清除快取</button>
  <select id="asr-type"><option value="cloud">雲端</option><option value="local-whisper">本地 Whisper</option></select>
  <select id="asr-tier"><option value="tiny">tiny</option><option value="base" selected>base</option><option value="small">small</option><option value="tiny-multi">tiny-multi</option><option value="base-multi">base-multi</option><option value="small-multi">small-multi</option></select>
  <input id="asr-endpoint" />
  <input id="asr-custom-model" />
  <input id="asr-vad-threshold" type="range" min="0.1" max="5" step="0.1" value="0.5" />
  <span id="asr-vad-val">0.5</span>
  <select id="asr-accumulate-window"><option value="2000" selected>2s</option><option value="3000">3s</option><option value="5000">5s</option></select>
  <input id="asr-model-name" disabled />
  <p id="asr-model-size-info"></p>
  <span id="asr-model-status-badge">檢測中...</span>
  <div id="asr-model-progress-container" style="display:none;">
    <progress id="asr-model-progress-bar" value="0" max="100"></progress>
    <span id="asr-model-progress-text">0%</span>
    <p id="asr-model-progress-detail"></p>
  </div>
  <button id="btn-download-asr-model">下載模型</button>
  <button id="btn-clear-asr-model">清除快取</button>
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
  <input type="checkbox" id="dbg-local-onnx" />
  <input type="checkbox" id="dbg-audio" />
  <input type="checkbox" id="dbg-popup" />
  <input id="translation-api-key" />
  <input id="asr-api-key" />
  <span id="status"></span>
  <button id="btn-save">保存</button>
  <button id="btn-reset">重置</button>
  <footer><span id="version"></span></footer>
`;

const SAVED_CONFIG: EngineConfig = {
  enabled: true,
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
    'local-onnx': false,
    audio: false,
    popup: false,
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

describe('Options — M2-24 補充修復十三 預加載模型按鈕', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('模型未下載時「預加載模型」按鈕禁用', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    // check-status 返回 downloaded:false（無 transformers-cache）。
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { downloaded: false },
    });
    await loadOptions();
    expect((document.getElementById('btn-warmup-model') as HTMLButtonElement).disabled).toBe(true);
  });

  it('點擊預加載：發送 local-onnx:warmup，成功後標籤顯示已預加載', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    // 模擬模型已下載（check-status 返回 ok）→ 預加載按鈕可用。
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockReset();
    sendMessage
      .mockResolvedValueOnce({ ok: true, result: { downloaded: true } }) // local-onnx check-status
      .mockResolvedValueOnce({ ok: true, result: { downloaded: true } }) // asr-whisper check-status
      .mockResolvedValueOnce({ ok: true }); // warmup
    await loadOptions();
    const btnWarmup = document.getElementById('btn-warmup-model') as HTMLButtonElement;
    expect(btnWarmup.disabled).toBe(false);
    btnWarmup.click();
    await new Promise((r) => setTimeout(r, 20));
    // 已發送 warmup 消息。
    expect(sendMessage).toHaveBeenCalledWith({ topic: 'local-onnx:warmup' });
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('已預加載');
    expect(document.getElementById('status')!.textContent).toContain('模型已預加載');
  });

  it('預加載失敗時標籤顯示錯誤並提示原因（§5.6 不靜默）', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockReset();
    sendMessage
      .mockResolvedValueOnce({ ok: true, result: { downloaded: true } }) // local-onnx check-status
      .mockResolvedValueOnce({ ok: true, result: { downloaded: true } }) // asr-whisper check-status
      .mockResolvedValueOnce({ ok: false, error: 'Local ONNX model not downloaded' }); // warmup 失敗
    await loadOptions();
    (document.getElementById('btn-warmup-model') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('預加載失敗');
    expect(document.getElementById('status')!.textContent).toContain('Local ONNX model not downloaded');
  });
});

describe('Options — M2-62 modelTier 持久化', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('選擇 base-multi 後保存，modelTier 不被性能檔位覆蓋', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    // 用戶選擇 base-multi（多語言）
    (document.getElementById('asr-tier') as HTMLSelectElement).value = 'base-multi';
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('engineConfig');
    const saved = (stored as Record<string, unknown>).engineConfig as EngineConfig;
    // M2-62：modelTier 保留用戶選擇，不被 PROFILE_DEFAULTS.balanced.asr.modelTier('base') 覆蓋
    expect(saved.asr.modelTier).toBe('base-multi');
  });

  it('選擇 tiny-multi + streaming 檔位保存，modelTier 仍為 tiny-multi', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    (document.getElementById('asr-tier') as HTMLSelectElement).value = 'tiny-multi';
    (document.getElementById('performance-profile') as HTMLSelectElement).value = 'streaming';
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('engineConfig');
    const saved = (stored as Record<string, unknown>).engineConfig as EngineConfig;
    expect(saved.asr.modelTier).toBe('tiny-multi');
  });

  it('.en 模型顯示「僅支持英文音頻」提示', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    // 默認 base（.en）→ sizeInfo 應含英文提示
    expect(document.getElementById('asr-model-size-info')!.textContent).toContain('僅支持英文音頻');
  });

  it('多語言模型不顯示英文限制提示', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    await loadOptions();
    (document.getElementById('asr-tier') as HTMLSelectElement).value = 'base-multi';
    // 觸發 change 事件 → checkModelStatus → updateModelName
    (document.getElementById('asr-tier') as HTMLSelectElement).dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('asr-model-size-info')!.textContent).not.toContain('僅支持英文音頻');
  });

  it('重新打開頁面後 asr-tier select 恢復已保存的 modelTier', async () => {
    const configWithMulti: EngineConfig = {
      ...SAVED_CONFIG,
      asr: { type: 'local-whisper', modelTier: 'base-multi' },
    };
    await chrome.storage.local.set({ engineConfig: configWithMulti });
    await loadOptions();
    expect((document.getElementById('asr-tier') as HTMLSelectElement).value).toBe('base-multi');
  });
});

describe('Options — M1-59 模型狀態廣播即時刷新', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('收到 local-onnx:status loaded=true 廣播 → badge 顯示已預加載（記憶體）', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    // check-status 返回模型已下載但未載入。
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { downloaded: true, loaded: false, loading: false },
    });
    await loadOptions();
    // 初始為「已就緒」。
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('已就緒');

    // 背景預熱完成 → offscreen 廣播 loaded:true → Options 即時刷新。
    dispatchRuntimeMessage({
      type: 'local-onnx:status',
      downloaded: true,
      loaded: true,
      loading: false,
      downloading: false,
    });
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('已預加載');
  });

  it('收到 local-onnx:status downloading=true 廣播 → badge 顯示下載中', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { downloaded: false },
    });
    await loadOptions();
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('未下載');

    dispatchRuntimeMessage({
      type: 'local-onnx:status',
      downloaded: false,
      loading: true,
      downloading: true,
    });
    expect(document.getElementById('local-model-status-badge')!.textContent).toContain('下載中');
  });

  it('收到 asr-whisper:status downloading=true 廣播 → badge 顯示下載中', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { downloaded: false },
    });
    await loadOptions();
    expect(document.getElementById('asr-model-status-badge')!.textContent).toContain('未下載');

    dispatchRuntimeMessage({
      type: 'asr-whisper:status',
      downloaded: false,
      downloading: true,
      modelId: 'Xenova/whisper-base.en',
    });
    expect(document.getElementById('asr-model-status-badge')!.textContent).toContain('下載中');
  });
});

// M2-68：VAD 閾值 + 音頻累積窗口 UI 配置。
describe('Options — M2-68 VAD 閾值 + 音頻累積窗口', () => {
  beforeEach(() => {
    resetChromeMock();
    document.body.innerHTML = HTML;
  });

  it('fillForm：config.vadThreshold=0.008 → slider=0.8 + span 顯示', async () => {
    const config: EngineConfig = { ...SAVED_CONFIG, asr: { type: 'local-whisper', modelTier: 'base', vadThreshold: 0.008 } };
    await chrome.storage.local.set({ engineConfig: config });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: { downloaded: false } });
    await loadOptions();
    expect((document.getElementById('asr-vad-threshold') as HTMLInputElement).value).toBe('0.8');
    expect(document.getElementById('asr-vad-val')!.textContent).toBe('0.8');
  });

  it('fillForm：config.accumulateTargetMs=2000 → select=2000', async () => {
    const config: EngineConfig = { ...SAVED_CONFIG, asr: { type: 'local-whisper', modelTier: 'base', accumulateTargetMs: 2000 } };
    await chrome.storage.local.set({ engineConfig: config });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: { downloaded: false } });
    await loadOptions();
    expect((document.getElementById('asr-accumulate-window') as HTMLSelectElement).value).toBe('2000');
  });

  it('readForm：slider=1.0 + select=5000 → config.vadThreshold=0.01, accumulateTargetMs=5000', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: { downloaded: false } });
    await loadOptions();

    (document.getElementById('asr-vad-threshold') as HTMLInputElement).value = '1.0';
    (document.getElementById('asr-accumulate-window') as HTMLSelectElement).value = '5000';
    (document.getElementById('btn-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));

    const saved = (await chrome.storage.local.get('engineConfig')).engineConfig as EngineConfig;
    expect(saved.asr.vadThreshold).toBeCloseTo(0.01, 4);
    expect(saved.asr.accumulateTargetMs).toBe(5000);
  });

  it('fillForm：無 vadThreshold → 默認 slider=0.5（0.005×100）', async () => {
    await chrome.storage.local.set({ engineConfig: SAVED_CONFIG });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: { downloaded: false } });
    await loadOptions();
    // SAVED_CONFIG.asr 無 vadThreshold → fillForm 用默認 0.005。
    expect((document.getElementById('asr-vad-threshold') as HTMLInputElement).value).toBe('0.5');
    expect(document.getElementById('asr-vad-val')!.textContent).toBe('0.5');
  });
});
