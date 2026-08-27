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

/** 創建 mock port，支持消息監聽和響應模擬 */
function createMockPort() {
  const listeners: Array<(msg: unknown) => void> = [];
  const port = {
    postMessage: vi.fn((msg: unknown) => {
      // 異步模擬響應（避免同步調用棧問題）
      setTimeout(() => {
        const msgObj = msg as { topic?: string; messageId?: string; payload?: { text?: string } };
        // 根據請求生成響應
        let response: unknown;
        if (msgObj.topic === 'local-onnx:translate') {
          const text = msgObj.payload?.text ?? '';
          response = {
            messageId: msgObj.messageId,
            result: {
              ok: true,
              translatedText: text
                .split('\n')
                .map((l) => `T:${l}`)
                .join('\n'),
            },
          };
        }
        // 觸發所有監聽器
        for (const listener of listeners) {
          listener(response);
        }
      }, 0);
    }),
    onMessage: {
      addListener: vi.fn((listener: (msg: unknown) => void) => {
        listeners.push(listener);
      }),
      removeListener: vi.fn((listener: (msg: unknown) => void) => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }),
    },
    onDisconnect: {
      addListener: vi.fn(),
    },
    // 測試輔助：模擬接收消息
    _simulateMessage: (msg: unknown) => {
      for (const listener of listeners) {
        listener(msg);
      }
    },
  };
  return port;
}

describe('LocalONNXTranslationProvider', () => {
  let mockPort: ReturnType<typeof createMockPort>;
  
  beforeEach(() => {
    mockPort = createMockPort();
    
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
        connect: vi.fn(() => mockPort),
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

    // 設置 port 響應模擬
    mockPort.postMessage.mockImplementation((msg: unknown) => {
      setTimeout(() => {
        const msgObj = msg as { messageId?: string; payload?: { text?: string } };
        mockPort._simulateMessage({
          messageId: msgObj.messageId,
          result: {
            ok: true,
            translatedText: '翻譯結果 0\n翻譯結果 1',
          },
        });
      }, 0);
    });

    const result = await provider.translate(req());

    expect(result.engineId).toBe('local-onnx');
    expect(result.degraded).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].translatedText).toBe('翻譯結果 0');
    expect(result.segments[1].translatedText).toBe('翻譯結果 1');

    // 驗證通過 port 發送請求
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'local-onnx:translate',
        payload: {
          text: 'line-0\nline-1',
          targetLang: 'zh-Hant',
          modelTier: 'large',
        },
      })
    );
  });

  it('translate 失敗時拋出錯誤並記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    // 設置 port 響應模擬（失敗）
    mockPort.postMessage.mockImplementation((msg: unknown) => {
      setTimeout(() => {
        const msgObj = msg as { messageId?: string };
        mockPort._simulateMessage({
          messageId: msgObj.messageId,
          result: {
            ok: false,
            error: 'Model not downloaded',
            notDownloaded: true,
          },
        });
      }, 0);
    });

    await expect(provider.translate(req())).rejects.toThrow('Model not downloaded');
  });

  it('translateStream：>5 行時逐 chunk emit 累計全量', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    const segments = Array.from({ length: 6 }, (_, i) => seg(i));
    
    // port 響應會自動生成（使用 createMockPort 的默認實現）
    const emitted: Array<{ segments: SubtitleSegment[]; degraded: boolean }> = [];
    await provider.translateStream({ segments, targetLang: 'zh-Hant' }, (r) =>
      emitted.push(r as { segments: SubtitleSegment[]; degraded: boolean })
    );

    // 6 行 → 2 次請求，每次完成即 emit 累計全量
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.segments).toHaveLength(5);
    expect(emitted[1]?.segments).toHaveLength(6);
    expect(emitted[0]?.segments[4]?.translatedText).toBe('T:line-4');
    expect(emitted[1]?.segments[5]?.translatedText).toBe('T:line-5');
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

  it('port 斷開時 postMessage 拋錯應被正確捕獲並清除 port 引用', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'onnx-community/Qwen2.5-0.5B-Instruct',
    });

    // 模擬 port 斷開：postMessage 拋出 "disconnected port" 錯誤
    mockPort.postMessage.mockImplementation(() => {
      throw new Error('Attempting to use a disconnected port object');
    });

    await expect(provider.translate(req())).rejects.toThrow('disconnected port');

    // 驗證 port 引用被清除（下次請求會重新建立連接）
    expect((provider as unknown as { port: unknown }).port).toBeNull();
  });

  it('Small model 退化輸出 → 回退原文 + 記錄診斷', async () => {
    const provider = new LocalONNXTranslationProvider({
      modelName: 'Xenova/opus-mt-en-zh',
      modelTier: 'small',
    });

    // 注入 mock port
    (provider as unknown as { port: unknown }).port = mockPort;

    // 模擬 port 返回退化輸出
    mockPort.postMessage.mockImplementation((msg: unknown) => {
      setTimeout(() => {
        const msgObj = msg as { topic?: string; messageId?: string };
        if (msgObj.topic === 'local-onnx:translate') {
          const response = {
            messageId: msgObj.messageId,
            result: {
              ok: false,
              error: 'Small model produced degenerate output (repetition detected).',
              degenerate: true,
            },
          };
          mockPort._simulateMessage(response);
        }
      }, 0);
    });

    const segments = [seg(0), seg(1), seg(2)];
    const result = await provider.translate({ segments, targetLang: 'zh-Hant' });

    // 驗證所有 segment 回退到原文
    expect(result.segments).toHaveLength(3);
    for (const s of result.segments) {
      expect(s.translatedText).toBe(s.sourceText);
    }

    // 驗證記錄了診斷
    expect(recordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pipeline-error',
        error: expect.objectContaining({
          code: 'small-model-degenerate',
        }),
      })
    );
  });
});
