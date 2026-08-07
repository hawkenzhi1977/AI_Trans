// 中央調試日誌門控（M1-51）。
// 背景：流程診斷日誌（render/draw/fetch 等）在真實環境每幀/每塊輸出，
// 淹沒控制台、且對普通用戶無意義——分類開關後默認全關；
// 錯誤/降級（console.warn + recordDiagnostic）不受開關影響（§5.6 紅線不靜默）。
// content-script / Options / interceptor（MAIN world）共用同一份旗標狀態，
// content-script 負責從配置加載並通過 CustomEvent 同步給 MAIN world。
import type { DebugLogConfig, DebugLogCategory } from '../domain/models/config';
import { DEBUG_LOG_OFF } from '../domain/models/config';

/** 當前各分類開關（模組內存——interceptor 無法訪問 chrome.storage，故用運行時旗標）。 */
let flags: DebugLogConfig = { ...DEBUG_LOG_OFF };

/** 設置調試旗標（content-script 啟動與配置變更時調用；interceptor 收到事件後調用）。 */
export function setDebugFlags(next: Partial<DebugLogConfig> | undefined): void {
  flags = { ...DEBUG_LOG_OFF, ...(next ?? {}) };
}

/** 讀取當前旗標（Options UI 回顯/測試用）。 */
export function getDebugFlags(): DebugLogConfig {
  return { ...flags };
}

/**
 * 分類門控的診斷日誌：僅在對應分類開啟時輸出 console.log。
 * 前綴保留 [AI_Trans:diag] 便於控制台過濾（日誌降壓前的既有約定）。
 */
export function diagLog(category: DebugLogCategory, ...args: unknown[]): void {
  if (!flags[category]) return;
  console.log(`[AI_Trans:diag][${category}]`, ...args);
}
