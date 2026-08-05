// Options 頁面邏輯：加載/保存 EngineConfig，密鑰寫入獨立安全 key（apiKeyRef 指向）。
// 擴充頁面環境：直接使用 chrome.storage，不經消息總線。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import type { EngineConfig } from '../../domain/models/config';
import { DEFAULT_CONFIG, PROFILE_DEFAULTS } from '../../domain/models/config';

const store = new ChromeStorageConfigStore();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function readForm(): EngineConfig {
  const translationType = $<HTMLSelectElement>('translation-type').value as EngineConfig['translation']['type'];
  const asrType = $<HTMLSelectElement>('asr-type').value as EngineConfig['asr']['type'];
  const modelTier = $<HTMLSelectElement>('asr-tier').value as 'tiny' | 'base' | 'small';
  const profile = $<HTMLSelectElement>('performance-profile').value as EngineConfig['performanceProfile'];

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
    },
    targetLang: $<HTMLInputElement>('target-lang').value || 'zh-Hant',
    displayMode: $<HTMLSelectElement>('display-mode').value as 'mono' | 'bilingual',
    performanceProfile: profile,
    subtitleStyle: {
      'font-size': $<HTMLInputElement>('style-font-size').value,
      color: $<HTMLInputElement>('style-color').value,
      'background-color': $<HTMLInputElement>('style-bg').value || 'transparent',
    },
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
  $<HTMLInputElement>('target-lang').value = config.targetLang;
  $<HTMLSelectElement>('display-mode').value = config.displayMode;
  $<HTMLSelectElement>('performance-profile').value = config.performanceProfile;
  $<HTMLInputElement>('style-font-size').value = config.subtitleStyle?.['font-size'] ?? '24px';
  $<HTMLInputElement>('style-color').value = config.subtitleStyle?.color ?? '#ffffff';
  $<HTMLInputElement>('style-bg').value = config.subtitleStyle?.['background-color'] ?? 'transparent';
}

async function loadKeysIntoForm(): Promise<void> {
  const llmKey = await store.getApiKey('llm');
  const asrKey = await store.getApiKey('asr');
  $<HTMLInputElement>('translation-api-key').value = llmKey ?? '';
  $<HTMLInputElement>('asr-api-key').value = asrKey ?? '';
}

async function save(): Promise<void> {
  const config = readForm();
  await store.set(config);
  await store.setApiKey('llm', $<HTMLInputElement>('translation-api-key').value.trim());
  await store.setApiKey('asr', $<HTMLInputElement>('asr-api-key').value.trim());
  showStatus('配置已保存');
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
  const config = await store.get();
  fillForm(config);
  await loadKeysIntoForm();

  // 性能檔位變更時自動提示（不強制改值，避免覆蓋用戶微調）。
  $<HTMLSelectElement>('performance-profile').addEventListener('change', () => {
    const prof = PROFILE_DEFAULTS[$<HTMLSelectElement>('performance-profile').value as EngineConfig['performanceProfile']];
    if (prof) {
      $<HTMLSelectElement>('asr-tier').value = prof.asr.modelTier ?? 'base';
      $<HTMLSelectElement>('display-mode').value = prof.displayMode;
    }
  });

  $<HTMLButtonElement>('btn-save').addEventListener('click', () => void save());
  $<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
    fillForm(DEFAULT_CONFIG);
  });
}

void init();
