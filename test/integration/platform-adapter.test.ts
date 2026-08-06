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
