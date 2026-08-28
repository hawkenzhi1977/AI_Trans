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

  /** 注入依賴（由 Orchestrator 調用）。 */
  inject(deps: RealtimeASRDeps): void {
    this.deps = deps;
    this.vad = new EnergyVAD({ threshold: deps.vadThreshold ?? 0.01 });
    this.perf = new PerfMetrics(100); // 滑動窗口 100 樣本。
  }

  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    // 檢查 ASR 配置與 tabCapture 授權狀態。
    if (ctx.config.asr.type === 'none') {
      ctx.diagnostics?.push?.('realtime-asr: ASR disabled (config.asr.type = none)');
      return false;
    }

    // 檢查 tabCapture 授權（content-script 會寫入 chrome.storage.local）。
    try {
      const authState = await chrome.storage.local.get('tabCaptureAuthorized');
      if (!authState.tabCaptureAuthorized) {
        ctx.diagnostics?.push?.('realtime-asr: tabCapture not authorized');
        return false;
      }
    } catch {
      // 非擴充環境（測試）→ 允許（mock 授權）。
    }

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

      // VAD 過濾靜音。
      this.vad!.markChunk(chunk);
      if (!chunk.isSpeech) return; // 靜音跳過。

      try {
        // ASR 推理（流式）。
        const req = {
          chunk,
          hintLang: undefined, // 由配置驅動。
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

            // 推送事件。
            if (!this.running) return;
            emit({
              type: asrResult.isPartial ? 'segments-updated' : 'segments-ready',
              segments: translatedSegments,
            });
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

          if (!this.running) return;
          emit({
            type: 'segments-ready',
            segments: translatedSegments,
          });
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

  /** 獲取性能統計摘要（用於觀測與調試）。 */
  getPerfSummary(): Map<string, import('../../infrastructure/perf/metrics').PerfSummary> | null {
    return this.perf?.allSummaries() ?? null;
  }
}
