import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeASRStrategy, alignSegmentsToVideoTimeline, filterEmptySegments, VAD_FALLBACK_SILENT_CHUNKS } from '../../src/application/strategies/realtime-asr-strategy';
import type { AudioSourceProvider, AudioSourceHandle, AudioChunk } from '../../src/domain/models/audio';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import type { PlatformAdapter } from '../../src/domain/ports/platform-adapter';
import type { StrategyContext } from '../../src/domain/ports/caption-strategy';
import type { EngineConfig } from '../../src/domain/models/config';
import type { SubtitleSegment } from '../../src/domain/models/subtitle';

// M2-58：mock 診斷模塊（passthrough + spy），供 VAD 兜底斷言 recordDiagnostic 調用。
vi.mock('../../src/infrastructure/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infrastructure/diagnostics')>();
  return {
    ...actual,
    recordDiagnostic: vi.fn(async (e: Parameters<typeof actual.recordDiagnostic>[0]) =>
      actual.recordDiagnostic(e)
    ),
  };
});
import { recordDiagnostic } from '../../src/infrastructure/diagnostics';

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

// M2-53：回歸測試——deps 未注入時 isApplicable 回傳 false 並記錄診斷。
describe('RealtimeASRStrategy — M2-53 deps 未注入回歸', () => {
  it('未調用 inject() 時 isApplicable 回傳 false 且診斷含 dependencies not injected', async () => {
    const strategy = new RealtimeASRStrategy();
    const diag: string[] = [];
    const ctx: StrategyContext = {
      platform: {} as never,
      playback: () => ({ currentTime: 0, playing: true, rate: 1, duration: 100, buffered: [] }),
      config: {
        asr: { type: 'local-whisper', modelTier: 'base' },
        targetLang: 'zh-Hant',
      } as EngineConfig,
      asr: {} as never,
      translation: {} as never,
      diagnostics: diag,
    };
    const result = await strategy.isApplicable(ctx);
    expect(result).toBe(false);
    expect(diag.some((d) => d.includes('dependencies not injected'))).toBe(true);
  });

  it('inject() 後 isApplicable 回傳 true（asr.type 非 none）', async () => {
    const strategy = new RealtimeASRStrategy();
    strategy.inject({
      audioSource: { kind: 'tab-capture', open: vi.fn(), onChunk: vi.fn() } as never,
      asrProvider: { engineId: 'test', location: 'local', warmup: vi.fn(), transcribe: vi.fn() } as never,
      translationProvider: { engineId: 'test', location: 'cloud', translate: vi.fn() } as never,
    });
    const diag: string[] = [];
    const ctx: StrategyContext = {
      platform: {} as never,
      playback: () => ({ currentTime: 0, playing: true, rate: 1, duration: 100, buffered: [] }),
      config: {
        asr: { type: 'local-whisper', modelTier: 'base' },
        targetLang: 'zh-Hant',
      } as EngineConfig,
      asr: {} as never,
      translation: {} as never,
      diagnostics: diag,
    };
    const result = await strategy.isApplicable(ctx);
    expect(result).toBe(true);
  });
});

// M2-58：時間軸對齊 + 空 segment 過濾（純函數）。
describe('M2-58 alignSegmentsToVideoTimeline / filterEmptySegments', () => {
  it('align：segment 時間戳加上 chunk 視頻起點（chunk-relative → video-absolute）', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: 'hello', start: 1000, end: 6000 },
      { id: '2', sourceText: 'world', start: 3000, end: 9000 },
    ];
    const aligned = alignSegmentsToVideoTimeline(segments, 5000);
    expect(aligned[0].start).toBe(6000);
    expect(aligned[0].end).toBe(11000);
    expect(aligned[1].start).toBe(8000);
    expect(aligned[1].end).toBe(14000);
    // 其餘字段保留。
    expect(aligned[0].sourceText).toBe('hello');
  });

  it('align：負偏移 clamp ≥0（播放狀態未觀察到時不產生負時間）', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: 'x', start: 50, end: 6050 },
    ];
    const aligned = alignSegmentsToVideoTimeline(segments, -100);
    expect(aligned[0].start).toBe(0);
    // M2-66：end 擴展至至少 start + MIN_DISPLAY_WINDOW_MS (5000)
    expect(aligned[0].end).toBeGreaterThanOrEqual(5000);
  });

  it('M2-66：短 segment（256ms）end 擴展至至少 5s 顯示窗口', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: '[MUSIC]', start: 0, end: 256 },
    ];
    const aligned = alignSegmentsToVideoTimeline(segments, 10000);
    expect(aligned[0].start).toBe(10000);
    // end 應擴展至至少 start + 5000 = 15000
    expect(aligned[0].end).toBeGreaterThanOrEqual(15000);
  });

  it('M2-66：長 segment（>5s）end 不被壓縮', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: 'long sentence here', start: 0, end: 8000 },
    ];
    const aligned = alignSegmentsToVideoTimeline(segments, 1000);
    expect(aligned[0].start).toBe(1000);
    // 原始 end = 9000 > start + 5000 = 6000，保持原值
    expect(aligned[0].end).toBe(9000);
  });

  it('align：空數組回傳空數組', () => {
    expect(alignSegmentsToVideoTimeline([], 1234)).toEqual([]);
  });

  it('filter：sourceText 與 translatedText 皆空 → 移除', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: '', start: 0, end: 100 },
      { id: '2', sourceText: '  ', translatedText: '', start: 100, end: 200 },
    ];
    expect(filterEmptySegments(segments)).toEqual([]);
  });

  it('filter：sourceText 非空 → 保留（即使無翻譯）', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: 'hello', start: 0, end: 100 },
    ];
    expect(filterEmptySegments(segments)).toHaveLength(1);
  });

  it('filter：sourceText 空但 translatedText 非空 → 保留', () => {
    const segments: SubtitleSegment[] = [
      { id: '1', sourceText: '', translatedText: '你好', start: 0, end: 100 },
    ];
    expect(filterEmptySegments(segments)).toHaveLength(1);
  });
});

// M2-58：策略級——VAD 兜底 + 時間軸對齊 + 空 segment 跳過。
describe('RealtimeASRStrategy — M2-58 VAD 兜底與時間軸對齊', () => {
  let strategy: RealtimeASRStrategy;
  let mockAudioSource: AudioSourceProvider;
  let mockHandle: AudioSourceHandle;
  let mockASR: ASRProvider;
  let mockTranslation: TranslationProvider;
  let chunkCallback: ((chunk: AudioChunk) => void) | null = null;

  /** 常幅 PCM chunk（rms = amplitude）。 */
  function makeChunk(seq: number, amplitude: number): AudioChunk {
    const pcm = new Float32Array(80_000);
    pcm.fill(amplitude);
    return { seq, startTime: 0, duration: 5000, sampleRate: 16_000, channels: 1, pcm, isSpeech: true };
  }

  function makeContext(currentTimeMs: number): StrategyContext {
    return {
      platform: {} as PlatformAdapter,
      playback: () => ({ currentTime: currentTimeMs, playing: true, rate: 1, duration: 100_000, buffered: [] }),
      config: {
        asr: { type: 'local-whisper', modelTier: 'base', vadThreshold: 0.01 },
        targetLang: 'zh-Hant',
      } as EngineConfig,
      asr: {} as ASRProvider,
      translation: {} as TranslationProvider,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
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
        segments: [{ id: '1', sourceText: 'hello', start: 1000, end: 2000 }],
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
        segments: [{ id: '1', sourceText: 'hello', translatedText: '你好', targetLang: 'zh-Hant', start: 1000, end: 2000 }],
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

  it('VAD 兜底：連續 N 塊全被過濾 → 落 vad-filtering-all 診斷並放寬閾值（低音量視頻不再永久靜音）', async () => {
    const ctx = makeContext(0);
    await strategy.run(ctx, () => {});

    // 餵入 VAD_FALLBACK_SILENT_CHUNKS 塊全零 PCM（rms=0 < 0.01）。
    for (let i = 0; i < VAD_FALLBACK_SILENT_CHUNKS; i++) {
      chunkCallback!(makeChunk(i, 0));
    }
    await new Promise((r) => setTimeout(r, 10));

    // §5.6：兜底必須落診斷（reason 含 vad-filtering-all）。
    const degradedCalls = (recordDiagnostic as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0]?.type === 'engine-degraded'
    );
    expect(degradedCalls.length).toBe(1);
    expect((degradedCalls[0][0] as { reason: string }).reason).toContain('vad-filtering-all');

    // 放寬後（0.01 → 0.005）：rms=0.006 的塊應通過 VAD → ASR 被調用。
    chunkCallback!(makeChunk(VAD_FALLBACK_SILENT_CHUNKS, 0.006));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockASR.transcribe).toHaveBeenCalledTimes(1);

    // 兜底單次（armed）：再餵 N 塊靜音不重複落診斷。
    for (let i = 0; i < VAD_FALLBACK_SILENT_CHUNKS; i++) {
      chunkCallback!(makeChunk(100 + i, 0));
    }
    await new Promise((r) => setTimeout(r, 10));
    const degradedCalls2 = (recordDiagnostic as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0]?.type === 'engine-degraded'
    );
    expect(degradedCalls2.length).toBe(1);
    strategy.stop();
  });

  it('時間軸對齊：ASR segment（chunk-relative）+ chunk 視頻起點 → segments-ready 為視頻絕對時間', async () => {
    // 視頻已播到 10s；chunk duration 5s → chunk 覆蓋 [5s, 10s]。
    const ctx = makeContext(10_000);
    const events: Array<{ type: string; segments?: SubtitleSegment[] }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    // rms=0.1 > 0.01 → 通過 VAD。
    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 10));

    const ready = events.find((e) => e.type === 'segments-ready');
    expect(ready).toBeDefined();
    // ASR 回傳 start=1000/end=2000（chunk-relative）+ chunkStart=5000 → 6000/7000。
    // M2-66：end 擴展至至少 start + MIN_DISPLAY_WINDOW_MS(5000) = 11000。
    expect(ready!.segments![0].start).toBe(6000);
    expect(ready!.segments![0].end).toBeGreaterThanOrEqual(11000);
    strategy.stop();
  });

  it('空 segment：ASR 回傳全空文本 → 不 emit segments-ready（避免空白 cue）', async () => {
    (mockASR.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      segments: [{ id: '1', sourceText: '', start: 0, end: 1000 }],
      isPartial: false,
      rtf: 0.5,
    });
    (mockTranslation.translate as ReturnType<typeof vi.fn>).mockResolvedValue({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: '1', sourceText: '', translatedText: '', targetLang: 'zh-Hant', start: 0, end: 1000 }],
    });
    const ctx = makeContext(10_000);
    const events: Array<{ type: string }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === 'segments-ready' || e.type === 'segments-updated')).toBe(false);
    strategy.stop();
  });

  it('stop() 重置 VAD 兜底狀態（restart 路徑不繼承舊會話的放寬/計數）', async () => {
    const ctx = makeContext(0);
    await strategy.run(ctx, () => {});
    // 觸發一次兜底。
    for (let i = 0; i < VAD_FALLBACK_SILENT_CHUNKS; i++) {
      chunkCallback!(makeChunk(i, 0));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(
      (recordDiagnostic as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0]?.type === 'engine-degraded'
      )
    ).toBe(true);

    // stop + 重新 run（模擬 restart；orchestrator 會重新 inject，此處直接驗證 stop 重置）。
    strategy.stop();
    vi.clearAllMocks();
    await strategy.run(ctx, () => {});

    // 新會話：餵入 N-1 塊靜音（未達兜底門檻）→ 不該有 engine-degraded。
    for (let i = 0; i < VAD_FALLBACK_SILENT_CHUNKS - 1; i++) {
      chunkCallback!(makeChunk(i, 0));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(
      (recordDiagnostic as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => c[0]?.type === 'engine-degraded'
      )
    ).toBe(false);
    strategy.stop();
  });

  // M2-64：極短文本（< 3 字符）跳過翻譯——避免 local-onnx 對 "um" 輸出 [BLANK AUDIO]。
  it('M2-64：ASR 返回極短文本（len < 3）→ 跳過翻譯不 emit', async () => {
    (mockASR.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      segments: [{ id: '1', sourceText: 'um', start: 0, end: 500 }],
      isPartial: false,
      rtf: 0.3,
    });
    const ctx = makeContext(10_000);
    const events: Array<{ type: string }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 10));

    // ASR 被調用但翻譯不被調用（極短文本跳過）。
    expect(mockASR.transcribe).toHaveBeenCalledTimes(1);
    expect(mockTranslation.translate).not.toHaveBeenCalled();
    // 無 segments-ready/updated 事件。
    expect(events.some((e) => e.type === 'segments-ready' || e.type === 'segments-updated')).toBe(false);
    strategy.stop();
  });

  // M2-64：正常長度文本（>= 3）→ 正常翻譯 + emit。
  it('M2-64：ASR 返回正常文本（len >= 3）→ 正常翻譯並 emit', async () => {
    (mockASR.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
      segments: [{ id: '1', sourceText: 'hello world', start: 0, end: 2000 }],
      isPartial: false,
      rtf: 0.5,
    });
    const ctx = makeContext(10_000);
    const events: Array<{ type: string }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockASR.transcribe).toHaveBeenCalledTimes(1);
    expect(mockTranslation.translate).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'segments-ready' || e.type === 'segments-updated')).toBe(true);
    strategy.stop();
  });
});

// M2-65：累計 emit——每次 emit 發送全量 segment（非僅當前 chunk）。
describe('RealtimeASRStrategy — M2-65 累計 emit', () => {
  let strategy: RealtimeASRStrategy;
  let mockAudioSource: AudioSourceProvider;
  let mockHandle: AudioSourceHandle;
  let mockASR: ASRProvider;
  let mockTranslation: TranslationProvider;
  let chunkCallback: ((chunk: AudioChunk) => void) | null = null;

  function makeChunk(seq: number, amplitude: number): AudioChunk {
    const pcm = new Float32Array(80_000);
    pcm.fill(amplitude);
    return { seq, startTime: 0, duration: 5000, sampleRate: 16_000, channels: 1, pcm, isSpeech: true };
  }

  function makeContext(currentTimeMs: number): StrategyContext {
    return {
      platform: {} as PlatformAdapter,
      playback: () => ({ currentTime: currentTimeMs, playing: true, rate: 1, duration: 100_000, buffered: [] }),
      config: {
        asr: { type: 'local-whisper', modelTier: 'base', vadThreshold: 0.01 },
        targetLang: 'zh-Hant',
      } as EngineConfig,
      asr: {} as ASRProvider,
      translation: {} as TranslationProvider,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
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
      transcribe: vi.fn(),
    };
    mockTranslation = {
      engineId: 'test-llm',
      location: 'cloud',
      translate: vi.fn(),
    };
    strategy.inject({
      audioSource: mockAudioSource,
      asrProvider: mockASR,
      translationProvider: mockTranslation,
      vadThreshold: 0.01,
    });
    chunkCallback = null;
  });

  it('M2-65 TC-4：第 2 次 emit 包含第 1 + 第 2 chunk 的 segments（累計）', async () => {
    const ctx = makeContext(0);
    const events: Array<{ type: string; segments?: SubtitleSegment[] }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    // 第 1 chunk：ASR 返回 segment id='a'
    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 0,
      segments: [{ id: 'a', sourceText: 'hello', start: 0, end: 1000, origin: 'realtime-asr', provisional: false, revision: 0 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'a', sourceText: 'hello', translatedText: '你好', start: 0, end: 1000 }],
    });

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 2 chunk：ASR 返回 segment id='b'
    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 1,
      segments: [{ id: 'b', sourceText: 'world', start: 0, end: 1000, origin: 'realtime-asr', provisional: false, revision: 0 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'b', sourceText: 'world', translatedText: '世界', start: 0, end: 1000 }],
    });

    chunkCallback!(makeChunk(1, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 收集 segments-ready/updated 事件
    const segEvents = events.filter((e) => e.type === 'segments-ready' || e.type === 'segments-updated');
    expect(segEvents.length).toBeGreaterThanOrEqual(2);

    // 第 1 次 emit：只有 segment 'a'
    const firstEmit = segEvents[0]!.segments!;
    expect(firstEmit).toHaveLength(1);
    expect(firstEmit[0].id).toBe('a');

    // 第 2 次 emit：包含 'a' + 'b'（累計）
    const secondEmit = segEvents[1]!.segments!;
    expect(secondEmit).toHaveLength(2);
    const ids = secondEmit.map((s) => s.id).sort();
    expect(ids).toEqual(['a', 'b']);

    strategy.stop();
  });

  it('M2-65 TC-5：provisional 修正覆蓋同 id segment（不重複）', async () => {
    const ctx = makeContext(0);
    const events: Array<{ type: string; segments?: SubtitleSegment[] }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    // 第 1 chunk：provisional（id='a', text='hel'）
    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 0,
      segments: [{ id: 'a', sourceText: 'hel', start: 0, end: 500, origin: 'realtime-asr', provisional: true, revision: 1 }],
      isPartial: true,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'a', sourceText: 'hel', translatedText: '你', start: 0, end: 500 }],
    });

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 2 chunk：final 修正（id='a', text='hello'）
    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 1,
      segments: [{ id: 'a', sourceText: 'hello', start: 0, end: 1000, origin: 'realtime-asr', provisional: false, revision: 2 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'a', sourceText: 'hello', translatedText: '你好', start: 0, end: 1000 }],
    });

    chunkCallback!(makeChunk(1, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    const segEvents = events.filter((e) => e.type === 'segments-ready' || e.type === 'segments-updated');
    // 最終 emit 只有 1 個 segment（id='a' 被覆蓋，不重複）
    const lastEmit = segEvents[segEvents.length - 1]!.segments!;
    expect(lastEmit).toHaveLength(1);
    expect(lastEmit[0].sourceText).toBe('hello');
    expect(lastEmit[0].translatedText).toBe('你好');

    strategy.stop();
  });

  it('M2-65 TC-6：stop() 清空累計緩衝（restart 後重新累積）', async () => {
    const ctx = makeContext(0);
    const events: Array<{ type: string; segments?: SubtitleSegment[] }> = [];
    await strategy.run(ctx, (e) => events.push(e as never));

    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 0,
      segments: [{ id: 'x', sourceText: 'test', start: 0, end: 1000, origin: 'realtime-asr', provisional: false, revision: 0 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'x', sourceText: 'test', translatedText: '測試', start: 0, end: 1000 }],
    });

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // stop 清空緩衝
    strategy.stop();

    // 重新 run（模擬 restart）
    const events2: Array<{ type: string; segments?: SubtitleSegment[] }> = [];
    await strategy.run(ctx, (e) => events2.push(e as never));

    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 0,
      segments: [{ id: 'y', sourceText: 'new', start: 0, end: 1000, origin: 'realtime-asr', provisional: false, revision: 0 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'y', sourceText: 'new', translatedText: '新', start: 0, end: 1000 }],
    });

    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // restart 後只有新 segment（舊 'x' 不在緩衝中）
    const segEvents2 = events2.filter((e) => e.type === 'segments-ready' || e.type === 'segments-updated');
    expect(segEvents2.length).toBeGreaterThanOrEqual(1);
    const lastEmit = segEvents2[segEvents2.length - 1]!.segments!;
    expect(lastEmit).toHaveLength(1);
    expect(lastEmit[0].id).toBe('y');

    strategy.stop();
  });
});

// M2-66：去重 + Backpressure。
describe('RealtimeASRStrategy — M2-66 去重與 Backpressure', () => {
  let strategy: RealtimeASRStrategy;
  let mockAudioSource: AudioSourceProvider;
  let mockHandle: AudioSourceHandle;
  let mockASR: ASRProvider;
  let mockTranslation: TranslationProvider;
  let chunkCallback: ((chunk: AudioChunk) => void) | null = null;

  function makeChunk(seq: number, amplitude: number): AudioChunk {
    const pcm = new Float32Array(80_000);
    pcm.fill(amplitude);
    return { seq, startTime: 0, duration: 5000, sampleRate: 16_000, channels: 1, pcm, isSpeech: true };
  }

  function makeContext(currentTimeMs: number): StrategyContext {
    return {
      platform: {} as PlatformAdapter,
      playback: () => ({ currentTime: currentTimeMs, playing: true, rate: 1, duration: 100_000, buffered: [] }),
      config: {
        asr: { type: 'local-whisper', modelTier: 'base', vadThreshold: 0.01 },
        targetLang: 'zh-Hant',
      } as EngineConfig,
      asr: {} as ASRProvider,
      translation: {} as TranslationProvider,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
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
      transcribe: vi.fn(),
    };
    mockTranslation = {
      engineId: 'test-llm',
      location: 'cloud',
      translate: vi.fn(),
    };
    strategy.inject({
      audioSource: mockAudioSource,
      asrProvider: mockASR,
      translationProvider: mockTranslation,
      vadThreshold: 0.01,
    });
    chunkCallback = null;
  });

  it('M2-66 TC-1：連續相同文本第 3 次起跳過翻譯（dedup）', async () => {
    const ctx = makeContext(0);
    await strategy.run(ctx, () => {});

    const asrResult = {
      seq: 0,
      segments: [{ id: 'd1', sourceText: '[MUSIC]', start: 0, end: 5000, origin: 'realtime-asr' as const, provisional: false, revision: 0 }],
      isPartial: false,
    };
    const transResult = {
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'd1', sourceText: '[MUSIC]', translatedText: '[音樂]', start: 0, end: 5000 }],
    };

    // 第 1 次：正常翻譯（consecutiveDuplicateCount=1）
    mockASR.transcribe!.mockResolvedValueOnce(asrResult);
    mockTranslation.translate!.mockResolvedValueOnce(transResult);
    chunkCallback!(makeChunk(0, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 2 次：相同文本（consecutiveDuplicateCount=2，仍翻譯）
    mockASR.transcribe!.mockResolvedValueOnce({ ...asrResult, seq: 1, segments: [{ ...asrResult.segments[0], id: 'd2' }] });
    mockTranslation.translate!.mockResolvedValueOnce({ ...transResult, segments: [{ ...transResult.segments[0], id: 'd2' }] });
    chunkCallback!(makeChunk(1, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 3 次：相同文本（consecutiveDuplicateCount=3 ≥ THRESHOLD → 跳過）
    mockASR.transcribe!.mockResolvedValueOnce({ ...asrResult, seq: 2, segments: [{ ...asrResult.segments[0], id: 'd3' }] });
    chunkCallback!(makeChunk(2, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 4 次：相同文本（consecutiveDuplicateCount=4 → 跳過）
    mockASR.transcribe!.mockResolvedValueOnce({ ...asrResult, seq: 3, segments: [{ ...asrResult.segments[0], id: 'd4' }] });
    chunkCallback!(makeChunk(3, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // translate 只被調用 2 次（第 1、2 次），第 3、4 次被 dedup 跳過
    expect(mockTranslation.translate).toHaveBeenCalledTimes(2);
    strategy.stop();
  });

  it('M2-66 TC-2：文本變化後重置 dedup 計數', async () => {
    const ctx = makeContext(0);
    await strategy.run(ctx, () => {});

    const transResult = (id: string, text: string) => ({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id, sourceText: text, translatedText: `譯${text}`, start: 0, end: 5000 }],
    });

    // 第 1-3 次：相同文本 "hello"（第 3 次觸發 dedup）
    for (let i = 0; i < 3; i++) {
      mockASR.transcribe!.mockResolvedValueOnce({
        seq: i,
        segments: [{ id: `h${i}`, sourceText: 'hello', start: 0, end: 5000, origin: 'realtime-asr' as const, provisional: false, revision: 0 }],
        isPartial: false,
      });
      mockTranslation.translate!.mockResolvedValueOnce(transResult(`h${i}`, 'hello'));
      chunkCallback!(makeChunk(i, 0.1));
      await new Promise((r) => setTimeout(r, 20));
    }

    // 第 4 次：不同文本 "world" → 重置計數，正常翻譯
    mockASR.transcribe!.mockResolvedValueOnce({
      seq: 3,
      segments: [{ id: 'w0', sourceText: 'world', start: 0, end: 5000, origin: 'realtime-asr' as const, provisional: false, revision: 0 }],
      isPartial: false,
    });
    mockTranslation.translate!.mockResolvedValueOnce(transResult('w0', 'world'));
    chunkCallback!(makeChunk(3, 0.1));
    await new Promise((r) => setTimeout(r, 20));

    // 第 5-7 次：再次 "world"（第 7 次觸發 dedup）
    for (let i = 4; i < 7; i++) {
      mockASR.transcribe!.mockResolvedValueOnce({
        seq: i,
        segments: [{ id: `w${i - 3}`, sourceText: 'world', start: 0, end: 5000, origin: 'realtime-asr' as const, provisional: false, revision: 0 }],
        isPartial: false,
      });
      mockTranslation.translate!.mockResolvedValueOnce(transResult(`w${i - 3}`, 'world'));
      chunkCallback!(makeChunk(i, 0.1));
      await new Promise((r) => setTimeout(r, 20));
    }

    // "hello" 翻譯 2 次（第 1、2；第 3 次 count=3≥THRESHOLD 跳過）
    // "world" 翻譯 2 次（第 4、5；第 6 次 count=3≥THRESHOLD 跳過）
    // 共 4 次
    expect(mockTranslation.translate).toHaveBeenCalledTimes(4);
    strategy.stop();
  });

  it('M2-66 TC-3：Backpressure——inflight ≥ MAX 時跳過新 chunk', async () => {
    const ctx = makeContext(0);
    await strategy.run(ctx, () => {});

    // 讓 ASR transcribe 延遲完成（模擬慢推理），使 inflight 計數保持
    let resolveASR: (v: unknown) => void;
    const asrPromise = new Promise((r) => { resolveASR = r; });

    mockASR.transcribe!.mockReturnValueOnce(asrPromise as never);
    mockTranslation.translate!.mockResolvedValue({
      engineId: 'test-llm',
      degraded: false,
      segments: [{ id: 'bp1', sourceText: 'slow', translatedText: '慢', start: 0, end: 5000 }],
    });

    // 第 1 chunk：開始 ASR（inflight=1）
    chunkCallback!(makeChunk(0, 0.1));
    // 第 2 chunk：開始 ASR（inflight=2 = MAX）
    chunkCallback!(makeChunk(1, 0.1));
    // 第 3 chunk：inflight=2 ≥ MAX → 跳過（不調用 transcribe）
    chunkCallback!(makeChunk(2, 0.1));
    await new Promise((r) => setTimeout(r, 10));

    // transcribe 只被調用 2 次（第 3 個被 backpressure 跳過）
    expect(mockASR.transcribe).toHaveBeenCalledTimes(2);

    // 解決 ASR promise 讓 inflight 歸零
    resolveASR!({ seq: 0, segments: [{ id: 'bp1', sourceText: 'slow text here', start: 0, end: 5000, origin: 'realtime-asr' as const, provisional: false, revision: 0 }], isPartial: false });
    await new Promise((r) => setTimeout(r, 20));

    strategy.stop();
  });
});
