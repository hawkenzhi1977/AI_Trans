import type { PipelineEvent } from '../domain/models/events';
import type { TranslationRequest, TranslationResult } from '../domain/models/translation';
import type { TranslationProvider } from '../domain/ports/translation-provider';

export interface TranslationPipelineOptions {
  primary: TranslationProvider;
  fallback?: TranslationProvider;
  targetLang: string;
  /** 是否啟用 streaming 返回。 */
  streaming?: boolean;
  onEvent?: (e: PipelineEvent) => void;
}

/**
 * 翻譯管線——實現 TranslationProvider 端口。
 * 混合策略：primary 為主，失敗/超時降級 fallback；degraded 標記記錄實際引擎。
 */
export class TranslationPipeline implements TranslationProvider {
  readonly location = 'cloud' as const;
  readonly engineId = 'pipeline';

  constructor(private readonly opts: TranslationPipelineOptions) {}

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const request: TranslationRequest = {
      ...req,
      targetLang: req.targetLang ?? this.opts.targetLang,
      streaming: this.opts.streaming,
    };

    try {
      const result = await this.opts.primary.translate(request);
      if (result.degraded) {
        this.emit({
          type: 'engine-degraded',
          port: 'translation',
          reason: `engine ${result.engineId} reported degraded`,
        });
      }
      return result;
    } catch (primaryErr) {
      if (this.opts.fallback) {
        // 同時通知降級與錯誤：觀測者需要看到「換引擎」與「為何換」。
        this.emit({
          type: 'engine-degraded',
          port: 'translation',
          reason: `primary failed: ${String(primaryErr)}`,
        });
        this.emitError(primaryErr);
        const result = await this.opts.fallback.translate(request);
        return {
          ...result,
          engineId: result.engineId,
          degraded: true,
          segments: result.segments.map((s) => ({
            ...s,
            translatedText: s.translatedText ?? s.sourceText,
          })),
        };
      }
      throw primaryErr;
    }
  }

  async translateStream(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void> {
    const request: TranslationRequest = {
      ...req,
      targetLang: req.targetLang ?? this.opts.targetLang,
      streaming: true,
    };
    if (!this.opts.primary.translateStream) {
      const result = await this.translate(request);
      emit(result);
      return;
    }
    await this.opts.primary.translateStream(request, emit);
  }

  private emit(e: PipelineEvent): void {
    this.opts.onEvent?.(e);
  }

  private emitError(cause: unknown): void {
    this.opts.onEvent?.({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'translation-failed',
        recoverable: !!this.opts.fallback,
        cause,
      },
    });
  }
}
