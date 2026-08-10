import { describe, it, expect, vi } from 'vitest';
import { FetchCaptionSource, YouTubePlatformAdapter } from '../../src/adapters/platform/youtube/platform-adapter';

// 針對 §5 紅線的專屬回歸測試：
//  R1 fetch 綁定、R2 URL 絕對化、R4 observePlayback 解除、R7 JSON/選擇器容錯。
// 這些在 jsdom 集成環境驗證（unit 為 node 無 DOM）。

function setPlayerResponse(json: string, opts?: { extraInlineScript?: string; named?: boolean }): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  if (opts?.extraInlineScript) {
    const noise = document.createElement('script');
    noise.textContent = opts.extraInlineScript;
    document.body.appendChild(noise);
  }
  const script = document.createElement('script');
  if (opts?.named !== false) script.id = 'ytInitialPlayerResponse';
  script.type = 'application/json';
  script.textContent = json;
  document.body.appendChild(script);
}

const validPlayerResponse = JSON.stringify({
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ baseUrl: '/timedtext?lang=en', languageCode: 'en', kind: 'standard' }],
    },
  },
});

describe('FetchCaptionSource — R1 fetch 綁定 / R2 URL 絕對化 / R7 JSON 容錯', () => {
  it('[R1] 默認 fetch 綁定 globalThis，不拋 Illegal invocation', async () => {
    setPlayerResponse(validPlayerResponse);
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] }),
    }) as Response);
    // 模擬宿主 fetch：this 必須為 globalThis，否則拋。
    const guard = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      return impl(...args);
    } as unknown as typeof fetch;
    vi.stubGlobal('fetch', guard);

    const src = new FetchCaptionSource(document); // 默認 fetch → 應被 bind
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(impl).toHaveBeenCalledOnce();
    expect(segs.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('[R2] 相對 baseUrl 被解析為絕對 URL 傳入 fetch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [] }),
    }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await src.fetchTracks('/timedtext?lang=en', 'en');
    const calledUrl = String(fetchFn.mock.calls[0][0]);
    // jsdom 默認 location 為 http://localhost/
    expect(calledUrl).toMatch(/^https?:\/\/[^/]+\/timedtext\?lang=en$/);
  });

  it('[TC-F16] 真實 YouTube timedtext URL 強制追加 fmt=json3（避免默認 srv3 XML 誤判）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [] }),
    }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await src.fetchTracks(
      'https://www.youtube.com/api/timedtext?lang=en&v=abc123',
      'en'
    );
    const calledUrl = new URL(String(fetchFn.mock.calls[0][0]));
    expect(calledUrl.searchParams.get('fmt')).toBe('json3');
    // 已有 fmt 參數時覆寫為 json3
    await src.fetchTracks(
      'https://www.youtube.com/api/timedtext?lang=en&fmt=srv3&v=abc123',
      'en'
    );
    const secondUrl = new URL(String(fetchFn.mock.calls[1][0]));
    expect(secondUrl.searchParams.get('fmt')).toBe('json3');
  });

  it('[TC-F16] 非 YouTube 域名的 timedtext 不追加 fmt（不破壞 Mock 站點契約）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [] }),
    }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await src.fetchTracks('http://localhost:8721/timedtext?lang=en', 'en');
    const calledUrl = new URL(String(fetchFn.mock.calls[0][0]));
    expect(calledUrl.searchParams.has('fmt')).toBe(false);
  });

  it('[R7] 具名 #ytInitialPlayerResponse 優先，忽略其他內聯腳本', async () => {
    setPlayerResponse(validPlayerResponse, {
      extraInlineScript: 'window.__ytExtra = 1;',
    });
    const src = new FetchCaptionSource(document);
    const list = await src.fetchTrackList();
    expect(list).toHaveLength(1);
    expect(list[0].lang).toBe('en');
    expect(list[0].baseUrl).toBe('/timedtext?lang=en');
  });

  it('[R7] 非法 JSON 不拋錯，返回空數組（避免誤判功能降級）', async () => {
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.id = 'ytInitialPlayerResponse';
    // type=application/json：jsdom 不會執行為 JS，僅作數據容器。
    script.type = 'application/json';
    script.textContent = '{ this is not valid json ]]';
    document.body.appendChild(script);
    const src = new FetchCaptionSource(document);
    await expect(src.fetchTrackList()).resolves.toEqual([]);
  });

  it('[R7] 頁面首個內聯腳本非字幕數據時不誤 parse 崩潰', async () => {
    document.body.innerHTML = '';
    const noise = document.createElement('script');
    // 合法 JS（jsdom 會執行），但不含 captionTracks，適配器應忽略並返回空。
    noise.textContent = 'window.__ytNoise = { unrelated: true };';
    document.body.appendChild(noise);
    const src = new FetchCaptionSource(document);
    // 沒有具名節點且無 captionTracks 內聯 → 返回空，不拋 SyntaxError
    await expect(src.fetchTrackList()).resolves.toEqual([]);
  });

  it('[R6/§5.6] 找不到 player response JSON → 返回空並記錄診斷（不靜默）', async () => {
    document.body.innerHTML = '';
    const noise = document.createElement('script');
    noise.textContent = 'window.__unrelated = 1;';
    document.body.appendChild(noise);
    const src = new FetchCaptionSource(document);
    await src.fetchTrackList();
    expect(src.getLastTrackDiagnostic()).toContain('player response JSON not found');
  });

  it('[R6/§5.6] 非法 JSON → 返回空並記錄解析失敗診斷', async () => {
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.id = 'ytInitialPlayerResponse';
    script.type = 'application/json';
    script.textContent = '{ this is not valid json ]]';
    document.body.appendChild(script);
    const src = new FetchCaptionSource(document);
    await src.fetchTrackList();
    expect(src.getLastTrackDiagnostic()).toContain('parse failed');
  });

  it('[R6/§5.6] 結構無 captionTracks → 記錄「無字幕軌」診斷；有軌則清空診斷', async () => {
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.id = 'ytInitialPlayerResponse';
    script.type = 'application/json';
    script.textContent = JSON.stringify({ some: 'response', without: 'captions' });
    document.body.appendChild(script);
    const src = new FetchCaptionSource(document);
    await src.fetchTrackList();
    expect(src.getLastTrackDiagnostic()).toContain('no captionTracks');

    // 有軌時診斷清空
    setPlayerResponse(validPlayerResponse);
    await src.fetchTrackList();
    expect(src.getLastTrackDiagnostic()).toBeUndefined();
  });

  it('[M2-22] videoId 不匹配（SPA 導航後 ytInitialPlayerResponse stale）→ 嘗試播放器 API fallback', async () => {
    // 當前頁面 URL 為視頻 B（v=bbb），但 ytInitialPlayerResponse 包含視頻 A（v=aaa）的數據。
    window.history.replaceState({}, '', '/watch?v=bbb');
    const stalePlayerResponse = JSON.stringify({
      videoDetails: { videoId: 'aaa' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: '/timedtext?v=aaa&lang=en', languageCode: 'en', kind: 'asr' }],
        },
      },
    });
    setPlayerResponse(stalePlayerResponse);
    // Mock 播放器元素 API 返回當前視頻的字幕軌。
    const mockPlayer = document.createElement('div');
    mockPlayer.id = 'movie_player';
    (mockPlayer as unknown as { getOption: (m: string, k: string) => unknown }).getOption = (m: string, k: string) => {
      if (m === 'captions' && k === 'tracklist') {
        return [{ baseUrl: '/timedtext?v=bbb&lang=en', languageCode: 'en', kind: 'standard' }];
      }
      return null;
    };
    document.body.appendChild(mockPlayer);
    const src = new FetchCaptionSource(document);
    const list = await src.fetchTrackList();
    // 應該返回播放器 API 的當前視頻字幕軌，而非 stale 數據。
    expect(list).toHaveLength(1);
    expect(list[0].baseUrl).toContain('v=bbb');
    expect(src.getLastTrackDiagnostic()).toContain('videoId mismatch');
    window.history.replaceState({}, '', '/');
  });

  it('[M2-22] videoId 不匹配且播放器 API 無軌 → 返回空並記錄診斷', async () => {
    window.history.replaceState({}, '', '/watch?v=bbb');
    const stalePlayerResponse = JSON.stringify({
      videoDetails: { videoId: 'aaa' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: '/timedtext?v=aaa&lang=en', languageCode: 'en' }],
        },
      },
    });
    setPlayerResponse(stalePlayerResponse);
    // 無播放器元素。
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.id = 'ytInitialPlayerResponse';
    script.type = 'application/json';
    script.textContent = stalePlayerResponse;
    document.body.appendChild(script);
    const src = new FetchCaptionSource(document);
    const list = await src.fetchTrackList();
    expect(list).toEqual([]);
    expect(src.getLastTrackDiagnostic()).toContain('videoId mismatch');
    window.history.replaceState({}, '', '/');
  });

  it('[M2-22] videoId 匹配 → 正常返回字幕軌（不觸發 fallback）', async () => {
    window.history.replaceState({}, '', '/watch?v=aaa');
    const matchingPlayerResponse = JSON.stringify({
      videoDetails: { videoId: 'aaa' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: '/timedtext?v=aaa&lang=en', languageCode: 'en', kind: 'standard' }],
        },
      },
    });
    setPlayerResponse(matchingPlayerResponse);
    const src = new FetchCaptionSource(document);
    const list = await src.fetchTrackList();
    expect(list).toHaveLength(1);
    expect(list[0].baseUrl).toContain('v=aaa');
    expect(src.getLastTrackDiagnostic()).toBeUndefined();
    window.history.replaceState({}, '', '/');
  });
});

describe('FetchCaptionSource — §5.6 拉取失敗診斷證據化', () => {
  it('HTTP 非 2xx → 診斷與錯誤含 status 與 URL', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await expect(src.fetchTracks('https://www.youtube.com/api/timedtext?lang=en', 'en')).rejects.toThrow(
      /timedtext fetch HTTP 403/
    );
    expect(src.getLastTrackDiagnostic()).toMatch(/HTTP 403/);
  });

  it('網絡層失敗 → 診斷與錯誤含原始錯誤與 URL（可區分 fetch vs parse）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await expect(
      src.fetchTracks('https://www.youtube.com/api/timedtext?lang=en', 'en')
    ).rejects.toThrow(/timedtext fetch failed: Failed to fetch/);
    expect(src.getLastTrackDiagnostic()).toContain('Failed to fetch');
    expect(src.getLastTrackDiagnostic()).toContain('timedtext');
  });

  it('200 但 body 為 HTML 錯誤頁 → 診斷含 content-type 與片段證據', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<!DOCTYPE html><html><head><title>Sign in</title></head><body>...</body></html>',
    }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    // jsdom DOMParser 對完整 HTML 走「missing transcript root」分支，但必須帶證據。
    await expect(src.fetchTracks('https://www.youtube.com/api/timedtext?lang=en', 'en')).rejects.toThrow(
      /body snippet/
    );
    expect(src.getLastTrackDiagnostic()).toContain('text/html');
    expect(src.getLastTrackDiagnostic()).toContain('actual root <html>');
  });

  it('200 但 body 為非法 JSON → 診斷含 json parse failed 與片段', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{ "events": [{"tStartMs":',
    }) as Response);
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch);
    await expect(src.fetchTracks('https://www.youtube.com/api/timedtext?lang=en', 'en')).rejects.toThrow(
      /timedtext JSON parse failed/
    );
    expect(src.getLastTrackDiagnostic()).toContain('application/json');
  });

  it('非法 baseUrl（new URL 拋錯）→ 診斷標記 URL 構造失敗（而非裸冒泡）', async () => {
    const src = new FetchCaptionSource(document);
    // jsdom 對 '%zz...' 不會拋錯（會百分比編碼），改用會真拋錯的輸入。
    await expect(src.fetchTracks('http://[::1', 'en')).rejects.toThrow(/URL construct failed/);
  });
});

describe('YouTubePlatformAdapter — R4 observePlayback 解除訂閱', () => {
  function mountVideo(): HTMLVideoElement {
    document.body.innerHTML = '<video class="html5-main-video"></video>';
    return document.querySelector<HTMLVideoElement>('video.html5-main-video')!;
  }

  it('[R4] observePlayback 返回的 unsubscribe 解除全部事件監聽', () => {
    const video = mountVideo();
    const addSpy = vi.spyOn(video, 'addEventListener');
    const removeSpy = vi.spyOn(video, 'removeEventListener');
    const adapter = new YouTubePlatformAdapter({ doc: document });

    const cb = vi.fn();
    const unsub = adapter.observePlayback(cb);
    const added = addSpy.mock.calls.map((c) => c[0]);
    expect(added.length).toBeGreaterThan(0);
    // 初次調用會立即讀一次狀態
    expect(cb).toHaveBeenCalled();

    unsub();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    // 每個註冊的事件都被解除
    for (const ev of added) expect(removed).toContain(ev);
    expect(removeSpy).toHaveBeenCalledTimes(addSpy.mock.calls.length);
  });

  it('[R4] 多次 observe/unsubscribe 後淨監聽器數為 0（不累積）', () => {
    const video = mountVideo();
    const addSpy = vi.spyOn(video, 'addEventListener');
    const removeSpy = vi.spyOn(video, 'removeEventListener');
    const adapter = new YouTubePlatformAdapter({ doc: document });

    for (let i = 0; i < 5; i++) {
      const unsub = adapter.observePlayback(() => {});
      unsub();
    }
    // add 次數 == remove 次數 → 無殘留
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
  });

  it('[R6] 播放器缺失時 observePlayback 返回 noop 而非拋錯', () => {
    document.body.innerHTML = '';
    const adapter = new YouTubePlatformAdapter({ doc: document });
    const unsub = adapter.observePlayback(() => {});
    expect(() => unsub()).not.toThrow();
  });

  it('[§5.6] 播放器 <video> 缺失時 observePlayback 打麵包屑警告（不靜默）', () => {
    document.body.innerHTML = '';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new YouTubePlatformAdapter({ doc: document });
    adapter.observePlayback(() => {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('video element not found'));
    warnSpy.mockRestore();
  });
});

describe('FetchCaptionSource — MAIN world 捕獲響應複用', () => {
  const validJson = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'captured' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'second' }] },
    ],
  });

  it('有捕獲值 → 優先複用捕獲響應，不發 fetch', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as Response);
    const provider = {
      getLatest: vi.fn(() => ({ url: 'https://www.youtube.com/api/timedtext?v=abc', responseText: validJson, contentType: 'application/json' })),
    };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs).toHaveLength(2);
    expect(segs[0].sourceText).toBe('captured');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('無捕獲值 → 回退直接 fetch（原有行為不變）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    const provider = { getLatest: vi.fn(() => null) };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('fetched');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('捕獲響應解析失敗（非字幕內容）→ 記診斷並回退 fetch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    const provider = {
      getLatest: vi.fn(() => ({ url: 'u', responseText: '<html>error</html>', contentType: 'text/html' })),
    };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('fetched');
    expect(src.getLastTrackDiagnostic()).toContain('capture parse failed');
  });

  it('捕獲值為 srv3 XML 也能解析（播放器無 fmt 時的默認格式）', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as Response);
    const srv3 = `<?xml version="1.0" encoding="utf-8"?><timedtext format="3"><body><p t="0" d="1500"><s>Hello</s> <s>world</s></p></body></timedtext>`;
    const provider = { getLatest: vi.fn(() => ({ url: 'u', responseText: srv3, contentType: 'text/xml' })) };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('Hello world');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('捕獲值為空字符串 → 忽略，走 fetch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    const provider = { getLatest: vi.fn(() => ({ url: 'u', responseText: '', contentType: 'text/html' })) };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('fetched');
  });

  it('[M1-43] 無捕獲值 → 等待播放器捕獲後複用（不發 fetch）', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"events":[]}',
    }) as Response);
    const captured = { url: 'https://www.youtube.com/api/timedtext?v=abc', responseText: validJson, contentType: 'application/json' };
    const provider = {
      getLatest: vi.fn(() => null), // 首次無捕獲
      waitForCapture: vi.fn(async () => captured), // 等待後捕獲到
    };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs).toHaveLength(2);
    expect(segs[0].sourceText).toBe('captured');
    // M2-22：傳入 expectedVideoId（從當前 URL 提取），確保只接受當前視頻的捕獲。
    // jsdom 默認 location 為 http://localhost/，無 v 參數，故 expectedVideoId 為 undefined。
    expect(provider.waitForCapture).toHaveBeenCalledWith(15_000, undefined);
    expect(fetchFn).not.toHaveBeenCalled(); // 複用捕獲，未直接 fetch
  });

  it('[M1-43] 等待超時（播放器無字幕/未播放）→ 回退直接 fetch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    const provider = {
      getLatest: vi.fn(() => null),
      waitForCapture: vi.fn(async () => null), // 超時無捕獲
    };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('fetched');
    expect(fetchFn).toHaveBeenCalledOnce();
    // §5.6：等待超時必須留痕（與「捕獲解析失敗」可區分），回退原因對用戶可見。
    expect(src.getLastTrackDiagnostic()).toContain('timedtext capture wait timeout');
  });

  it('[M1-43] provider 無 waitForCapture（舊實現）→ 不等待直接 fetch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    const provider = { getLatest: vi.fn(() => null) }; // 僅 getLatest，無 waitForCapture
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs[0].sourceText).toBe('fetched');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('[M2-22] 視頻切換時 stale 捕獲被拒絕（videoId 不匹配）', async () => {
    // M2-22：恢復 videoId 驗證——攔截器的 lastCapture 在 MAIN world，
    // bridge.clearLatest() 只清空 isolated world 的緩存，MAIN world 的 lastCapture
    // 仍可能保留舊視頻的捕獲。必須驗證捕獲的 videoId 與當前視頻匹配。
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'fetched' }] }] }),
    }) as Response);
    // 當前頁面 URL 為視頻 B（v=bbb），捕獲來自視頻 A（v=aaa）。
    window.history.replaceState({}, '', '/watch?v=bbb');
    const capturedA = { url: 'https://www.youtube.com/api/timedtext?v=aaa', responseText: validJson, contentType: 'application/json', videoId: 'aaa' };
    const provider = {
      getLatest: vi.fn(() => capturedA), // latest 是舊視頻 A 的 stale 捕獲
    };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    // M2-22 新行為：stale 捕獲被拒絕，回退到直接 fetch
    expect(segs).toHaveLength(1);
    expect(segs[0].sourceText).toBe('fetched');
    expect(fetchFn).toHaveBeenCalledOnce(); // 回退直接 fetch
    window.history.replaceState({}, '', '/');
  });

  it('[M1-45] 捕獲屬於當前視頻 → 正常複用（不誤傷）', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as Response);
    window.history.replaceState({}, '', '/watch?v=bbb');
    const capturedB = { url: 'https://www.youtube.com/api/timedtext?v=bbb', responseText: validJson, contentType: 'application/json', videoId: 'bbb' };
    const provider = { getLatest: vi.fn(() => capturedB) };
    const src = new FetchCaptionSource(document, fetchFn as unknown as typeof fetch, provider);
    const segs = await src.fetchTracks('/timedtext?lang=en', 'en');
    expect(segs).toHaveLength(2);
    expect(fetchFn).not.toHaveBeenCalled(); // 複用當前視頻捕獲，不發 fetch
    window.history.replaceState({}, '', '/');
  });
});
