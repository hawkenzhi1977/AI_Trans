// 診斷模塊——把管線降級/錯誤事件轉為用戶可查的持久化記錄與 console 麵包屑。
// 背景：翻譯失敗（如 HTTPS 頁面 mixed-content 攔截本地 http 端點）被管線降級吞掉，
// 用戶與開發者都無法看出「為什麼字幕沒出來」。此模塊記錄最近一次失敗原因，
// popup 讀取顯示，console 打警告，讓診斷鏈條可見。
import type { PipelineEvent } from '../domain/models/events';

/** 持久化的診斷記錄（chrome.storage.local['lastDiagnostic']）。 */
export interface DiagnosticRecord {
  kind: 'degraded' | 'error';
  /** 失敗發生的相對時間點。 */
  timestamp: string;
  /** 人類可讀原因（如 mixed-content 的 TypeError: Failed to fetch）。 */
  message: string;
}

/** 存儲 key——與 engineConfig 無關的獨立診斷槽位。 */
export const DIAGNOSTIC_KEY = 'lastDiagnostic';

/** 提取降級/錯誤事件的人類可讀消息；非相關事件返回 undefined（不記錄）。 */
export function extractDiagnostic(e: PipelineEvent): { kind: DiagnosticRecord['kind']; message: string } | undefined {
  switch (e.type) {
    case 'engine-degraded':
      // 僅記錄翻譯/ASR 引擎降級；策略級降級（原生→ASR）是正常流轉，不當失敗看。
      if (e.port === 'translation' || e.port === 'asr') {
        return { kind: 'degraded', message: e.reason };
      }
      return undefined;
    case 'pipeline-error':
      return { kind: 'error', message: formatCause(e.error.cause) };
    default:
      return undefined;
  }
}

/** 把任意 cause 轉成單行文本（錯誤對象取 message，其餘 String 化）。 */
function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    // mixed-content 攔截在 Chrome 中表現為 TypeError: Failed to fetch——保留完整類名便於排查。
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause ?? 'unknown error');
}

/**
 * 記錄一次降級/錯誤診斷：寫入 chrome.storage.local 並打 console.warn。
 * §5.7：chrome API 在異常環境（被卸載/權限不足）可能拋錯，必須 try/catch 守護，
 * 診斷記錄失敗不得影響主流程。
 */
export async function recordDiagnostic(e: PipelineEvent): Promise<void> {
  const diag = extractDiagnostic(e);
  if (!diag) return;
  const record: DiagnosticRecord = {
    kind: diag.kind,
    timestamp: new Date().toISOString(),
    message: diag.message,
  };
  // 麵包屑：優先讓 DevTools console 直接可見（不含敏感信息，純錯誤原因）。
  console.warn(`[AI_Trans] translation degraded: ${diag.message}`);
  try {
    await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: record });
  } catch {
    // 診斷寫入失敗不影響主流程（無日誌避免噪音循環）。
  }
}

/** 讀取最近一次診斷記錄（popup 用）；無記錄或讀取失敗返回 undefined。 */
export async function readLastDiagnostic(): Promise<DiagnosticRecord | undefined> {
  try {
    const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
    const rec = stored[DIAGNOSTIC_KEY];
    if (
      rec &&
      typeof rec === 'object' &&
      typeof (rec as DiagnosticRecord).message === 'string'
    ) {
      return rec as DiagnosticRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 格式化為 popup 顯示文本；無記錄返回 undefined（popup 顯示「—」）。 */
export function formatDiagnostic(rec: DiagnosticRecord | undefined): string | undefined {
  if (!rec) return undefined;
  const kind = rec.kind === 'degraded' ? '降級' : '錯誤';
  return `${kind}: ${rec.message} (${rec.timestamp})`;
}
