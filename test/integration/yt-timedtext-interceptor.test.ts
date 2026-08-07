import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MAIN world 攔截器：hook XMLHttpRequest 捕獲 timedtext 響應並 postMessage。
// 覆蓋 §5.1（宿主方法綁定）、R4（load 監聽器解除）、R7（精確匹配）、冪等安裝。
//
// 注意：interceptor 在 import 時執行 install()，會 hook 全局 XMLHttpRequest。
// 為隔離，每個測試前重置注入標記並保存/還原原型方法。

const INSTALL_FLAG = '__aiTransTimedtextInterceptorInstalled';

describe('yt-timedtext-interceptor — XHR 攔截', () => {
  let origOpen: typeof XMLHttpRequest.prototype.open;
  let origSend: typeof XMLHttpRequest.prototype.send;
  let postMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origOpen = XMLHttpRequest.prototype.open;
    origSend = XMLHttpRequest.prototype.send;
    Reflect.deleteProperty(globalThis, INSTALL_FLAG);
    postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    Reflect.deleteProperty(globalThis, INSTALL_FLAG);
    postMessageSpy.mockRestore();
    vi.resetModules();
  });

  async function loadInterceptor(): Promise<void> {
    // 動態 import 觸發 install()（帶 cache-buster 避免模塊緩存跳過 install）。
    await import('../../src/runtime/yt-timedtext-interceptor?t=' + Date.now());
  }

  it('安裝後設置注入標記，重複 import 不重複 hook（冪等）', async () => {
    await loadInterceptor();
    expect(Reflect.get(globalThis, INSTALL_FLAG)).toBe(true);
    const openAfterFirst = XMLHttpRequest.prototype.open;
    // 第二次（模塊已改 flag）——手動再調 install 邏輯不重 hook：直接驗證 open 未被再次替換
    await import('../../src/runtime/yt-timedtext-interceptor');
    expect(XMLHttpRequest.prototype.open).toBe(openAfterFirst);
  });

  it('timedtext XHR 完成後 postMessage 捕獲響應（含 URL 與 responseText）', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    const url = 'https://www.youtube.com/api/timedtext?v=abc&pot=xyz&fmt=json3';
    xhr.open('GET', url);
    // 模擬響應：覆寫 responseText/getResponseHeader，手動觸發 load。
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    // send 會註冊 load 監聽器；jsdom 不真發請求，手動 dispatch。
    try {
      xhr.send();
    } catch {
      // jsdom send 可能因無網絡拋錯，忽略——我們只驗證 load 監聽掛載後的行為。
    }
    xhr.dispatchEvent(new Event('load'));

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0] as {
      __aiTrans: boolean;
      type: string;
      payload: { url: string; responseText: string };
    };
    expect(msg.__aiTrans).toBe(true);
    expect(msg.type).toBe('ai-trans:timedtext-capture');
    expect(msg.payload.url).toBe(url);
    expect(msg.payload.responseText).toBe('{"events":[]}');
  });

  it('[M1-45] 捕獲攜帶 videoId（從 timedtext URL v 參數提取）', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    const url = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3';
    xhr.open('GET', url);
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    const msg = postMessageSpy.mock.calls[0][0] as {
      payload: { videoId?: string };
    };
    expect(msg.payload.videoId).toBe('abc123');
  });

  it('[M1-45] timedtext URL 無 v 參數時 videoId 為空串（不誤提取）', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?lang=en&fmt=json3');
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    const msg = postMessageSpy.mock.calls[0][0] as {
      payload: { videoId?: string };
    };
    expect(msg.payload.videoId).toBe('');
  });

  it('[R7] 非 timedtext 請求不觸發 postMessage', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/stats/watchtime?v=abc');
    Object.defineProperty(xhr, 'responseText', { value: 'data', configurable: true });
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('空響應（無登錄態/無字幕）不轉發，避免污染最新值', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=abc');
    Object.defineProperty(xhr, 'responseText', { value: '', configurable: true });
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('[M1-43] 匹配 localhost timedtext URL（E2E mock 宿主）', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/timedtext?lang=en&v=abc123');
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0] as { type: string; payload: { url: string } };
    expect(msg.type).toBe('ai-trans:timedtext-capture');
    expect(msg.payload.url).toContain('/timedtext');
  });

  it('[M1-46] 重播：晚註冊的監聽器收到最近捕獲（修復 document_start 注入早於 bridge 監聽器就位的競態）', async () => {
    vi.useFakeTimers();
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=abc&lang=en');
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    // 即時 postMessage（第一次）。
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const firstCall = postMessageSpy.mock.calls[0][0] as { payload: { url: string; responseText: string } };
    expect(firstCall.payload.responseText).toBe('{"events":[]}');
    // 推進 1.5s，重播定時器觸發（第二次 postMessage，payload 相同）。
    vi.advanceTimersByTime(1500);
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const replayCall = postMessageSpy.mock.calls[1][0] as { payload: { url: string; responseText: string } };
    expect(replayCall.payload.url).toBe(firstCall.payload.url);
    expect(replayCall.payload.responseText).toBe(firstCall.payload.responseText);
    vi.useRealTimers();
  });

  it('[M1-46] 新捕獲覆蓋重播（SPA 換視頻場景）', async () => {
    vi.useFakeTimers();
    await loadInterceptor();
    // 第一次捕獲（v=abc）。
    const xhr1 = new XMLHttpRequest();
    xhr1.open('GET', 'https://www.youtube.com/api/timedtext?v=abc&lang=en');
    Object.defineProperty(xhr1, 'responseText', { value: '{"events":[{"tStartMs":0}]}', configurable: true });
    vi.spyOn(xhr1, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr1.send();
    } catch {
      /* ignore */
    }
    xhr1.dispatchEvent(new Event('load'));
    postMessageSpy.mockClear();
    // 第二次捕獲（v=xyz，新視頻）。
    const xhr2 = new XMLHttpRequest();
    xhr2.open('GET', 'https://www.youtube.com/api/timedtext?v=xyz&lang=en');
    Object.defineProperty(xhr2, 'responseText', { value: '{"events":[{"tStartMs":1000}]}', configurable: true });
    vi.spyOn(xhr2, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr2.send();
    } catch {
      /* ignore */
    }
    xhr2.dispatchEvent(new Event('load'));
    // 推進 1.5s，重播應發送新捕獲（v=xyz）而非舊捕獲（v=abc）。
    vi.advanceTimersByTime(1500);
    const replayCall = postMessageSpy.mock.calls[postMessageSpy.mock.calls.length - 1][0] as {
      payload: { url: string; videoId?: string };
    };
    expect(replayCall.payload.url).toContain('v=xyz');
    expect(replayCall.payload.videoId).toBe('xyz');
    vi.useRealTimers();
  });

  it('[M1-46] 空響應不更新 lastCapture，重播不發空', async () => {
    vi.useFakeTimers();
    await loadInterceptor();
    // 先捕獲一個非空響應。
    const xhr1 = new XMLHttpRequest();
    xhr1.open('GET', 'https://www.youtube.com/api/timedtext?v=abc');
    Object.defineProperty(xhr1, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr1, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr1.send();
    } catch {
      /* ignore */
    }
    xhr1.dispatchEvent(new Event('load'));
    const initialCallCount = postMessageSpy.mock.calls.length;
    // 再捕獲空響應（emitCapture 第 67 行 return，不更新 lastCapture）。
    const xhr2 = new XMLHttpRequest();
    xhr2.open('GET', 'https://www.youtube.com/api/timedtext?v=xyz');
    Object.defineProperty(xhr2, 'responseText', { value: '', configurable: true });
    try {
      xhr2.send();
    } catch {
      /* ignore */
    }
    xhr2.dispatchEvent(new Event('load'));
    // 空響應不 postMessage（即時不發）。
    expect(postMessageSpy).toHaveBeenCalledTimes(initialCallCount);
    // 推進 1.5s，重播應仍發舊的非空捕獲（v=abc），不發空。
    vi.advanceTimersByTime(1500);
    const replayCall = postMessageSpy.mock.calls[postMessageSpy.mock.calls.length - 1][0] as {
      payload: { url: string };
    };
    expect(replayCall.payload.url).toContain('v=abc');
    vi.useRealTimers();
  });

  it('[M1-46] 放寬 hostname 匹配：video.google.com/timedtext 被捕獲', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://video.google.com/timedtext?v=abc&lang=en');
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0] as { type: string; payload: { url: string } };
    expect(msg.type).toBe('ai-trans:timedtext-capture');
    expect(msg.payload.url).toContain('video.google.com');
  });

  it('[M1-46] 調試輔助：捕獲後 __aiTransTimedtextRequests 計數 + lastCapture 更新', async () => {
    await loadInterceptor();
    // 初始計數為 0。
    expect(Reflect.get(globalThis, '__aiTransTimedtextRequests')).toBe(0);
    expect(Reflect.get(globalThis, '__aiTransTimedtextLastCapture')).toBe(null);
    // 捕獲一次。
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=abc&lang=en');
    Object.defineProperty(xhr, 'responseText', { value: '{"events":[]}', configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    // 計數 +1，lastCapture 更新。
    expect(Reflect.get(globalThis, '__aiTransTimedtextRequests')).toBe(1);
    const lastCapture = Reflect.get(globalThis, '__aiTransTimedtextLastCapture') as {
      url: string;
      videoId?: string;
    };
    expect(lastCapture).not.toBe(null);
    expect(lastCapture.url).toContain('v=abc');
    expect(lastCapture.videoId).toBe('abc');
  });
});

describe('yt-timedtext-interceptor — fetch hook（M1-43）', () => {
  let origFetch: typeof globalThis.fetch;
  let origOpen: typeof XMLHttpRequest.prototype.open;
  let origSend: typeof XMLHttpRequest.prototype.send;
  let postMessageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origOpen = XMLHttpRequest.prototype.open;
    origSend = XMLHttpRequest.prototype.send;
    Reflect.deleteProperty(globalThis, '__aiTransTimedtextInterceptorInstalled');
    postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    Reflect.deleteProperty(globalThis, '__aiTransTimedtextInterceptorInstalled');
    postMessageSpy.mockRestore();
    vi.resetModules();
  });

  async function loadInterceptor(): Promise<void> {
    await import('../../src/runtime/yt-timedtext-interceptor?t=' + Date.now());
  }

  it('hook 後 timedtext fetch 捕獲響應並透傳原響應（不阻塞播放器）', async () => {
    const bodyText = '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"hi"}]}]}';
    const fakeRes = {
      clone: () => fakeRes,
      text: async () => bodyText,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
    };
    // 攔截器 install() 時把當前的 globalThis.fetch 綁定為原 fetch；
    // 因此 install 前先 mock 底層，讓攔截器包裝到它。
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(fakeRes as unknown as Response) as unknown as typeof fetch;
    await loadInterceptor();
    const wrapped = globalThis.fetch;
    // wrapped 應已替換為攔截器包裝（非原 mock）。
    const result = await wrapped('https://www.youtube.com/api/timedtext?v=abc', {});
    expect(result).toBe(fakeRes); // 透傳原響應（不阻塞播放器）
    await vi.waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalled();
    });
    const msg = postMessageSpy.mock.calls[0][0] as { type: string; payload: { url: string; responseText: string } };
    expect(msg.type).toBe('ai-trans:timedtext-capture');
    expect(msg.payload.url).toContain('timedtext');
    expect(msg.payload.responseText).toBe(bodyText);
  });

  it('非 timedtext fetch 不攔截（原樣透傳）', async () => {
    const fakeRes = { clone: () => fakeRes, text: async () => 'x', headers: { get: () => null } };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(fakeRes as unknown as Response) as unknown as typeof fetch;
    await loadInterceptor();
    const wrapped = globalThis.fetch;
    const result = await wrapped('https://www.youtube.com/api/stats/watchtime', {});
    expect(result).toBe(fakeRes);
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  // ── M1-47 §5.1/§5.5：responseType 硬化 ──
  // 真實環境播放器可能把 responseType 設為 'json'，此時讀 responseText 拋 InvalidStateError。
  // 硬化後應改從 xhr.response 讀取並 JSON.stringify，仍能捕獲。
  it('[M1-47] responseType=json 時從 response 讀取（不觸碰 responseText）', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    const url = 'https://www.youtube.com/api/timedtext?v=abc&pot=xyz&fmt=json3';
    xhr.open('GET', url);
    // 模擬 responseType='json'：response 為已解析對象；responseText 存取器設為拋錯（模擬真實瀏覽器）。
    Object.defineProperty(xhr, 'responseType', { value: 'json', configurable: true });
    Object.defineProperty(xhr, 'response', { value: { events: [{ segs: [] }] }, configurable: true });
    Object.defineProperty(xhr, 'responseText', {
      get() {
        throw new DOMException('InvalidStateError', 'InvalidStateError');
      },
      configurable: true,
    });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/json');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0] as { payload: { responseText: string } };
    expect(msg.payload.responseText).toBe(JSON.stringify({ events: [{ segs: [] }] }));
  });

  it('[M1-47] responseType=blob（二進制）時跳過，不 postMessage', async () => {
    await loadInterceptor();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=abc&fmt=srv3');
    Object.defineProperty(xhr, 'responseType', { value: 'blob', configurable: true });
    Object.defineProperty(xhr, 'response', { value: { size: 10 }, configurable: true });
    vi.spyOn(xhr, 'getResponseHeader').mockReturnValue('application/octet-stream');
    try {
      xhr.send();
    } catch {
      /* ignore */
    }
    xhr.dispatchEvent(new Event('load'));
    expect(postMessageSpy).not.toHaveBeenCalled();
  });
});

// ── M1-47：主動驅動播放器字幕模組（核心修復）──
// 背景：CC 關閉時播放器不發 timedtext 請求，攔截器捕獲不到 pot → 回退無 pot fetch → 空 body。
// 攔截器透過播放器 API（loadModule/getOption/setOption）主動選軌，逼播放器發帶 pot 的請求。
describe('yt-timedtext-interceptor — 字幕模組驅動（M1-47）', () => {
  const INSTALL_FLAG_2 = '__aiTransTimedtextInterceptorInstalled';
  let origOpen: typeof XMLHttpRequest.prototype.open;
  let origSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    origOpen = XMLHttpRequest.prototype.open;
    origSend = XMLHttpRequest.prototype.send;
    Reflect.deleteProperty(globalThis, INSTALL_FLAG_2);
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    Reflect.deleteProperty(globalThis, INSTALL_FLAG_2);
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.resetModules();
  });

  /** 建立帶字幕 API 的 mock 播放器元素並掛到 DOM。 */
  function mountMockPlayer(tracklist: unknown[]): {
    setOption: ReturnType<typeof vi.fn>;
    loadModule: ReturnType<typeof vi.fn>;
  } {
    const el = document.createElement('div');
    el.id = 'movie_player';
    const setOption = vi.fn();
    const loadModule = vi.fn();
    Object.assign(el, {
      loadModule,
      getOption: (m: string, k: string) => (m === 'captions' && k === 'tracklist' ? tracklist : undefined),
      setOption,
    });
    document.body.appendChild(el);
    return { setOption, loadModule };
  }

  async function loadInterceptor(): Promise<void> {
    await import('../../src/runtime/yt-timedtext-interceptor?t=' + Date.now());
  }

  it('播放器就緒且有字幕軌時，選人工軌 setOption 觸發字幕請求', async () => {
    const { setOption, loadModule } = mountMockPlayer([
      { languageCode: 'en', kind: 'asr' },
      { languageCode: 'en', kind: undefined }, // 人工軌
    ]);
    await loadInterceptor();
    // 驅動由 setInterval(1000ms) 重試；推進計時器觸發一次 ensureCaptionModuleLoaded。
    vi.advanceTimersByTime(1_000);
    expect(loadModule).toHaveBeenCalledWith('captions');
    expect(setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en', kind: undefined });
  });

  it('無字幕軌時不選軌，記錄 __aiTransCaptionTracks=0（診斷可見）', async () => {
    const { setOption } = mountMockPlayer([]);
    await loadInterceptor();
    vi.advanceTimersByTime(1_000);
    expect(setOption).not.toHaveBeenCalled();
    expect(Reflect.get(globalThis, '__aiTransCaptionTracks')).toBe(0);
  });

  it('選軌後短延遲復位（抑制原生字幕渲染）', async () => {
    const { setOption } = mountMockPlayer([{ languageCode: 'en', kind: undefined }]);
    await loadInterceptor();
    vi.advanceTimersByTime(1_000);
    setOption.mockClear();
    vi.advanceTimersByTime(3_100); // M1-48：延遲增加到 3000ms
    expect(setOption).toHaveBeenCalledWith('captions', 'track', {});
  });

  it('播放器未就緒時不拋錯，後續就緒後重試成功', async () => {
    // 首次無播放器 → 不動作；掛上播放器後下一輪重試觸發選軌。
    await loadInterceptor();
    vi.advanceTimersByTime(1_000); // 播放器缺席，靜默跳過
    const { setOption } = mountMockPlayer([{ languageCode: 'en', kind: undefined }]);
    vi.advanceTimersByTime(1_000); // 就緒後重試
    expect(setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en', kind: undefined });
  });

  it('set-target-lang 消息更新調試變量並重驅動', async () => {
    const { setOption } = mountMockPlayer([{ languageCode: 'en', kind: undefined }]);
    await loadInterceptor();
    vi.advanceTimersByTime(1_000); // 首輪驅動成功
    setOption.mockClear();
    // 發送 set-target-lang（模擬 SPA 換視頻 restart 重發）→ 重置並重驅動。
    // 使用 CustomEvent 替代 MessageEvent（M1-47 修復：避免 isolated world 與 MAIN world 通信問題）
    document.dispatchEvent(
      new CustomEvent('ai-trans:set-target-lang', {
        detail: { targetLang: 'zh-Hant' },
      })
    );
    expect(Reflect.get(globalThis, '__aiTransTargetLang')).toBe('zh-Hant');
    vi.advanceTimersByTime(1_000); // 重驅動輪
    expect(setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en', kind: undefined });
  });
});
