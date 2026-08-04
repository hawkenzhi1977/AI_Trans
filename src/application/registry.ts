import type { ASRProvider } from '../domain/ports/asr-provider';
import type { CaptionStrategy } from '../domain/ports/caption-strategy';
import type { PlatformAdapter } from '../domain/ports/platform-adapter';
import type { SubtitleRenderer } from '../domain/ports/subtitle-renderer';
import type { TranslationProvider } from '../domain/ports/translation-provider';

/**
 * 適配器註冊表——可插拔邊緣的掛載點。
 * 新增適配器只需向對應 Map/數組註冊；選擇邏輯由配置驅動。
 */
export interface Registry {
  platforms: PlatformAdapter[];
  /** 有序，代表降級優先級。 */
  strategies: CaptionStrategy[];
  asr: Map<string, ASRProvider>;
  translation: Map<string, TranslationProvider>;
  renderer: SubtitleRenderer;
}

/** 為註冊表挑選平台適配器。 */
export function selectPlatform(
  registry: Registry,
  url: string
): PlatformAdapter | undefined {
  return registry.platforms.find((p) => p.matches(url));
}
