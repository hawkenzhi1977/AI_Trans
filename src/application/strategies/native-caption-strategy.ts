import type { PipelineEvent } from '../../domain/models/events';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { CaptionStrategy, StrategyContext } from '../../domain/ports/caption-strategy';

/**
 * 一級策略：原生字幕。抓取平台原生字幕軌 → 翻譯 → 推送 segments-ready。
 */
export class NativeCaptionStrategy implements CaptionStrategy {
  readonly origin = 'native' as const;

  private stopped = false;

  async isApplicable(ctx: StrategyContext): Promise<boolean> {
    try {
      const tracks = await ctx.platform.listCaptionTracks();
      return tracks.length > 0;
    } catch {
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
