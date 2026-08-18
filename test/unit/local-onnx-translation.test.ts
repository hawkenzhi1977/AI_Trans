import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalONNXTranslationProvider } from '../../src/adapters/translation/local-onnx-translation';
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

describe('LocalONNXTranslationProvider', () => {
  beforeEach(() => {
    // Mock chrome.runtime.sendMessage
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
      },
    });
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

  it('translateStream 退化為非流式 translate 並 emit 結果', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      translatedText: '翻譯結果 0\n翻譯結果 1',
    });

    const emitted: unknown[] = [];
    await provider.translateStream(req(), (r) => emitted.push(r));

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { engineId: string }).engineId).toBe('local-onnx');
    expect((emitted[0] as { degraded: boolean }).degraded).toBe(true);
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
});
