// 本地 ONNX 翻譯適配器——使用 Transformers.js + ONNX Runtime Web 在 Offscreen Document 推理。
// 當雲端 LLM 失敗時作為 fallback 引擎，實現完全離線的本地翻譯兜底。
// 模型：onnx-community/Qwen2.5-0.5B-Instruct (INT4 ONNX，約 350MB)。
import type { TranslationProvider } from '../../domain/ports/translation-provider';
import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

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

  private readonly defaultTargetLang: string;
  private readonly isPrimary: boolean;

  constructor(config: LocalOnnxTranslationConfig) {
    // modelName 保留供未來擴充（如多模型切換），目前仅用於配置顯示。
    void config.modelName;
    this.defaultTargetLang = config.targetLang ?? 'zh-Hant';
    this.isPrimary = config.isPrimary ?? false;
  }

  /**
   * 非流式翻譯——透過 chrome.runtime.sendMessage 發送請求給 Service Worker。
   * Service Worker 轉發給 Offscreen Document 執行 ONNX 推理。
   */
  async translate(req: TranslationRequest): Promise<TranslationResult> {
    // 合併所有 segments 的 sourceText 為單一請求（減少推理次數）。
    const combinedText = req.segments.map((s) => s.sourceText).join('\n');
    const targetLang = req.targetLang ?? this.defaultTargetLang;

    const request: LocalOnnxTranslateRequest = {
      topic: 'local-onnx:translate',
      payload: {
        text: combinedText,
        targetLang,
      },
    };

    try {
      const response = await chrome.runtime.sendMessage(request);
      const res = response as LocalOnnxTranslateResponse;

      if (!res.ok) {
        // §5.6：模型未下載或推理失敗必須落診斷。
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

      // 解析翻譯結果——將單一結果拆分回各 segment。
      const translatedTexts = (res.translatedText ?? '').split('\n');
      const segments: SubtitleSegment[] = req.segments.map((s, i) => ({
        ...s,
        translatedText: translatedTexts[i]?.trim() ?? s.sourceText,
      }));

      return {
        engineId: this.engineId,
        degraded: !this.isPrimary, // primary 成功不標降級；作 fallback 時仍標記。
        segments,
      };
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
   * 流式翻譯——本地 ONNX 模型目前不支援 streaming，退化為非流式。
   * TranslationPipeline 會自動處理此情況（見 translateStream 邏輯）。
   */
  async translateStream(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void> {
    // 本地 ONNX 不支援流式，直接調用非流式並 emit。
    const result = await this.translate(req);
    emit(result);
  }
}
