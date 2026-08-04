import type { CaptionOrigin } from './subtitle';
import type { PipelineError } from './pipeline-error';

/** 性能觀測樣本。 */
export interface PerfSample {
  stage: 'segment' | 'asr' | 'translate' | 'render';
  ms: number;
  seq?: number;
  rtf?: number;
  dropped?: boolean;
}

/** 管線事件——跨組件觀察與降級通知。 */
export type PipelineEvent =
  | { type: 'segments-ready'; segments: import('./subtitle').SubtitleSegment[] }
  | { type: 'segments-updated'; segments: import('./subtitle').SubtitleSegment[] }
  | { type: 'strategy-degraded'; from: CaptionOrigin; to: CaptionOrigin }
  | { type: 'engine-degraded'; port: 'asr' | 'translation'; reason: string }
  | { type: 'pipeline-error'; error: PipelineError }
  | { type: 'metrics'; data: PerfSample };
