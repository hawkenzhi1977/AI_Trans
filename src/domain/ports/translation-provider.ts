import type { TranslationRequest, TranslationResult } from '../models/translation';

/**
 * 翻譯引擎端口——LLM / MT、雲端 / 本地統一接入。
 * 混合兜底策略在 TranslationPipeline 中組合。
 */
export interface TranslationProvider {
  readonly engineId: string;
  readonly location: 'local' | 'cloud';
  translate(req: TranslationRequest): Promise<TranslationResult>;
  translateStream?(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void>;
  /** 預加載引擎/模型到記憶體（消除首次推理延遲）。可選——雲端 LLM 通常無需預熱。 */
  warmup?(): Promise<void>;
}
