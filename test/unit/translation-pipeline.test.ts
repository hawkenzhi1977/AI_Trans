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

  it('[R5] translateStream 的 primary.stream 拋錯時降級 fallback 並發降級事件', async () => {
    // primary 具備 translateStream 但會拋錯；驗證流式路徑也走 fallback（不只 translate 做降級）。
    const failingStream: import('../../src/domain/ports/translation-provider').TranslationProvider = {
      engineId: 'llm',
      location: 'cloud',
      translate: async () => {
        throw new Error('primary translate should not be reached before stream');
      },
      translateStream: async () => {
        throw new Error('stream boom');
      },
    };
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary: failingStream,
      fallback: mt,
      targetLang: 'zh-Hant',
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    const emitted: unknown[] = [];
    await pipeline.translateStream(req(), (r) => emitted.push(r));

    // 降級後由 fallback 產出結果並 emit
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { engineId: string }).engineId).toBe('mt');
    expect((emitted[0] as { degraded: boolean }).degraded).toBe(true);
    // 必發 engine-degraded + pipeline-error（觀測性與非流式一致）
    expect(events.some((e) => (e as { type: string }).type === 'engine-degraded')).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === 'pipeline-error')).toBe(true);
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

  it('translateStream 的 primary.stream 拋 AbortError 時不觸發 fallback，直接向上拋出', async () => {
    const abortingStream: import('../../src/domain/ports/translation-provider').TranslationProvider = {
      engineId: 'llm',
      location: 'cloud',
      translate: async () => { throw new Error('should not reach'); },
      translateStream: async () => {
        throw new DOMException('Translation aborted', 'AbortError');
      },
    };
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary: abortingStream,
      fallback: mt,
      targetLang: 'zh-Hant',
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    const emitted: unknown[] = [];
    await expect(pipeline.translateStream(req(), (r) => emitted.push(r))).rejects.toThrow('Translation aborted');
    // AbortError 不觸發 fallback
    expect(mt.calls).toBe(0);
    // 不發降級事件
    expect(events.some((e) => (e as { type: string }).type === 'engine-degraded')).toBe(false);
  });

  it('Fix A: primary 與 fallback 為相同引擎時跳過 fallback 直接拋錯', async () => {
    // 模擬 config.translation.type === 'local-onnx' 且 fallbackType === 'local-onnx'
    const primary = new StubTranslationProvider({ engineId: 'local-onnx', failAlways: true });
    const fallback = new StubTranslationProvider({ engineId: 'local-onnx', prefix: '[onnx-fallback]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary,
      fallback,
      targetLang: 'zh-Hant',
      onEvent: (e) => events.push(e),
    });

    await expect(pipeline.translate(req())).rejects.toThrow('injected failure');
    // fallback 不應被調用（相同引擎）
    expect(fallback.calls).toBe(0);
    // 跳過相同引擎時不發 engine-degraded（沒有實際降級發生）
    // 但會發 pipeline-error
    expect(events.some((e) => (e as { type: string }).type === 'pipeline-error')).toBe(true);
  });

  it('Fix B: translateStream 失敗時只嘗試不同引擎的 fallback，不重試 primary.translate()', async () => {
    let primaryTranslateCalls = 0;
    const failingStream: import('../../src/domain/ports/translation-provider').TranslationProvider = {
      engineId: 'local-onnx',
      location: 'local',
      translate: async () => {
        primaryTranslateCalls++;
        throw new Error('primary translate should not be called');
      },
      translateStream: async () => {
        throw new Error('stream failed after partial translation');
      },
    };
    const mt = new StubTranslationProvider({ engineId: 'mt', prefix: '[mt]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary: failingStream,
      fallback: mt,
      targetLang: 'zh-Hant',
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    const emitted: unknown[] = [];
    await pipeline.translateStream(req(), (r) => emitted.push(r));

    // primary.translate() 不應被調用（Fix B）
    expect(primaryTranslateCalls).toBe(0);
    // fallback（不同引擎）應被調用
    expect(mt.calls).toBe(1);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { engineId: string }).engineId).toBe('mt');
  });

  it('Fix B: translateStream 失敗且 fallback 為相同引擎時直接拋錯', async () => {
    const failingStream: import('../../src/domain/ports/translation-provider').TranslationProvider = {
      engineId: 'local-onnx',
      location: 'local',
      translate: async () => { throw new Error('should not reach'); },
      translateStream: async () => {
        throw new Error('stream failed');
      },
    };
    const sameEngineFallback = new StubTranslationProvider({ engineId: 'local-onnx', prefix: '[same]' });
    const events: unknown[] = [];
    const pipeline = new TranslationPipeline({
      primary: failingStream,
      fallback: sameEngineFallback,
      targetLang: 'zh-Hant',
      streaming: true,
      onEvent: (e) => events.push(e),
    });

    const emitted: unknown[] = [];
    await expect(pipeline.translateStream(req(), (r) => emitted.push(r))).rejects.toThrow('stream failed');
    // 相同引擎的 fallback 不應被調用
    expect(sameEngineFallback.calls).toBe(0);
  });
});
