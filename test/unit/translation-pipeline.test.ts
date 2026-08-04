import { describe, it, expect } from 'vitest';
import { TranslationPipeline } from '../../src/application/translation-pipeline';
import { StubTranslationProvider } from '../support/stub-engines';
import type { TranslationRequest } from '../../src/domain/models/translation';
import type { SubtitleSegment } from '../../src/domain/models/subtitle';

function seg(i: number): SubtitleSegment {
  return {
    id: `s${i}`,
    start: i * 1000,
    end: (i + 1) * 1000,
    sourceText: `line-${i}`,
    origin: 'native',
    provisional: false,
    revision: 0,
  };
}

function req(): TranslationRequest {
  return { segments: [seg(0), seg(1)], targetLang: 'zh-Hant' };
}

describe('TranslationPipeline', () => {
  it('primary 正常時直接返回，無 degraded 標記', async () => {
    const llm = new StubTranslationProvider({ engineId: 'llm', prefix: '[llm]' });
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const pipeline = new TranslationPipeline({
      primary: llm,
      fallback: mt,
      targetLang: 'zh-Hant',
    });

    const result = await pipeline.translate(req());
    expect(result.engineId).toBe('llm');
    expect(result.degraded).toBe(false);
    expect(result.segments[0].translatedText).toBe('[llm]line-0');
    expect(llm.calls).toBe(1);
    expect(mt.calls).toBe(0);
  });

  it('primary 失敗時降級到 fallback，標記 degraded 並回填 sourceText', async () => {
    const llm = new StubTranslationProvider({ engineId: 'llm', failAlways: true });
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary: llm,
      fallback: mt,
      targetLang: 'zh-Hant',
      onEvent: (e) => events.push(e),
    });

    const result = await pipeline.translate(req());
    expect(result.engineId).toBe('mt');
    expect(result.degraded).toBe(true);
    expect(result.segments[0].translatedText).toBe('[mt]line-0');
    // 應發 engine-degraded 與 pipeline-error 兩個事件
    expect(events.some((e) => (e as { type: string }).type === 'engine-degraded')).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === 'pipeline-error')).toBe(true);
  });

  it('primary 失敗且無 fallback 時向上拋錯', async () => {
    const llm = new StubTranslationProvider({ engineId: 'llm', failAlways: true });
    const pipeline = new TranslationPipeline({
      primary: llm,
      fallback: undefined,
      targetLang: 'zh-Hant',
    });

    await expect(pipeline.translate(req())).rejects.toThrow('injected failure');
  });

  it('translateStream 無 primary.stream 時退回落為整體 translate', async () => {
    const llm = new StubTranslationProvider({ engineId: 'llm', prefix: '[llm]' });
    const pipeline = new TranslationPipeline({
      primary: llm,
      targetLang: 'zh-Hant',
      streaming: true,
    });
    const emitted: unknown[] = [];
    await pipeline.translateStream(req(), (r) => emitted.push(r));

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { segments: SubtitleSegment[] }).segments[0].translatedText).toBe(
      '[llm]line-0'
    );
  });

  it('未指定 targetLang 時使用管線默認值', async () => {
    const llm = new StubTranslationProvider({ engineId: 'llm' });
    const pipeline = new TranslationPipeline({
      primary: llm,
      targetLang: 'ja',
    });
    const result = await pipeline.translate({ segments: [seg(0)], targetLang: 'zh-Hant' });
    expect(result.segments[0].targetLang).toBe('zh-Hant');
  });
});
