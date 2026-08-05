// Popup 頁面邏輯：顯示當前引擎/語言狀態，提供開啟 Options 入口與「重新載入當前頁」快捷鍵。
// 顯示最近一次翻譯降級/錯誤診斷（見 infrastructure/diagnostics.ts），
// 並提供「測試連接」按鈕直接驗證端點與模型名（見 connection-test.ts）——
// 讓「字幕沒出現」時用戶能一鍵確認是端點/模型/CORS 哪一環的問題。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import { readLastDiagnostic, formatDiagnostic } from '../../infrastructure/diagnostics';
import { testConnection } from './connection-test';
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

  // 最近一次失敗診斷：常駐顯示（無記錄顯示「無」，避免「看不到行」誤會成 bug）。
  const diag = await readLastDiagnostic();
  const diagEl = $('status-diagnostic');
  const text = formatDiagnostic(diag);
  if (text) {
    diagEl.textContent = `最近失敗: ${text}`;
    diagEl.classList.add('warn');
  } else {
    diagEl.textContent = '最近失敗: 無';
  }

  $('btn-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  // 測試連接：直接向配置端點發最小請求，驗證端點可達 + 模型存在 + 響應有效。
  $('btn-test').addEventListener('click', async () => {
    const connEl = $('status-connection');
    connEl.textContent = '連接測試: 測試中…';
    connEl.classList.remove('warn', 'ok');
    const apiKey = (await store.getApiKey('llm')) ?? '';
    const status = await testConnection(config, apiKey);
    if (status.ok) {
      connEl.textContent = `連接測試: ${status.detail}`;
      connEl.classList.add('ok');
    } else {
      connEl.textContent = `連接測試: ${status.error}`;
      connEl.classList.add('warn');
    }
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
      // 顯示實際生效的模型名：若 popup 顯示舊名，說明 storage 未更新（保存/熱重載鏈路問題）。
      return `翻譯: 本地模型${model ? ` (${model})` : ''}`;
    case 'mt':
      return '翻譯: 傳統 MT';
  }
}

function describeAsr(c: EngineConfig): string {
  if (c.asr.type === 'local-whisper') return `ASR: 本地 Whisper (${c.asr.modelTier ?? 'base'})`;
  return 'ASR: 雲端';
}

void init();
