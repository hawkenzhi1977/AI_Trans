import type { PipelineEvent } from '../../domain/models/events';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';

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

    const segments = await track.fetch();
    if (this.stopped) return;

    const result = await ctx.translation.translate({
      segments,
      targetLang: ctx.config.targetLang,
    });
    if (this.stopped) return;

    emit({ type: 'segments-ready', segments: result.segments });
  }

  stop(): void {
    this.stopped = true;
  }
}

export type { SubtitleSegment };
