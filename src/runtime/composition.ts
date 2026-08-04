import type { Registry } from '../application/registry';
import {
  NativeCaptionStrategy,
  LookAheadASRStrategy,
  RealtimeASRStrategy,
} from '../application';
import { YouTubePlatformAdapter, FetchCaptionSource } from '../adapters';
import { LLMTranslationProvider } from '../adapters/translation/llm-translation';
import { MTTranslationProvider } from '../adapters/translation/mt-translation';
import { OverlayRenderer } from '../adapters/render/overlay-renderer';
import type { EngineConfig } from '../domain/models/config';
import type { TranslationProvider } from '../domain/ports/translation-provider';

/** 組裝默認 M1 Registry（生產組裝）。外部易變依賴在 runtime 注入，核心無感。 */
export function buildDefaultRegistry(config: EngineConfig): Registry {
  const youtube = new YouTubePlatformAdapter({
    captionSource: new FetchCaptionSource(),
  });

  const llm = new LLMTranslationProvider({
    engineId: 'llm',
    endpoint: config.translation.endpoint ?? 'https://api.openai.com/v1/chat/completions',
    model: config.translation.model ?? 'gpt-4o-mini',
    apiKey: '', // 從安全存儲解析（見 chrome-config-store apiKeyRef）
  });

  const mt = new MTTranslationProvider({
    // 演示字典；實際接入真實 MT 服務。
    hello: '你好',
    world: '世界',
    welcome: '歡迎',
  });

  return {
    platforms: [youtube],
    strategies: [
      new NativeCaptionStrategy(),
      new LookAheadASRStrategy(),
      new RealtimeASRStrategy(),
    ],
    asr: new Map(),
    translation: new Map<string, TranslationProvider>([
      ['llm', llm],
      ['mt', mt],
    ]),
    renderer: new OverlayRenderer(),
  };
}
