// Popup 頁面邏輯：顯示當前引擎/語言狀態，提供開啟 Options 入口與「重新載入當前頁」快捷鍵。
// 顯示最近一次翻譯降級/錯誤診斷（見 infrastructure/diagnostics.ts），
// 並提供「測試連接」按鈕直接驗證端點與模型名（見 connection-test.ts）——
// 讓「字幕沒出現」時用戶能一鍵確認是端點/模型/CORS 哪一環的問題。
import { ChromeStorageConfigStore } from '../../infrastructure/chrome-config-store';
import { readLastDiagnostic, formatDiagnostic, recordDiagnostic } from '../../infrastructure/diagnostics';
import { testConnection } from './connection-test';
import type { EngineConfig } from '../../domain/models/config';
import { DEFAULT_CONFIG } from '../../domain/models/config';

const store = new ChromeStorageConfigStore();

const OPTIONS_URL = chrome.runtime.getURL('src/runtime/options/options.html');

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/** 將關鍵事件寫入 popup 底部 DOM 診斷區，讓用戶肉眼可見 popup 是否執行、按鈕點擊是否觸發。 */
function popupDiag(msg: string): void {
  const el = document.getElementById('popup-diag-dom');
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} ${msg}`;
  el.textContent = el.textContent ? `${el.textContent}\n${line}` : line;
  console.log(`[AI_Trans:popup:diag] ${msg}`);
}

// M2-26 可觀測性：popup init watchdog（§5.6「字幕沒出來」可追溯）。
// slow（>3s）：僅落 breadcrumb 診斷提醒「初始化慢」；timeout（10s）：popup 通常已被用戶關閉，
// 但仍持續落持久化診斷（storage），下次打開可見「上次 init 未完成」，定位是否被 offscreen 模型 OOM 拖累。
const INIT_SLOW_MS = 3000;
const INIT_TIMEOUT_MS = 10000;
let initSlowFired = false;
let initTimer: ReturnType<typeof setTimeout> | undefined;
let initTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

function startInitWatchdog(): void {
  initTimer = setTimeout(() => {
    if (initSlowFired) return;
    initSlowFired = true;
    console.warn('[AI_Trans:popup] init-slow | >3s，可能被 offscreen 模型載入/OOM 拖累');
    popupDiag('init-slow >3s');
    void recordDiagnostic({
      type: 'pipeline-error',
      error: { port: 'platform', code: 'popup-init-slow', recoverable: true, cause: new Error('popup init exceeded 3s') },
    });
  }, INIT_SLOW_MS);
  initTimeoutTimer = setTimeout(fireInitTimeout, INIT_TIMEOUT_MS);
}

function stopInitWatchdog(): void {
  if (initTimer !== undefined) {
    clearTimeout(initTimer);
    initTimer = undefined;
  }
  if (initTimeoutTimer !== undefined) {
    clearTimeout(initTimeoutTimer);
    initTimeoutTimer = undefined;
  }
}

function fireInitTimeout(): void {
  // timeout 是比 slow 更嚴重的事件，獨立記錄（不受 slow 已觸發影響）；
  // 單一 setTimeout 只 fire 一次，無需額外冪等守衛。
  console.error('[AI_Trans:popup] init-timeout | >10s，init 未返回（極可能進程被 OOM/掛起）');
  popupDiag('init-timeout >10s');
  void recordDiagnostic({
    type: 'pipeline-error',
    error: { port: 'platform', code: 'popup-init-timeout', recoverable: true, cause: new Error('popup init did not complete within 10s') },
  });
}

// watchdog 在 init() 開頭啟動（與 t0 對齊），完成/早退時 stopInitWatchdog。
// 不放在 module load：避免 vi.resetModules 重載時舊實例計時器殘留污染後續測試。

/** 用 chrome.tabs API 打開/激活 Options 頁面，替代 chrome.runtime.openOptionsPage()。
 *  openOptionsPage() 依賴 Chrome 內部追蹤 tab 狀態，長時間播放後可能靜默失敗。
 *  改用 tabs.query + tabs.create / tabs.update 更可控。 */
async function openOptionsPage(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: OPTIONS_URL });
    if (tabs.length > 0 && tabs[0].id != null) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      popupDiag('options tab focused');
    } else {
      await chrome.tabs.create({ url: OPTIONS_URL });
      popupDiag('options tab created');
    }
  } catch (err) {
    popupDiag(`options open failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function init(): Promise<void> {
  // §5.6：storage 讀取失敗不能使 popup 整頁無聲不可用（void init 的 rejection 會靜默消失）。
  // 失敗時顯示錯誤狀態而不是卡在空白。
  const t0 = performance.now();
  console.log('[AI_Trans:popup] init-start | elapsed=0ms');
  popupDiag('init-start');
  startInitWatchdog(); // M2-26：與 t0 對齊啟動 slow/timeout 計時

  // 立即綁定「設定」按鈕——不依賴任何 async 數據，避免 storage 讀取阻塞期間用戶點擊無響應。
  // 播放期間 content-script 頻繁寫入 diagnostics 到 storage，導致 store.get() 可能阻塞數秒，
  // 若此 handler 在 store.get() 之後才綁定，用戶點擊只會觸發瀏覽器默認 focus/defocus。
  $('btn-options').addEventListener('click', () => {
    console.log('[AI_Trans:popup] btn-options-click | elapsed=%dms', performance.now() - t0);
    popupDiag('btn-options clicked');
    void openOptionsPage();
  });

  let config: EngineConfig;
  console.log('[AI_Trans:popup] store-get-start | elapsed=%dms', performance.now() - t0);
  try {
    config = await store.get();
    console.log('[AI_Trans:popup] store-get-done | elapsed=%dms | type=%s',
      performance.now() - t0, config.translation.type);
    popupDiag('store-get done');
  } catch (err) {
    console.warn('[AI_Trans:popup] store-get-error | elapsed=%dms | %s',
      performance.now() - t0,
      err instanceof Error ? err.message : String(err));
    popupDiag(`store-get error: ${err instanceof Error ? err.message : String(err)}`);
    $('status-diagnostic').textContent = `最近失敗: 錯誤: 配置讀取失敗: ${err instanceof Error ? err.message : String(err)}`;
    $('status-diagnostic').classList.add('warn');
    bindActions(configFallback());
    stopInitWatchdog(); // M2-26：早退也視為完成，停止 slow/timeout 計時
    return;
  }

  $('status-translation').textContent = describeTranslation(config);
  $('status-asr').textContent = describeAsr(config);
  $('status-lang').textContent = `目標語言: ${config.targetLang} · ${config.displayMode === 'mono' ? '僅譯文' : '雙語'}`;

  // 最近一次失敗診斷：僅顯示用戶可操作的錯誤（actionable !== false）。
  // DevTools 仍保留所有記錄，popup 過濾內部調測信息。
  // 舊記錄無 actionable 字段時默認顯示（向後兼容）。
  let diagText: string | undefined;
  console.log('[AI_Trans:popup] diag-read-start | elapsed=%dms', performance.now() - t0);
  try {
    const diag = await readLastDiagnostic();
    console.log('[AI_Trans:popup] diag-read-done | elapsed=%dms | hasDiag=%s',
      performance.now() - t0, diag ? 'yes' : 'no');
    // 僅顯示 actionable 的錯誤（undefined 視為 true，兼容舊記錄）
    if (diag && diag.actionable !== false) {
      diagText = formatDiagnostic(diag);
    }
  } catch {
    console.warn('[AI_Trans:popup] diag-read-error | elapsed=%dms', performance.now() - t0);
    diagText = undefined; // 診斷讀取失敗不阻塞 popup 其餘功能
  }
  const diagEl = $('status-diagnostic');
  if (diagText) {
    diagEl.textContent = `最近失敗: ${diagText}`;
    diagEl.classList.add('warn');
  } else {
    diagEl.textContent = '最近失敗: 無';
  }

  console.log('[AI_Trans:popup] bind-actions | elapsed=%dms', performance.now() - t0);
  bindActions(config);
  await updateAsrButton();
  console.log('[AI_Trans:popup] init-done | elapsed=%dms', performance.now() - t0);
  popupDiag('init-done');
  stopInitWatchdog(); // M2-26：init 完成，停止 slow/timeout 計時（避免誤報）
}

/** 更新 ASR 按鈕狀態（已授權顯示「ASR 已啟用」，未授權顯示「啟用 ASR」）。 */
async function updateAsrButton(): Promise<void> {
  const btn = $('btn-asr') as HTMLButtonElement;
  const authorized = await chrome.storage.local.get('tabCaptureAuthorized');
  if (authorized.tabCaptureAuthorized) {
    btn.textContent = 'ASR 已啟用';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else {
    btn.textContent = '啟用 ASR';
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

/** 綁定 popup 按鈕事件（config 讀取失敗時以默認值佔位，不影響手動操作）。 */
function bindActions(config: EngineConfig): void {
  // btn-options 的 handler 已在 init() 最開始立即綁定（不依賴 async 數據），此處不再重複。

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

  // M2-14：tabCapture 授權按鈕——用戶點擊後觸發 tabCapture.getMediaStreamId（需用戶手勢）。
  // 授權成功後寫入 chrome.storage.local['tabCaptureAuthorized'] = true，
  // content-script 監聽 storage.onChanged 後啟用 ASR 策略。
  $('btn-asr').addEventListener('click', async () => {
    const connEl = $('status-connection');
    connEl.textContent = 'ASR 授權: 請求中…';
    connEl.classList.remove('warn', 'ok');
    try {
      // 觸發 tabCapture 授權對話框（需用戶手勢觸發，popup 按鈕符合條件）。
      // getMediaStreamId 會彈出授權對話框，用戶點擊「允許」後返回 streamId。
      // @ts-expect-error Chrome extension API: getMediaStreamId signature varies by version.
      const streamId = await chrome.tabCapture.getMediaStreamId({});
      // 授權成功 → 記錄 streamId（實際捕獲由 Offscreen Document 使用）。
      await chrome.storage.local.set({
        tabCaptureAuthorized: true,
        tabCaptureStreamId: streamId,
      });
      connEl.textContent = 'ASR 授權: 成功';
      connEl.classList.add('ok');
      await updateAsrButton();
    } catch (err) {
      // 授權失敗（用戶點擊「拒絕」或權限不足）。
      connEl.textContent = `ASR 授權: 失敗 — ${err instanceof Error ? err.message : String(err)}`;
      connEl.classList.add('warn');
      // §5.6：授權失敗必須落診斷。
      void recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'audio',
          code: 'tab-capture-not-authorized',
          recoverable: true,
          cause: err instanceof Error ? err : new Error(String(err)),
        },
      });
    }
  });
}

/** 配置讀取失敗時的簡單兜底（允許手動操作、避免整頁不可用）。 */
function configFallback(): EngineConfig {
  return DEFAULT_CONFIG;
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
    case 'local-onnx':
      return '翻譯: 本地 ONNX 模型';
  }
}

function describeAsr(c: EngineConfig): string {
  if (c.asr.type === 'local-whisper') return `ASR: 本地 Whisper (${c.asr.modelTier ?? 'base'})`;
  return 'ASR: 雲端';
}

// M2-26：watchdog 控制與狀態（供 integrate 測試用 fake timers 驅動 slow/timeout）。
export const _testExports = {
  startInitWatchdog,
  stopInitWatchdog,
  fireInitTimeout,
  resetWatchdogForTest() {
    initSlowFired = false;
    stopInitWatchdog();
  },
};

void init();
