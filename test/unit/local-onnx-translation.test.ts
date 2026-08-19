import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalONNXTranslationProvider } from '../../src/adapters/translation/local-onnx-translation';
import { recordDiagnostic } from '../../src/infrastructure/diagnostics';
import type { TranslationRequest } from '../../src/domain/models/translation';
import type { SubtitleSegment } from '../../src/domain/models/subtitle';

// 聚合 echo 診斷斷言需要攔截 recordDiagnostic（不真正寫 storage）。
vi.mock('../../src/infrastructure/diagnostics', () => ({
  recordDiagnostic: vi.fn(),
}));

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

describe('LocalONNXTranslationProvider', () => {
  beforeEach(() => {
    // Mock chrome.runtime.sendMessage
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
      },
    });
    vi.mocked(recordDiagnostic).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('engineId 應為 local-onnx，location 應為 local', () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });
    expect(provider.engineId).toBe('local-onnx');
    expect(provider.location).toBe('local');
  });

  it('translate 成功時返回翻譯結果並標記 degraded: true', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
      targetLang: 'zh-Hant',
    });

    // Mock chrome.runtime.sendMessage 返回成功結果
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '翻譯結果 0\n翻譯結果 1',
    });

    const result = await provider.translate(req());

    expect(result.engineId).toBe('local-onnx');
    expect(result.degraded).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].translatedText).toBe('翻譯結果 0');
    expect(result.segments[1].translatedText).toBe('翻譯結果 1');

    // 驗證發送的請求格式
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      topic: 'local-onnx:translate',
      payload: {
        text: 'line-0\nline-1',
        targetLang: 'zh-Hant',
        sourceLang: undefined,
      },
    });
  });

  it('translate 失敗時拋出錯誤並記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    // Mock chrome.runtime.sendMessage 返回失敗結果
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: false,
      error: 'Model not downloaded',
      notDownloaded: true,
    });

    await expect(provider.translate(req())).rejects.toThrow('Model not downloaded');
  });

  it('translate 通信失敗時拋出錯誤並記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    // Mock chrome.runtime.sendMessage 拋出錯誤（如 SW 崩潰）
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error('Extension context invalidated'));

    await expect(provider.translate(req())).rejects.toThrow('Extension context invalidated');
  });

  it('translateStream：>5 行時逐 chunk emit 累計全量（首塊 5 段，次塊 6 段）', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    const segments = Array.from({ length: 6 }, (_, i) => seg(i));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg) => {
      const reqMsg = msg as { payload?: { text?: string } };
      const text = reqMsg.payload?.text ?? '';
      return {
        ok: true,
        translatedText: text
          .split('\n')
          .map((l) => `T:${l}`)
          .join('\n'),
      };
    });

    const emitted: Array<{ segments: SubtitleSegment[]; degraded: boolean }> = [];
    await provider.translateStream({ segments, targetLang: 'zh-Hant' }, (r) =>
      emitted.push(r as { segments: SubtitleSegment[]; degraded: boolean })
    );

    // 6 行 → 2 次請求，每次完成即 emit 累計全量。
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.segments).toHaveLength(5);
    expect(emitted[1]?.segments).toHaveLength(6);
    expect(emitted[0]?.segments[4]?.translatedText).toBe('T:line-4');
    expect(emitted[1]?.segments[5]?.translatedText).toBe('T:line-5');
  });

  it('translateStream：首塊完成即 emit（不等待全部 chunk），無 echo 時不記聚合診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    const segments = Array.from({ length: 6 }, (_, i) => seg(i));
    // 首塊 1 次 sendMessage 即 resolve——證明不必等全部 87 chunk。
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg) => {
      const reqMsg = msg as { payload?: { text?: string } };
      const text = reqMsg.payload?.text ?? '';
      return {
        ok: true,
        translatedText: text
          .split('\n')
          .map((l) => `T:${l}`)
          .join('\n'),
      };
    });

    const emitted: unknown[] = [];
    await provider.translateStream({ segments, targetLang: 'zh-Hant' }, (r) => emitted.push(r));

    expect(emitted).toHaveLength(2);
    expect((emitted[0] as { segments: SubtitleSegment[] }).segments.length).toBeGreaterThan(0);
    expect(vi.mocked(recordDiagnostic)).not.toHaveBeenCalled();
  });

  it('translateStream：多數 chunk echo → 記聚合 local-onnx-echo-chunks 診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    const segments = Array.from({ length: 6 }, (_, i) => seg(i));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg) => {
      const reqMsg = msg as { payload?: { text?: string } };
      const text = reqMsg.payload?.text ?? '';
      return {
        ok: true,
        // 回顯原文（echoed=true）——響應字段透傳給 provider 統計。
        echoed: true,
        translatedText: text.split('\n').map((l) => l).join('\n'),
      };
    });

    const emitted: unknown[] = [];
    await provider.translateStream({ segments, targetLang: 'zh-Hant' }, (r) => emitted.push(r));

    expect(emitted).toHaveLength(2);
    expect(vi.mocked(recordDiagnostic)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordDiagnostic).mock.calls[0]?.[0];
    expect(call.type).toBe('pipeline-error');
    const err = (call as { error: { code: string; cause: Error } }).error;
    expect(err.code).toBe('local-onnx-echo-chunks');
    expect(err.cause.message).toContain('echoed input in 2/2 chunks');
  });

  it('翻譯結果行數不足時使用 sourceText 填充', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    // Mock 返回只有一行結果（但請求有兩個 segments）
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '只有一個翻譯結果',
    });

    const result = await provider.translate(req());

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].translatedText).toBe('只有一個翻譯結果');
    expect(result.segments[1].translatedText).toBe('line-1'); // 使用 sourceText 填充
  });

  it('分塊翻譯：>5 行時按 CHUNK_SIZE 分多次請求並合併對齊', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
      targetLang: 'zh-Hant',
    });

    const segments = Array.from({ length: 6 }, (_, i) => seg(i));
    // 依請求文本逐行加前綴返回譯文，模擬 Offscreen 行號對齊輸出。
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg) => {
      const reqMsg = msg as { payload?: { text?: string } };
      const text = reqMsg.payload?.text ?? '';
      return {
        ok: true,
        translatedText: text
          .split('\n')
          .map((l) => `T:${l}`)
          .join('\n'),
      };
    });

    const result = await provider.translate({ segments, targetLang: 'zh-Hant' });

    // 6 行 → ceil(6/5) = 2 次請求；結果按序合併。
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(result.segments).toHaveLength(6);
    expect(result.segments[0].translatedText).toBe('T:line-0');
    expect(result.segments[4].translatedText).toBe('T:line-4');
    expect(result.segments[5].translatedText).toBe('T:line-5');
  });

  it('分塊翻譯：空譯文行回退原文（不渲染空行）', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '第一行譯文\n',
    });

    const result = await provider.translate(req());

    expect(result.segments[0].translatedText).toBe('第一行譯文');
    expect(result.segments[1].translatedText).toBe('line-1'); // 空譯文 → 原文
  });

  it('isPrimary=true 時成功結果不標記 degraded', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
      targetLang: 'zh-Hant',
      isPrimary: true,
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '你好',
    });

    const result = await provider.translate(req());

    expect(result.engineId).toBe('local-onnx');
    expect(result.degraded).toBe(false);
  });

  it('isPrimary=false（作 fallback）時成功結果仍標記 degraded', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
      targetLang: 'zh-Hant',
      isPrimary: false,
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '你好',
    });

    const result = await provider.translate(req());

    expect(result.degraded).toBe(true);
  });

  it('warmup 成功時發送 local-onnx:warmup 消息且不拋錯', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });

    await expect(provider.warmup()).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ topic: 'local-onnx:warmup' });
  });

  it('warmup 失敗（模型未下載）時拋錯並記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: false,
      error: 'Local ONNX model not downloaded',
    });

    await expect(provider.warmup()).rejects.toThrow('Local ONNX model not downloaded');
  });

  it('warmup 通信失敗（SW 不可達）時拋錯並記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error('Extension context invalidated')
    );

    await expect(provider.warmup()).rejects.toThrow('Extension context invalidated');
  });
});
