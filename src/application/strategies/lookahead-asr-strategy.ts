import type { PipelineEvent } from '../../domain/models/events';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';

/**
 * 二級策略：預緩衝提前處理（M3 高風險項）。
 * M1 佔位：isApplicable 恆 false。
 */
export class LookAheadASRStrategy implements CaptionStrategy {
  readonly origin = 'lookahead-asr' as const;

  async isApplicable(_ctx: StrategyContext): Promise<boolean> {
    return false; // M3 實現
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
