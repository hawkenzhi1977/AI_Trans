// 測試組裝——向 Registry 注入 stub 引擎與 mock 平臺，實現無外部依賴的閉環。
import type { Registry } from '../../src/application/registry';
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';
import type { PlatformAdapter } from '../../src/domain/ports/platform-adapter';
import {
  NativeCaptionStrategy,
  LookAheadASRStrategy,
  RealtimeASRStrategy,
} from '../../src/application';
import { OverlayRenderer } from '../../src/adapters/render/overlay-renderer';
import { MockYouTubeAdapter } from './mock-youtube';
import { StubTranslationProvider, StubASRProvider } from './stub-engines';

export interface TestRegistryOverrides {
  platforms?: PlatformAdapter[];
  translation?: Map<string, TranslationProvider>;
  asr?: Map<string, ASRProvider>;
}

/** 構建測試用 Registry：真實策略鏈/管線/渲染 + stub 外部依賴。 */
export function buildTestRegistry(overrides: TestRegistryOverrides = {}): Registry {
  const llm = new StubTranslationProvider({ engineId: 'llm', prefix: '[llm]' });
  const mt = new StubTranslationProvider({
    engineId: 'mt',
    prefix: '[mt]',
    location: 'cloud',
  });

  return {
    platforms: overrides.platforms ?? [new MockYouTubeAdapter()],
    strategies: [
      new NativeCaptionStrategy(),
      new LookAheadASRStrategy(),
      new RealtimeASRStrategy(),
    ],
    asr: overrides.asr ?? new Map<string, ASRProvider>([['asr', new StubASRProvider()]]),
    translation:
      overrides.translation ??
      new Map<string, TranslationProvider>([
        ['llm', llm],
        ['mt', mt],
      ]),
    renderer: new OverlayRenderer(),
  };
}
