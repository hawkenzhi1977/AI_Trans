import type { PipelineEvent } from '../../domain/models/events';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';

/**
 * 二級策略：預緩衝提前處理（M3 高風險項）。
 * M1 佔位：isApplicable 恆 false。
 */
export class LookAheadASRStrategy implements CaptionStrategy {
  readonly origin = 'lookahead-asr' as const;

  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    // M3 未實現：返回 false 使策略鏈跳過；寫入診斷讓鏈能區分「未實現」與「真失敗」（§5.6）。
    ctx.diagnostics?.push?.('lookahead-asr: not implemented (M3)');
    return false;
  }

  async run(
    _ctx: StrategyContext,
    _emit: (e: PipelineEvent) => void
  ): Promise<void> {
    /* M3 實現：預取音頻 → 提前 ASR → 翻譯 → 推送 */
  }

  stop(): void {
    /* no-op */
  }
}
