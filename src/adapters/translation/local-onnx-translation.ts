/**
 * 本地 ONNX 翻譯適配器——使用 Transformers.js + ONNX Runtime Web 在 Offscreen Document 推理。
 * 當雲端 LLM 失敗時作為 fallback 引擎，實現完全離線的本地翻譯兜底。
 * 模型：onnx-community/Qwen2.5-0.5B-Instruct (INT4 ONNX，模型倉庫總計約 750MB)。
 */
import type { TranslationProvider } from '../../domain/ports/translation-provider';
import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { LocalOnnxChunkSize } from '../../domain/models/config';
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
  /** 該 chunk 是否被判定為退化輸出（token 重複亂碼，Offscreen 端判定，供診斷統計）。 */
  degenerate?: boolean;
  /** 該 chunk 是否被判定為語言錯誤（目標語言為中文但輸出無中文，Offscreen 端判定）。 */
  wrongLanguage?: boolean;
}

/** 本地 ONNX 翻譯適配器配置。 */
export interface LocalOnnxTranslationConfig {
  /** 模型名稱（唯讀，預設為 Qwen2.5-0.5B）。 */
  modelName: string;
  /** 目標語言（預設 zh-Hant）。 */
  targetLang?: string;
  /** 是否作為主翻譯引擎（primary）——primary 成功時不標記 degraded，避免誤發降級事件。 */
  isPrimary?: boolean;
  /** 單次推理的最大字幕行數（3/4/5），值越小記憶體峰值越低。 */
  chunkSize?: LocalOnnxChunkSize;
}

/** 單次翻譯會話的最大時限（毫秒）：超過此時間主動中斷，避免 Offscreen 長時間運行不穩定。 */
const MAX_SESSION_DURATION_MS = 10 * 60 * 1000; // 10 分鐘

/** 翻譯質量統計（用於後續優化分析）。 */
const modelStats = {
  totalChunks: 0,
  mergedChunks: 0,      // 輸出行數 < 輸入行數的 chunks
  perfectChunks: 0,     // 輸出行數 = 輸入行數的 chunks
  totalFallbacks: 0,    // 回退原文的行數
};

/**
 * 本地 ONNX 翻譯 Provider——透過 Offscreen Document 執行推理。
 * 可作為主翻譯引擎（type='local-onnx'）或雲端 LLM 失敗時的離線兜底。
 */
export class LocalONNXTranslationProvider implements TranslationProvider {
  readonly engineId = 'local-onnx';
  readonly location = 'local' as const;

  private readonly defaultTargetLang: string;
  private readonly isPrimary: boolean;
  private readonly _chunkSize: LocalOnnxChunkSize;
  
  /** Port 長連接——避免 sendMessage 短連接被 Service Worker 回收。 */
  private port: chrome.runtime.Port | null = null;
  private messageIdCounter = 0;

  constructor(config: LocalOnnxTranslationConfig) {
    // modelName 保留供未來擴充（如多模型切換），目前仅用於配置顯示。
    void config.modelName;
    this.defaultTargetLang = config.targetLang ?? 'zh-Hant';
    this.isPrimary = config.isPrimary ?? false;
    this._chunkSize = config.chunkSize ?? 5;
  }

  /** 返回配置的 chunk size。 */
  private get chunkSize(): number {
    return this._chunkSize;
  }

  /**
   * 建立與 Service Worker 的 port 長連接。
   * 使用 port 而非 sendMessage，避免推理時間過長導致消息通道關閉。
   * 添加 port 有效性檢查：當 port 已斷開但 onDisconnect 回調尚未觸發時，
   * 主動清除並重建連接，避免 "Attempting to use a disconnected port object" 錯誤。
   */
  private ensurePort(): chrome.runtime.Port {
    // 檢查現有 port 是否有效
    if (this.port) {
      try {
        // 嘗試訪問 port.name 來驗證 port 是否仍然有效
        // 如果 port 已斷開，這會拋出 "Attempting to use a disconnected port object" 錯誤
        void this.port.name;
      } catch {
        // port 已斷開，清除引用以便重建
        diagLog('local-onnx', 'port was disconnected, clearing reference');
        this.port = null;
      }
    }
    
    if (!this.port) {
      this.port = chrome.runtime.connect({ name: 'content-onnx' });
      this.port.onDisconnect.addListener(() => {
        diagLog('local-onnx', 'port disconnected, will reconnect on next request');
        this.port = null;
      });
    }
    
    return this.port;
  }

  /**
   * 預加載模型到記憶體——發送 `local-onnx:warmup` 給 Offscreen（經 SW 轉發）。
   * M2-24 補充修復十三：消除首次推理 30-60s 載入延遲（此前首塊 request 被 30s 超時誤殺）。
   * 模型未下載時拋錯（`local-onnx-warmup-failed` 診斷），調用方據此提示用戶先下載。
   * §5.6：warmup 失敗必須落診斷，禁止靜默吞掉。
   */
  async warmup(): Promise<void> {
    try {
      // warmup 使用 sendMessage（短時間操作，不需要 port）
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

    for (let i = 0; i < req.segments.length; i += this.chunkSize) {
      const chunk = req.segments.slice(i, i + this.chunkSize);
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
   * 將 Offscreen 返回的單一結果拆分回各 segment。
   * 模型依行號解析，少於輸入行數時缺行回退原文。
     */
  private async translateChunk(
    chunk: SubtitleSegment[],
    targetLang: string
  ): Promise<{ segments: SubtitleSegment[]; echoed: boolean; degenerate: boolean; wrongLanguage: boolean }> {
    const combinedText = chunk.map((s) => s.sourceText).join('\n');

    diagLog('local-onnx', `translateChunk: chunkSize=${chunk.length}, targetLang=${targetLang}`);

    const request: LocalOnnxTranslateRequest = {
      topic: 'local-onnx:translate',
      payload: {
        text: combinedText,
        targetLang,
      },
    };

    diagLog('local-onnx', `requestTranslate: sending request`);
    const res = await this.requestTranslate(request);
    
    const rawOutput = res.translatedText ?? '';
    const isEchoed = res.echoed === true;
    const isDegenerate = res.degenerate === true;
    const isWrongLanguage = res.wrongLanguage === true;
    
    // 解析翻譯結果——將單一結果拆分回各 segment。
    let translatedTexts: string[];
    
    // 如果輸出行數等於輸入行數，直接按行分割
    const outputLines = rawOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    diagLog('local-onnx', `translateChunk: received response, rawOutput length=${rawOutput.length}, outputLines=${outputLines.length}`);
    
    if (outputLines.length === chunk.length) {
      translatedTexts = outputLines;
    } else if (outputLines.length < chunk.length) {
      // 輸出行數少於輸入行數：記錄合併行為
      diagLog(
        'local-onnx',
        `model-merge-detected: input=${chunk.length} lines, rawOutput=${outputLines.length} lines, ` +
        `inputText="${combinedText.slice(0, 100)}...", rawOutput="${rawOutput.slice(0, 200)}..."`
      );
      // 嘗試按句子邊界分割
      translatedTexts = this.splitBySentenceBoundary(rawOutput, chunk.length);
      
      // 記錄診斷：輸出行數不匹配
      if (translatedTexts.length < chunk.length) {
        diagLog(
          'local-onnx',
          `chunk output mismatch: input=${chunk.length} lines, output=${outputLines.length} lines, split=${translatedTexts.length} lines`
        );
      }
    } else {
      // 輸出行數多於輸入：按行分割，多餘的忽略
      translatedTexts = outputLines;
    }

    // 當檢測到 echo、退化輸出或語言錯誤時，回退原文（避免顯示亂碼或錯誤語言）
    const shouldFallbackToSource = isEchoed || isDegenerate || isWrongLanguage;
    if (shouldFallbackToSource) {
      const reasons: string[] = [];
      if (isEchoed) reasons.push('echo');
      if (isDegenerate) reasons.push('degenerate');
      if (isWrongLanguage) reasons.push('wrong language');
      diagLog('local-onnx', `translateChunk: fallback to source text due to ${reasons.join(' and ')} output`);
    }

    const segments = chunk.map((seg, j) => ({
      ...seg,
      // 空譯文（''）亦視為無效，回退原文（避免渲染空行）。
      // echo、退化輸出或語言錯誤時，所有 segment 回退原文（避免顯示亂碼或錯誤語言）。
      translatedText: shouldFallbackToSource ? seg.sourceText : (translatedTexts[j]?.trim() || seg.sourceText),
    }));
    
    // 更新模型統計
    modelStats.totalChunks++;
    if (outputLines.length < chunk.length) {
      modelStats.mergedChunks++;
      modelStats.totalFallbacks += (chunk.length - translatedTexts.length);
    } else if (outputLines.length === chunk.length) {
      modelStats.perfectChunks++;
    }
    
    // 每 10 個 chunks 輸出一次統計摘要
    if (modelStats.totalChunks % 10 === 0) {
      diagLog('local-onnx', `model-stats: chunks=${modelStats.totalChunks}, ` +
        `merged=${modelStats.mergedChunks}, perfect=${modelStats.perfectChunks}, ` +
        `fallbacks=${modelStats.totalFallbacks}`);
    }
    
    return { segments, echoed: isEchoed, degenerate: isDegenerate, wrongLanguage: isWrongLanguage };
  }

  /**
   * 按句子邊界分割文本——用於 Small model 輸出行數少於輸入行數的情況。
   * 嘗試按中文標點（。！？；）分割，如果分割後行數仍不足，則按逗號分割。
   * 如果仍不足，剩餘行回退到原文。
   */
  private splitBySentenceBoundary(text: string, expectedLines: number): string[] {
    // 先嘗試按強標點分割（句號、問號、感嘆號、分號）
    const strongSplit = text.split(/[。！？；]/).filter(s => s.trim().length > 0);
    if (strongSplit.length >= expectedLines) {
      return strongSplit.slice(0, expectedLines);
    }

    // 如果強標點分割不足，嘗試按弱標點分割（逗號、頓號）
    const weakSplit = text.split(/[，,、]/).filter(s => s.trim().length > 0);
    if (weakSplit.length >= expectedLines) {
      return weakSplit.slice(0, expectedLines);
    }

    // 如果仍不足，返回實際分割的行數，剩餘行會回退到原文
    return weakSplit.length > 0 ? weakSplit : [text];
  }

  /**
   * 發送單次翻譯請求並校驗結果——使用 port 長連接。
   * §5.6：模型未下載/推理失敗/通信失敗都必須落診斷。
   */
  private async requestTranslate(
    request: LocalOnnxTranslateRequest
  ): Promise<LocalOnnxTranslateResponse> {
    try {
      const port = this.ensurePort();
      const messageId = `msg-${++this.messageIdCounter}-${Date.now()}`;

      // 通過 port 發送請求並等待響應
      const response = await new Promise<LocalOnnxTranslateResponse>((resolve, reject) => {
        const listener = (msg: unknown) => {
          const res = msg as { messageId?: string; result?: LocalOnnxTranslateResponse; error?: string };
          if (res.messageId === messageId) {
            port.onMessage.removeListener(listener);
            if (res.error) {
              reject(new Error(res.error));
            } else if (res.result) {
              resolve(res.result);
            } else {
              reject(new Error('Empty response from offscreen'));
            }
          }
        };

        port.onMessage.addListener(listener);

        // port 斷開時 postMessage 會拋出 "Attempting to use a disconnected port object"
        try {
          port.postMessage({ ...request, messageId });
        } catch (err) {
          port.onMessage.removeListener(listener);
          const errMsg = err instanceof Error ? err.message : String(err);
          // port 已斷開，清除引用以便下次重連
          if (errMsg.includes('disconnected port')) {
            this.port = null;
          }
          reject(err instanceof Error ? err : new Error(errMsg));
          return;
        }

        // 超時處理（120 秒）
        setTimeout(() => {
          port.onMessage.removeListener(listener);
          reject(new Error('Offscreen Document response timeout'));
        }, 120000);
      });

      if (!response.ok) {
        const error = new Error(response.error ?? 'local-onnx translation failed');
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: response.notDownloaded ? 'local-onnx-not-downloaded' : 'local-onnx-inference-failed',
            recoverable: true,
            cause: error,
          },
        });
        throw error;
      }
      return response;
    } catch (err) {
      // §5.6：通信失敗必須落診斷。
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
   * 
   * 支持 AbortSignal：seek 時策略中斷翻譯，每個 chunk 前檢查 signal.aborted，
   * 已中止則拋 AbortError（不觸發 fallback，由策略層靜默處理）。
   * 
   * Fix D: 最大翻譯時限保護——連續翻譯超過 10 分鐘主動中斷，避免 Offscreen 長時間運行不穩定。
   */
   async translateStream(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void> {
    const targetLang = req.targetLang ?? this.defaultTargetLang;
    const accumulated: SubtitleSegment[] = [];
    let echoedChunks = 0;
    let degenerateChunks = 0;
    let wrongLanguageChunks = 0;
    const totalChunks = Math.ceil(req.segments.length / this.chunkSize);
    const streamStartedAt = performance.now();

    for (let i = 0; i < req.segments.length; i += this.chunkSize) {
      // 每個 chunk 前檢查 abort signal——seek 中斷時停止翻譯，避免浪費已落後位置的 chunks。
      if (req.signal?.aborted) {
        diagLog('local-onnx', 'translation aborted by signal after', accumulated.length, 'segments');
        throw new DOMException('Translation aborted', 'AbortError');
      }

      // Fix D: 檢查最大翻譯時限——超過 10 分鐘主動中斷，避免 Offscreen 長時間運行不穩定
      const elapsedMs = performance.now() - streamStartedAt;
      if (elapsedMs > MAX_SESSION_DURATION_MS) {
        diagLog('local-onnx', 'translation session exceeded max duration', MAX_SESSION_DURATION_MS, 'ms after', accumulated.length, 'segments, aborting to prevent Offscreen instability');
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: 'local-onnx-session-timeout',
            recoverable: true,
            cause: new Error(
              `local-onnx translation session exceeded ${MAX_SESSION_DURATION_MS / 1000}s (translated ${accumulated.length} segments), aborting to prevent Offscreen instability`
            ),
          },
        });
        throw new Error('local-onnx session timeout (10min limit)');
      }

      const chunk = req.segments.slice(i, i + this.chunkSize);
      const chunkIndex = Math.floor(i / this.chunkSize) + 1;
      const chunkStartedAt = performance.now();
      const chunkResult = await this.translateChunk(chunk, targetLang);
      const chunkLatencyMs = Math.round(performance.now() - chunkStartedAt);
      accumulated.push(...chunkResult.segments);
      if (chunkResult.echoed) echoedChunks += 1;
      if (chunkResult.degenerate) degenerateChunks += 1;
      if (chunkResult.wrongLanguage) wrongLanguageChunks += 1;

      // D5：記錄 chunk 計時與翻譯速度。
      const totalElapsedMs = Math.round(performance.now() - streamStartedAt);
      const segmentsPerSec = (accumulated.length / (totalElapsedMs / 1000)).toFixed(2);
      diagLog(
        'local-onnx',
        `chunk ${chunkIndex}/${totalChunks} done in ${chunkLatencyMs}ms, cumulative`,
        accumulated.length,
        'segments, echoed:',
        chunkResult.echoed,
        'degenerate:',
        chunkResult.degenerate,
        'wrongLanguage:',
        chunkResult.wrongLanguage,
        `| total: ${totalElapsedMs}ms, speed: ${segmentsPerSec} seg/s`
      );

      emit({
        engineId: this.engineId,
        degraded: !this.isPrimary, // primary 成功不標降級；作 fallback 時仍標記。
        segments: [...accumulated],
      });
    }

    this.recordEchoSummary(echoedChunks, totalChunks);
    this.recordDegenerateSummary(degenerateChunks, totalChunks);
    this.recordWrongLanguageSummary(wrongLanguageChunks, totalChunks);
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

  /**
   * 結束時若有 chunk 被判定為退化輸出（token 重複亂碼）→ 記聚合診斷（§5.6 留痕）。
   * 純診斷行為，不做任何降級/回退（回退已在 translateChunk 中完成）。
   */
  private recordDegenerateSummary(degenerateChunks: number, totalChunks: number): void {
    if (degenerateChunks === 0) return;
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-degenerate-chunks',
        recoverable: true,
        cause: new Error(
          `local ONNX model produced degenerate output in ${degenerateChunks}/${totalChunks} chunks (token repetition/low quality)`
        ),
      },
    });
  }

  /**
   * 結束時若有 chunk 被判定為語言錯誤（目標語言為中文但輸出無中文）→ 記聚合診斷（§5.6 留痕）。
   * 純診斷行為，不做任何降級/回退（回退已在 translateChunk 中完成）。
   */
  private recordWrongLanguageSummary(wrongLanguageChunks: number, totalChunks: number): void {
    if (wrongLanguageChunks === 0) return;
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-wrong-language-chunks',
        recoverable: true,
        cause: new Error(
          `local ONNX model produced wrong language output in ${wrongLanguageChunks}/${totalChunks} chunks (target: Chinese, output: no Chinese)`
        ),
      },
    });
  }
}
