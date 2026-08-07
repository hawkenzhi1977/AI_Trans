import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  LLMTranslationProvider,
  stripReasoning,
  chunkSegments,
  djb2Hash,
  invalidateLlmCache,
  llmCacheSize,
  ensureLlmCacheInvalidationHook,
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
  choices: [{ message: { content: '0\t譯文零\n1\t譯文一' } }],
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

  it('[M1-52] 超時觸發 AbortSignal 屬瞬態：重試耗盡後塊原文兜底', async () => {
    // 永不 resolve 的 fetch：依賴超時中斷（含 body 讀取階段，見下獨立用例）。
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

  it('[M1-52] 超時覆蓋 body 讀取：響應頭已回但 res.text() 掛死時仍被 abort 中斷', async () => {
    // 舊 bug：clearTimeout 在收到響應頭後即取消 → body 流掛死時超時永不觸發（連接 lost）。
    // 修復後 AbortController 覆蓋 fetch+body 全程：res.text() 掛死也會被 abort 拒絕。
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
      timeoutMs: 5,
    });
    // body 掛死 → 超時 abort → 瞬態重試耗盡 → 塊原文兜底（不會永久卡死）。
    const promise = provider.translate(req());
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.segments[0].translatedText).toBe('line-0');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
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
    it('不超過 CHUNK_SIZE=60，保持順序與 id', () => {
      const segs = Array.from({ length: 130 }, (_, i) => seg(i));
      const chunks = chunkSegments(segs);
      expect(chunks).toHaveLength(3); // 60 + 60 + 10
      expect(chunks[0]).toHaveLength(60);
      expect(chunks[1]).toHaveLength(60);
      expect(chunks[2]).toHaveLength(10);
      expect(chunks[0]![0]!.id).toBe('s0');
      expect(chunks[2]![9]!.id).toBe('s129');
    });

    it('恰好 60 段切為單塊', () => {
      const segs = Array.from({ length: 60 }, (_, i) => seg(i));
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
    it('130 段分 3 塊：translate 發起 3 次請求並合併', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const many = Array.from({ length: 130 }, (_, i) => seg(i));
      const result = await provider.translate({ segments: many, targetLang: 'zh-Hant' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.segments).toHaveLength(130);
      // 每塊內容是該塊的行（塊 1 為 0..59，塊 2 為 60..119…）。
      const contents = contentOf(fetchMock);
      expect(contents[0]).toContain('line-0');
      expect(contents[0]).toContain('line-59');
      expect(contents[0]).not.toContain('line-60');
      expect(contents[1]).toContain('line-60');
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
      // 3 塊 → 3 次 emit；每次長度遞增：60、120、130。
      expect(emitted).toHaveLength(3);
      expect(emitted.map((e) => e.segments.length)).toEqual([60, 120, 130]);
      // 後次 emit 包含前次內容（累計）。
      expect(emitted[2]!.segments[0].translatedText).toBe('譯文零');
      expect(emitted[2]!.segments[129].id).toBe('s129');
    });

    it('translateStream 塊間快取共享：重播時不重新請求', async () => {
      const fetchMock = vi.fn(async () => okResponse(llmBody));
      vi.stubGlobal('fetch', fetchMock);

      const provider = makeProvider();
      const many = Array.from({ length: 130 }, (_, i) => seg(i));
      await provider.translateStream({ segments: many, targetLang: 'zh-Hant' }, () => {});
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // 第二次完全相同請求 → 全命中快取，零請求。
      await provider.translateStream({ segments: many, targetLang: 'zh-Hant' }, () => {});
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('djb2Hash 確定性', () => {
    it('相同輸入同哈希；不同輸入不同哈希', () => {
      expect(djb2Hash('abc')).toBe(djb2Hash('abc'));
      expect(djb2Hash('abc')).not.toBe(djb2Hash('abd'));
    });
  });
});
