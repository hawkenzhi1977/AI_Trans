import type { SubtitleSegment } from './subtitle';

export interface TranslationRequest {
  /** 待翻譯段（可批量）。 */
  segments: SubtitleSegment[];
  targetLang: string;
  /** 前文，用於連貫性。 */
  context?: string[];
  /** 是否需要流式返回（低延遲）。 */
  streaming?: boolean;
}

export interface TranslationResult {
  /** translatedText 已回填。 */
  segments: SubtitleSegment[];
  /** 實際使用的引擎（觀測/降級記錄）。 */
  engineId: string;
  /** 是否為兜底引擎產出。 */
  degraded: boolean;
}
