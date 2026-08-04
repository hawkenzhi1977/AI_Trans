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

    for (const strategy of this.strategies) {
      try {
        const applicable = await strategy.isApplicable(ctx);
        if (!applicable) {
          errors.push({
            port: 'platform',
            code: 'strategy-not-applicable',
            recoverable: true,
          });
          continue;
        }

        await strategy.run(ctx, (e) => {
          if (e.type === 'strategy-degraded') {
            this.onEvent?.(e);
          }
          this.onEvent?.(e);
        });
        // 成功接管並執行（run 正常返回）
        return { origin: strategy.origin, errors };
      } catch (err) {
        const next = this.strategies[this.strategies.indexOf(strategy) + 1];
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

    return { origin: undefined, errors };
  }

  stopAll(): void {
    for (const s of this.strategies) s.stop();
  }
}
