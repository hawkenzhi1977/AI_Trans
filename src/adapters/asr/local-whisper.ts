// 本地 Whisper ASR——使用 @huggingface/transformers（transformers.js v3）進行 WASM/WebGPU 推理。
// 模型存儲：IndexedDB（chrome.storage.local 有 5MB 限制，Whisper tiny ~150MB）。
// 支持自定義模型（如 vibevoice）——通過 modelPath 參數指定本地模型路徑。
import type { ASRProvider } from '../../domain/ports/asr-provider';
import type { ASRConfig } from '../../domain/models/config';
import type { ASRRequest, ASRResult } from '../../domain/models/asr';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

/**
 * 代理 Cache 實現：Content-script 受 CORS 限制無法直接 fetch HuggingFace，
 * 透過 Service Worker 代理 fetch（SW 有 host_permissions 即可跨域）。
 * 結果存入共享 Cache API（transformers-cache），transformers.js 從 Cache 讀取。
 *
 * 實現 transformers.js 的 customCache 接口（match + put）。
 */
class ContentScriptProxyCache {
  private cacheName = 'transformers-cache';

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    const cache = await caches.open(this.cacheName);
    // 先檢查是否已緩存（可能由其他上下文寫入）。
    const cached = await cache.match(url);
    if (cached) return cached;
    // 未緩存 → 請求 SW 代理 fetch → SW 寫入 Cache → 再讀取。
    const response = await chrome.runtime.sendMessage({
      topic: 'sw:proxy-fetch',
      payload: { url },
    });
    const res = response as { ok: boolean; error?: string };
    if (!res.ok) {
      throw new Error(`ContentScriptProxyCache fetch failed: ${res.error ?? 'unknown error'}`);
    }
    return cache.match(url);
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    // transformers.js 調用 put 時，數據已由 match 預填充，此處為 no-op。
    // 保留接口以滿足 customCache 合約。
    void request;
    void response;
  }
}

/** 全局 ProxyCache 實例（供 warmup 使用）。 */
const contentScriptProxyCache = new ContentScriptProxyCache();

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

/** transformers.js pipeline 類型（動態加載，避免硬依賴）。 */
type WhisperPipeline = (
  audio: Float32Array,
  options?: { language?: string; task?: string; return_timestamps?: boolean }
) => Promise<{ text?: string; chunks?: Array<{ text: string; timestamp?: [number, number] }> }>;

/**
 * 本地 Whisper ASR Provider——使用 transformers.js 進行推理。
 * 模型首次加載時從 HuggingFace Hub 下載到 IndexedDB，後續使用緩存。
 */
export class LocalWhisperASR implements ASRProvider {
  readonly engineId = 'local-whisper';
  readonly location = 'local' as const;

  private pipeline: WhisperPipeline | null = null;
  private modelId: string;

  constructor(config: LocalWhisperConfig) {
    // 自定義模型路徑優先；否則使用預設檔位。
    this.modelId = config.modelPath ?? WHISPER_MODELS[config.modelTier] ?? WHISPER_MODELS.base;
  }

  /**
   * 預熱模型——首次調用時從 HuggingFace Hub 下載到 IndexedDB。
   * 後續調用直接使用緩存（transformers.js 內部管理）。
   */
  async warmup(_config: ASRConfig): Promise<void> {
    try {
      // 動態導入 @huggingface/transformers（esbuild 打包進 bundle，不使用 new Function
      // 以避免 Chrome 擴展 CSP 禁止 unsafe-eval）。
      const transformers = await import('@huggingface/transformers');
      const { pipeline, env } = transformers;
      // 模型下載鏡像：HuggingFace 在中國大陸可能被牆，改用 hf-mirror.com 加速。
      (env as unknown as { remoteHost: string }).remoteHost = 'https://hf-mirror.com/';
      // 代理 Cache：Content-script 受 CORS 限制無法直接 fetch HuggingFace，
      // 透過 Service Worker 代理 fetch（SW 有 host_permissions 即可跨域）。
      (env as unknown as { useCustomCache: boolean }).useCustomCache = true;
      (env as unknown as { customCache: ContentScriptProxyCache }).customCache = contentScriptProxyCache;
      // M2-24 補充修復七：WASM 本地化——content-script 中 transformers.js 默認從 CDN
      // 載入 onnxruntime wasm，YouTube 頁面 CSP 會阻擋 CDN 請求（warmup 失敗）。
      // 改指向擴充內打包的 wasm（copy-static.mjs 拷貝至 src/runtime/ort/）。
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
      }
      // 轉型以匹配本地 WhisperPipeline 接口（transformers.js 返回類型更複雜）。
      // dtype: 'q8' 明確指定量化精度，消除 transformers.js 的 "dtype not specified" 警告。
      this.pipeline = (await pipeline(
        'automatic-speech-recognition',
        this.modelId,
        { dtype: 'q8' }
      )) as unknown as WhisperPipeline;
    } catch (err) {
      const error = new Error(
        `LocalWhisperASR warmup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Please install @huggingface/transformers: npm install @huggingface/transformers`
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

  /** 非流式推理。 */
  async transcribe(req: ASRRequest): Promise<ASRResult> {
    if (!this.pipeline) {
      throw new Error('LocalWhisperASR not warmed up. Call warmup() first.');
    }

    const { chunk, hintLang } = req;
    const startTime = performance.now();

    try {
      // transformers.js pipeline 接受 Float32Array 輸入。
      const result = await this.pipeline(chunk.pcm, {
        language: hintLang,
        task: 'transcribe',
        return_timestamps: true,
      });

      const durationMs = performance.now() - startTime;
      const audioDurationMs = chunk.duration;
      const rtf = durationMs / audioDurationMs;

      // 解析結果（transformers.js 返回格式）。
      const segments: SubtitleSegment[] = result.chunks?.map((c, i) => ({
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
          sourceText: result.text?.trim() ?? '',
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
   * 流式推理——分段輸出 provisional → final 結果。
   * 當前實現：將音頻塊分為 3 段，每段推理後 emit provisional，最後一段 emit final。
   */
  async transcribeStream(req: ASRRequest, emit: (r: ASRResult) => void): Promise<void> {
    if (!this.pipeline) {
      throw new Error('LocalWhisperASR not warmed up. Call warmup() first.');
    }

    const { chunk } = req;
    const segmentDuration = chunk.pcm.length / 3; // 分為 3 段。

    for (let i = 0; i < 3; i++) {
      const start = Math.floor(i * segmentDuration);
      const end = Math.floor((i + 1) * segmentDuration);
      const segmentPcm = chunk.pcm.slice(start, end);
      const isLast = i === 2;

      const startTime = performance.now();
      const result = await this.pipeline(segmentPcm, {
        task: 'transcribe',
        return_timestamps: false,
      });
      const durationMs = performance.now() - startTime;
      const audioDurationMs = (segmentPcm.length / chunk.sampleRate) * 1000;
      const rtf = durationMs / audioDurationMs;

      const segment: SubtitleSegment = {
        id: `${chunk.seq}-${i}`,
        sourceText: result.text?.trim() ?? '',
        translatedText: undefined,
        provisional: !isLast,
        start: (start / chunk.sampleRate) * 1000,
        end: (end / chunk.sampleRate) * 1000,
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
