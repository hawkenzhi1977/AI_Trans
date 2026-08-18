import type { Registry } from '../application/registry';
import { normalizeEndpoint } from './endpoint';
import {
  NativeCaptionStrategy,
  LookAheadASRStrategy,
  RealtimeASRStrategy,
} from '../application';
import { YouTubePlatformAdapter, FetchCaptionSource } from '../adapters';
import { LLMTranslationProvider, ensureLlmCacheInvalidationHook } from '../adapters/translation/llm-translation';
import { MTTranslationProvider } from '../adapters/translation/mt-translation';
import { LocalONNXTranslationProvider } from '../adapters/translation/local-onnx-translation';
import { OverlayRenderer } from '../adapters/render/overlay-renderer';
import { TabCaptureAudioSource } from '../adapters/audio/tab-capture-source';
import { CloudASR } from '../adapters/asr/cloud-asr';
import { LocalWhisperASR } from '../adapters/asr/local-whisper';
import type { CaptionCaptureProvider } from '../adapters/platform/youtube/platform-adapter';
import type { EngineConfig, TranslationConfig } from '../domain/models/config';
import { DEFAULT_LOCAL_TRANSLATION_MODEL } from '../domain/models/config';
import type { TranslationProvider } from '../domain/ports/translation-provider';
import type { AudioSourceProvider } from '../domain/ports/audio-source';
import type { ASRProvider } from '../domain/ports/asr-provider';
import type { ApiKeyStore } from '../domain/ports/config-store';

export interface BuildRegistryOptions {
  /** 組裝時解析 API 密鑰所需的安全存儲。 */
  apiKeyStore: ApiKeyStore;
  /** 平台 URL 匹配規則覆蓋（測試環境用於匹配 Mock 站點）。 */
  platformWatchRe?: RegExp;
  /** MAIN world 播放器 timedtext 響應捕獲提供者（注入給 FetchCaptionSource 優先複用）。 */
  captionCaptureProvider?: CaptionCaptureProvider;
}

/**
 * 組裝默認 M1 Registry（生產組裝）。外部易變依賴在 runtime 注入，核心無感。
 * 依 EngineConfig 選中主/兜底翻譯引擎，並解析 apiKeyRef 注入真實密鑰。
 */
export async function buildDefaultRegistry(
  config: EngineConfig,
  opts: BuildRegistryOptions
): Promise<Registry> {
  const youtube = new YouTubePlatformAdapter({
    captionSource: new FetchCaptionSource(
      globalThis.document,
      globalThis.fetch,
      opts.captionCaptureProvider
    ),
    watchUrlRe: opts.platformWatchRe,
  });

  // 依配置構建翻譯引擎集合（LLM + MT 字典兜底）。
  const translation = await buildTranslationProviders(config, opts.apiKeyStore);

  // M1-52：安裝 LLM 塊級快取失效監聽（engineConfig 變更 → 清空快取）。
  // 非擴充環境（無 chrome.storage）內部 try/catch 守護為無操作。
  ensureLlmCacheInvalidationHook();

  // M2-04：註冊音頻源（tabCapture）。
  const audioSources = new Map<string, AudioSourceProvider>();
  audioSources.set('tab-capture', new TabCaptureAudioSource());

  // M2-05/06：註冊 ASR providers（本地 Whisper + 雲端 ASR）。
  const asr = await buildASRProviders(config, opts.apiKeyStore);

  return {
    platforms: [youtube],
    strategies: [
      new NativeCaptionStrategy(),
      new LookAheadASRStrategy(),
      new RealtimeASRStrategy(),
    ],
    audioSources,
    asr,
    translation,
    renderer: new OverlayRenderer(),
  };
}

/** 依配置構建 ASR providers。 */
async function buildASRProviders(
  config: EngineConfig,
  apiKeyStore: ApiKeyStore
): Promise<Map<string, ASRProvider>> {
  const providers = new Map<string, ASRProvider>();

  if (config.asr.type === 'local-whisper') {
    const whisper = new LocalWhisperASR({
      modelTier: config.asr.modelTier ?? 'base',
      modelPath: config.asr.customModelPath,
    });
    providers.set(whisper.engineId, whisper);
  } else if (config.asr.type === 'cloud' && config.asr.endpoint) {
    const apiKey = (await apiKeyStore.getApiKey('asr')) ?? '';
    const cloud = new CloudASR({
      endpoint: config.asr.endpoint,
      apiKey,
      model: config.asr.modelTier,
    });
    providers.set(cloud.engineId, cloud);
  }

  return providers;
}

/** 依配置構建可用的翻譯引擎集合；密鑰從安全存儲解析。 */
async function buildTranslationProviders(
  config: EngineConfig,
  apiKeyStore: ApiKeyStore
): Promise<Map<string, TranslationProvider>> {
  const providers = new Map<string, TranslationProvider>();
  const tc = config.translation;

  const llm = await createLLM(tc, apiKeyStore);
  if (llm) providers.set(llm.engineId, llm);

  const mt = new MTTranslationProvider({
    // 演示字典；實際接入真實 MT 服務。
    hello: '你好',
    world: '世界',
    welcome: '歡迎',
  });
  providers.set('mt', mt);

  // 本地 ONNX 翻譯——type 選為 primary 或 fallbackType 為 'local-onnx' 時組裝。
  if (tc.type === 'local-onnx' || tc.fallbackType === 'local-onnx') {
    const localOnnx = new LocalONNXTranslationProvider({
      modelName: tc.localModelName ?? DEFAULT_LOCAL_TRANSLATION_MODEL,
      targetLang: config.targetLang,
      isPrimary: tc.type === 'local-onnx',
    });
    providers.set(localOnnx.engineId, localOnnx);
  }

  return providers;
}


/** 依翻譯配置構建 LLM 適配器；無端點/密鑰時返回 undefined（改由 MT 兜底）。 */
async function createLLM(
  tc: TranslationConfig,
  apiKeyStore: ApiKeyStore
): Promise<TranslationProvider | undefined> {
  if (tc.type !== 'cloud-llm' && tc.type !== 'local') return undefined;

  // 端點規範化：兼容 Base URL（/v1）與完整路徑（/v1/chat/completions）兩種填法。
  const endpoint = normalizeEndpoint(tc.endpoint);
  const model = tc.model ?? 'gpt-4o-mini';
  // 密鑰始終從安全存儲解析（apiKeyRef 僅為存在性標記，實際值不入配置對象）。
  const apiKey = (await apiKeyStore.getApiKey('llm')) ?? '';

  return new LLMTranslationProvider({
    engineId: tc.type === 'local' ? 'local-llm' : 'llm',
    endpoint,
    model,
    apiKey,
  });
}
