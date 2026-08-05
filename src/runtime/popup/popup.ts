// Popup 頁面邏輯：顯示當前引擎/語言狀態，提供開啟 Options 入口與「重新載入當前頁」快捷鍵。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import type { EngineConfig } from '../../domain/models/config';

const store = new ChromeStorageConfigStore();

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

async function init(): Promise<void> {
  const config: EngineConfig = await store.get();

  $('status-translation').textContent = describeTranslation(config);
  $('status-asr').textContent = describeAsr(config);
  $('status-lang').textContent = `目標語言: ${config.targetLang} · ${config.displayMode === 'mono' ? '僅譯文' : '雙語'}`;

  $('btn-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  // 快捷鍵：觸發當前標籤頁重新載入（改配置後生效）。
  $('btn-reload').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) void chrome.tabs.reload(tab.id);
  });
}

function describeTranslation(c: EngineConfig): string {
  const type = c.translation.type;
  const model = c.translation.model ?? '';
  switch (type) {
    case 'cloud-llm':
      return `翻譯: 雲端 LLM${model ? ` (${model})` : ''}`;
    case 'local':
      return '翻譯: 本地模型';
    case 'mt':
      return '翻譯: 傳統 MT';
  }
}

function describeAsr(c: EngineConfig): string {
  if (c.asr.type === 'local-whisper') return `ASR: 本地 Whisper (${c.asr.modelTier ?? 'base'})`;
  return 'ASR: 雲端';
}

void init();
