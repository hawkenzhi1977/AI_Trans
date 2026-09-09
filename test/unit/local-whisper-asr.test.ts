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

  it('transcribeStream M2-56：整塊 PCM 一次推理，結果為 final', async () => {
    // 先 warmup
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 模擬整塊推理結果（帶 chunks 時間戳）
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        text: 'full sentence',
        rtf: 0.25,
        chunks: [
          { text: 'full sentence', timestamp: [0.1, 2.5] },
        ],
      },
    });

    const chunk = makeChunk(1);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: true };
    const emitted: Array<{ segments: number; partial: boolean }> = [];

    await asr.transcribeStream(req, (r) => {
      emitted.push({ segments: r.segments.length, partial: r.isPartial });
    });

    // 應該只發送 1 次推理請求（整塊）
    const transcribeCalls = mockSendMessage.mock.calls.filter(
      (call) => call[0]?.topic === 'asr-whisper:transcribe'
    );
    expect(transcribeCalls).toHaveLength(1);

    // 結果為 final（非 partial），含 1 段
    expect(emitted).toHaveLength(1);
    expect(emitted[0].partial).toBe(false);
    expect(emitted[0].segments).toBe(1);
  });

  it('transcribeStream M2-56：無 chunks 時回退為單段 final', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 無 chunks 字段，僅有 text
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, text: 'fallback text', rtf: 0.3 },
    });

    const chunk = makeChunk(2);
    const req: ASRRequest = { chunk, hintLang: undefined, allowPartial: true };
    const emitted: Array<{ text: string; partial: boolean }> = [];

    await asr.transcribeStream(req, (r) => {
      emitted.push({ text: r.segments[0].sourceText, partial: r.isPartial });
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('fallback text');
    expect(emitted[0].partial).toBe(false);
  });

  it('transcribeStream M2-56：未 warmup 時拋錯', async () => {
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    // 不調用 warmup

    const chunk = makeChunk(3);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: true };

    await expect(asr.transcribeStream(req, () => {})).rejects.toThrow('not warmed up');
  });

  it('isReady() M2-56：warmup 前後狀態正確', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });

    // warmup 前
    expect(asr.isReady()).toBe(false);

    await asr.warmup(mockConfig);

    // warmup 後
    expect(asr.isReady()).toBe(true);
  });
});
