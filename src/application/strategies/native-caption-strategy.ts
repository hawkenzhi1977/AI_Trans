import type { PipelineEvent } from '../../domain/models/events';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';
import { diagLog } from '../../infrastructure/debug-log';

/**
 * 一級策略：原生字幕。抓取平台原生字幕軌 → 翻譯 → 推送 segments-ready。
 */
export class NativeCaptionStrategy implements CaptionStrategy {
  readonly origin = 'native' as const;

  private stopped = false;

  /**
   * 判斷是否有原生字幕軌可用。
   * 注意：listCaptionTracks 失敗/為空**不拋錯、返回 false**，交由鏈降級——
   * 但必須把原因記到 ctx 供鏈在「全鏈不適用」時發出可見診斷（§5.6 不靜默）。
   */
  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    try {
      const tracks = await ctx.platform.listCaptionTracks();
      if (tracks.length === 0) {
        // 優先取平台側的詳細診斷（找不到數據源 vs 數據源無字幕 vs 解析失敗），
        // 讓用戶能精確定位「字幕軌抓不到」的真實原因（§5.6 不靜默）。
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
    // 選擇首個可用軌（優先在配置目標語之前的語言）。MVP：取第一個。
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
    const segments = await track.fetch();
    diagLog('strategy', 'track.fetch() returned', segments.length, 'segments');
    if (this.stopped) return;

    try {
      diagLog('strategy', 'translation starting, targetLang:', ctx.config.targetLang);
      // M1-52：引擎支持流式（分塊漸進）時優先走流式——首塊完成即 emit segments-ready，
      // 後續塊累計替換 emit segments-updated，渲染層 5-10s 內先見首塊（降低感知延遲）。
      // 無流式能力的引擎（如 MT stub）退回落原非流式路徑。
      if (ctx.translation.translateStream) {
        let firstEmit = true;
        diagLog('strategy', 'using translateStream (chunked progressive)');
        await ctx.translation.translateStream(
          { segments, targetLang: ctx.config.targetLang },
          (result) => {
            if (this.stopped) return;
            if (firstEmit) {
              firstEmit = false;
              diagLog('strategy', 'emit segments-ready,', result.segments.length, 'segments');
              emit({ type: 'segments-ready', segments: result.segments });
            } else {
              diagLog('strategy', 'emit segments-updated,', result.segments.length, 'segments');
              emit({ type: 'segments-updated', segments: result.segments });
            }
          }
        );
        if (this.stopped) return;
        return;
      }

      const result = await ctx.translation.translate({
        segments,
        targetLang: ctx.config.targetLang,
      });
      diagLog('strategy', 'translation succeeded,', result.segments.length, 'translated segments');
      if (this.stopped) return;

      diagLog('strategy', 'emitting segments-ready');
      emit({ type: 'segments-ready', segments: result.segments });
    } catch (err) {
      // §5.6 關鍵節點：翻譯失敗必須留痕——diagLog('strategy') 為流程級門控日誌，
      // 但同時發出 engine-degraded 降級事件（recordDiagnostic 無條件落盤 + console.warn）。
      diagLog('strategy', 'translation FAILED:', err instanceof Error ? err.message : String(err));
      // 翻譯失敗時顯示原文字幕作為降級（§5.6：不靜默失敗）
      if (this.stopped) return;
      emit({
        type: 'engine-degraded',
        port: 'translation',
        reason: `translation failed, falling back to original subtitles: ${err instanceof Error ? err.message : String(err)}`,
      });
      // 使用原文字幕（translatedText 設為 sourceText）
      const fallbackSegments = segments.map((s) => ({
        ...s,
        translatedText: s.sourceText,
        targetLang: s.sourceLang,
      }));
      emit({ type: 'segments-ready', segments: fallbackSegments });
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

export type { SubtitleSegment };
