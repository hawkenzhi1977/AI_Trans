// 本地 ONNX 翻譯適配器——使用 Transformers.js + ONNX Runtime Web 在 Offscreen Document 推理。
// 當雲端 LLM 失敗時作為 fallback 引擎，實現完全離線的本地翻譯兜底。
// 模型：onnx-community/Qwen2.5-0.5B-Instruct (INT4 ONNX，約 350MB)。
import type { TranslationProvider } from '../../domain/ports/translation-provider';
import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { recordDiagnostic } from '../../infrastructure/diagnostics';
import { diagLog } from '../../infrastructure/debug-log';

/** Service Worker 轉發的本地 ONNX 翻譯請求消息。 */
interface LocalOnnxTranslateRequest {
  topic: 'local-onnx:translate';
  payload: {
    text: string;
    targetLang: string;
    sourceLang?: string;
  };
}

/** Service Worker 返回的本地 ONNX 翻譯結果消息。 */
interface LocalOnnxTranslateResponse {
  ok: boolean;
  translatedText?: string;
  error?: string;
  /** 模型是否尚未下載（用於區分未下載與推理失敗）。 */
  notDownloaded?: boolean;
  /** 該 chunk 是否被判定為回顯原文（低質量輸出，Offscreen 端判定，供診斷統計）。 */
  echoed?: boolean;
}

/** 本地 ONNX 翻譯適配器配置。 */
export interface LocalOnnxTranslationConfig {
  /** 模型名稱（唯讀，預設為 Qwen2.5-0.5B）。 */
  modelName: string;
  /** 目標語言（預設 zh-Hant）。 */
  targetLang?: string;
  /** 是否作為主翻譯引擎（primary）——primary 成功時不標記 degraded，避免誤發降級事件。 */
  isPrimary?: boolean;
}

/**
 * 本地 ONNX 翻譯 Provider——透過 Offscreen Document 執行推理。
 * 可作為主翻譯引擎（type='local-onnx'）或雲端 LLM 失敗時的離線兜底。
 */
export class LocalONNXTranslationProvider implements TranslationProvider {
  readonly engineId = 'local-onnx';
  readonly location = 'local' as const;

  /** 單次推理的最大字幕行數——限制 prompt/生成長度，避免 0.5B 小模型長輸入時回顯原文。 */
  private static readonly CHUNK_SIZE = 5;

  private readonly defaultTargetLang: string;
  private readonly isPrimary: boolean;

  constructor(config: LocalOnnxTranslationConfig) {
    // modelName 保留供未來擴充（如多模型切換），目前仅用於配置顯示。
    void config.modelName;
    this.defaultTargetLang = config.targetLang ?? 'zh-Hant';
    this.isPrimary = config.isPrimary ?? false;
  }

  /**
   * 預加載模型到記憶體——發送 `local-onnx:warmup` 給 Offscreen（經 SW 轉發）。
   * M2-24 補充修復十三：消除首次推理 30-60s 載入延遲（此前首塊 request 被 30s 超時誤殺）。
   * 模型未下載時拋錯（`local-onnx-warmup-failed` 診斷），調用方據此提示用戶先下載。
   * §5.6：warmup 失敗必須落診斷，禁止靜默吞掉。
   */
  async warmup(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ topic: 'local-onnx:warmup' });
      const res = response as { ok: boolean; error?: string };
      if (!res.ok) {
        throw new Error(res.error ?? 'local-onnx warmup failed');
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-warmup-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }
  }

  /**
   * 非流式翻譯——分塊發送給 Service Worker（轉發 Offscreen Document 執行 ONNX 推理）。
   * 分塊避免單次輸入過長壓垮小模型（回顯原文根因之一）。
   */
  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const targetLang = req.targetLang ?? this.defaultTargetLang;
    const translatedSegments: SubtitleSegment[] = [];

    for (let i = 0; i < req.segments.length; i += LocalONNXTranslationProvider.CHUNK_SIZE) {
      const chunk = req.segments.slice(i, i + LocalONNXTranslationProvider.CHUNK_SIZE);
      const chunkResult = await this.translateChunk(chunk, targetLang);
      translatedSegments.push(...chunkResult.segments);
    }

    return {
      engineId: this.engineId,
      degraded: !this.isPrimary, // primary 成功不標降級；作 fallback 時仍標記。
      segments: translatedSegments,
    };
  }

  /**
   * 翻譯單一 chunk——合併 sourceText 為單一請求（減少推理次數），
   * 將 Offscreen 返回的單一結果拆分回各 segment（行號對齊由 Offscreen 端保證），
   * 並攜帶 Offscreen 判定的 echo 標記（供流式路徑統計低質量輸出）。
   */
  private async translateChunk(
    chunk: SubtitleSegment[],
    targetLang: string
  ): Promise<{ segments: SubtitleSegment[]; echoed: boolean }> {
    const combinedText = chunk.map((s) => s.sourceText).join('\n');

    const request: LocalOnnxTranslateRequest = {
      topic: 'local-onnx:translate',
      payload: {
        text: combinedText,
        targetLang,
      },
    };

    const res = await this.requestTranslate(request);

    // 解析翻譯結果——將單一結果拆分回各 segment。
    const translatedTexts = (res.translatedText ?? '').split('\n');
    const segments = chunk.map((seg, j) => ({
      ...seg,
      // 空譯文（''）亦視為無效，回退原文（避免渲染空行）。
      translatedText: translatedTexts[j]?.trim() || seg.sourceText,
    }));
    return { segments, echoed: res.echoed === true };
  }

  /**
   * 發送單次翻譯請求並校驗結果。
   * §5.6：模型未下載/推理失敗/sendMessage 通信失敗都必須落診斷。
   */
  private async requestTranslate(
    request: LocalOnnxTranslateRequest
  ): Promise<LocalOnnxTranslateResponse> {
    try {
      const response = await chrome.runtime.sendMessage(request);
      const res = response as LocalOnnxTranslateResponse;

      if (!res.ok) {
        const error = new Error(res.error ?? 'local-onnx translation failed');
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: res.notDownloaded ? 'local-onnx-not-downloaded' : 'local-onnx-inference-failed',
            recoverable: true,
            cause: error,
          },
        });
        throw error;
      }
      return res;
    } catch (err) {
      // §5.6：chrome.runtime.sendMessage 失敗（如 SW 崩潰、Offscreen 未建立）必須落診斷。
      const error = err instanceof Error ? err : new Error(String(err));
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-communication-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }
  }

  /**
   * 流式翻譯——逐 chunk 推理完成即 emit **累計全量**譯文（M2-24 補充修復十六）。
   * 修復：此前本地 ONNX 非真流式（`await this.translate(req)` 全量跑完才 emit 一次），
   * 431 段 = 87 次串行推理需數分鐘，NativeCaptionStrategy 首次 emit 才發 segments-ready，
   * 導致字幕長時間空白。現在首塊數秒內 emit，後續塊累計替換（與 LLM 流式同語義）。
   */
  async translateStream(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void> {
    const targetLang = req.targetLang ?? this.defaultTargetLang;
    const accumulated: SubtitleSegment[] = [];
    let echoedChunks = 0;
    const totalChunks = Math.ceil(req.segments.length / LocalONNXTranslationProvider.CHUNK_SIZE);

    for (let i = 0; i < req.segments.length; i += LocalONNXTranslationProvider.CHUNK_SIZE) {
      const chunk = req.segments.slice(i, i + LocalONNXTranslationProvider.CHUNK_SIZE);
      const chunkIndex = Math.floor(i / LocalONNXTranslationProvider.CHUNK_SIZE) + 1;
      const chunkResult = await this.translateChunk(chunk, targetLang);
      accumulated.push(...chunkResult.segments);
      if (chunkResult.echoed) echoedChunks += 1;

      diagLog(
        'local-onnx',
        `chunk ${chunkIndex}/${totalChunks} done, cumulative`,
        accumulated.length,
        'segments, echoed:',
        chunkResult.echoed
      );

      emit({
        engineId: this.engineId,
        degraded: !this.isPrimary, // primary 成功不標降級；作 fallback 時仍標記。
        segments: [...accumulated],
      });
    }

    this.recordEchoSummary(echoedChunks, totalChunks);
  }

  /**
   * 結束時若有 chunk 被判定為回顯原文 → 記聚合診斷（§5.6 留痕，popup「最近失敗」可見）。
   * 純診斷行為，不做任何降級/回退。
   */
  private recordEchoSummary(echoedChunks: number, totalChunks: number): void {
    if (echoedChunks === 0) return;
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-echo-chunks',
        recoverable: true,
        cause: new Error(
          `local ONNX model echoed input in ${echoedChunks}/${totalChunks} chunks (low quality output)`
        ),
      },
    });
  }
}
