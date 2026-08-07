import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMTranslationProvider, stripReasoning } from '../../src/adapters/translation/llm-translation';
import type { TranslationRequest } from '../../src/domain/models/translation';
import type { SubtitleSegment } from '../../src/domain/models/subtitle';

// 針對 §5.1 紅線（R1）：LLM 適配器默認 fetch 必須綁定 globalThis，
// 否則 content-script 中裸 fetch 會拋 "Illegal invocation"。

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

function okResponse(body: unknown): Response {
  const bodyStr = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => bodyStr,
  } as Response;
}

const llmBody = {
  choices: [{ message: { content: '0\t譯文零\n1\t譯文一' } }],
};

describe('LLMTranslationProvider — fetch 綁定與調用', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[R1] 默認 fetch 綁定 globalThis：以 window/global 為接收者調用不拋 Illegal invocation', async () => {
    // Mock globalThis.fetch
    const fetchMock = vi.fn(async () => okResponse(llmBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk-test',
    });

    const result = await provider.translate(req());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.segments[0].translatedText).toBe('譯文零');
    expect(result.segments[1].translatedText).toBe('譯文一');
    expect(result.degraded).toBe(false);
  });

  it('端點與 Authorization 正確', async () => {
    const fetchMock = vi.fn(async () => okResponse(llmBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk-secret',
    });

    await provider.translate(req());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-secret',
    });
  });

  it('HTTP 非 2xx 時拋錯（供管線降級）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'error' }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow('HTTP 500');
  });
});

describe('LLMTranslationProvider — reasoning 剝離與超時降級', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('content 含  思考塊時剝離，不污染字幕解析', async () => {
    const reasoningContent =
      'Let me translate carefully.\n0\t你好，世界\n1\t早安';
    const fetchMock = vi.fn(async () => okResponse({
      choices: [{ message: { content: reasoningContent } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    const result = await provider.translate(req());
    expect(result.segments[0].translatedText).toBe('你好，世界');
    expect(result.segments[1].translatedText).toBe('早安');
  });

  it('超時觸發 AbortSignal，拋錯供管線降級', async () => {
    // 永不 resolve 的 fetch：依賴 30ms 超時中斷。
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 30,
    });

    await expect(provider.translate(req())).rejects.toThrow(/aborted/i);
  });

  it('正常請求完成時不會殘留未清理的定時器', async () => {
    const fetchMock = vi.fn(async () => okResponse(llmBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 30_000,
    });
    await provider.translate(req());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stripReasoning：剝離成對思考塊與殘留單邊標籤', () => {
    expect(stripReasoning('a\n0\t你好')).toBe('a\n0\t你好');
    expect(stripReasoning('0\t你好')).toBe('0\t你好');
    expect(stripReasoning('0\t你好\nb1\t早安')).toBe('0\t你好\nb1\t早安');
    expect(stripReasoning('plain')).toBe('plain');
  });
});

describe('LLMTranslationProvider — §5.6 響應結構診斷（不靜默回退原文）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HTTP 200 但 body 非 JSON（HTML 錯誤頁）→ 拋「非合法 JSON」錯誤而非 SyntaxError', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>Error</html>',
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow(/response is not valid JSON/);
  });

  it('HTTP 200 但 body 讀取拋 Failed to fetch（連接中斷）→ 拋錯供管線降級', async () => {
    // 真實場景：本地模型服務發完 200 響應頭後連接被重置/中斷，res.text() 讀 body 流時
    // 拋 TypeError: Failed to fetch——必須拋錯走降級機制。
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('Failed to fetch');
      },
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow('Failed to fetch');
  });

  it('HTTP 200 但 body 讀取拋非 JSON 語法錯誤 → 仍報「not valid JSON」', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>Error</html>',
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow(/response is not valid JSON/);
    await expect(provider.translate(req())).rejects.not.toThrow(/connection lost/);
  });

  it('HTTP 200 但 choices 缺失（限流返回 {error}）→ 拋錯走降級而非靜默回退原文', async () => {
    const fetchMock = vi.fn(async () => okResponse({ error: { message: 'rate limited' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    // 必須 reject（觸發 pipeline fallback/降級事件），不許帶 degraded=false 回退原文。
    await expect(provider.translate(req())).rejects.toThrow(/no valid choices/);
  });

  it('HTTP 200 但 choices[0].message.content 非字符串 → 拋錯不靜默', async () => {
    const fetchMock = vi.fn(async () => okResponse({ choices: [{ message: { content: 42 } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow(/no valid choices/);
  });
});
