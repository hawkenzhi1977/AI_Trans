import { CaptionStrategyChain } from './caption-strategy-chain';
import type { PipelineEvent } from '../domain/models/events';
import type { EngineConfig } from '../domain/models/config';
import type { PlaybackState } from '../domain/models/playback';
import type { ASRProvider } from '../domain/ports/asr-provider';
import type { StrategyContext } from '../domain/ports/caption-strategy';
import type { Registry } from './registry';
import { selectPlatform } from './registry';
import { TranslationPipeline } from './translation-pipeline';
import { RealtimeASRStrategy } from './strategies/realtime-asr-strategy';

/** ASR 未啟用時的空實現，保證 StrategyContext.asr 端口可空。 */
class NoopASR implements ASRProvider {
  static readonly instance = new NoopASR();
  readonly engineId = 'noop';
  readonly location = 'local' as const;
  async warmup(): Promise<void> {}
  async transcribe(): Promise<never> {
    throw new Error('ASR not enabled');
  }
}

export interface OrchestratorDeps {
  registry: Registry;
  getConfig: () => Promise<EngineConfig>;
  /** 是否啟用 ASR（M2 起；M1 中 false）。 */
  enableAsr: boolean;
}

/**
 * 總調度——選擇平台與策略鏈，組裝管線，推送渲染事件。
 * M1 範圍：平台適配 + 原生字幕策略 + 翻譯管線 + 渲染。
 */
export class Orchestrator {
  private chain: CaptionStrategyChain | null = null;
  private currentPlatformId: string | null = null;
  private readonly cleanups: Array<() => void> = [];
  private lastPlayback: PlaybackState = {
    currentTime: 0,
    playing: false,
    rate: 1,
    duration: 0,
    buffered: [],
  };

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly onEvent: (e: PipelineEvent) => void
  ) {}

  /** 在給定頁面啟動翻譯字幕流程。 */
  async start(url: string): Promise<void> {
    this.stop();
    const platform = selectPlatform(this.deps.registry, url);
    if (!platform) {
      this.onEvent({
        type: 'engine-degraded',
        port: 'translation',
        reason: `no platform adapter matches ${url}`,
      });
      return;
    }
    this.currentPlatformId = platform.platformId;

    const config = await this.deps.getConfig();

    // 組裝翻譯管線：主 LLM/本地/ONNX + 兜底 MT 或 local-onnx（依配置）。
    const primary = this.deps.registry.translation.get(
      config.translation.type === 'local-onnx'
        ? 'local-onnx'
        : config.translation.type === 'cloud-llm'
          ? 'llm'
          : config.translation.type === 'local'
            ? 'local-llm'
            : 'mt'
    );
    // fallback 引擎選擇：local-onnx > mt > undefined。
    let fallback;
    if (config.translation.fallbackType === 'local-onnx') {
      fallback = this.deps.registry.translation.get('local-onnx');
    } else if (config.translation.fallbackType === 'mt') {
      fallback = this.deps.registry.translation.get('mt');
    }
    if (!primary) {
      this.onEvent({
        type: 'engine-degraded',
        port: 'translation',
        reason: `primary translation engine "${config.translation.type}" not registered`,
      });
      return;
    }

    const translationPipeline = new TranslationPipeline({
      primary,
      fallback,
      targetLang: config.targetLang,
      streaming: config.performanceProfile === 'streaming',
      onEvent: this.onEvent,
    });

    // M2-24 補充修復十三：預熱翻譯引擎——local-onnx 模型載入記憶體需 30-60s，
    // 若不預熱，首次翻譯首塊 request 會超時被拒（此前「字幕卡 71s」根因）。
    // 非阻塞（void）：warmup 失敗不阻止策略啟動，由 degraded 事件告知用戶。
    if (primary.warmup) {
      void primary.warmup().catch((err) => {
        this.onEvent({
          type: 'engine-degraded',
          port: 'translation',
          reason: `Translation warmup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }

    // 組裝 ASR 上下文（M2 起啟用；M1 用 no-op 保證端口可空實現）。
    const asrProvider: ASRProvider = this.deps.enableAsr
      ? (this.deps.registry.asr.values().next().value ?? NoopASR.instance)
      : NoopASR.instance;

    // M2 修復：注入 RealtimeASRStrategy 依賴並預熱 ASR。
    const realtimeStrategy = this.deps.registry.strategies.find(
      (s): s is RealtimeASRStrategy => s instanceof RealtimeASRStrategy
    );
    if (realtimeStrategy && this.deps.enableAsr && asrProvider !== NoopASR.instance) {
      const audioSource = this.deps.registry.audioSources.get('tab-capture');
      if (audioSource) {
        realtimeStrategy.inject({
          audioSource,
          asrProvider,
          translationProvider: translationPipeline,
          vadThreshold: config.asr.vadThreshold,
        });
        // 預熱 ASR 模型（消除首次推理抖動）。
        void asrProvider.warmup(config.asr).catch((err) => {
          this.onEvent({
            type: 'engine-degraded',
            port: 'asr',
            reason: `ASR warmup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      }
    }

    // 監聽播放狀態，供策略與渲染使用。
    const unsubscribe = platform.observePlayback((state) => {
      this.lastPlayback = state;
    });
    this.cleanups.push(unsubscribe);

    const ctx: StrategyContext = {
      platform,
      playback: () => this.lastPlayback,
      config,
      asr: asrProvider,
      translation: translationPipeline,
    };

    this.chain = new CaptionStrategyChain(
      this.deps.registry.strategies,
      this.onEvent
    );
    await this.chain.runWithFallback(ctx);
  }

  /** 停止當前策略與資源。 */
  stop(): void {
    this.chain?.stopAll();
    this.chain = null;
    this.currentPlatformId = null;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  get platformId(): string | null {
    return this.currentPlatformId;
  }
}
