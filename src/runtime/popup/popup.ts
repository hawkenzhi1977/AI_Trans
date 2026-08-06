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
  // §5.6：storage 讀取失敗不能使 popup 整頁無聲不可用（void init 的 rejection 會靜默消失）。
  // 失敗時顯示錯誤狀態而不是卡在空白。
  let config: EngineConfig;
  try {
    config = await store.get();
  } catch (err) {
    $('status-diagnostic').textContent = `最近失敗: 錯誤: 配置讀取失敗: ${err instanceof Error ? err.message : String(err)}`;
    $('status-diagnostic').classList.add('warn');
    bindActions(configFallback());
    return;
  }

  $('status-translation').textContent = describeTranslation(config);
  $('status-asr').textContent = describeAsr(config);
  $('status-lang').textContent = `目標語言: ${config.targetLang} · ${config.displayMode === 'mono' ? '僅譯文' : '雙語'}`;

  // 最近一次失敗診斷：常駐顯示（無記錄顯示「無」，避免「看不到行」誤會成 bug）。
  let diagText: string | undefined;
  try {
    const diag = await readLastDiagnostic();
    diagText = formatDiagnostic(diag);
  } catch {
    diagText = undefined; // 診斷讀取失敗不阻塞 popup 其餘功能
  }
  const diagEl = $('status-diagnostic');
  if (diagText) {
    diagEl.textContent = `最近失敗: ${diagText}`;
    diagEl.classList.add('warn');
  } else {
    diagEl.textContent = '最近失敗: 無';
  }

  bindActions(config);
}

/** 綁定 popup 按鈕事件（config 讀取失敗時以默認值佔位，不影響手動操作）。 */
function bindActions(config: EngineConfig): void {
  $('btn-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  // 測試連接：直接向配置端點發最小請求，驗證端點可達 + 模型存在 + 響應有效。
  $('btn-test').addEventListener('click', async () => {
    const connEl = $('status-connection');
    connEl.textContent = '連接測試: 測試中…';
    connEl.classList.remove('warn', 'ok');
    try {
      const apiKey = (await store.getApiKey('llm')) ?? '';
      const status = await testConnection(config, apiKey);
      if (status.ok) {
        connEl.textContent = `連接測試: ${status.detail}`;
        connEl.classList.add('ok');
      } else {
        connEl.textContent = `連接測試: ${status.error}`;
        connEl.classList.add('warn');
      }
    } catch (err) {
      connEl.textContent = `連接測試: ${err instanceof Error ? err.message : String(err)}`;
      connEl.classList.add('warn');
    }
  });

  // 快捷鍵：觸發當前標籤頁重新載入（改配置後生效）。
  // §5.6/P3：tabs.query/reload 失敗（權限/無活動 tab）不許無聲無反饋。
  $('btn-reload').addEventListener('click', async () => {
    const connEl = $('status-connection');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id) {
        connEl.textContent = '重新載入: 未找到活動標籤頁';
        connEl.classList.remove('ok');
        connEl.classList.add('warn');
        return;
      }
      await chrome.tabs.reload(tab.id);
    } catch (err) {
      connEl.textContent = `重新載入: ${err instanceof Error ? err.message : String(err)}`;
      connEl.classList.remove('ok');
      connEl.classList.add('warn');
    }
  });
}

/** 配置讀取失敗時的簡單兜底（允許手動操作、避免整頁不可用）。 */
function configFallback(): EngineConfig {
  return {
    translation: { type: 'mt' },
    asr: { type: 'cloud' },
    targetLang: 'zh-Hant',
    displayMode: 'mono',
    performanceProfile: 'balanced',
  };
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
