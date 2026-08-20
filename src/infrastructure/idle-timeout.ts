// 空閒計時器——追蹤「最後一次活動」，超過 timeoutMs 後觸發一次回調。
// 用途：Offscreen Document 空閒資源釋放（WASM 模型記憶體 + 音頻捕獲）。
// 背景（真實環境根因）：offscreen 與 popup 同屬 extension pages，Chrome 可能共用渲染進程；
// offscreen 一旦創建永不關閉，WASM 350MB 模型 + ScriptProcessor 實時音頻堆在共享進程，
// 播放後該進程無法再創建新頁面 → popup 彈不出（刷新插件才恢復）。空閒關閉是根治方案。

export interface IdleTimeoutOptions {
  /** 空閒閾值（毫秒）。超過此時間無活動即觸發 onTimeout。 */
  timeoutMs: number;
  /** 空閒超時回調（僅觸發一次）。 */
  onTimeout: () => void;
  /** 時間源（測試注入用；默認 Date.now）。 */
  now?: () => number;
}

export class IdleTimeout {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityMs: number;
  private stopped = false;

  constructor(private readonly opts: IdleTimeoutOptions) {
    this.lastActivityMs = this.now();
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** 開始計時（重複調用無害；stop 後無效）。 */
  start(): void {
    if (this.stopped) return;
    this.schedule();
  }

  /** 標記一次活動：刷新最後活動時間並重新排程（§5.4：不重複註冊計時器）。 */
  reset(): void {
    if (this.stopped) return;
    this.lastActivityMs = this.now();
    this.schedule();
  }

  /** 立即判斷是否已空閒（供測試/外部檢查）。 */
  isIdle(): boolean {
    return this.now() - this.lastActivityMs >= this.opts.timeoutMs;
  }

  /** 停止計時（一次性；stop 後 reset 不再生效）。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const remaining = Math.max(0, this.lastActivityMs + this.opts.timeoutMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.opts.onTimeout();
    }, remaining);
  }
}