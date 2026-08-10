// 測試組裝——向 Registry 注入 stub 引擎與 mock 平臺，實現無外部依賴的閉環。
import type { Registry } from '../../src/application/registry';
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';
import type { AudioSourceProvider } from '../../src/domain/ports/audio-source';
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
  audioSources?: Map<string, AudioSourceProvider>;
}

/** Stub AudioSourceProvider（測試用，模擬 tabCapture 音頻源）。 */
class StubAudioSource implements AudioSourceProvider {
  readonly kind = 'tab-capture' as const;
  private chunkCallback: ((chunk: import('../../src/domain/models/audio').AudioChunk) => void) | null = null;

  async open(): Promise<import('../../src/domain/models/audio').AudioSourceHandle> {
    return {
      kind: 'tab-capture',
      start: async () => {},
      stop: async () => {},
    };
  }

  onChunk(cb: (chunk: import('../../src/domain/models/audio').AudioChunk) => void): void {
    this.chunkCallback = cb;
  }

  /** 測試輔助：模擬推送音頻塊。 */
  emitChunk(chunk: import('../../src/domain/models/audio').AudioChunk): void {
    this.chunkCallback?.(chunk);
  }
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
    audioSources: overrides.audioSources ?? new Map<string, AudioSourceProvider>([['tab-capture', new StubAudioSource()]]),
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
