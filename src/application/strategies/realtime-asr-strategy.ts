// 三級策略：實時擷取 ASR（M2 完整實裝）。
// 鏈路：tabCapture → AudioSource → VAD → ASR → 翻譯 → 推送。
// 支持 provisional 字幕（segments-updated 事件）。
// M2-13：集成 PerfMetrics 動態降檔（RTF > 1.0 持續 30s → 降檔模型檔位）。
import type { PipelineEvent } from '../../domain/models/events';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';
import type { AudioSourceProvider } from '../../domain/ports/audio-source';
import type { ASRProvider } from '../../domain/ports/asr-provider';
import type { TranslationProvider } from '../../domain/ports/translation-provider';
import type { AudioChunk, AudioSourceHandle } from '../../domain/models/audio';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { EnergyVAD } from '../../infrastructure/vad';
import { PerfMetrics } from '../../infrastructure/perf/metrics';
import { recordDiagnostic } from '../../infrastructure/diagnostics';
import { diagLog } from '../../infrastructure/debug-log';

/** RealtimeASRStrategy 依賴注入。 */
export interface RealtimeASRDeps {
  audioSource: AudioSourceProvider;
  asrProvider: ASRProvider;
  translationProvider: TranslationProvider;
  /** VAD 能量閾值（0-1）。 */
  vadThreshold?: number;
}

/**
 * M2-58：VAD 兜底觸發條件——連續 N 塊（40 × 256ms ≈ 10.2s）全部被過濾時放寬閾值。
 * 防止低音量視頻（安靜旁白/音樂）被固定閾值永久過濾 → 「有音頻但永遠無字幕」。
 */
export const VAD_FALLBACK_SILENT_CHUNKS = 40;

/** M2-64：ASR 返回文本總長小於此值時跳過翻譯——local-onnx 對極短無意義文本輸出 [BLANK AUDIO]。 */
const MIN_TRANSLATE_TEXT_LEN = 3;

/**
 * M2-66：ASR 結果去重——連續 N 個 chunk 返回相同文本時視為重複（Whisper 對
 * 低音量/音樂段會反覆產出相同短文本如 [MUSIC]），跳過翻譯以減少鎖競爭。
 */
const DEDUP_CONSECUTIVE_THRESHOLD = 3;

/**
 * M2-66：最小顯示窗口（ms）——ASR segment 的 end-start 可能僅 256ms（單碎片），
 * 加上推理延遲後 cue 到達時已過期。擴展至至少 5s 確保用戶有時間看到字幕。
 */
const MIN_DISPLAY_WINDOW_MS = 5000;

/** M2-66：Backpressure——in-flight ASR 請求數超過此值時跳過新 chunk。 */
const MAX_INFLIGHT_ASR = 2;

/**
 * M2-67：non-speech token 正規化——Whisper 對音樂/音效段產出 [MUSIC]、[APPLAUSE]、
 * (laughing)、(gunsire) 等變體，精確匹配去重無法覆蓋。正規化為統一類別標記後比較。
 */
export function normalizeForDedup(text: string): string {
  const t = text.trim().toLowerCase();
  // 全段為 bracket token（[MUSIC]、[APPLAUSE] 等）→ 統一為 'ns'。
  if (/^\[[a-z ]+\]$/.test(t)) return 'ns';
  // 全段為 parenthetical（(laughing)、(gunsire) 等）→ 統一為 'ns'。
  if (/^\([^)]+\)$/.test(t)) return 'ns';
  // 混合文本：替換 bracket/parenthetical token 為 'ns'，保留實際語音文字。
  return t.replace(/\[[a-z ]+\]/g, 'ns').replace(/\([^)]*\)/g, 'ns');
}

/**
 * M2-58：將 ASR segment 時間戳對齊到視頻時間軸。
 * Whisper 輸出的 start/end 相對於輸入 chunk（0~chunk.duration）；
 * 加上 chunk 開始時的視頻時間（onChunk 以播放狀態反推）即為視頻絕對時間。
 * clamp ≥0（播放狀態未觀察到時 chunkStartMs 可能為 0，不產生負時間）。
 */
export function alignSegmentsToVideoTimeline(
  segments: SubtitleSegment[],
  chunkStartMs: number,
): SubtitleSegment[] {
  return segments.map((s) => {
    const start = Math.max(0, s.start + chunkStartMs);
    // M2-66：確保最小顯示窗口——Whisper 對短碎片返回的 segment 可能僅 256ms，
    // 加上推理延遲後 cue 到達時已過期。擴展 end 至至少 MIN_DISPLAY_WINDOW_MS。
    const rawEnd = Math.max(0, s.end + chunkStartMs);
    const end = Math.max(rawEnd, start + MIN_DISPLAY_WINDOW_MS);
    return { ...s, start, end };
  });
}

/** M2-58：過濾空文本 segment（靜音/識別失敗），避免空白 cue 進入 overlay。 */
export function filterEmptySegments(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.filter(
    (s) => s.sourceText.trim().length > 0 || (s.translatedText ?? '').trim().length > 0,
  );
}

/**
 * 三級策略：實時擷取 ASR。
 * isApplicable：config.asr.type !== 'none' && tabCaptureAuthorized。
 * run：tabCapture → ASR → 翻譯 → 推送（支持 provisional 字幕）。
 */
export class RealtimeASRStrategy implements CaptionStrategy {
  readonly origin = 'realtime-asr' as const;

  private deps: RealtimeASRDeps | null = null;
  private vad: EnergyVAD | null = null;
  private perf: PerfMetrics | null = null;
  private running = false;
  private unsubscribeChunk: (() => void) | null = null;
  private downgradeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private audioHandle: AudioSourceHandle | null = null;

  // M2-58：VAD 統計與兜底（§5.6——「chunk 全被過濾」必須留痕，不得靜默）。
  private baseVadThreshold = 0.005;
  private consecutiveSilentChunks = 0;
  private vadFallbackArmed = false;
  private vadWindowReceived = 0;
  private vadWindowPassed = 0;
  private vadWindowMaxRms = 0;
  private vadSessionMaxRms = 0;
  private vadWindowStart = 0;
  // M2-58：ASR 調用計數（首調 breadcrumb——確認 VAD→ASR 交接真的發生）。
  private asrCallCount = 0;
  // M2-65：累計字幕緩衝——每次 emit 發送全量（非僅當前 chunk），避免 content-script 全量替換丟失舊字幕。
  private accumulatedSegments = new Map<string, SubtitleSegment>();

  // M2-66：ASR 結果去重——追蹤連續相同文本的 chunk 數。
  private lastAsrText = '';
  private consecutiveDuplicateCount = 0;
  // M2-66：Backpressure——in-flight ASR 請求計數。
  private inflightAsrCount = 0;

  /** 注入依賴（由 Orchestrator 調用）。 */
  inject(deps: RealtimeASRDeps): void {
    this.deps = deps;
    // M2-58：記錄基礎閾值（兜底放寬的基準）；重注入時重置兜底狀態（restart 路徑）。
    this.baseVadThreshold = deps.vadThreshold ?? 0.005;
    this.consecutiveSilentChunks = 0;
    this.vadFallbackArmed = false;
    this.asrCallCount = 0;
    this.accumulatedSegments.clear();
    this.lastAsrText = '';
    this.consecutiveDuplicateCount = 0;
    this.inflightAsrCount = 0;
    this.vad = new EnergyVAD({ threshold: this.baseVadThreshold });
    this.perf = new PerfMetrics(100); // 滑動窗口 100 樣本。
  }

  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    // 檢查 ASR 配置。
    if (ctx.config.asr.type === 'none') {
      ctx.diagnostics?.push?.('realtime-asr: ASR disabled (config.asr.type = none)');
      return false;
    }

    // M2-46：tabCapture 授權由 content-script 持有的 InMemoryTabStreamIdProvider 判定，
    // 不再讀 chrome.storage（避免依賴 TTL 已過期的持久化狀態）。
    // 此處僅檢查 deps 注入與 ASR 配置，授權與流可用性由 start() 時消費 streamId 確認。
    if (!this.deps) {
      ctx.diagnostics?.push?.('realtime-asr: dependencies not injected');
      return false;
    }

    return true;
  }

  async run(ctx: StrategyContext, emit: (e: PipelineEvent) => void): Promise<void> {
    if (!this.deps || !this.vad || !this.perf) {
      throw new Error('RealtimeASRStrategy: dependencies not injected');
    }

    const { audioSource, asrProvider, translationProvider } = this.deps;
    this.running = true;

    // M2-13：啟動定時檢查降檔（每 10s 檢查一次）。
    this.downgradeCheckInterval = setInterval(() => {
      if (this.perf?.shouldDowngrade(30000)) {
        // §5.6：降檔必須落診斷。
        recordDiagnostic({
          type: 'engine-degraded',
          port: 'asr',
          reason: 'ASR performance degraded: RTF > 1.0 for 30s. Consider switching to cloud ASR or lower model tier.',
        });
        emit({
          type: 'engine-degraded',
          port: 'asr',
          reason: 'RTF > 1.0 for 30s, recommend downgrade',
        });
      }
    }, 10000);

    // M2-56：先 await ASR warmup 完成，再啟動音頻捕獲。
    // 根因修復：此前 warmup 由 orchestrator fire-and-forget，音頻塊在模型載入期間
    // 到達時 transcribeStream 因 !warmedUp 拋錯 → 所有 chunk 被靜默丟棄 → 字幕不出現。
    diagLog('strategy', 'realtime-asr: warming up ASR model...');
    try {
      await asrProvider.warmup(ctx.config.asr);
    } catch (err) {
      // §5.6：warmup 失敗必須落診斷 + emit degraded（不靜默）。
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-warmup-failed',
          recoverable: true,
          cause: err instanceof Error ? err : new Error(String(err)),
        },
      });
      emit({
        type: 'engine-degraded',
        port: 'asr',
        reason: `ASR warmup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err; // 讓策略鏈降級到下一策略（或終止）。
    }
    diagLog('strategy', 'realtime-asr: ASR warmup complete, opening audio source...');

    // 啟動音頻源（保存 handle 供 stop() 關閉，§5.4 洩漏零容忍）。
    // M2-44：增加診斷日誌，方便排查掛起或拋錯。
    diagLog('strategy', 'realtime-asr: opening audio source...');
    this.audioHandle = await audioSource.open(ctx.platform);
    diagLog('strategy', 'realtime-asr: audio source opened, starting...');
    await this.audioHandle.start();
    diagLog('strategy', 'realtime-asr: audio source started successfully');

    // 監聽音頻塊。
    audioSource.onChunk(async (chunk: AudioChunk) => {
      if (!this.running) return;

      // M2-56：若 provider 有 isReady() 且未就緒，跳過（防 warmup 邊界競態）。
      if (asrProvider.isReady && !asrProvider.isReady()) return;

      // M2-58：時間軸對齊——offscreen 無法獲取視頻時間軸（chunk.startTime=0），
      // 此處以播放狀態反推：chunk 覆蓋視頻時間 [videoNow - duration, videoNow]。
      // lastPlayback 由 timeupdate 驅動（~250ms 粒度），誤差可接受。
      const videoNow = ctx.playback().currentTime; // ms
      chunk.startTime = Math.max(0, videoNow - chunk.duration);

      // VAD 過濾靜音（M2-58：用 process() 取 rms 做統計，markChunk 會丟棄它）。
      const vadResult = this.vad!.process(chunk.pcm, chunk.sampleRate, performance.now());
      chunk.isSpeech = vadResult.isSpeech;

      // M2-58：VAD 5s 窗口統計（§5.6 breadcrumb）——區分「無 chunk」與「有 chunk 但全被過濾」。
      this.vadWindowReceived++;
      if (vadResult.rms > this.vadWindowMaxRms) this.vadWindowMaxRms = vadResult.rms;
      if (vadResult.rms > this.vadSessionMaxRms) this.vadSessionMaxRms = vadResult.rms;
      if (vadResult.isSpeech) this.vadWindowPassed++;
      const vadNow = performance.now();
      if (this.vadWindowStart === 0) this.vadWindowStart = vadNow;
      if (vadNow - this.vadWindowStart >= 5000) {
        diagLog(
          'strategy',
          `realtime-asr: VAD window — received=${this.vadWindowReceived}, passed=${this.vadWindowPassed}, maxRms=${this.vadWindowMaxRms.toFixed(5)} (last 5s)`,
        );
        this.vadWindowReceived = 0;
        this.vadWindowPassed = 0;
        this.vadWindowMaxRms = 0;
        this.vadWindowStart = vadNow;
      }

      if (!vadResult.isSpeech) {
        // M2-58：兜底——連續 ~10s 全被過濾時放寬閾值（降半）並落診斷，
        // 防止低音量視頻被固定閾值永久過濾（§5.6：軟失敗必須留痕）。
        this.consecutiveSilentChunks++;
        if (!this.vadFallbackArmed && this.consecutiveSilentChunks >= VAD_FALLBACK_SILENT_CHUNKS) {
          const relaxed = this.baseVadThreshold / 2;
          this.vad!.setThreshold(relaxed);
          this.vadFallbackArmed = true;
          recordDiagnostic({
            type: 'engine-degraded',
            port: 'asr',
            reason: `vad-filtering-all: ${this.consecutiveSilentChunks} consecutive chunks below threshold (${this.baseVadThreshold} -> ${relaxed}), sessionMaxRms=${this.vadSessionMaxRms.toFixed(5)}; threshold relaxed`,
          });
          diagLog('strategy', `realtime-asr: VAD fallback armed — threshold relaxed ${this.baseVadThreshold} -> ${relaxed}`);
        }
        return; // 靜音跳過。
      }
      this.consecutiveSilentChunks = 0;

      // M2-66：Backpressure——in-flight ASR 請求過多時跳過（防鎖隊列爆炸）。
      if (this.inflightAsrCount >= MAX_INFLIGHT_ASR) {
        diagLog('strategy', `realtime-asr: backpressure — skipping seq=${chunk.seq} (inflight=${this.inflightAsrCount})`);
        return;
      }

      // M2-58：首次 ASR dispatch breadcrumb（§5.6）——確認 VAD→ASR 交接真的發生。
      this.asrCallCount++;
      if (this.asrCallCount === 1) {
        diagLog('strategy', `realtime-asr: first ASR dispatch (seq=${chunk.seq}, chunkMs=${Math.round(chunk.duration)})`);
      }

      this.inflightAsrCount++;
      try {
        // ASR 推理（流式）。
        const req = {
          chunk,
          hintLang: ctx.audioLanguage,
          allowPartial: true,
        };

        const asrStartTime = performance.now();

        if (asrProvider.transcribeStream) {
          // 流式推理——emit provisional → final。
          await asrProvider.transcribeStream(req, async (asrResult) => {
            // M2-12：收集性能指標。
            const asrMs = performance.now() - asrStartTime;
            this.perf?.add({
              stage: 'asr',
              ms: asrMs,
              seq: chunk.seq,
              rtf: asrResult.rtf,
            });
            if (!this.running) return;
            emit({
              type: 'metrics',
              data: { stage: 'asr', ms: asrMs, seq: chunk.seq, rtf: asrResult.rtf },
            });

            // M2-58：ASR 結果摘要（每結果一行的頻率 ~1/s，非洪水）。
            const totalTextLen = asrResult.segments.reduce((n, s) => n + s.sourceText.trim().length, 0);
            diagLog(
              'strategy',
              `realtime-asr: ASR result seq=${chunk.seq}, segments=${asrResult.segments.length}, partial=${asrResult.isPartial}, textLen=${totalTextLen}`,
            );

            // M2-64：極短文本跳過翻譯——local-onnx 對 "um"/"yeah" 等輸出 [BLANK AUDIO]，浪費 15-27s CPU。
            if (totalTextLen < MIN_TRANSLATE_TEXT_LEN) {
              diagLog('strategy', `realtime-asr: skipping translation for very short text (len=${totalTextLen}, seq=${chunk.seq})`);
              return;
            }

            // M2-66/M2-67：去重——連續相同文本跳過翻譯（Whisper 對低音量/音樂段反覆產出 [MUSIC]）。
            // M2-67：正規化 non-speech token（[MUSIC]/(laughing) 等）後比較，覆蓋變體。
            const currentText = normalizeForDedup(asrResult.segments.map((s) => s.sourceText.trim()).join(' '));
            if (currentText === this.lastAsrText) {
              this.consecutiveDuplicateCount++;
              if (this.consecutiveDuplicateCount >= DEDUP_CONSECUTIVE_THRESHOLD) {
                diagLog('strategy', `realtime-asr: dedup — skipping duplicate text "${currentText.slice(0, 30)}" (consecutive=${this.consecutiveDuplicateCount}, seq=${chunk.seq})`);
                return;
              }
            } else {
              this.lastAsrText = currentText;
              this.consecutiveDuplicateCount = 1;
            }

            // 翻譯。
            const translateStart = performance.now();
            const translatedSegments = await this.translateSegments(
              asrResult.segments,
              translationProvider
            );
            const translateMs = performance.now() - translateStart;
            this.perf?.add({ stage: 'translate', ms: translateMs, seq: chunk.seq });
            if (!this.running) return;
            emit({
              type: 'metrics',
              data: { stage: 'translate', ms: translateMs, seq: chunk.seq },
            });

            // 推送事件（M2-58：對齊視頻時間軸 + 過濾空文本）。
            if (!this.running) return;
            this.emitAligned(asrResult, translatedSegments, chunk, emit);
          });
        } else {
          // 非流式推理。
          const asrResult = await asrProvider.transcribe(req);
          if (!this.running) return;
          const asrMs = performance.now() - asrStartTime;
          this.perf?.add({
            stage: 'asr',
            ms: asrMs,
            seq: chunk.seq,
            rtf: asrResult.rtf,
          });
          emit({
            type: 'metrics',
            data: { stage: 'asr', ms: asrMs, seq: chunk.seq, rtf: asrResult.rtf },
          });

          // M2-64：極短文本跳過翻譯（非流式路徑）。
          const totalTextLen = asrResult.segments.reduce((n, s) => n + s.sourceText.trim().length, 0);
          if (totalTextLen < MIN_TRANSLATE_TEXT_LEN) {
            diagLog('strategy', `realtime-asr: skipping translation for very short text (len=${totalTextLen}, seq=${chunk.seq})`);
            return;
          }

          // M2-66/M2-67：去重（非流式路徑）——正規化 non-speech token 後比較。
          const currentText = normalizeForDedup(asrResult.segments.map((s) => s.sourceText.trim()).join(' '));
          if (currentText === this.lastAsrText) {
            this.consecutiveDuplicateCount++;
            if (this.consecutiveDuplicateCount >= DEDUP_CONSECUTIVE_THRESHOLD) {
              diagLog('strategy', `realtime-asr: dedup — skipping duplicate text "${currentText.slice(0, 30)}" (consecutive=${this.consecutiveDuplicateCount}, seq=${chunk.seq})`);
              return;
            }
          } else {
            this.lastAsrText = currentText;
            this.consecutiveDuplicateCount = 1;
          }

          const translateStart = performance.now();
          const translatedSegments = await this.translateSegments(
            asrResult.segments,
            translationProvider
          );
          if (!this.running) return;
          const translateMs = performance.now() - translateStart;
          this.perf?.add({ stage: 'translate', ms: translateMs, seq: chunk.seq });
          emit({
            type: 'metrics',
            data: { stage: 'translate', ms: translateMs, seq: chunk.seq },
          });

          // M2-58：對齊視頻時間軸 + 過濾空文本。
          if (!this.running) return;
          this.emitAligned(asrResult, translatedSegments, chunk, emit);
        }
      } catch (err) {
        // §5.6：ASR 失敗必須落診斷。
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'asr',
            code: 'asr-engine-failed',
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        });
        if (!this.running) return;
        emit({
          type: 'engine-degraded',
          port: 'asr',
          reason: `ASR failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        this.inflightAsrCount = Math.max(0, this.inflightAsrCount - 1);
      }
    });

    // 保存 unsubscribe（§5.4）。
    this.unsubscribeChunk = () => {
      // AudioSourceProvider 的 onChunk 不支持 unsubscribe，由 stop() 控制。
    };
  }

  stop(): void {
    // §5.4：所有資源必須在 stop 時清理。
    this.running = false;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = null;
    this.vad?.reset();
    // M2-58：重置統計與兜底狀態，避免跨會話累積誤讀（§5.4 註冊必配解除的計數器版本）。
    this.consecutiveSilentChunks = 0;
    this.vadFallbackArmed = false;
    this.vadWindowReceived = 0;
    this.vadWindowPassed = 0;
    this.vadWindowMaxRms = 0;
    this.vadSessionMaxRms = 0;
    this.vadWindowStart = 0;
    this.asrCallCount = 0;
    // M2-65：清空累計緩衝（restart/seek 時重新累積）。
    this.accumulatedSegments.clear();
    // M2-13：清理降檔檢查定時器。
    if (this.downgradeCheckInterval !== null) {
      clearInterval(this.downgradeCheckInterval);
      this.downgradeCheckInterval = null;
    }
    // §5.4：關閉音頻源（tabCapture + Offscreen Document），避免視頻切換時資源洩漏。
    // handle.stop() 是 async，但 CaptionStrategy.stop() 介面是同步——fire-and-forget + catch。
    if (this.audioHandle) {
      void this.audioHandle.stop().catch((err) => {
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'audio',
            code: 'audio-handle-stop-failed',
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        });
      });
      this.audioHandle = null;
    }
  }

  /** 翻譯字幕段（批量）。 */
  private async translateSegments(
    segments: SubtitleSegment[],
    provider: TranslationProvider
  ): Promise<SubtitleSegment[]> {
    const result = await provider.translate({
      segments,
      targetLang: 'zh-Hant',
    });
    return result.segments;
  }

  /**
   * M2-58：對齊 + 過濾後推送。全空時跳過 emit（留 breadcrumb，§5.6 不靜默）。
   * M2-65：累計 emit——將新 segment 合併入緩衝（按 id 去重/覆蓋），emit 全量列表。
   * content-script 的 onEvent 做全量替換 this.cues，因此必須發送累計全量而非僅當前 chunk。
   */
  private emitAligned(
    asrResult: { isPartial: boolean },
    translatedSegments: SubtitleSegment[],
    chunk: AudioChunk,
    emit: (e: PipelineEvent) => void,
  ): void {
    const aligned = alignSegmentsToVideoTimeline(translatedSegments, chunk.startTime);
    const filtered = filterEmptySegments(aligned);
    if (filtered.length === 0) {
      diagLog('strategy', `realtime-asr: ASR returned no usable text (seq=${chunk.seq}), skipping emit`);
      return;
    }

    // M2-65：合併入累計緩衝（同 id 覆蓋——provisional 修正）。
    for (const seg of filtered) {
      this.accumulatedSegments.set(seg.id, seg);
    }

    // 按 start 時間排序後 emit 全量。
    const allSegments = [...this.accumulatedSegments.values()].sort((a, b) => a.start - b.start);
    emit({ type: asrResult.isPartial ? 'segments-updated' : 'segments-ready', segments: allSegments });
  }

  /** 獲取性能統計摘要（用於觀測與調試）。 */
  getPerfSummary(): Map<string, import('../../infrastructure/perf/metrics').PerfSummary> | null {
    return this.perf?.allSummaries() ?? null;
  }
}
