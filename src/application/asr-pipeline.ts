import type { AudioChunk } from '../domain/models/audio';
import type { ASRRequest, ASRResult } from '../domain/models/asr';
import type { PipelineEvent } from '../domain/models/events';
import type { SubtitleSegment } from '../domain/models/subtitle';
import type { ASRProvider } from '../domain/ports/asr-provider';

export interface ASRPipelineOptions {
  provider: ASRProvider;
  hintLang?: string;
  allowPartial: boolean;
  onEvent?: (e: PipelineEvent) => void;
}

/**
 * ASR 管線——分段音頻 → 識別 → 按 seq 有序重排。
 * 支持 provisional 部分結果與最終結果合併。
 */
export class ASRPipeline {
  constructor(private readonly opts: ASRPipelineOptions) {}

  /** 識別單個 chunk，返回有序（按 seq）結果段。 */
  async transcribe(chunk: AudioChunk): Promise<SubtitleSegment[]> {
    const req: ASRRequest = {
      chunk,
      hintLang: this.opts.hintLang,
      allowPartial: this.opts.allowPartial,
    };

    const started = performance.now();
    const result = await this.opts.provider.transcribe(req);
    this.emitMetric('asr', performance.now() - started, chunk.seq, result.rtf);

    return result.segments;
  }

  /** 流式識別（若 provider 支持），emit 推送部分/最終結果。 */
  async transcribeStream(
    chunk: AudioChunk,
    emit: (result: ASRResult) => void
  ): Promise<SubtitleSegment[]> {
    if (!this.opts.provider.transcribeStream) {
      return this.transcribe(chunk);
    }
    const req: ASRRequest = {
      chunk,
      hintLang: this.opts.hintLang,
      allowPartial: this.opts.allowPartial,
    };

    const started = performance.now();
    let finalSegments: SubtitleSegment[] = [];
    await this.opts.provider.transcribeStream(req, (result) => {
      this.emitMetric('asr', performance.now() - started, chunk.seq, result.rtf);
      emit(result);
      if (!result.isPartial) {
        finalSegments = result.segments;
      }
    });
    return finalSegments;
  }

  private emitMetric(
    stage: 'asr',
    ms: number,
    seq: number,
    rtf?: number
  ): void {
    this.opts.onEvent?.({
      type: 'metrics',
      data: { stage, ms, seq, rtf },
    });
  }
}
