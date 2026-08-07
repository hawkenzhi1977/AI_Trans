import type { PipelineEvent } from '../domain/models/events';
import type { TranslationRequest, TranslationResult } from '../domain/models/translation';
import type { TranslationProvider } from '../domain/ports/translation-provider';
import { diagLog } from '../infrastructure/debug-log';

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
    diagLog('pipeline', 'translate() called,', req.segments.length, 'segments, targetLang:', req.targetLang ?? this.opts.targetLang);
    const request: TranslationRequest = {
      ...req,
      targetLang: req.targetLang ?? this.opts.targetLang,
      streaming: this.opts.streaming,
    };

    try {
      diagLog('pipeline', 'calling primary engine:', this.opts.primary.engineId);
      const result = await this.opts.primary.translate(request);
      diagLog('pipeline', 'primary engine succeeded, degraded:', result.degraded);
      if (result.degraded) {
        this.emit({
          type: 'engine-degraded',
          port: 'translation',
          reason: `engine ${result.engineId} reported degraded`,
        });
      }
      return result;
    } catch (primaryErr) {
      // §5.6：primary 失敗屬關鍵節點——降級事件（engine-degraded/pipeline-error）已由
      // recordDiagnostic 無條件落盤+console.warn，此處 console 日誌為流程級（可關）。
      diagLog('pipeline', 'primary engine FAILED:', String(primaryErr));
      if (this.opts.fallback) {
        diagLog('pipeline', 'falling back to:', this.opts.fallback.engineId);
        // 同時通知降級與錯誤：觀測者需要看到「換引擎」與「為何換」。
        this.emit({
          type: 'engine-degraded',
          port: 'translation',
          reason: `primary failed: ${String(primaryErr)}`,
        });
        this.emitError(primaryErr);
        const result = await this.opts.fallback.translate(request);
        diagLog('pipeline', 'fallback engine succeeded');
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
    // primary 無流式能力 → 退化為非流式（translate 已含 fallback + 降級事件）。
    if (!this.opts.primary.translateStream) {
      const result = await this.translate(request);
      emit(result);
      return;
    }
    // R5：流式路徑與非流式一樣須 try/catch + fallback + 降級事件，
    // 不能只在 translate() 做降級，否則 primary 流式中途拋錯會直接 reject 且無觀測。
    try {
      await this.opts.primary.translateStream(request, emit);
    } catch (primaryErr) {
      this.emit({
        type: 'engine-degraded',
        port: 'translation',
        reason: `primary stream failed: ${String(primaryErr)}`,
      });
      this.emitError(primaryErr);
      // 降級為非流式：優先 fallback，否則 translate() 內部再兜底。
      const result = await this.translate(request);
      emit(result);
    }
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
