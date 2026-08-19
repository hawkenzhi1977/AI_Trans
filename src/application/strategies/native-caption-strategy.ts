import type { PipelineEvent } from '../../domain/models/events';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';
import { diagLog } from '../../infrastructure/debug-log';

/** 滑動窗口起始偏移（毫秒）：從 currentTime 之後 2s 開始翻譯，之前的內容無意義。 */
const WINDOW_START_OFFSET_MS = 2000;
/** 滑動窗口結束偏移（毫秒）：優先翻譯 currentTime+2s ~ currentTime+120s 範圍。 */
const WINDOW_END_OFFSET_MS = 120_000;

/**
 * 一級策略：原生字幕。抓取平台原生字幕軌 → 翻譯 → 推送 segments-ready。
 * 支持 seek 響應：用戶拖動進度條時中斷當前翻譯，按新位置重新優先化翻譯隊列。
 */
export class NativeCaptionStrategy implements CaptionStrategy {
  readonly origin = 'native' as const;

  private stopped = false;
  private allSegments: SubtitleSegment[] = [];
  private readonly translatedIds = new Set<string>();
  private accumulatedSegments: SubtitleSegment[] = [];
  private abortController: AbortController | null = null;
  private hasSeek = false;
  private seekTime = 0;

  /**
   * 判斷是否有原生字幕軌可用。
   * 注意：listCaptionTracks 失敗/為空**不拋錯、返回 false**，交由鏈降級——
   * 但必須把原因記到 ctx 供鏈在「全鏈不適用」時發出可見診斷（§5.6 不靜默）。
   */
  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    try {
      const tracks = await ctx.platform.listCaptionTracks();
      if (tracks.length === 0) {
        const platformDiag = ctx.platform.getLastTrackDiagnostic?.();
        ctx.diagnostics?.push?.(`native: no caption tracks found — ${platformDiag ?? 'no captions on page'}`);
      }
      return tracks.length > 0;
    } catch (err) {
      ctx.diagnostics?.push?.(
        `native: listCaptionTracks failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  async run(
    ctx: StrategyContext,
    emit: (e: PipelineEvent) => void
  ): Promise<void> {
    this.stopped = false;
    const tracks = await ctx.platform.listCaptionTracks();
    const track = tracks[0];
    if (!track) {
      emit({
        type: 'engine-degraded',
        port: 'translation',
        reason: 'no caption track available',
      });
      return;
    }

    diagLog('strategy', 'track.fetch() starting');
    this.allSegments = await track.fetch();
    diagLog('strategy', 'track.fetch() returned', this.allSegments.length, 'segments');
    if (this.stopped) return;

    // 重置翻譯狀態
    this.translatedIds.clear();
    this.accumulatedSegments = [];

    try {
      await this.translateWithPriority(ctx, emit);
    } catch (err) {
      // AbortError 由 translateWithPriority 內部處理，此處只處理其他錯誤。
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (this.stopped) return;

      diagLog('strategy', 'translation FAILED:', err instanceof Error ? err.message : String(err));
      emit({
        type: 'engine-degraded',
        port: 'translation',
        reason: `translation failed, falling back to original subtitles: ${err instanceof Error ? err.message : String(err)}`,
      });
      const untranslated = this.allSegments.filter(s => !this.translatedIds.has(s.id));
      const fallbackSegments = untranslated.map((s) => ({
        ...s,
        translatedText: s.sourceText,
        targetLang: s.sourceLang,
      }));
      emit({ type: 'segments-ready', segments: fallbackSegments });
    }
  }

  /**
   * 動態優先級翻譯循環：
   * 1. 按 currentTime+2s 為起點排序未翻譯 segments（滑動窗口優先）
   * 2. 流式翻譯，每 chunk 完成即 emit 累計結果
   * 3. seek 時中斷當前翻譯，重新優先化後繼續
   */
  private async translateWithPriority(
    ctx: StrategyContext,
    emit: (e: PipelineEvent) => void
  ): Promise<void> {
    let firstEmit = this.accumulatedSegments.length === 0;

    while (!this.stopped) {
      // 處理 seek：重新優先化翻譯隊列
      if (this.hasSeek) {
        this.hasSeek = false;
        diagLog('strategy', 'seek detected at', this.seekTime, 'ms, re-prioritizing');
      }

      const currentTime = this.seekTime || ctx.playback().currentTime;
      this.seekTime = 0;

      // 獲取按優先級排序的未翻譯 segments
      const prioritized = this.getPrioritizedSegments(currentTime);
      if (prioritized.length === 0) {
        diagLog('strategy', 'all segments translated, total:', this.translatedIds.size);
        break;
      }

      diagLog('strategy', 'translation round starting, currentTime:', currentTime,
        'untranslated:', prioritized.length, 'translated:', this.translatedIds.size,
        'first priority start:', prioritized[0]?.start);

      // 建立新的 AbortController 用於這輪翻譯
      this.abortController = new AbortController();

      try {
        if (ctx.translation.translateStream) {
          await ctx.translation.translateStream(
            { segments: prioritized, targetLang: ctx.config.targetLang, signal: this.abortController.signal },
            (result) => {
              if (this.stopped) return;
              // 更新已翻譯追蹤
              for (const seg of result.segments) {
                if (!this.translatedIds.has(seg.id)) {
                  this.translatedIds.add(seg.id);
                }
              }
              // 合併累計結果（保留已翻譯的 + 新翻譯的）
              this.mergeAccumulated(result.segments);
              const sortedSegments = [...this.accumulatedSegments].sort((a, b) => a.start - b.start);
              // 診斷日誌
              const coverageStart = sortedSegments[0]?.start ?? 0;
              const coverageEnd = sortedSegments[sortedSegments.length - 1]?.end ?? 0;
              const currentPlaybackTime = ctx.playback().currentTime;
              const gap = currentPlaybackTime - coverageEnd;
              if (firstEmit) {
                firstEmit = false;
                diagLog('strategy', 'emit segments-ready at currentTime:', currentPlaybackTime,
                  ', coverage:', coverageStart, '-', coverageEnd, 'ms, gap:', gap, 'ms',
                  gap > 0 ? 'BEHIND' : 'AHEAD');
                emit({ type: 'segments-ready', segments: sortedSegments });
              } else {
                diagLog('strategy', 'emit segments-updated at currentTime:', currentPlaybackTime,
                  ', coverage:', coverageStart, '-', coverageEnd, 'ms, gap:', gap, 'ms',
                  gap > 0 ? 'BEHIND' : 'AHEAD');
                emit({ type: 'segments-updated', segments: sortedSegments });
              }
            }
          );
        } else {
          const result = await ctx.translation.translate({
            segments: prioritized,
            targetLang: ctx.config.targetLang,
          });
          for (const seg of result.segments) {
            this.translatedIds.add(seg.id);
          }
          this.mergeAccumulated(result.segments);
          const sortedSegments = [...this.accumulatedSegments].sort((a, b) => a.start - b.start);
          if (firstEmit) {
            firstEmit = false;
            emit({ type: 'segments-ready', segments: sortedSegments });
          } else {
            emit({ type: 'segments-updated', segments: sortedSegments });
          }
        }
      } catch (err) {
        // AbortError：seek 中斷，繼續外層 while 循環重新優先化
        if (err instanceof DOMException && err.name === 'AbortError') {
          diagLog('strategy', 'translation aborted, will re-prioritize');
          continue;
        }
        throw err;
      }

      this.abortController = null;
    }
  }

  /**
   * 獲取按優先級排序的未翻譯 segments。
   * 滑動窗口 [currentTime+2s, currentTime+120s] 內的 segments 優先，
   * 窗口外的按時間順序排在後面。
   */
  private getPrioritizedSegments(currentTime: number): SubtitleSegment[] {
    const untranslated = this.allSegments.filter(s => !this.translatedIds.has(s.id));
    if (untranslated.length === 0) return [];

    const windowStart = currentTime + WINDOW_START_OFFSET_MS;
    const windowEnd = currentTime + WINDOW_END_OFFSET_MS;

    // 窗口內的 segments（優先）
    const inWindow = untranslated.filter(s => s.start >= windowStart && s.start <= windowEnd);
    // 窗口外的 segments（currentTime 之後但超出窗口，或 currentTime 之前的）
    const outWindow = untranslated.filter(s => s.start < windowStart || s.start > windowEnd);

    // 窗口內按時間排序，窗口外也按時間排序
    inWindow.sort((a, b) => a.start - b.start);
    outWindow.sort((a, b) => a.start - b.start);

    return [...inWindow, ...outWindow];
  }

  /** 合併新翻譯的 segments 到累計結果（更新已存在的，添加新的）。 */
  private mergeAccumulated(newSegments: SubtitleSegment[]): void {
    const existingMap = new Map(this.accumulatedSegments.map(s => [s.id, s]));
    for (const seg of newSegments) {
      existingMap.set(seg.id, seg);
    }
    this.accumulatedSegments = Array.from(existingMap.values());
  }

  /** Seek 時由 Orchestrator 調用：中斷當前翻譯，記錄新位置。 */
  onSeek(currentTimeMs: number): void {
    this.hasSeek = true;
    this.seekTime = currentTimeMs;
    // 中斷當前翻譯（下一輪 while 循環會重新優先化）
    this.abortController?.abort();
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }
}

export type { SubtitleSegment };
