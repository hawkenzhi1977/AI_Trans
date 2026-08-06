import type { PipelineEvent } from '../domain/models/events';
import type { CaptionOrigin } from '../domain/models/subtitle';
import type { CaptionStrategy } from '../domain/ports/caption-strategy';
import type { PipelineError } from '../domain/models/pipeline-error';

export type { CaptionStrategy, StrategyContext } from '../domain/ports/caption-strategy';

/**
 * 策略鏈——依降級優先級逐級嘗試，直到某一策略成功接管。
 * 策略失敗（isApplicable=false 或 run 拋錯）→ 發 strategy-degraded → 下一策略。
 */
export class CaptionStrategyChain {
  constructor(
    private readonly strategies: CaptionStrategy[],
    private readonly onEvent?: (e: PipelineEvent) => void
  ) {}

  /** 依序嘗試各策略，返回最終接管且成功執行的策略 origin。 */
  async runWithFallback(ctx: Parameters<CaptionStrategy['run']>[0]): Promise<{
    origin: CaptionOrigin | undefined;
    errors: PipelineError[];
  }> {
    const errors: PipelineError[] = [];

    // 提供策略可寫入的診斷累加器：軟失敗（isApplicable 內部 catch）原因也能在
    // 「全鏈不適用」時被用戶看到，避免 §5.6 靜默吞掉「字幕軌抓取失敗」。
    const diagnostics: string[] = [];
    const ctxWithDiag = { ...ctx, diagnostics };

    for (const strategy of this.strategies) {
      try {
        const applicable = await strategy.isApplicable(ctxWithDiag);
        if (!applicable) {
          errors.push({
            port: 'platform',
            code: 'strategy-not-applicable',
            recoverable: true,
          });
          continue;
        }

        await strategy.run(ctxWithDiag, (e) => {
          if (e.type === 'strategy-degraded') {
            this.onEvent?.(e);
          }
          this.onEvent?.(e);
        });
        // 成功接管並執行（run 正常返回）
        return { origin: strategy.origin, errors };
      } catch (err) {
        const next = this.strategies[this.strategies.indexOf(strategy) + 1];
        const causeMsg = err instanceof Error ? err.message : String(err);
        // §5.6：策略 run 失敗的真實原因也必須進診斷累加器，否則「全鏈不適用」
        // 的 pipeline-error 只剩下後續佔位策略（M2/M3 not implemented）的原因，
        // 用戶看不到真正把字幕擋住的根因（如 timedtext 抓取失敗 / 翻譯異常）。
        diagnostics.push(`${strategy.origin}: run failed — ${causeMsg}`);
        errors.push({
          port: 'platform',
          code: 'strategy-failed',
          recoverable: !!next,
          cause: err,
        });
        if (next) {
          this.onEvent?.({
            type: 'strategy-degraded',
            from: strategy.origin,
            to: next.origin,
          });
        } else {
          // 無可降級策略，停止
          return { origin: strategy.origin, errors };
        }
      }
    }

    // 全鏈無策略接管：發 pipeline-error 診斷（含各策略軟失敗原因），
    // 讓「字幕沒出現」的原因可見而非靜默（§5.6）。
    if (this.onEvent) {
      const reason =
        diagnostics.length > 0
          ? diagnostics.join(' | ')
          : 'all caption strategies not applicable (no captions found)';
      this.onEvent({
        type: 'pipeline-error',
        error: {
          port: 'platform',
          code: 'no-caption-strategy',
          recoverable: false,
          cause: new Error(reason),
        },
      });
    }

    return { origin: undefined, errors };
  }

  stopAll(): void {
    for (const s of this.strategies) s.stop();
  }
}
