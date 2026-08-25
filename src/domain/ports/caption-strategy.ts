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
  /** M2-30：視頻音頻語言（BCP-47 格式）；無法獲取時為 undefined。 */
  audioLanguage?: string;
  /**
   * 策略診斷信息累加器（可選）：isApplicable/run 內部不抛錯的「軟失敗」原因寫入此處，
   * 由策略鏈在「全鏈不適用」時統一收集並發 pipeline-error 診斷（§5.6 不靜默掩蓋缺失）。
   */
  diagnostics?: string[];
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
  /** 用戶 seek 時通知策略重新優先化（可選——僅原生字幕策略需要）。 */
  onSeek?(currentTimeMs: number): void;
}
