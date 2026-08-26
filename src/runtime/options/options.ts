// Options 頁面邏輯：加載/保存 EngineConfig，密鑰寫入獨立安全 key（apiKeyRef 指向）。
// 擴充頁面環境：直接使用 chrome.storage，不經消息總線。
// 同時負責本地 ONNX 翻譯模型的狀態顯示、下載和快取管理。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import type { EngineConfig, DebugLogCategory, LocalModelTier } from '../../domain/models/config';
import { DEFAULT_CONFIG, PROFILE_DEFAULTS, DEBUG_LOG_OFF, LOCAL_TRANSLATION_MODELS } from '../../domain/models/config';

const store = new ChromeStorageConfigStore();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/** 預設背景值映射 */
const BG_PRESETS: Record<string, string> = {
  none: 'transparent',
  gray: 'rgba(32, 32, 32, 0.7)',
  black: 'rgba(0, 0, 0, 0.7)',
};

/** 將 rgba 字符串解析為 {color, opacity}，失敗返回 null */
function parseRgba(value: string): { color: string; opacity: number } | null {
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!match) return null;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  const a = match[4] ? parseFloat(match[4]) : 1;
  const hex = '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
  return { color: hex, opacity: Math.round(a * 100) };
}

/** 根據背景值匹配預設，無匹配返回 'custom' */
function matchPreset(value: string): string {
  for (const [key, preset] of Object.entries(BG_PRESETS)) {
    if (value === preset) return key;
  }
  return 'custom';
}

/** 調試日誌分類 → Options 頁面 checkbox 元素 id（M1-51，順序與 UI 展示對齊）。 */
const DEBUG_CATEGORY_IDS: Array<[DebugLogCategory, string]> = [
  ['overlay', 'dbg-overlay'],
  ['llm', 'dbg-llm'],
  ['capture', 'dbg-capture'],
  ['pipeline', 'dbg-pipeline'],
  ['strategy', 'dbg-strategy'],
  ['content', 'dbg-content'],
  ['bridge', 'dbg-bridge'],
  ['interceptor', 'dbg-interceptor'],
  ['local-onnx', 'dbg-local-onnx'],
  ['popup', 'dbg-popup'],
];

/** 讀取調試日誌 checkbox 狀態。 */
function readDebugLog(): EngineConfig['debugLog'] {
  const out = { ...DEBUG_LOG_OFF };
  for (const [category, id] of DEBUG_CATEGORY_IDS) {
    out[category] = $<HTMLInputElement>(id).checked;
  }
  return out;
}

/** 回填調試日誌 checkbox 狀態。 */
function fillDebugLog(config: EngineConfig['debugLog']): void {
  const merged = { ...DEBUG_LOG_OFF, ...config };
  for (const [category, id] of DEBUG_CATEGORY_IDS) {
    $<HTMLInputElement>(id).checked = merged[category];
  }
}

function readForm(): EngineConfig {
  const translationType = $<HTMLSelectElement>('translation-type').value as EngineConfig['translation']['type'];
  const asrType = $<HTMLSelectElement>('asr-type').value as EngineConfig['asr']['type'];
  const modelTier = $<HTMLSelectElement>('asr-tier').value as 'tiny' | 'base' | 'small';
  const profile = $<HTMLSelectElement>('performance-profile').value as EngineConfig['performanceProfile'];

  // 背景色：根據預設選擇決定
  const preset = $<HTMLSelectElement>('style-bg-preset').value;
  let bgColor: string;
  if (preset === 'custom') {
    const color = $<HTMLInputElement>('style-bg-color').value;
    const opacity = parseInt($<HTMLInputElement>('style-bg-opacity').value, 10);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    bgColor = `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
  } else {
    bgColor = BG_PRESETS[preset] ?? 'transparent';
  }

  // 性能檔位會覆蓋 asr/displayMode 默認（見 PROFILE_DEFAULTS），但保留用戶手動微調。
  const config: EngineConfig = {
    enabled: $<HTMLInputElement>('enable-toggle').checked,
    translation: {
      type: translationType,
      model: $<HTMLInputElement>('translation-model').value || undefined,
      endpoint: $<HTMLInputElement>('translation-endpoint').value || undefined,
      fallbackType: ($<HTMLSelectElement>('translation-fallback').value as 'mt' | 'none') || undefined,
      localModelTier: ($<HTMLSelectElement>('local-model-tier').value as LocalModelTier) || 'small',
      localModelName: LOCAL_TRANSLATION_MODELS[($<HTMLSelectElement>('local-model-tier').value as LocalModelTier) || 'small'],
    },
    asr: {
      type: asrType,
      modelTier,
      endpoint: $<HTMLInputElement>('asr-endpoint').value || undefined,
      customModelPath: $<HTMLInputElement>('asr-custom-model').value || undefined,
    },
    targetLang: $<HTMLSelectElement>('target-lang').value || 'zh-Hant',
    displayMode: $<HTMLSelectElement>('display-mode').value as 'mono' | 'bilingual',
    performanceProfile: profile,
    subtitleStyle: {
      'font-size': $<HTMLInputElement>('style-font-size').value,
      color: $<HTMLInputElement>('style-color').value,
      'background-color': bgColor,
    },
    debugLog: readDebugLog(),
  };

  // 檔位默認值合併：未手動指定 tier 時依檔位。
  const prof = PROFILE_DEFAULTS[profile];
  if (prof) {
    config.asr = { ...config.asr, ...(prof.asr as Partial<EngineConfig['asr']>) };
    if (modelTier === 'base' && profile !== 'balanced') {
      config.asr.modelTier = prof.asr.modelTier;
    }
  }
  return config;
}

function fillForm(config: EngineConfig): void {
  $<HTMLInputElement>('enable-toggle').checked = config.enabled;
  $<HTMLSelectElement>('translation-type').value = config.translation.type;
  $<HTMLInputElement>('translation-model').value = config.translation.model ?? '';
  $<HTMLInputElement>('translation-endpoint').value = config.translation.endpoint ?? '';
  $<HTMLSelectElement>('translation-fallback').value = config.translation.fallbackType ?? 'mt';
  // 本地模型檔位
  const localTier = config.translation.localModelTier ?? 'small';
  $<HTMLSelectElement>('local-model-tier').value = localTier;
  $<HTMLInputElement>('local-model-name').value = LOCAL_TRANSLATION_MODELS[localTier];
  $<HTMLSelectElement>('asr-type').value = config.asr.type;
  $<HTMLSelectElement>('asr-tier').value = config.asr.modelTier ?? 'base';
  $<HTMLInputElement>('asr-endpoint').value = config.asr.endpoint ?? '';
  $<HTMLInputElement>('asr-custom-model').value = config.asr.customModelPath ?? '';
  $<HTMLSelectElement>('target-lang').value = config.targetLang;
  $<HTMLSelectElement>('display-mode').value = config.displayMode;
  $<HTMLSelectElement>('performance-profile').value = config.performanceProfile;
  $<HTMLInputElement>('style-font-size').value = config.subtitleStyle?.['font-size'] ?? '24px';
  $<HTMLInputElement>('style-color').value = config.subtitleStyle?.color ?? '#ffffff';

  // 背景色：匹配預設或設為自定義
  const bgColor = config.subtitleStyle?.['background-color'] ?? 'transparent';
  const preset = matchPreset(bgColor);
  $<HTMLSelectElement>('style-bg-preset').value = preset;

  const customArea = document.getElementById('style-bg-custom');
  if (preset === 'custom') {
    const parsed = parseRgba(bgColor);
    if (parsed) {
      $<HTMLInputElement>('style-bg-color').value = parsed.color;
      $<HTMLInputElement>('style-bg-opacity').value = String(parsed.opacity);
      $<HTMLSpanElement>('style-bg-opacity-val').textContent = String(parsed.opacity);
    }
    if (customArea) customArea.style.display = '';
  } else {
    if (customArea) customArea.style.display = 'none';
  }
  fillDebugLog(config.debugLog);
}

async function loadKeysIntoForm(): Promise<void> {
  const llmKey = await store.getApiKey('llm');
  const asrKey = await store.getApiKey('asr');
  $<HTMLInputElement>('translation-api-key').value = llmKey ?? '';
  $<HTMLInputElement>('asr-api-key').value = asrKey ?? '';
}

async function save(): Promise<void> {
  const config = readForm();
  // §5.5/R6：保存失敗必須讓用戶可見（顯示錯誤狀態），不許未捕獲 reject 靜默消失。
  try {
    await store.set(config);
    await store.setApiKey('llm', $<HTMLInputElement>('translation-api-key').value.trim());
    await store.setApiKey('asr', $<HTMLInputElement>('asr-api-key').value.trim());
    
    // 通知 Offscreen Document 切換模型檔位（如果已載入）
    const localTier = config.translation.localModelTier ?? 'small';
    try {
      await chrome.runtime.sendMessage({
        topic: 'local-onnx:set-model-tier',
        tier: localTier,
      });
    } catch {
      // Offscreen 可能未啟動，忽略錯誤
    }
    
    showStatus('配置已保存');
  } catch (err) {
    console.warn('[AI_Trans] config save failed:', err);
    showStatus(`保存失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// R4：去抖，避免快速連點累積 setTimeout 提前清空當前訊息。
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function showStatus(msg: string): void {
  const el = $<HTMLSpanElement>('status');
  el.textContent = msg;
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.textContent = '';
    statusTimer = null;
  }, 2000);
}

async function init(): Promise<void> {
  // D8：Options 頁面初始化診斷（始終輸出，不依賴 debug flag）
  console.log('[AI_Trans:options] Options page loading...');
  
  // §5.6：storage 讀取失敗不能使 Options 頁無聲不可用（void init 的 rejection 會靜默消失）。
  let config: EngineConfig;
  try {
    config = await store.get();
  } catch (err) {
    const errorMsg = `讀取配置失敗: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[AI_Trans:options]', errorMsg, err);
    showStatus(errorMsg);
    config = DEFAULT_CONFIG;
  }
  
  try {
    fillForm(config);
  } catch (err) {
    // F5：捕獲 fillForm 錯誤並顯示
    const errorMsg = `填充表單失敗: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[AI_Trans:options]', errorMsg, err);
    showStatus(errorMsg);
  }
  
  try {
    await loadKeysIntoForm();
  } catch (err) {
    // 密鑰讀取失敗：頁面仍可用（保存會覆蓋），但必須可見，避免用戶以為 key 已填。
    const errorMsg = `讀取密鑰失敗: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[AI_Trans:options]', errorMsg, err);
    showStatus(errorMsg);
  }

  // 性能檔位變更時自動提示（不強制改值，避免覆蓋用戶微調）。
  $<HTMLSelectElement>('performance-profile').addEventListener('change', () => {
    const prof = PROFILE_DEFAULTS[$<HTMLSelectElement>('performance-profile').value as EngineConfig['performanceProfile']];
    if (prof) {
      $<HTMLSelectElement>('asr-tier').value = prof.asr.modelTier ?? 'base';
      $<HTMLSelectElement>('display-mode').value = prof.displayMode;
    }
  });

  // 背景預設切換：控制自定義區域顯示
  const customArea = document.getElementById('style-bg-custom');
  $<HTMLSelectElement>('style-bg-preset').addEventListener('change', () => {
    const preset = $<HTMLSelectElement>('style-bg-preset').value;
    if (customArea) customArea.style.display = preset === 'custom' ? '' : 'none';
  });

  // 透明度滑塊：即時顯示數值
  $<HTMLInputElement>('style-bg-opacity').addEventListener('input', () => {
    $<HTMLSpanElement>('style-bg-opacity-val').textContent = $<HTMLInputElement>('style-bg-opacity').value;
  });

  $<HTMLButtonElement>('btn-save').addEventListener('click', () => void save());
  $<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
    fillForm(DEFAULT_CONFIG);
  });

  // 本地 ONNX 模型相關事件處理。
  initLocalOnnxModelUI();

  // ASR Whisper 模型手動下載事件處理。
  initAsrModelUI();

  // 版本號顯示
  const versionEl = $('version');
  if (versionEl) {
    try {
      const manifest = chrome.runtime.getManifest();
      versionEl.textContent = `v${manifest.version}`;
    } catch {
      versionEl.textContent = 'v0.0.0';
    }
  }
  
  // D8：初始化成功診斷
  console.log('[AI_Trans:options] Options page loaded successfully');
}

// F5：捕獲 init 的未處理錯誤並顯示
void init().catch((err) => {
  console.error('[AI_Trans:options] Options page failed to load:', err);
  const body = document.body;
  if (body) {
    body.innerHTML = `<div style="color: red; padding: 20px; font-family: monospace;">Options page error: ${err instanceof Error ? err.message : String(err)}<br><br>Stack: ${err instanceof Error ? err.stack : 'N/A'}</div>`;
  }
});

// ============================================================
// 本地 ONNX 翻譯模型 UI 邏輯
// ============================================================

/** 本地 ONNX 模型狀態。 */
type LocalModelStatus = 'checking' | 'not-downloaded' | 'downloading' | 'preloading' | 'preloaded' | 'downloaded' | 'error';

/** 初始化本地 ONNX 模型 UI——狀態檢查、下載、預加載、快取清理。 */
function initLocalOnnxModelUI(): void {
  const statusBadge = $<HTMLSpanElement>('local-model-status-badge');
  const progressContainer = $<HTMLDivElement>('local-model-progress-container');
  const progressBar = $<HTMLProgressElement>('local-model-progress-bar');
  const progressText = $<HTMLSpanElement>('local-model-progress-text');
  const progressDetail = $<HTMLParagraphElement>('local-model-progress-detail');
  const btnDownload = $<HTMLButtonElement>('btn-download-model');
  const btnWarmup = $<HTMLButtonElement>('btn-warmup-model');
  const btnClear = $<HTMLButtonElement>('btn-clear-model');
  const tierSelect = $<HTMLSelectElement>('local-model-tier');
  const modelNameInput = $<HTMLInputElement>('local-model-name');
  const sizeInfo = $<HTMLSpanElement>('local-model-size-info');

  /** 模型大小映射（根據檔位）。 */
  const MODEL_SIZES: Record<LocalModelTier, string> = {
    small: '約 150 MB',
    large: '約 750 MB',
  };

  /** 更新模型名稱和大小顯示。 */
  function updateModelInfo(): void {
    const tier = tierSelect.value as LocalModelTier;
    modelNameInput.value = LOCAL_TRANSLATION_MODELS[tier];
    sizeInfo.textContent = MODEL_SIZES[tier];
  }

  // 監聽檔位變化，更新模型信息
  tierSelect.addEventListener('change', updateModelInfo);
  // 初始化時設置正確的模型信息
  updateModelInfo();

  /** 更新狀態標籤樣式與文字。 */
  function updateStatusBadge(status: LocalModelStatus, message?: string): void {
    const styles: Record<LocalModelStatus, { bg: string; color: string; text: string }> = {
      checking: { bg: '#eee', color: '#666', text: '檢測中...' },
      'not-downloaded': { bg: '#fff3cd', color: '#856404', text: '未下載' },
      downloading: { bg: '#cce5ff', color: '#004085', text: '下載中...' },
      preloading: { bg: '#e2e3f9', color: '#3b3d99', text: '預加載中...' },
      preloaded: { bg: '#d1ecf1', color: '#0c5460', text: '已預加載（記憶體）' },
      downloaded: { bg: '#d4edda', color: '#155724', text: '已就緒' },
      error: { bg: '#f8d7da', color: '#721c24', text: '錯誤' },
    };
    const style = styles[status];
    statusBadge.style.background = style.bg;
    statusBadge.style.color = style.color;
    statusBadge.textContent = message ?? style.text;
  }

  /** 顯示/隱藏進度條。 */
  function setProgressVisible(visible: boolean): void {
    progressContainer.style.display = visible ? '' : 'none';
  }

  /** 更新進度條。 */
  function updateProgress(percent: number, detail?: string): void {
    progressBar.value = percent;
    progressText.textContent = `${Math.round(percent)}%`;
    if (detail) progressDetail.textContent = detail;
  }

  /** 依 offscreen 回報的狀態字段更新 badge。 */
  function applyModelStatus(status: {
    downloaded: boolean;
    loaded?: boolean;
    loading?: boolean;
    downloading?: boolean;
  }): void {
    // M1-59：優先展示載入/下載進行中的狀態，讓 Options 頁與實際模型狀態同步。
    if (status.downloading) {
      updateStatusBadge('downloading');
      btnDownload.disabled = true;
      btnWarmup.disabled = true;
      btnClear.disabled = false;
      return;
    }
    if (status.loaded) {
      updateStatusBadge('preloaded');
      btnDownload.disabled = true;
      btnWarmup.disabled = true;
      btnClear.disabled = false;
      return;
    }
    if (status.loading) {
      updateStatusBadge('preloading');
      btnDownload.disabled = true;
      btnWarmup.disabled = true;
      btnClear.disabled = false;
      return;
    }
    if (status.downloaded) {
      updateStatusBadge('downloaded');
      btnDownload.disabled = true;
      btnWarmup.disabled = false;
      btnClear.disabled = false;
    } else {
      updateStatusBadge('not-downloaded');
      btnDownload.disabled = false;
      btnWarmup.disabled = true;
      btnClear.disabled = true;
    }
  }

  /** 檢查模型狀態。 */
  async function checkModelStatus(): Promise<void> {
    updateStatusBadge('checking');
    try {
      const response = await chrome.runtime.sendMessage({
        topic: 'local-onnx:check-status',
      });
      const res = response as {
        ok: boolean;
        result?: { downloaded: boolean; loaded?: boolean; loading?: boolean; downloading?: boolean };
      };
      if (res.ok && res.result) {
        applyModelStatus(res.result);
      } else {
        updateStatusBadge('not-downloaded');
        btnDownload.disabled = false;
        btnWarmup.disabled = true;
        btnClear.disabled = true;
      }
    } catch (err) {
      updateStatusBadge('error', '檢測失敗');
      console.warn('[AI_Trans] check model status failed:', err);
    }
  }

  /** 預加載模型到記憶體（手動觸發式加載，OMLX 風格）。 */
  async function warmupModel(): Promise<void> {
    updateStatusBadge('preloading');
    btnWarmup.disabled = true;
    btnDownload.disabled = true;
    try {
      // §5.6：預加載失敗必須對用戶可見（不靜默吞掉）。
      const response = await chrome.runtime.sendMessage({ topic: 'local-onnx:warmup' });
      const res = response as { ok: boolean; error?: string };
      if (res.ok) {
        updateStatusBadge('preloaded');
        showStatus('模型已預加載，翻譯首響應將即時');
      } else {
        updateStatusBadge('error', '預加載失敗');
        btnDownload.disabled = false;
        btnWarmup.disabled = false;
        showStatus(`預加載失敗: ${res.error ?? 'unknown error'}`);
      }
    } catch (err) {
      updateStatusBadge('error', '預加載失敗');
      btnDownload.disabled = false;
      btnWarmup.disabled = false;
      showStatus(`預加載失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 下載模型。 */
  async function downloadModel(): Promise<void> {
    updateStatusBadge('downloading');
    setProgressVisible(true);
    updateProgress(0, '正在初始化...');
    btnDownload.disabled = true;
    btnWarmup.disabled = true;

    // §5.6：進度監聽必須在發送請求**之前**添加，否則 await 阻塞導致錯過所有進度消息。
    const progressListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void
    ): void => {
      const msg = message as { type?: string };
      console.log('[AI_Trans:options] received message:', msg.type, msg);
      if (msg.type === 'local-onnx:download-progress') {
        const progressMsg = msg as {
          type: string;
          progress: number;
          loaded: number;
          total: number;
        };
        updateProgress(
          progressMsg.progress,
          `${formatBytes(progressMsg.loaded)} / ${formatBytes(progressMsg.total)}`
        );
      } else if (msg.type === 'local-onnx:download-complete') {
        const completeMsg = msg as { type: string; ok: boolean; error?: string };
        chrome.runtime.onMessage.removeListener(progressListener);
        setProgressVisible(false);
        if (completeMsg.ok) {
          updateStatusBadge('downloaded');
          btnClear.disabled = false;
          btnWarmup.disabled = false;
          showStatus('模型下載完成');
        } else {
          updateStatusBadge('error', '下載失敗');
          btnDownload.disabled = false;
          showStatus(`下載失敗: ${completeMsg.error ?? 'unknown error'}`);
        }
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    try {
      // 發送下載請求給 Service Worker（轉發給 Offscreen）。
      // 使用 void 不 await——進度消息透過 onMessage 廣播，最終結果也透過廣播通知。
      void chrome.runtime.sendMessage({
        topic: 'local-onnx:download',
      });
    } catch (err) {
      chrome.runtime.onMessage.removeListener(progressListener);
      setProgressVisible(false);
      updateStatusBadge('error', '下載失敗');
      btnDownload.disabled = false;
      showStatus(`下載失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 清除模型快取。 */
  async function clearModelCache(): Promise<void> {
    if (!confirm('確定要清除本地模型快取嗎？這將釋放約 350 MB 的儲存空間。')) return;

    try {
      const response = await chrome.runtime.sendMessage({
        topic: 'local-onnx:clear-cache',
      });
      const res = response as { ok: boolean };
      if (res.ok) {
        updateStatusBadge('not-downloaded');
        btnDownload.disabled = false;
        btnWarmup.disabled = true;
        btnClear.disabled = true;
        showStatus('模型快取已清除');
      } else {
        showStatus('清除快取失敗');
      }
    } catch (err) {
      showStatus(`清除快取失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 格式化位元組為人類可讀格式。 */
  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  // 綁定按鈕事件。
  btnDownload.addEventListener('click', () => void downloadModel());
  btnWarmup.addEventListener('click', () => void warmupModel());
  btnClear.addEventListener('click', () => void clearModelCache());

  // M1-59：監聽 offscreen 主動廣播的狀態（背景預熱完成/失敗後即時刷新，
  // 而不是只在頁面生命週期內查一次）。頁面生命週期只註冊一次，不隨操作重複註冊。
  chrome.runtime.onMessage.addListener(
    (message: unknown): boolean => {
      const msg = message as { type?: string };
      if (msg.type === 'local-onnx:status') {
        const statusMsg = msg as {
          type: string;
          downloaded: boolean;
          loaded?: boolean;
          loading?: boolean;
          downloading?: boolean;
        };
        // 下載完成/清除快取路徑已有專屬監聽器處理進度；這裡只處理被動狀態廣播。
        applyModelStatus(statusMsg);
      }
      return false;
    }
  );

  // 初始檢查模型狀態。
  void checkModelStatus();
}

// ============================================================
// ASR Whisper 模型下載 UI 邏輯
// ============================================================

/** Whisper 模型檔位映射（HuggingFace Hub 模型 ID）。 */
const WHISPER_MODEL_IDS: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
  small: 'Xenova/whisper-small.en',
};

/** Whisper 模型大小提示。 */
const WHISPER_MODEL_SIZES: Record<string, string> = {
  'Xenova/whisper-tiny.en': '約 150 MB',
  'Xenova/whisper-base.en': '約 290 MB',
  'Xenova/whisper-small.en': '約 460 MB',
};

/** ASR 模型狀態。 */
type AsrModelStatus = 'checking' | 'not-downloaded' | 'downloading' | 'downloaded' | 'error';

/** 初始化 ASR 模型 UI——狀態檢查、下載、快取清理。 */
function initAsrModelUI(): void {
  const modelNameInput = $<HTMLInputElement>('asr-model-name');
  const sizeInfo = $<HTMLParagraphElement>('asr-model-size-info');
  const statusBadge = $<HTMLSpanElement>('asr-model-status-badge');
  const progressContainer = $<HTMLDivElement>('asr-model-progress-container');
  const progressBar = $<HTMLProgressElement>('asr-model-progress-bar');
  const progressText = $<HTMLSpanElement>('asr-model-progress-text');
  const progressDetail = $<HTMLParagraphElement>('asr-model-progress-detail');
  const btnDownload = $<HTMLButtonElement>('btn-download-asr-model');
  const btnClear = $<HTMLButtonElement>('btn-clear-asr-model');
  const tierSelect = $<HTMLSelectElement>('asr-tier');
  const customModelInput = $<HTMLInputElement>('asr-custom-model');

  /** 獲取當前選中的模型 ID。 */
  function getCurrentModelId(): string {
    const customPath = customModelInput.value.trim();
    if (customPath) return customPath;
    return WHISPER_MODEL_IDS[tierSelect.value] ?? WHISPER_MODEL_IDS.base;
  }

  /** 更新模型名稱顯示和大小提示。 */
  function updateModelName(): void {
    const modelId = getCurrentModelId();
    modelNameInput.value = modelId;
    const size = WHISPER_MODEL_SIZES[modelId] ?? '大小未知';
    sizeInfo.textContent = size;
  }

  /** 更新狀態標籤樣式與文字。 */
  function updateStatusBadge(status: AsrModelStatus, message?: string): void {
    const styles: Record<AsrModelStatus, { bg: string; color: string; text: string }> = {
      checking: { bg: '#eee', color: '#666', text: '檢測中...' },
      'not-downloaded': { bg: '#fff3cd', color: '#856404', text: '未下載' },
      downloading: { bg: '#cce5ff', color: '#004085', text: '下載中...' },
      downloaded: { bg: '#d4edda', color: '#155724', text: '已就緒' },
      error: { bg: '#f8d7da', color: '#721c24', text: '錯誤' },
    };
    const style = styles[status];
    statusBadge.style.background = style.bg;
    statusBadge.style.color = style.color;
    statusBadge.textContent = message ?? style.text;
  }

  /** 顯示/隱藏進度條。 */
  function setProgressVisible(visible: boolean): void {
    progressContainer.style.display = visible ? '' : 'none';
  }

  /** 更新進度條。 */
  function updateProgress(percent: number, detail?: string): void {
    progressBar.value = percent;
    progressText.textContent = `${Math.round(percent)}%`;
    if (detail) progressDetail.textContent = detail;
  }

  /** 格式化位元組。 */
  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /** 依 offscreen 回報的狀態字段更新 badge。 */
  function applyModelStatus(status: { downloaded: boolean; downloading?: boolean }): void {
    // M1-59：下載進行中時顯示「下載中...」，Options 頁重開也能看到進行中的下載。
    if (status.downloading) {
      updateStatusBadge('downloading');
      btnDownload.disabled = true;
      btnClear.disabled = false;
      return;
    }
    if (status.downloaded) {
      updateStatusBadge('downloaded');
      btnDownload.disabled = true;
      btnClear.disabled = false;
    } else {
      updateStatusBadge('not-downloaded');
      btnDownload.disabled = false;
      btnClear.disabled = true;
    }
  }

  /** 檢查 ASR 模型狀態。 */
  async function checkModelStatus(): Promise<void> {
    const modelId = getCurrentModelId();
    updateModelName();
    updateStatusBadge('checking');
    try {
      const response = await chrome.runtime.sendMessage({
        topic: 'asr-whisper:check-status',
        payload: { modelId },
      });
      const res = response as {
        ok: boolean;
        result?: { downloaded: boolean; downloading?: boolean };
      };
      if (res.ok && res.result) {
        applyModelStatus(res.result);
      } else {
        updateStatusBadge('not-downloaded');
        btnDownload.disabled = false;
        btnClear.disabled = true;
      }
    } catch (err) {
      updateStatusBadge('error', '檢測失敗');
      console.warn('[AI_Trans] check ASR model status failed:', err);
    }
  }

  /** 下載 ASR 模型。 */
  async function downloadModel(): Promise<void> {
    const modelId = getCurrentModelId();
    updateStatusBadge('downloading');
    setProgressVisible(true);
    updateProgress(0, '正在初始化...');
    btnDownload.disabled = true;
    btnClear.disabled = true;

    const progressListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void
    ): void => {
      const msg = message as { type?: string };
      if (msg.type === 'asr-whisper:download-progress') {
        const progressMsg = msg as {
          type: string;
          progress: number;
          loaded: number;
          total: number;
        };
        updateProgress(
          progressMsg.progress,
          `${formatBytes(progressMsg.loaded)} / ${formatBytes(progressMsg.total)}`
        );
      } else if (msg.type === 'asr-whisper:download-complete') {
        const completeMsg = msg as { type: string; ok: boolean; error?: string };
        chrome.runtime.onMessage.removeListener(progressListener);
        setProgressVisible(false);
        if (completeMsg.ok) {
          updateStatusBadge('downloaded');
          btnClear.disabled = false;
          showStatus('ASR 模型下載完成');
        } else {
          updateStatusBadge('error', '下載失敗');
          btnDownload.disabled = false;
          showStatus(`下載失敗: ${completeMsg.error ?? 'unknown error'}`);
        }
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    try {
      void chrome.runtime.sendMessage({
        topic: 'asr-whisper:download',
        payload: { modelId },
      });
    } catch (err) {
      chrome.runtime.onMessage.removeListener(progressListener);
      setProgressVisible(false);
      updateStatusBadge('error', '下載失敗');
      btnDownload.disabled = false;
      showStatus(`下載失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 清除 ASR 模型快取。 */
  async function clearModelCache(): Promise<void> {
    if (!confirm('確定要清除 ASR 模型快取嗎？')) return;

    const modelId = getCurrentModelId();
    try {
      const response = await chrome.runtime.sendMessage({
        topic: 'asr-whisper:clear-cache',
        payload: { modelId },
      });
      const res = response as { ok: boolean };
      if (res.ok) {
        updateStatusBadge('not-downloaded');
        btnDownload.disabled = false;
        btnClear.disabled = true;
        showStatus('ASR 模型快取已清除');
      } else {
        showStatus('清除快取失敗');
      }
    } catch (err) {
      showStatus(`清除快取失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 綁定按鈕事件。
  btnDownload.addEventListener('click', () => void downloadModel());
  btnClear.addEventListener('click', () => void clearModelCache());

  // M1-59：監聽 offscreen 主動廣播的 ASR 狀態（下載進行中時重開頁面也能看到）。
  // 頁面生命週期只註冊一次，不隨操作重複註冊。
  chrome.runtime.onMessage.addListener(
    (message: unknown): boolean => {
      const msg = message as { type?: string };
      if (msg.type === 'asr-whisper:status') {
        const statusMsg = msg as {
          type: string;
          downloaded: boolean;
          downloading?: boolean;
        };
        applyModelStatus(statusMsg);
      }
      return false;
    }
  );

  // 檔位或自定義模型變更時更新模型名並重新檢查狀態。
  tierSelect.addEventListener('change', () => void checkModelStatus());
  customModelInput.addEventListener('input', () => void checkModelStatus());

  // 初始檢查。
  updateModelName();
  void checkModelStatus();
}
