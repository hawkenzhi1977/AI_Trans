// 單元測試：LocalWhisperASR 消息代理（M2-37）。
// 驗證 content-script 側的 LocalWhisperASR 正確轉發 warmup/transcribe 請求給 Offscreen Document。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalWhisperASR } from '../../src/adapters/asr/local-whisper';
import type { ASRConfig } from '../../src/domain/models/config';
import type { ASRRequest } from '../../src/domain/models/asr';
import type { AudioChunk } from '../../src/domain/models/audio';

// Mock chrome.runtime.sendMessage
const mockSendMessage = vi.fn();
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: mockSendMessage,
  },
});

function makeChunk(seq: number, durationMs = 5000): AudioChunk {
  return {
    seq,
    startTime: seq * durationMs,
    duration: durationMs,
    sampleRate: 16000,
    channels: 1,
    pcm: new Float32Array(80000), // 5s @ 16kHz
    isSpeech: true,
  };
}

const mockConfig: ASRConfig = {
  type: 'local-whisper',
  modelTier: 'base',
};

describe('LocalWhisperASR — M2-37 消息代理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warmup 轉發 asr-whisper:warmup 消息給 Offscreen', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    expect(mockSendMessage).toHaveBeenCalledWith({
      topic: 'asr-whisper:warmup',
      payload: { modelId: 'Xenova/whisper-base.en' },
    });
  });

  it('warmup 使用自定義 modelPath', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const asr = new LocalWhisperASR({ modelTier: 'base', modelPath: 'custom/model' });
    await asr.warmup(mockConfig);

    expect(mockSendMessage).toHaveBeenCalledWith({
      topic: 'asr-whisper:warmup',
      payload: { modelId: 'custom/model' },
    });
  });

  it('warmup 失敗時拋出錯誤', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: false, error: 'model not downloaded' } });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await expect(asr.warmup(mockConfig)).rejects.toThrow('ASR warmup failed');
  });

  it('warmup 網絡失敗時顯示網絡錯誤提示', async () => {
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: false, error: 'Failed to fetch' },
    });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    try {
      await asr.warmup(mockConfig);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('network error');
      expect((err as Error).message).toContain('選項頁面');
    }
  });

  it('transcribe 轉發 asr-whisper:transcribe 消息給 Offscreen', async () => {
    // 先 warmup
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 再 transcribe
    const mockResult = {
      ok: true,
      text: 'hello world',
      chunks: [{ text: 'hello world', timestamp: [0, 5] }],
      rtf: 0.5,
    };
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: mockResult });

    const chunk = makeChunk(1);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };
    const result = await asr.transcribe(req);

    expect(mockSendMessage).toHaveBeenLastCalledWith({
      topic: 'asr-whisper:transcribe',
      payload: {
        pcm: chunk.pcm,
        sampleRate: 16000,
        hintLang: 'en',
      },
    });
    expect(result.seq).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].sourceText).toBe('hello world');
    expect(result.rtf).toBe(0.5);
  });

  it('transcribe 未 warmup 時拋出錯誤', async () => {
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    const chunk = makeChunk(1);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };

    await expect(asr.transcribe(req)).rejects.toThrow('not warmed up');
  });

  it('transcribe 失敗時拋出錯誤', async () => {
    // 先 warmup
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 再 transcribe 失敗
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: false, error: 'inference failed' } });

    const chunk = makeChunk(1);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };

    await expect(asr.transcribe(req)).rejects.toThrow('transcribe failed');
  });

  it('transcribeStream 分段轉發推理請求', async () => {
    // 先 warmup
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 模擬 3 段推理結果
    mockSendMessage
      .mockResolvedValueOnce({ ok: true, result: { ok: true, text: 'part1', rtf: 0.3 } })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, text: 'part2', rtf: 0.3 } })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, text: 'part3', rtf: 0.3 } });

    const chunk = makeChunk(1);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: true };
    const emitted: Array<{ text: string; provisional: boolean }> = [];

    await asr.transcribeStream(req, (r) => {
      emitted.push({ text: r.segments[0].sourceText, provisional: r.isPartial });
    });

    // 應該發送 3 次推理請求
    const transcribeCalls = mockSendMessage.mock.calls.filter(
      (call) => call[0]?.topic === 'asr-whisper:transcribe'
    );
    expect(transcribeCalls).toHaveLength(3);

    // 前 2 段是 provisional，最後一段是 final
    expect(emitted).toHaveLength(3);
    expect(emitted[0].provisional).toBe(true);
    expect(emitted[1].provisional).toBe(true);
    expect(emitted[2].provisional).toBe(false);
  });
});
