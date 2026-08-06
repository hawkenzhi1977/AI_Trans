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
  return {
    ok: true,
    status: 200,
    json: async () => body,
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
    // 模擬「宿主 fetch 必須以 globalThis 為接收者」的行為：若 this 非 globalThis 則拋。
    const realImpl = vi.fn(async () => okResponse(llmBody));
    const boundGuard = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError('Illegal invocation');
      }
      return realImpl(...args);
    } as unknown as typeof fetch;
    vi.stubGlobal('fetch', boundGuard);

    // 未注入 fetchFn → 走默認 globalThis.fetch.bind(globalThis)
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk-test',
    });

    const result = await provider.translate(req());
    expect(realImpl).toHaveBeenCalledOnce();
    expect(result.segments[0].translatedText).toBe('譯文零');
    expect(result.segments[1].translatedText).toBe('譯文一');
    expect(result.degraded).toBe(false);
  });

  it('注入的 fetchFn 被使用，端點與 Authorization 正確', async () => {
    const fetchFn = vi.fn(async () => okResponse(llmBody));
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk-secret',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await provider.translate(req());
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-secret',
    });
  });

  it('HTTP 非 2xx 時拋錯（供管線降級）', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(provider.translate(req())).rejects.toThrow('HTTP 500');
  });
});

describe('LLMTranslationProvider — reasoning 剝離與超時降級', () => {
  it('content 含 <think> 思考塊時剝離，不污染字幕解析', async () => {
    const reasoningContent =
      '<think>Let me translate carefully.</think>\n0\t你好，世界\n1\t早安';
    const fetchFn = vi.fn(async () => okResponse({
      choices: [{ message: { content: reasoningContent } }],
    }));
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await provider.translate(req());
    expect(result.segments[0].translatedText).toBe('你好，世界');
    expect(result.segments[1].translatedText).toBe('早安');
  });

  it('超時觸發 AbortSignal，拋錯供管線降級', async () => {
    // 永不 resolve 的 fetch：依賴 30ms 超時中斷。
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    );
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 30,
    });

    await expect(provider.translate(req())).rejects.toThrow(/aborted/i);
  });

  it('正常請求完成時不會殘留未清理的定時器', async () => {
    const fetchFn = vi.fn(async () => okResponse(llmBody));
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 30_000,
    });
    await provider.translate(req());
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('stripReasoning：剝離成對思考塊與殘留單邊標籤', () => {
    expect(stripReasoning('<think>a</think>\n0\t你好')).toBe('0\t你好');
    expect(stripReasoning('</think>0\t你好')).toBe('0\t你好');
    expect(stripReasoning('0\t你好\n<think>b</think>1\t早安')).toBe('0\t你好\n1\t早安');
    expect(stripReasoning('plain')).toBe('plain');
  });
});

describe('LLMTranslationProvider — §5.6 響應結構診斷（不靜默回退原文）', () => {
  it('HTTP 200 但 body 非 JSON（HTML 錯誤頁）→ 拋「非合法 JSON」錯誤而非 SyntaxError', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }) as Response);
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(provider.translate(req())).rejects.toThrow(/response is not valid JSON/);
  });

  it('HTTP 200 但 choices 缺失（限流返回 {error}）→ 拋錯走降級而非靜默回退原文', async () => {
    const fetchFn = vi.fn(async () => okResponse({ error: { message: 'rate limited' } }));
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    // 必須 reject（觸發 pipeline fallback/降級事件），不許帶 degraded=false 回退原文。
    await expect(provider.translate(req())).rejects.toThrow(/no valid choices/);
  });

  it('HTTP 200 但 choices[0].message.content 非字符串 → 拋錯不靜默', async () => {
    const fetchFn = vi.fn(async () => okResponse({ choices: [{ message: { content: 42 } }] }));
    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(provider.translate(req())).rejects.toThrow(/no valid choices/);
  });
});
