import type { PipelineEvent } from '../../domain/models/events';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';

/**
 * 三級策略：實時擷取 ASR（M2 實現）。
 * M1 中作為佔位：isApplicable 恆 false，策略鏈跳過。
 */
export class RealtimeASRStrategy implements CaptionStrategy {
  readonly origin = 'realtime-asr' as const;

  async isApplicable(_ctx: StrategyContext): Promise<boolean> {
    // M1 未實現：返回 false 使策略鏈跳過。
    return false;
  }

  async run(
    _ctx: StrategyContext,
    _emit: (e: PipelineEvent) => void
  ): Promise<void> {
    /* M2 實現：tabCapture → ASR → 翻譯 → 推送 */
  }

  stop(): void {
    /* no-op */
  }
}
