// 單元測試：LocalWhisperASR 消息代理（M2-37）。
// 驗證 content-script 側的 LocalWhisperASR 正確轉發 warmup/transcribe 請求給 Offscreen Document。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalWhisperASR } from '../../src/adapters/asr/local-whisper';
import type { ASRConfig } from '../../src/domain/models/config';
import type { ASRRequest } from '../../src/domain/models/asr';
import type { AudioChunk } from '../../src/domain/models/audio';
import { encodePcmFloat32 } from '../../src/infrastructure/pcm-encoding';

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

  it('M2-69：warmup 遇 single offscreen 錯誤 → ensure-created + 重試成功', async () => {
    // 第一次 warmup：SW 回傳 single offscreen 錯誤（result.ok=false）。
    mockSendMessage.mockResolvedValueOnce({
      ok: false,
      error: 'asr-whisper operation failed: Only a single offscreen document may be created.',
    });
    // 第二次：offscreen:ensure-created → ok。
    mockSendMessage.mockResolvedValueOnce({ ok: true });
    // 第三次：重試 warmup → 成功。
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await expect(asr.warmup(mockConfig)).resolves.toBeUndefined();

    // 共發送 3 次：warmup(失敗) → ensure-created → warmup(重試成功)。
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, { topic: 'offscreen:ensure-created' });
    expect(mockSendMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ topic: 'asr-whisper:warmup' })
    );
  });

  it('M2-69：warmup 遇 single offscreen 錯誤 → 重試仍失敗 → 拋錯', async () => {
    // 第一次 warmup：single offscreen 錯誤。
    mockSendMessage.mockResolvedValueOnce({
      ok: false,
      error: 'asr-whisper operation failed: Only a single offscreen document may be created.',
    });
    // ensure-created → ok。
    mockSendMessage.mockResolvedValueOnce({ ok: true });
    // 重試 warmup → 仍失敗（非 single offscreen）。
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: false, error: 'model not downloaded' } });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await expect(asr.warmup(mockConfig)).rejects.toThrow('ASR warmup failed');
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
  });

  it('M2-69：warmup 一般失敗（非 single offscreen）→ 不重試直接拋錯', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: false, error: 'model not downloaded' } });

    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await expect(asr.warmup(mockConfig)).rejects.toThrow('ASR warmup failed');
    // 只發送一次（無 ensure-created / 無重試）。
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
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
        pcm: encodePcmFloat32(chunk.pcm),
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

  // ─── M2-57：響應雙格式兼容 + 超時保護 ───────────────────────────────

  it('M2-57：transcribe 兼容 SW 包裝格式 { ok, result }', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // SW 包裝格式：{ ok: true, result: { type, ok, text, chunks } }
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        type: 'asr-whisper:transcribe-result',
        ok: true,
        text: 'sw wrapped',
        chunks: [{ text: 'sw wrapped', timestamp: [0, 3] }],
        rtf: 0.4,
      },
    });

    const chunk = makeChunk(10);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };
    const result = await asr.transcribe(req);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].sourceText).toBe('sw wrapped');
  });

  it('M2-57：transcribe 兼容 offscreen 裸廣播格式（頂層 ok/text/chunks）', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // Offscreen 裸廣播格式：直接是 AsrTranscribeResponse（無 result 包裝）
    mockSendMessage.mockResolvedValueOnce({
      type: 'asr-whisper:transcribe-result',
      ok: true,
      text: 'raw broadcast',
      chunks: [{ text: 'raw broadcast', timestamp: [0, 2] }],
      rtf: 0.3,
    });

    const chunk = makeChunk(11);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };
    const result = await asr.transcribe(req);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].sourceText).toBe('raw broadcast');
  });

  it('M2-57：transcribeStream 兼容 offscreen 裸廣播格式', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 裸廣播格式（無 result 包裝）
    mockSendMessage.mockResolvedValueOnce({
      type: 'asr-whisper:transcribe-result',
      ok: true,
      text: 'stream raw',
      chunks: [{ text: 'stream raw', timestamp: [0.5, 4.0] }],
      rtf: 0.2,
    });

    const chunk = makeChunk(12);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: true };
    const emitted: Array<{ text: string }> = [];

    await asr.transcribeStream(req, (r) => {
      emitted.push({ text: r.segments[0].sourceText });
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('stream raw');
  });

  it('M2-57：transcribe 超時時拋出 timeout 錯誤', async () => {
    vi.useFakeTimers();
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 模擬 sendMessage 永遠不 resolve（掛起）
    mockSendMessage.mockImplementationOnce(
      () => new Promise(() => {})
    );

    const chunk = makeChunk(13);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };
    const promise = asr.transcribe(req);

    // 推進超時（M2-64：120s）——先 attach catch 避免 unhandled rejection
    const result = promise.then(
      () => { throw new Error('should have rejected'); },
      (err: Error) => err
    );

    await vi.advanceTimersByTimeAsync(121_000);
    const err = await result;
    expect(err.message).toContain('timeout');
    vi.useRealTimers();
  });

  it('M2-57/M2-63：transcribeStream 超時時拋出 timeout 錯誤', async () => {
    vi.useFakeTimers();
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 模擬掛起
    mockSendMessage.mockImplementationOnce(
      () => new Promise(() => {}) // 永不 resolve
    );

    const chunk = makeChunk(14);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: true };
    const promise = asr.transcribeStream(req, () => {});

    // 先 attach catch 避免 unhandled rejection
    const result = promise.then(
      () => { throw new Error('should have rejected'); },
      (err: Error) => err
    );

    await vi.advanceTimersByTimeAsync(121_000);
    const err = await result;
    expect(err.message).toContain('timeout');
    vi.useRealTimers();
  });

  // M2-64：串行化後排隊+推理=90s 不超時（120s 閾值內）。
  it('M2-64：transcribe 在 120s 內完成 → 不超時', async () => {
    vi.useFakeTimers();
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base' });
    await asr.warmup(mockConfig);

    // 模擬 90s 後才響應（排隊 ~20s + 推理 ~70s）——用 fake timer 可推進的 setTimeout。
    mockSendMessage.mockImplementationOnce(
      () => new Promise((resolve) => {
        vi.advanceTimersByTime(90_000);
        resolve({ ok: true, result: { ok: true, text: 'hello' } });
      })
    );

    const chunk = makeChunk(15);
    const req: ASRRequest = { chunk, hintLang: 'en', allowPartial: false };
    const promise = asr.transcribe(req);
    // 推進超時窗口（120s）——90s < 120s → 不超時。
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await promise;
    expect(result.segments[0].sourceText).toBe('hello');
    vi.useRealTimers();
  });

  // M2-60：多語言模型檔位映射。
  it('M2-60: base-multi 檔位映射到 Xenova/whisper-base（多語言）', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'base-multi' });
    await asr.warmup(mockConfig);

    // 斷言 warmup 消息的 modelId 為多語言變體（非 .en）。
    const warmupCall = mockSendMessage.mock.calls.find(
      (c) => c[0]?.topic === 'asr-whisper:warmup'
    );
    expect(warmupCall?.[0].payload.modelId).toBe('Xenova/whisper-base');
  });

  it('M2-60: tiny-multi 檔位映射到 Xenova/whisper-tiny（多語言）', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'tiny-multi' });
    await asr.warmup(mockConfig);

    const warmupCall = mockSendMessage.mock.calls.find(
      (c) => c[0]?.topic === 'asr-whisper:warmup'
    );
    expect(warmupCall?.[0].payload.modelId).toBe('Xenova/whisper-tiny');
  });

  it('M2-60: small-multi 檔位映射到 Xenova/whisper-small（多語言）', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'small-multi' });
    await asr.warmup(mockConfig);

    const warmupCall = mockSendMessage.mock.calls.find(
      (c) => c[0]?.topic === 'asr-whisper:warmup'
    );
    expect(warmupCall?.[0].payload.modelId).toBe('Xenova/whisper-small');
  });

  it('M2-60: 未知檔位回退到 base（.en）', async () => {
    mockSendMessage.mockResolvedValueOnce({ ok: true, result: { ok: true } });
    const asr = new LocalWhisperASR({ modelTier: 'unknown-tier' });
    await asr.warmup(mockConfig);

    const warmupCall = mockSendMessage.mock.calls.find(
      (c) => c[0]?.topic === 'asr-whisper:warmup'
    );
    expect(warmupCall?.[0].payload.modelId).toBe('Xenova/whisper-base.en');
  });
});
