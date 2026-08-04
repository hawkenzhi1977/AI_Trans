import { describe, it, expect } from 'vitest';
import { ASRPipeline } from '../../src/application/asr-pipeline';
import { StubASRProvider } from '../support/stub-engines';
import type { AudioChunk } from '../../src/domain/models/audio';
import type { ASRResult } from '../../src/domain/models/asr';

function chunk(seq: number, startTime = seq * 5000): AudioChunk {
  return {
    seq,
    startTime,
    duration: 5000,
    sampleRate: 16_000,
    channels: 1,
    pcm: new Float32Array(80_000),
    isSpeech: true,
  };
}

describe('ASRPipeline', () => {
  it('識別單個 chunk，返回有序段並發 metrics 事件', async () => {
    const stub = new StubASRProvider({ transcript: (seq) => `utterance-${seq}` });
    const events: unknown[] = [];
    const pipeline = new ASRPipeline({
      provider: stub,
      allowPartial: false,
      onEvent: (e) => events.push(e),
    });

    const segs = await pipeline.transcribe(chunk(3));
    expect(segs).toHaveLength(1);
    expect(segs[0].sourceText).toBe('utterance-3');
    expect(segs[0].start).toBe(15_000);
    expect(events.some((e) => (e as { type: string }).type === 'metrics')).toBe(true);
  });

  it('provider 無 transcribeStream 時流式退回普通識別', async () => {
    const stub = new StubASRProvider();
    const pipeline = new ASRPipeline({ provider: stub, allowPartial: true });
    const emitted: ASRResult[] = [];

    const finalSeqs = await pipeline.transcribeStream(chunk(1), (r) => emitted.push(r));
    expect(finalSeqs).toHaveLength(1);
    // 無 streaming 支持時，不發射 partial 結果（直接返回最終）
    expect(emitted).toHaveLength(0);
  });

  it('warmup 可在使用前調用', async () => {
    const stub = new StubASRProvider();
    await stub.warmup({ type: 'local-whisper', modelTier: 'tiny' });
    expect(stub.warmed).toBe(true);
  });
});
