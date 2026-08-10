import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeASRStrategy } from '../../src/application/strategies/realtime-asr-strategy';
import type { AudioSourceProvider, AudioSourceHandle, AudioChunk } from '../../src/domain/models/audio';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import type { PlatformAdapter } from '../../src/domain/ports/platform-adapter';
import type { StrategyContext } from '../../src/domain/ports/caption-strategy';
import type { EngineConfig } from '../../src/domain/models/config';

function createMockChunk(seq = 0): AudioChunk {
  return {
    seq,
    startTime: seq * 5000,
    duration: 5000,
    sampleRate: 16_000,
    channels: 1,
    pcm: new Float32Array(80_000),
    isSpeech: true,
  };
}

function createMockContext(): StrategyContext {
  return {
    platform: {} as PlatformAdapter,
    playback: () => ({ currentTime: 0, playing: true, rate: 1, duration: 100, buffered: [] }),
    config: {
      asr: { type: 'local-whisper', modelTier: 'base', vadThreshold: 0.01 },
      targetLang: 'zh-Hant',
    } as EngineConfig,
    asr: {} as ASRProvider,
    translation: {} as TranslationProvider,
  };
}

describe('RealtimeASRStrategy — §5.4 資源清理', () => {
  let strategy: RealtimeASRStrategy;
  let mockAudioSource: AudioSourceProvider;
  let mockHandle: AudioSourceHandle;
  let mockASR: ASRProvider;
  let mockTranslation: TranslationProvider;
  let chunkCallback: ((chunk: AudioChunk) => void) | null = null;

  beforeEach(() => {
    strategy = new RealtimeASRStrategy();
    mockHandle = {
      kind: 'tab-capture',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mockAudioSource = {
      kind: 'tab-capture',
      open: vi.fn().mockResolvedValue(mockHandle),
      onChunk: vi.fn((cb) => { chunkCallback = cb; }),
    };
    mockASR = {
      engineId: 'test-asr',
      location: 'local',
      warmup: vi.fn().mockResolvedValue(undefined),
      transcribe: vi.fn().mockResolvedValue({
        segments: [{ id: '1', sourceText: 'hello', start: 0, end: 1000 }],
        isPartial: false,
        rtf: 0.5,
      }),
    };
    mockTranslation = {
      engineId: 'test-llm',
      location: 'cloud',
      translate: vi.fn().mockResolvedValue({
        engineId: 'test-llm',
        degraded: false,
        segments: [{ id: '1', sourceText: 'hello', translatedText: '你好', targetLang: 'zh-Hant', start: 0, end: 1000 }],
      }),
    };
    strategy.inject({
      audioSource: mockAudioSource,
      asrProvider: mockASR,
      translationProvider: mockTranslation,
      vadThreshold: 0.01,
    });
    chunkCallback = null;
  });

  it('stop() 調用 handle.stop() 關閉音頻源（避免視頻切換時 tabCapture 洩漏）', async () => {
    const ctx = createMockContext();
    const events: unknown[] = [];
    await strategy.run(ctx, (e) => events.push(e));
    expect(mockHandle.start).toHaveBeenCalledTimes(1);
    strategy.stop();
    expect(mockHandle.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() 後 async 回調不再 emit 事件（避免舊 ASR 字幕殘留）', async () => {
    const ctx = createMockContext();
    const events: unknown[] = [];
    await strategy.run(ctx, (e) => events.push(e));
    // 模擬 stop 後觸發 chunk 回調（在 async 操作完成前 running 已變 false）
    strategy.stop();
    // 等待 handle.stop() 的 fire-and-forget promise
    await new Promise((r) => setTimeout(r, 0));
    // 模擬 chunk 回調（stop 後 onChunk 可能仍被調用）
    if (chunkCallback) {
      chunkCallback(createMockChunk(1));
    }
    // 等待 async 操作完成
    await new Promise((r) => setTimeout(r, 10));
    // stop 後不應有新的 segments-ready 事件
    const segmentEvents = events.filter((e) =>
      (e as { type: string }).type === 'segments-ready' ||
      (e as { type: string }).type === 'segments-updated'
    );
    expect(segmentEvents).toHaveLength(0);
  });

  it('handle.stop() 失敗時落診斷但不拋錯', async () => {
    const ctx = createMockContext();
    const events: unknown[] = [];
    vi.spyOn(mockHandle, 'stop').mockRejectedValue(new Error('stop failed'));
    await strategy.run(ctx, (e) => events.push(e));
    // stop() 是同步的，handle.stop() 是 fire-and-forget
    strategy.stop();
    // 等待 fire-and-forget promise 完成
    await new Promise((r) => setTimeout(r, 10));
    // 不應拋錯到 unhandled rejection
  });
});
