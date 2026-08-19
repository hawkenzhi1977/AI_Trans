// 確定性 Stub 引擎——測試專用，行為可預測、可斷言。
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import type { TranslationRequest, TranslationResult } from '../../src/domain/models/translation';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';
import type { ASRRequest, ASRResult } from '../../src/domain/models/asr';
import type { ASRConfig } from '../../src/domain/models/config';

interface StubTranslationOpts {
  engineId?: string;
  location?: 'local' | 'cloud';
  /** 前綴標記，便於斷言譯文來源。 */
  prefix?: string;
  /** 注入失敗，用於驗證降級。 */
  failOnce?: boolean;
  failAlways?: boolean;
  latencyMs?: number;
  /** 是否實現 warmup（默認 false——僅 local 引擎如 local-onnx 實現）。 */
  warmup?: boolean;
}

/** 確定性翻譯 Stub：譯文 = `${prefix}${sourceText}`。 */
export class StubTranslationProvider implements TranslationProvider {
  readonly engineId: string;
  readonly location: 'local' | 'cloud';
  private readonly prefix: string;
  private failOnce: boolean;
  private readonly failAlways: boolean;
  private readonly latencyMs: number;
  private readonly hasWarmup: boolean;
  calls = 0;
  warmupCalls = 0;

  constructor(opts: StubTranslationOpts = {}) {
    this.engineId = opts.engineId ?? 'stub-llm';
    this.location = opts.location ?? 'cloud';
    this.prefix = opts.prefix ?? '[t]';
    this.failOnce = opts.failOnce ?? false;
    this.failAlways = opts.failAlways ?? false;
    this.latencyMs = opts.latencyMs ?? 0;
    this.hasWarmup = opts.warmup ?? false;
  }

  async warmup(): Promise<void> {
    if (this.hasWarmup) this.warmupCalls += 1;
  }

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    this.calls += 1;
    if (this.latencyMs) await delay(this.latencyMs);
    if (this.failAlways || this.failOnce) {
      this.failOnce = false;
      throw new Error(`${this.engineId} injected failure`);
    }
    return {
      engineId: this.engineId,
      degraded: false,
      segments: req.segments.map((s) => ({
        ...s,
        translatedText: `${this.prefix}${s.sourceText}`,
        targetLang: req.targetLang,
      })),
    };
  }
}

interface StubASROpts {
  engineId?: string;
  location?: 'local' | 'cloud';
  /** seq -> 識別文本 的固定映射。 */
  transcript?: (seq: number) => string;
}

/** 確定性 ASR Stub：把每個 chunk 轉為單段字幕。 */
export class StubASRProvider implements ASRProvider {
  readonly engineId: string;
  readonly location: 'local' | 'cloud';
  private readonly transcript: (seq: number) => string;
  warmed = false;
  calls = 0;

  constructor(opts: StubASROpts = {}) {
    this.engineId = opts.engineId ?? 'stub-asr';
    this.location = opts.location ?? 'local';
    this.transcript = opts.transcript ?? ((seq) => `chunk-${seq}`);
  }

  async warmup(_config: ASRConfig): Promise<void> {
    this.warmed = true;
  }

  async transcribe(req: ASRRequest): Promise<ASRResult> {
    this.calls += 1;
    const { chunk } = req;
    return {
      seq: chunk.seq,
      isPartial: false,
      rtf: 0.1,
      segments: [
        {
          id: `asr-${chunk.seq}`,
          start: chunk.startTime,
          end: chunk.startTime + chunk.duration,
          sourceText: this.transcript(chunk.seq),
          origin: 'realtime-asr',
          provisional: false,
          revision: 0,
        },
      ],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
