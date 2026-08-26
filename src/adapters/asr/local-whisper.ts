// 本地 Whisper ASR——使用 @huggingface/transformers（transformers.js v3）進行 WASM/WebGPU 推理。
// M2-37：推理遷移至 Offscreen Document（避免 content-script 的 YouTube CSP 阻止 ORT WASM worker 載入）。
// Content-script 側僅作為消息代理，將 warmup/transcribe 請求轉發給 Offscreen Document。
import type { ASRProvider } from '../../domain/ports/asr-provider';
import type { ASRConfig } from '../../domain/models/config';
import type { ASRRequest, ASRResult } from '../../domain/models/asr';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

/** Whisper 模型檔位映射（HuggingFace Hub 模型 ID）。 */
const WHISPER_MODELS: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
  small: 'Xenova/whisper-small.en',
};

/** LocalWhisperASR 配置。 */
export interface LocalWhisperConfig {
  /** 模型檔位（tiny/base/small）或自定義模型路徑。 */
  modelTier: 'tiny' | 'base' | 'small' | string;
  /** 自定義模型路徑（用於 vibevoice 等本地模型）。 */
  modelPath?: string;
}

/** ASR warmup 響應結構。 */
interface AsrWarmupResponse {
  ok: boolean;
  error?: string;
}

/** ASR transcribe 響應結構。 */
interface AsrTranscribeResponse {
  ok: boolean;
  text?: string;
  chunks?: Array<{ text: string; timestamp?: [number, number] }>;
  error?: string;
  rtf?: number;
}

/**
 * 本地 Whisper ASR Provider——M2-37 遷移至 Offscreen Document 推理。
 * Content-script 側僅作為消息代理，將請求轉發給 Offscreen Document 執行實際推理。
 * 解決 content-script 環境下 YouTube CSP 阻止 ORT WASM worker 載入的問題。
 */
export class LocalWhisperASR implements ASRProvider {
  readonly engineId = 'local-whisper';
  readonly location = 'local' as const;

  private modelId: string;
  private warmedUp = false;

  constructor(config: LocalWhisperConfig) {
    // 自定義模型路徑優先；否則使用預設檔位。
    this.modelId = config.modelPath ?? WHISPER_MODELS[config.modelTier] ?? WHISPER_MODELS.base;
  }

  /**
   * 預熱模型——M2-37：轉發 warmup 請求給 Offscreen Document。
   * Offscreen Document 載入 Whisper pipeline 到記憶體，供後續推理使用。
   */
  async warmup(_config: ASRConfig): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        topic: 'asr-whisper:warmup',
        payload: { modelId: this.modelId },
      });

      // 響應可能直接是結果，或包裹在 { ok, result } 中。
      const raw = response as { ok?: boolean; result?: AsrWarmupResponse } | AsrWarmupResponse;
      const warmupResult = 'result' in raw && raw.result ? raw.result : (raw as AsrWarmupResponse);

      if (!warmupResult?.ok) {
        throw new Error(warmupResult?.error ?? 'warmup failed');
      }

      this.warmedUp = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNetwork = /Failed to fetch|NetworkError|network/i.test(msg);
      const error = new Error(
        isNetwork
          ? `ASR warmup failed (network error). Check your connection and download the ASR model from Options. / ASR 預熱失敗（網絡錯誤），請檢查網絡並從選項頁面下載模型: ${msg}`
          : `ASR warmup failed: ${msg}. Download the ASR model from Options. / 請從選項頁面下載 ASR 模型`
      );
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-engine-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }
  }

  /** 非流式推理——M2-37：轉發推理請求給 Offscreen Document。 */
  async transcribe(req: ASRRequest): Promise<ASRResult> {
    if (!this.warmedUp) {
      throw new Error('LocalWhisperASR not warmed up. Call warmup() first.');
    }

    const { chunk, hintLang } = req;
    const startTime = performance.now();

    try {
      // 轉發推理請求給 Offscreen Document。
      const response = await chrome.runtime.sendMessage({
        topic: 'asr-whisper:transcribe',
        payload: {
          pcm: chunk.pcm,
          sampleRate: chunk.duration > 0 ? Math.round(chunk.pcm.length / (chunk.duration / 1000)) : 16000,
          hintLang,
        },
      });

      // 響應可能直接是結果，或包裹在 { ok, result } 中。
      const raw = response as { ok?: boolean; result?: AsrTranscribeResponse } | AsrTranscribeResponse;
      const transcribeResult = 'result' in raw && raw.result ? raw.result : (raw as AsrTranscribeResponse);

      if (!transcribeResult?.ok) {
        throw new Error(transcribeResult?.error ?? 'transcribe failed');
      }

      const durationMs = performance.now() - startTime;
      const audioDurationMs = chunk.duration;
      const rtf = transcribeResult.rtf ?? (durationMs / audioDurationMs);

      // 解析結果（Offscreen 返回格式）。
      const segments: SubtitleSegment[] = transcribeResult.chunks?.map((c: { text: string; timestamp?: [number, number] }, i: number) => ({
        id: `${chunk.seq}-${i}`,
        sourceText: c.text.trim(),
        translatedText: undefined,
        provisional: false,
        start: (c.timestamp?.[0] ?? 0) * 1000, // 秒 → 毫秒
        end: (c.timestamp?.[1] ?? chunk.duration / 1000) * 1000,
        origin: 'realtime-asr' as const,
        revision: 0,
      })) ?? [
        {
          id: `${chunk.seq}-0`,
          sourceText: transcribeResult.text?.trim() ?? '',
          translatedText: undefined,
          provisional: false,
          start: 0,
          end: chunk.duration,
          origin: 'realtime-asr' as const,
          revision: 0,
        },
      ];

      return {
        seq: chunk.seq,
        segments,
        isPartial: false,
        rtf,
      };
    } catch (err) {
      const error = new Error(
        `LocalWhisperASR transcribe failed: ${err instanceof Error ? err.message : String(err)}`
      );
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-engine-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }
  }

  /**
   * 流式推理——M2-37：轉發推理請求給 Offscreen Document。
   * 當前實現：將音頻塊分為 3 段，每段推理後 emit provisional，最後一段 emit final。
   */
  async transcribeStream(req: ASRRequest, emit: (r: ASRResult) => void): Promise<void> {
    if (!this.warmedUp) {
      throw new Error('LocalWhisperASR not warmed up. Call warmup() first.');
    }

    const { chunk } = req;
    const segmentDuration = chunk.pcm.length / 3; // 分為 3 段。
    const sampleRate = chunk.duration > 0 ? Math.round(chunk.pcm.length / (chunk.duration / 1000)) : 16000;

    for (let i = 0; i < 3; i++) {
      const start = Math.floor(i * segmentDuration);
      const end = Math.floor((i + 1) * segmentDuration);
      const segmentPcm = chunk.pcm.slice(start, end);
      const isLast = i === 2;

      const startTime = performance.now();

      // 轉發推理請求給 Offscreen Document。
      const response = await chrome.runtime.sendMessage({
        topic: 'asr-whisper:transcribe',
        payload: {
          pcm: segmentPcm,
          sampleRate,
        },
      });

      // 響應可能直接是結果，或包裹在 { ok, result } 中。
      const raw = response as { ok?: boolean; result?: AsrTranscribeResponse } | AsrTranscribeResponse;
      const transcribeResult = 'result' in raw && raw.result ? raw.result : (raw as AsrTranscribeResponse);

      if (!transcribeResult?.ok) {
        throw new Error(transcribeResult?.error ?? 'transcribe failed');
      }

      const durationMs = performance.now() - startTime;
      const audioDurationMs = (segmentPcm.length / sampleRate) * 1000;
      const rtf = transcribeResult.rtf ?? (durationMs / audioDurationMs);

      const segment: SubtitleSegment = {
        id: `${chunk.seq}-${i}`,
        sourceText: transcribeResult.text?.trim() ?? '',
        translatedText: undefined,
        provisional: !isLast,
        start: (start / sampleRate) * 1000,
        end: (end / sampleRate) * 1000,
        origin: 'realtime-asr' as const,
        revision: 0,
      };

      emit({
        seq: chunk.seq,
        segments: [segment],
        isPartial: !isLast,
        rtf,
      });
    }
  }
}
