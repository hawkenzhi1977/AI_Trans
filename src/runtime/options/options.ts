// Options 頁面邏輯：加載/保存 EngineConfig，密鑰寫入獨立安全 key（apiKeyRef 指向）。
// 擴充頁面環境：直接使用 chrome.storage，不經消息總線。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import type { EngineConfig, DebugLogCategory } from '../../domain/models/config';
import { DEFAULT_CONFIG, PROFILE_DEFAULTS, DEBUG_LOG_OFF } from '../../domain/models/config';

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
    translation: {
      type: translationType,
      model: $<HTMLInputElement>('translation-model').value || undefined,
      endpoint: $<HTMLInputElement>('translation-endpoint').value || undefined,
      fallbackType: ($<HTMLSelectElement>('translation-fallback').value as 'mt' | 'none') || undefined,
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
  $<HTMLSelectElement>('translation-type').value = config.translation.type;
  $<HTMLInputElement>('translation-model').value = config.translation.model ?? '';
  $<HTMLInputElement>('translation-endpoint').value = config.translation.endpoint ?? '';
  $<HTMLSelectElement>('translation-fallback').value = config.translation.fallbackType ?? 'mt';
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
  // §5.6：storage 讀取失敗不能使 Options 頁無聲不可用（void init 的 rejection 會靜默消失）。
  let config: EngineConfig;
  try {
    config = await store.get();
  } catch (err) {
    showStatus(`讀取配置失敗: ${err instanceof Error ? err.message : String(err)}`);
    config = DEFAULT_CONFIG;
  }
  fillForm(config);
  try {
    await loadKeysIntoForm();
  } catch (err) {
    // 密鑰讀取失敗：頁面仍可用（保存會覆蓋），但必須可見，避免用戶以為 key 已填。
    showStatus(`讀取密鑰失敗: ${err instanceof Error ? err.message : String(err)}`);
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
}

void init();
