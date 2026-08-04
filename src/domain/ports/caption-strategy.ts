import type { EngineConfig } from '../models/config';
import type { PipelineEvent } from '../models/events';
import type { CaptionOrigin } from '../models/subtitle';
import type { ASRProvider } from './asr-provider';
import type { PlatformAdapter } from './platform-adapter';
import type { TranslationProvider } from './translation-provider';

export interface StrategyContext {
  platform: PlatformAdapter;
  /** 實時播放狀態。 */
  playback(): import('../models/playback').PlaybackState;
  config: EngineConfig;
  asr: ASRProvider;
  translation: TranslationProvider;
}

/**
 * 字幕獲取策略端口——三級策略鏈的節點。
 * 通過 isApplicable 支持降級：為假則鏈上切換到下一策略。
 */
export interface CaptionStrategy {
  readonly origin: CaptionOrigin;
  isApplicable(ctx: StrategyContext): Promise<boolean>;
  /** 產出字幕流；通過 emit 推送（支持增量與 provisional 修正）。 */
  run(ctx: StrategyContext, emit: (e: PipelineEvent) => void): Promise<void>;
  stop(): void;
}
