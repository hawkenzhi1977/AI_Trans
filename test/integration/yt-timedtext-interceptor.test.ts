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
});
