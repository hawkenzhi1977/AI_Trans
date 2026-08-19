// 晚捕獲重試狀態機（M2-24 補充修復十四）。
//
// 背景：真實環境中 YouTube 的 pot 重驅動鏈（無 pot 掛起 → 2s 排程 → 播放器帶 pot
// 重發 → 響應）常超過 native 策略 waitForCapture 的 15s 窗口。捕獲最終成功到達時，
// 管線已因 no-caption-strategy 永久降級。本類在管線降級後繼續追蹤「捕獲是否到達」，
// 到達且符合守衛（同一視頻 / 未達上限 / 未在冷卻內）時允許調用方重試策略鏈。
//
// 純邏輯、無副作用——由 content-script 持有並驅動，便於單元測試。
export interface LateCaptureRetryOptions {
  /** 每視頻重試上限（防止捕獲持續到達但解析仍失敗時無限重啟）。 */
  maxRetries?: number;
  /** 重試冷卻（毫秒）：攔截器 1.5s 重播同一捕獲，過濾同 capturedAt 後仍可能密集觸發。 */
  cooldownMs?: number;
  /** 可注入的時鐘（測試用；默認 Date.now）。 */
  now?: () => number;
}

/** 默認重試上限與冷卻。 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_COOLDOWN_MS = 5_000;

export class LateCaptureRetry {
  private awaiting = false;
  private retryVideoId: string | null = null;
  private retries = 0;
  private armedAt = 0;
  private lastRetryAt = 0;
  private readonly maxRetries: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;

  constructor(opts: LateCaptureRetryOptions = {}) {
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.nowFn = opts.now ?? Date.now;
  }

  /** 是否正等待晚捕獲重試。 */
  get isAwaiting(): boolean {
    return this.awaiting;
  }

  /** 已執行的重試次數。 */
  get retryCount(): number {
    return this.retries;
  }

  /** 從置位到當前時間的延遲（毫秒；未置位返回 0）。 */
  get latencyMs(): number {
    return this.awaiting ? this.nowFn() - this.armedAt : 0;
  }

  /** 管線全鏈失敗（no-caption-strategy）時置位，開始等待晚捕獲。 */
  arm(videoId: string | null): void {
    this.awaiting = true;
    this.retryVideoId = videoId || null;
    this.armedAt = this.nowFn();
  }

  /** 字幕成功接管（segments-ready）或停止/換視頻時解除，重置計數。 */
  disarm(): void {
    this.awaiting = false;
    this.retryVideoId = null;
    this.retries = 0;
    this.armedAt = 0;
    this.lastRetryAt = 0;
  }

  /**
   * 捕獲到達時調用：判定是否應觸發重試。
   * @returns 本次重試序號（1-based）；不應重試返回 null（未置位 / 視頻不匹配 / 達上限 / 在冷卻內）。
   */
  onCapture(capture: { videoId?: string }): number | null {
    if (!this.awaiting) return null;
    // 僅對同一視頻的捕獲觸發；捕獲無 videoId 時無法判別，保守接受（與 bridge.matchesVideo 一致）。
    if (this.retryVideoId && capture.videoId && capture.videoId !== this.retryVideoId) {
      return null;
    }
    if (this.retries >= this.maxRetries) return null;
    const now = this.nowFn();
    // 冷卻僅約束「後續」重試；首次（retries 尚未累計）直接允許。
    if (this.retries > 0 && now - this.lastRetryAt < this.cooldownMs) return null;
    this.retries += 1;
    this.lastRetryAt = now;
    return this.retries;
  }
}