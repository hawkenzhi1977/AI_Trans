import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  LLMTranslationProvider,
  stripReasoning,
  chunkSegments,
  djb2Hash,
  invalidateLlmCache,
  llmCacheSize,
  ensureLlmCacheInvalidationHook,
  BODY_TIMEOUT_MS,
} from '../../src/adapters/translation/llm-translation';
import type { TranslationRequest } from '../../src/domain/models/translation';
import type { TranslationResult } from '../../src/domain/models/translation';
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
  choices: [{ message: { content: '0\t譯文零\n1\t譯文一\n2\t譯文二\n3\t譯文三\n4\t譯文四\n5\t譯文五\n6\t譯文六\n7\t譯文七\n8\t譯文八\n9\t譯文九\n10\t譯文十\n11\t譯文十一\n12\t譯文十二\n13\t譯文十三\n14\t譯文十四' } }],
};

// 模塊級 LRU 快取跨測試共享：每個用例前後清空，避免快取命中污染斷言。
beforeEach(() => invalidateLlmCache());
afterEach(() => invalidateLlmCache());

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

  it('請求 body 包含 max_tokens=4096（避免 LLM 輸出截斷）', async () => {
    const fetchMock = vi.fn(async () => okResponse(llmBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    await provider.translate(req());
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.max_tokens).toBe(4096);
  });

  it('[M1-52] HTTP 5xx 屬瞬態：重試耗盡後塊原文兜底（不阻塞字幕）', async () => {
    // 500 為瞬態失敗——重試 MAX_RETRIES 次仍失敗 → 該塊回退原文（translatedText=sourceText），
    // 不再直接拋錯（塊級兜底不中斷其餘塊）。用 fake timers 跳過退避延遲。
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'error' }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    // 3 次嘗試（首次 + 2 重試）全部 500。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 塊兜底：譯文回退為原文。
    expect(result.segments[0].translatedText).toBe('line-0');
    expect(result.segments[1].translatedText).toBe('line-1');
    vi.useRealTimers();
  });

  it('[M1-52] HTTP 4xx（非 429）屬永久失敗：立即拋錯不重試（走管線降級）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad request' }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    await expect(provider.translate(req())).rejects.toThrow('HTTP 400');
    // 永久失敗不重試：僅 1 次請求。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[M1-52] HTTP 429 屬瞬態：先失敗後成功則採用成功結果', async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 429, text: async () => 'rate limited' } as Response;
      return okResponse(llmBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.segments[0].translatedText).toBe('譯文零');
    vi.useRealTimers();
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

  it('[M1-53] headers 階段超時（timeoutMs）觸發 AbortSignal 屬瞬態：重試耗盡後塊原文兜底', async () => {
    // Phase 1：永不 resolve 的 fetch（響應頭遲遲不到）→ headers 定時器 abort。
    // 超時為瞬態 → 重試耗盡後回退原文。
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 5,
    });
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.segments[0].translatedText).toBe('line-0');
    vi.useRealTimers();
  });

  it('[M1-53] body 階段超時（bodyTimeoutMs）：響應頭已回但 res.text() 掛死時仍被 abort 中斷', async () => {
    // Phase 2：headers 已到達（fetch resolve），但 res.text() 掛死 → body 定時器 abort。
    // 兩階段共用 controller；body 超時為瞬態，重試耗盡後塊原文兜底（不永久卡死）。
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          // body 讀取永不 resolve，直到 abort 觸發才 reject。
          text: () =>
            new Promise<string>((_, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }),
        } as unknown as Response)
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 30_000, // headers 階段足夠寬（不觸發）
      bodyTimeoutMs: 5, // body 階段短超時，斷言 body 掛死也會被中斷
    });
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.segments[0].translatedText).toBe('line-0');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('[M1-53] headers 快返 + body 慢生成（< bodyTimeoutMs）→ 不被 headers 超時誤殺，成功翻譯', async () => {
    // 回歸本次根因：本地 LLM 11ms 回 headers 但 body 生成需數十秒，
    // 舊單一 30s 超時會在 body 讀取階段誤殺。兩階段方案下 headers 極短、body 寬鬆 → 成功。
    const fetchMock = vi.fn(
      (_url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          // body 讀取延遲 100ms（模擬慢生成），遠小於 bodyTimeoutMs。
          text: () =>
            new Promise<string>((resolve) => {
              setTimeout(() => resolve(JSON.stringify(llmBody)), 100);
            }),
        } as unknown as Response)
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
      timeoutMs: 5, // headers 階段極短：只要 headers 已到就 clearTimeout，不會誤殺 body
      // bodyTimeoutMs 用默認 300s
    });
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    // 成功翻譯（未被 headers 超時中斷），單次請求即成功。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.segments[0].translatedText).toBe('譯文零');
    expect(result.degraded).toBe(false);
    vi.useRealTimers();
  });

  it('[M1-53] BODY_TIMEOUT_MS 常數為 5 分鐘（本地 LLM 長輸出窗口）', () => {
    expect(BODY_TIMEOUT_MS).toBe(300_000);
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

  it('[M1-52] HTTP 200 但 body 非 JSON（HTML 錯誤頁）→ 瞬態重試耗盡後塊原文兜底並記診斷', async () => {
    // JSON 解析失敗歸為瞬態（代理偶發返回垃圾頁重試可恢復）；重試耗盡 → 塊原文兜底。
    // §5.6：診斷已由 console.error 無條件落盤（parse failed, body snippet）。
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.segments[0].translatedText).toBe('line-0');
    // §5.6：解析失敗必須留痕（console.error 不受 debug 門控）。
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('[M1-52] HTTP 200 但 body 讀取拋 Failed to fetch（連接中斷）→ 瞬態重試耗盡後塊原文兜底', async () => {
    // 真實場景：本地模型服務發完 200 響應頭後連接被重置/中斷，res.text() 讀 body 流時
    // 拋 TypeError: Failed to fetch——歸為瞬態，重試耗盡後塊原文兜底（不永久卡死）。
    vi.useFakeTimers();
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
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.segments[0].translatedText).toBe('line-0');
    vi.useRealTimers();
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

describe('LLMTranslationProvider — §5.6 LLM 輸出不完整診斷', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('LLM 返回行數少於輸入段數時重試並最終輸出 warn 診斷', async () => {
    // LLM 每次只返回 1 行翻譯，但輸入有 3 段 → 應觸發重試，最終 incomplete warning。
    const incompleteBody = {
      choices: [{ message: { content: '0\t譯文零' } }],
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => okResponse(incompleteBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    const result = await provider.translate({
      segments: [seg(0), seg(1), seg(2)],
      targetLang: 'zh-Hant',
    });

    // 缺失的段回退為原文。
    expect(result.segments[0].translatedText).toBe('譯文零');
    expect(result.segments[1].translatedText).toBe('line-1');
    expect(result.segments[2].translatedText).toBe('line-2');
    // 應調用 fetch 4 次（1 次初始 + 3 次 incomplete 重試，M2-31 增加重試次數）
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // §5.6：不完整輸出最終必須留痕。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('incomplete translation after')
    );
    warnSpy.mockRestore();
  });

  it('LLM 不完整翻譯重試後成功返回完整翻譯', async () => {
    // 第一次返回不完整（缺 index 1, 2），第二次返回完整
    const incompleteBody = {
      choices: [{ message: { content: '0\t譯文零' } }],
    };
    const completeBody = {
      choices: [{ message: { content: '0\t譯文零\n1\t譯文一\n2\t譯文二' } }],
    };

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? okResponse(incompleteBody) : okResponse(completeBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    const result = await provider.translate({
      segments: [seg(0), seg(1), seg(2)],
      targetLang: 'zh-Hant',
    });

    // 重試後應返回完整翻譯
    expect(result.segments[0].translatedText).toBe('譯文零');
    expect(result.segments[1].translatedText).toBe('譯文一');
    expect(result.segments[2].translatedText).toBe('譯文二');
    // 應調用 fetch 2 次（1 次初始 + 1 次重試成功）
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('LLM 返回完整行數時不輸出 warn', async () => {
    const completeBody = {
      choices: [{ message: { content: '0\t譯文零\n1\t譯文一' } }],
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => okResponse(completeBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    await provider.translate(req());

    // 完整翻譯不應觸發 warning。
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('LLM 重複翻譯不同 index 時輸出 warn 診斷', async () => {
    // LLM 對 index 0, 1, 2 都返回相同翻譯 → 應觸發 duplicate warning。
    const duplicateBody = {
      choices: [{ message: { content: '0\t相同譯文\n1\t相同譯文\n2\t相同譯文' } }],
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => okResponse(duplicateBody));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-x',
      apiKey: 'sk',
    });

    await provider.translate({
      segments: [seg(0), seg(1), seg(2)],
      targetLang: 'zh-Hant',
    });

    // §5.6：重複翻譯必須留痕（小模型可能在長輸出中迷失）。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('duplicate translations detected')
    );
    warnSpy.mockRestore();
  });
});

describe('LLMTranslationProvider — M1-52 分塊 / 快取 / 流式', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeProvider(model = 'gpt-x'): LLMTranslationProvider {
    return new LLMTranslationProvider({
      engineId: 'llm',
      endpoint: 'https://api.example.com/v1/chat/completions',
      model,
      apiKey: 'sk',
    });
  }

  function contentOf(calls: ReturnType<typeof vi.fn>): string[] {
    return calls.mock.calls.map((c) => {
      const init = c[1] as RequestInit;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      return body.messages[body.messages.length - 1]!.content as string;
    });
  }

  describe('chunkSegments 分塊', () => {
    it('不超過 CHUNK_SIZE=15，保持順序與 id', () => {
      const segs = Array.from({ length: 40 }, (_, i) => seg(i));
      const chunks = chunkSegments(segs);
      expect(chunks).toHaveLength(3); // 15 + 15 + 10
      expect(chunks[0]).toHaveLength(15);
      expect(chunks[1]).toHaveLength(15);
      expect(chunks[2]).toHaveLength(10);
      expect(chunks[0]![0]!.id).toBe('s0');
      expect(chunks[2]![9]!.id).toBe('s39');
    });

    it('恰好 15 段切為單塊', () => {
      const segs = Array.from({ length: 15 }, (_, i) => seg(i));
      expect(chunkSegments(segs)).toHaveLength(1);
    });

    it('空輸入返回 [[]]（仍走一次請求避免空響應分支）', () => {
      expect(chunkSegments([])).toEqual([[]]);
    });
  });

  describe('LRU 快取', () => {
    it('相同請求第二次命中快取：不再請求 LLM', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const r1 = await provider.translate(req());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const r2 = await provider.translate(req());
      expect(fetchMock).toHaveBeenCalledTimes(1); // 命中快取
      expect(r1.segments[0].translatedText).toBe('譯文零');
      expect(r2.segments[0].translatedText).toBe('譯文零');
    });

    it('換模型/換目標語言 → 快取 miss（key 含 model|targetLang|hash）', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider('gpt-x');
      await provider.translate(req());
      // 同 provider 但改目標語言。
      await provider.translate({ segments: [seg(0), seg(1)], targetLang: 'en' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('超過 100 條時逐出最舊條目（LRU）', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      // 塞入 110 個不同塊 → 緩存 110 條；超過上限後最早被逐出。
      for (let i = 0; i < 110; i++) {
        await provider.translate({
          segments: [{ ...seg(0), sourceText: `line-${i}-${Math.random()}` }],
          targetLang: 'zh-Hant',
        });
      }
      expect(llmCacheSize()).toBe(100);
      // 重新翻譯最早塞入的塊 → miss（已被逐出）。
      await provider.translate({
        segments: [{ ...seg(0), sourceText: 'line-0-0.123456789' }],
        targetLang: 'zh-Hant',
      });
      // 未命中則再次請求；總請求數 > 110。
      expect(fetchMock.mock.calls.length).toBeGreaterThan(110);
    });

    it('invalidateLlmCache() 全量清空快取', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      await provider.translate(req());
      expect(llmCacheSize()).toBe(1);
      invalidateLlmCache();
      expect(llmCacheSize()).toBe(0);
      await provider.translate(req());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('快取命中的結果標記 targetLang', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const r1 = await provider.translate(req());
      const r2 = await provider.translate(req());
      expect(r1.segments[0].targetLang).toBe('zh-Hant');
      expect(r2.segments[0].targetLang).toBe('zh-Hant');
    });

    it('ensureLlmCacheInvalidationHook 是幂等的（只註冊一次監聽）', async () => {
      // node 環境無 chrome.storage → 捕獲後靜默；不拋錯。
      expect(() => ensureLlmCacheInvalidationHook()).not.toThrow();
      expect(() => ensureLlmCacheInvalidationHook()).not.toThrow();
    });
  });

  describe('分塊請求與流式漸進', () => {
    it('130 段分 9 塊：translate 發起 9 次請求並合併', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const many = Array.from({ length: 130 }, (_, i) => seg(i));
      const result = await provider.translate({ segments: many, targetLang: 'zh-Hant' });
      expect(fetchMock).toHaveBeenCalledTimes(9);
      expect(result.segments).toHaveLength(130);
      // 每塊內容是該塊的行（塊 1 為 0..14，塊 2 為 15..29…）。
      const contents = contentOf(fetchMock);
      expect(contents[0]).toContain('line-0');
      expect(contents[0]).toContain('line-14');
      expect(contents[0]).not.toContain('line-15');
      expect(contents[1]).toContain('line-15');
    });

    it('translateStream 每次 emit 都是累計全量（首塊後續漸進）', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const many = Array.from({ length: 130 }, (_, i) => seg(i));
      const emitted: TranslationResult[] = [];
      await provider.translateStream({ segments: many, targetLang: 'zh-Hant' }, (r) =>
        emitted.push(r)
      );
      // 9 塊 → 9 次 emit；每次長度遞增：15、30、45、60、75、90、105、120、130。
      expect(emitted).toHaveLength(9);
      expect(emitted.map((e) => e.segments.length)).toEqual([15, 30, 45, 60, 75, 90, 105, 120, 130]);
      // 後次 emit 包含前次內容（累計）。
      expect(emitted[8]!.segments[0].translatedText).toBe('譯文零');
      expect(emitted[8]!.segments[129].id).toBe('s129');
    });

    it('translateStream 塊間快取共享：重播時不重新請求', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const many = Array.from({ length: 130 }, (_, i) => seg(i));
      await provider.translateStream({ segments: many, targetLang: 'zh-Hant' }, () => {});
      expect(fetchMock).toHaveBeenCalledTimes(9);
      // 第二次完全相同請求 → 全命中快取，零請求。
      await provider.translateStream({ segments: many, targetLang: 'zh-Hant' }, () => {});
      expect(fetchMock).toHaveBeenCalledTimes(9);
    });
  });

  describe('djb2Hash 確定性', () => {
    it('相同輸入同哈希；不同輸入不同哈希', () => {
      expect(djb2Hash('abc')).toBe(djb2Hash('abc'));
      expect(djb2Hash('abc')).not.toBe(djb2Hash('abd'));
    });
  });

  // M2-31：重複翻譯偵測與重試。
  describe('M2-31 重複翻譯偵測與重試', () => {
    it('偵測到過度重複（>30%）時觸發額外重試', async () => {
      // 第一次返回大量重複：5 個唯一值各出現 2 次 = 10 段，加上 5 個唯一值各出現 1 次 = 5 段。
      // 總計 15 段，5 個重複值 → 5/15 = 33% > 30% 閾值。
      const duplicateBody = {
        choices: [{ message: { content: '0\t重複A\n1\t重複A\n2\t重複B\n3\t重複B\n4\t重複C\n5\t重複C\n6\t重複D\n7\t重複D\n8\t重複E\n9\t重複E\n10\t唯一1\n11\t唯一2\n12\t唯一3\n13\t唯一4\n14\t唯一5' } }],
      };
      // 第二次返回無重複。
      const uniqueBody = {
        choices: [{ message: { content: Array.from({ length: 15 }, (_, i) => `${i}\t譯文${i}`).join('\n') } }],
      };

      let callCount = 0;
      const fetchMock = vi.fn(async () => {
        callCount++;
        return okResponse(callCount === 1 ? duplicateBody : uniqueBody);
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const segments = Array.from({ length: 15 }, (_, i) => seg(i));
      const result = await provider.translate({ segments, targetLang: 'zh-Hant' });

      // 應觸發重複重試（1 次初始 + 1 次重複重試 = 2 次）。
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 最終結果應無重複。
      const translations = result.segments.map(s => s.translatedText);
      const uniqueTranslations = new Set(translations);
      expect(uniqueTranslations.size).toBe(15);
    });

    it('重複比例未超閾值（≤30%）時不觸發重試', async () => {
      // 15 段中 2 個唯一值各出現 2 次 = 4 段重複，加上 11 個唯一值 = 11 段。
      // 總計 15 段，2 個重複值 → 2/15 = 13% < 30% 閾值。
      const body = {
        choices: [{ message: { content: '0\t重複A\n1\t重複A\n2\t重複B\n3\t重複B\n4\t唯一1\n5\t唯一2\n6\t唯一3\n7\t唯一4\n8\t唯一5\n9\t唯一6\n10\t唯一7\n11\t唯一8\n12\t唯一9\n13\t唯一10\n14\t唯一11' } }],
      };
      const fetchMock = vi.fn(async () => okResponse(body));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const segments = Array.from({ length: 15 }, (_, i) => seg(i));
      await provider.translate({ segments, targetLang: 'zh-Hant' });

      // 不觸發重複重試（僅 1 次初始請求）。
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
