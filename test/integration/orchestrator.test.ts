import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../../src/application/orchestrator';
import type { PipelineEvent } from '../../src/domain/models/events';
import { DEFAULT_CONFIG } from '../../src/domain/models/config';
import type { SubtitleSegment } from '../../src/domain/models/subtitle';
import { buildTestRegistry } from '../support/test-registry';
import { MockYouTubeAdapter, staticTrack } from '../support/mock-youtube';
import { StubTranslationProvider } from '../support/stub-engines';
import type { TranslationProvider } from '../../src/domain/ports/translation-provider';
import { resetChromeMock } from '../support/setup-dom';
import { StubASRProvider } from '../support/stub-engines';
import type { ASRProvider } from '../../src/domain/ports/asr-provider';

function nativeSeg(i: number): SubtitleSegment {
  return {
    id: `n${i}`,
    start: i * 2000,
    end: (i + 1) * 2000,
    sourceText: `native line ${i}`,
    sourceLang: 'en',
    origin: 'native',
    provisional: false,
    revision: 0,
  };
}

const WATCH_URL = 'https://www.youtube.com/watch?v=abc123';

describe('Orchestrator 集成：原生字幕策略閉環', () => {
  beforeEach(() => resetChromeMock());

  it('選中 YouTube 平臺、抓原生字幕、翻譯、發 segments-ready', async () => {
    const platform = new MockYouTubeAdapter({
      tracks: [staticTrack('en', [nativeSeg(0), nativeSeg(1)])],
    });
    const registry = buildTestRegistry({ platforms: [platform] });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);

    const ready = events.find((e) => e.type === 'segments-ready');
    expect(ready).toBeDefined();
    const segs = (ready as { segments: SubtitleSegment[] }).segments;
    expect(segs).toHaveLength(2);
    // buildTestRegistry 的主引擎 llm 前綴 [llm]
    expect(segs[0].translatedText).toBe('[llm]native line 0');
    expect(segs[0].targetLang).toBe('zh-Hant');
    expect(orch.platformId).toBe('youtube');
  });

  it('無匹配平臺時發 engine-degraded', async () => {
    const registry = buildTestRegistry();
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      (e) => events.push(e)
    );

    await orch.start('https://vimeo.com/12345');
    expect(
      events.some((e) => e.type === 'engine-degraded' && /no platform adapter/.test(e.reason))
    ).toBe(true);
  });

  it('LLM 失敗時降級 MT 兜底，仍產出譯文', async () => {
    const platform = new MockYouTubeAdapter({
      tracks: [staticTrack('en', [nativeSeg(0)])],
    });
    const failingLlm = new StubTranslationProvider({ engineId: 'llm', failAlways: true });
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const registry = buildTestRegistry({
      platforms: [platform],
      translation: new Map<string, TranslationProvider>([
        ['llm', failingLlm],
        ['mt', mt],
      ]),
    });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);
    const ready = events.find((e) => e.type === 'segments-ready');
    const segs = (ready as { segments: SubtitleSegment[] }).segments;
    expect(segs[0].translatedText).toBe('[mt]native line 0');
    expect(events.some((e) => e.type === 'engine-degraded' || e.type === 'pipeline-error')).toBe(
      true
    );
  });

  it('type=local-onnx 時以 local-onnx 作為 primary 翻譯引擎', async () => {
    const platform = new MockYouTubeAdapter({
      tracks: [staticTrack('en', [nativeSeg(0)])],
    });
    const localOnnx = new StubTranslationProvider({
      engineId: 'local-onnx',
      prefix: '[onnx]',
      location: 'local',
    });
    const registry = buildTestRegistry({
      platforms: [platform],
      translation: new Map<string, TranslationProvider>([
        ['local-onnx', localOnnx],
        ['mt', new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' })],
      ]),
    });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      {
        registry,
        getConfig: async () => ({
          ...DEFAULT_CONFIG,
          translation: { type: 'local-onnx', fallbackType: 'mt' },
        }),
        enableAsr: false,
      },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);
    const ready = events.find((e) => e.type === 'segments-ready');
    const segs = (ready as { segments: SubtitleSegment[] }).segments;
    expect(segs[0].translatedText).toBe('[onnx]native line 0');
  });

  it('無字幕軌時降級（NativeCaptionStrategy 不適用）', async () => {
    const platform = new MockYouTubeAdapter({ tracks: [] });
    const registry = buildTestRegistry({ platforms: [platform] });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);
    // 無原生字幕 → 不應有 native 的 segments-ready
    const nativeReady = events.find((e) => e.type === 'segments-ready');
    expect(nativeReady).toBeUndefined();
  });

  it('stop 後可重新 start，platformId 正確重置', async () => {
    const platform = new MockYouTubeAdapter({
      tracks: [staticTrack('en', [nativeSeg(0)])],
    });
    const registry = buildTestRegistry({ platforms: [platform] });
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      () => {}
    );
    await orch.start(WATCH_URL);
    expect(orch.platformId).toBe('youtube');
    orch.stop();
    expect(orch.platformId).toBeNull();
  });
});

describe('Orchestrator 集成：M2 ASR 依賴注入（§5.6 不靜默）', () => {
  beforeEach(() => resetChromeMock());

  it('enableAsr=true 時 RealtimeASRStrategy 被注入依賴，ASR warmup 被調用', async () => {
    const asrStub = new StubASRProvider({ engineId: 'test-asr' });
    const asrMap = new Map<string, ASRProvider>([['test-asr', asrStub]]);
    const registry = buildTestRegistry({ asr: asrMap });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: true },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);
    // warmup 被調用（StubASRProvider.warmed 標記）。
    expect(asrStub.warmed).toBe(true);
    // 無原生字幕時，RealtimeASRStrategy 應被選中（isApplicable=true）。
    // 但 tabCaptureAuthorized 在測試環境默認未授權，策略會跳過 → 無 segments-ready。
    const ready = events.find((e) => e.type === 'segments-ready');
    expect(ready).toBeUndefined();
  });

  it('enableAsr=false 時 ASR 不預熱，RealtimeASRStrategy 不被注入', async () => {
    const asrStub = new StubASRProvider({ engineId: 'test-asr' });
    const asrMap = new Map<string, ASRProvider>([['test-asr', asrStub]]);
    const registry = buildTestRegistry({ asr: asrMap });
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: false },
      () => {}
    );

    await orch.start(WATCH_URL);
    // warmup 不被調用。
    expect(asrStub.warmed).toBe(false);
  });

  it('ASR warmup 失敗時發 engine-degraded 事件（§5.6 不靜默）', async () => {
    const failingAsr = new StubASRProvider({ engineId: 'failing-asr' });
    // 覆蓋 warmup 使其拋錯。
    failingAsr.warmup = async () => {
      throw new Error('warmup exploded');
    };
    const asrMap = new Map<string, ASRProvider>([['failing-asr', failingAsr]]);
    const registry = buildTestRegistry({ asr: asrMap });
    const events: PipelineEvent[] = [];
    const orch = new Orchestrator(
      { registry, getConfig: async () => DEFAULT_CONFIG, enableAsr: true },
      (e) => events.push(e)
    );

    await orch.start(WATCH_URL);
    // 等待 warmup 的 catch 回調。
    await new Promise((r) => setTimeout(r, 10));
    const degraded = events.find(
      (e) => e.type === 'engine-degraded' && e.port === 'asr'
    );
    expect(degraded).toBeDefined();
    expect((degraded as { reason: string }).reason).toContain('warmup exploded');
  });
});
