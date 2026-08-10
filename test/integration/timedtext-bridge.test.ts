import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimedTextBridge, POLL_INTERVAL_MS } from '../../src/runtime/timedtext-bridge';

// TimedTextBridge：MAIN world 攔截器 → content-script 的消息橋。
// 覆蓋 R4（註冊必配解除）、R7（外部消息容錯）、最新值覆蓋、注入冪等、
// stop 保留 latest（restart 不丟捕獲）、waitForCapture（M1-43 等待窗口）。

describe('TimedTextBridge — 消息接收與存儲', () => {
  let bridge: TimedTextBridge;

  beforeEach(() => {
    bridge = new TimedTextBridge();
  });

  afterEach(() => {
    bridge.dispose();
    vi.useRealTimers();
  });

  it('start 後收到 timedtext-capture 消息 → getLatest 返回捕獲值', () => {
    bridge.start();
    const payload = {
      url: 'https://www.youtube.com/api/timedtext?v=abc&pot=xyz',
      responseText: '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"hi"}]}]}',
      contentType: 'application/json',
      capturedAt: 123,
    };
    window.dispatchEvent(
      new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } })
    );
    expect(bridge.getLatest()).toEqual(payload);
  });

  it('後到的捕獲覆蓋先到的（最新優先）', () => {
    bridge.start();
    const p1 = { url: 'url1', responseText: '{"events":[]}', contentType: 'x', capturedAt: 1 };
    const p2 = { url: 'url2', responseText: '{"events":[]}', contentType: 'y', capturedAt: 2 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: p1 } }));
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: p2 } }));
    expect(bridge.getLatest()?.url).toBe('url2');
  });

  it('[R7] 忽略非本擴充消息（無 __aiTrans 標記）與畸形 payload', () => {
    bridge.start();
    window.dispatchEvent(new MessageEvent('message', { data: { foo: 'bar' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'other-event', payload: {} } }));
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: { url: 'x' } } })); // 缺 responseText
    expect(bridge.getLatest()).toBeNull();
  });

  it('dispose 後不再接收消息，且緩存清空（R4）', () => {
    bridge.start();
    const payload = { url: 'u', responseText: 'r', contentType: 'c', capturedAt: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } }));
    expect(bridge.getLatest()).not.toBeNull();
    bridge.dispose();
    expect(bridge.getLatest()).toBeNull();
    // dispose 後再發消息不應被接收
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: { url: 'u2', responseText: 'r2', contentType: 'c', capturedAt: 2 } } }));
    expect(bridge.getLatest()).toBeNull();
  });

  it('inject 冪等：多次調用只注入一次腳本', () => {
    const getURLSpy = vi.spyOn(chrome.runtime, 'getURL').mockReturnValue('chrome-extension://fake/yt-timedtext-interceptor.js');
    const appendSpy = vi.spyOn(document.head, 'appendChild');
    bridge.inject();
    bridge.inject();
    expect(getURLSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    getURLSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('start 冪等：重複調用不累積 message 監聽器（R4）', () => {
    const spy = vi.spyOn(globalThis, 'addEventListener');
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    // 清空歷史調用（本測試前其他測試可能留痕），只統計本測試內的淨增。
    spy.mockClear();
    removeSpy.mockClear();
    bridge.start();
    bridge.start();
    bridge.start();
    // 每次 start 先 remove 再 add：3 次 start → remove 3 次 + add 3 次。
    // 若未先 remove 會 add 3 份（累積）；此模式保證最終僅 1 份生效。
    const addMessage = spy.mock.calls.filter(([ev]) => ev === 'message');
    const removeMessage = removeSpy.mock.calls.filter(([ev]) => ev === 'message');
    expect(addMessage.length).toBe(3);
    expect(removeMessage.length).toBe(3);
    spy.mockRestore();
    removeSpy.mockRestore();
  });

  it('stop 保留 latest 緩存（restart 不丟已捕獲響應）', () => {
    bridge.start();
    const payload = { url: 'u', responseText: 'r', contentType: 'c', capturedAt: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } }));
    bridge.stop();
    // stop 後 latest 仍在
    expect(bridge.getLatest()).toEqual(payload);
    // stop 後不再接收消息
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: { url: 'u2', responseText: 'r2', contentType: 'c', capturedAt: 2 } } }));
    expect(bridge.getLatest()?.url).toBe('u');
  });

  it('clearLatest 清空 latest 緩存（視頻切換時避免複用舊字幕）', () => {
    bridge.start();
    const payload = { url: 'u', responseText: 'r', contentType: 'c', capturedAt: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } }));
    expect(bridge.getLatest()).toEqual(payload);
    bridge.clearLatest();
    expect(bridge.getLatest()).toBeNull();
    // clearLatest 後仍可接收新消息
    const newPayload = { url: 'u2', responseText: 'r2', contentType: 'c', capturedAt: 2 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: newPayload } }));
    expect(bridge.getLatest()).toEqual(newPayload);
  });

  it('waitForCapture：已有捕獲值立即返回（不等待）', async () => {
    bridge.start();
    const payload = { url: 'u', responseText: 'r', contentType: 'c', capturedAt: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } }));
    const result = await bridge.waitForCapture(100);
    expect(result).toEqual(payload);
  });

  it('waitForCapture：捕獲到達後 resolve（消息事件驅動）', async () => {
    vi.useFakeTimers();
    bridge.start();
    const payload = { url: 'u', responseText: 'r', contentType: 'c', capturedAt: 1 };
    const p = bridge.waitForCapture(5000);
    let resolved: unknown = 'pending';
    void p.then((v) => { resolved = v; });
    // 捕獲到達 → resolve 返回捕獲值
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual(payload);
  });

  it('[M1-46] 晚註冊監聽器收到重播捕獲：捕獲發生在 bridge.start() 之前，重播仍送達', async () => {
    // 背景：M1-45 把攔截器提前到 document_start（MAIN world），播放器在 document_idle 前
    // 發的 timedtext 請求被捕獲並 postMessage，但 bridge 監聽器（content-script）尚未註冊，
    // 即時消息丟失。修復：攔截器周期性重播最近捕獲（1.5s），晚註冊的監聽器最遲 1.5s 內收到。
    vi.useFakeTimers();
    // 捕獲已發生（模擬 interceptor 在 bridge.start() 之前發出了重播消息）。
    const payload = {
      url: 'https://www.youtube.com/api/timedtext?v=abc&pot=xyz',
      responseText: '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"hi"}]}]}',
      contentType: 'application/json',
      capturedAt: 1,
    };
    // 晚註冊監聽器：此刻才 start。
    bridge.start();
    // 監聽器註冊後，重播的捕獲消息送達 → latest 就緒。
    window.dispatchEvent(
      new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload } })
    );
    expect(bridge.getLatest()).toEqual(payload);
    // 等待捕獲也能立即命中（waitForCapture 對已就緒 latest 立即返回）。
    const result = await bridge.waitForCapture(5000);
    expect(result).toEqual(payload);
    vi.useRealTimers();
  });

  it('waitForCapture：超時返回 null，且 timer 不殘留（R4）', async () => {
    vi.useFakeTimers();
    bridge.start();
    const p = bridge.waitForCapture(500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeNull();
  });

  it('[M1-45] waitForCapture 指定期望 videoId：最新值不匹配則等待匹配的捕獲', async () => {
    vi.useFakeTimers();
    bridge.start();
    const p = bridge.waitForCapture(5000, 'bbb');
    let resolved: unknown = 'pending';
    void p.then((v) => { resolved = v; });
    // 先到的是視頻 A 的捕獲（不匹配 bbb）→ 不應 resolve
    const captureA = { url: 'u-a', responseText: 'r', contentType: 'c', capturedAt: 1, videoId: 'aaa' };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: captureA } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe('pending');
    // 視頻 B 的捕獲到達 → resolve
    const captureB = { url: 'u-b', responseText: 'r', contentType: 'c', capturedAt: 2, videoId: 'bbb' };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: captureB } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toEqual(captureB);
  });

  it('[M1-45] waitForCapture 指定期望 videoId：latest 已匹配則立即返回', async () => {
    bridge.start();
    const captureB = { url: 'u-b', responseText: 'r', contentType: 'c', capturedAt: 2, videoId: 'bbb' };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: captureB } }));
    const result = await bridge.waitForCapture(100, 'bbb');
    expect(result).toEqual(captureB);
  });

  it('[M1-45] waitForCapture 超時後輪詢器仍可被 stop 清理（R4 pollTimer 引用不丟失）', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    bridge.start();
    const p = bridge.waitForCapture(500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeNull();
    // 超時後 stop：若 pollTimer 引用被錯誤置 null，stop 不會調用 clearInterval（洩漏）。
    const before = clearSpy.mock.calls.length;
    bridge.stop();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });

  it('[M1-45] SPA 換視頻後 latest 保留但等待側以期望 videoId 過濾（不誤用舊視頻捕獲）', async () => {
    bridge.start();
    // 視頻 A 的捕獲已入 latest
    const captureA = { url: 'u-a', responseText: 'r', contentType: 'c', capturedAt: 1, videoId: 'aaa' };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: captureA } }));
    // 等待視頻 B（期望 bbb）→ 不立即返回 stale 的 A，需等 B 到來
    let resolved: unknown = 'pending';
    void bridge.waitForCapture(1000, 'bbb').then((v) => { resolved = v; });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe('pending');
    const captureB = { url: 'u-b', responseText: 'r', contentType: 'c', capturedAt: 2, videoId: 'bbb' };
    window.dispatchEvent(new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:timedtext-capture', payload: captureB } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toEqual(captureB);
  });

  it('輪詢器按 POLL_INTERVAL_MS 啟動（M1-43 探查節奏）', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    bridge.start();
    expect(setSpy).toHaveBeenCalled();
    // 輪詢 interval 為 2000ms
    const intervals = setSpy.mock.calls.map((c) => c[1]).filter((v): v is number => typeof v === 'number');
    expect(intervals).toContain(POLL_INTERVAL_MS);
    setSpy.mockRestore();
  });

  it('[M2-22 第三層] start 後收到 track-info 消息 → getCapturedTracks 返回軌道信息', () => {
    bridge.start();
    const tracks = [
      { lang: 'en', baseUrl: '/timedtext?v=abc&lang=en', isAutoGenerated: false, videoId: 'abc' },
      { lang: 'zh-Hant', baseUrl: '/timedtext?v=abc&lang=zh-Hant', isAutoGenerated: false, videoId: 'abc' },
    ];
    window.dispatchEvent(
      new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:track-info', payload: tracks } })
    );
    expect(bridge.getCapturedTracks()).toEqual(tracks);
    expect(bridge.getCapturedTracks('abc')).toEqual(tracks);
    expect(bridge.getCapturedTracks('xyz')).toEqual([]);
  });

  it('[M2-22 第三層] getCapturedTracks 無 track-info 時返回空陣列', () => {
    bridge.start();
    expect(bridge.getCapturedTracks()).toEqual([]);
    expect(bridge.getCapturedTracks('abc')).toEqual([]);
  });

  it('[M2-22 第四層] waitForCapturedTracks 已有軌道時立即返回', async () => {
    bridge.start();
    const tracks = [
      { lang: 'en', baseUrl: '/timedtext?v=abc&lang=en', isAutoGenerated: false, videoId: 'abc' },
    ];
    window.dispatchEvent(
      new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:track-info', payload: tracks } })
    );
    const result = await bridge.waitForCapturedTracks(1000, 'abc');
    expect(result).toEqual(tracks);
  });

  it('[M2-22 第四層] waitForCapturedTracks 等待軌道到達後返回', async () => {
    bridge.start();
    const tracks = [
      { lang: 'en', baseUrl: '/timedtext?v=abc&lang=en', isAutoGenerated: false, videoId: 'abc' },
    ];
    const promise = bridge.waitForCapturedTracks(5000, 'abc');
    // 延遲發送軌道信息
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:track-info', payload: tracks } })
      );
    }, 100);
    const result = await promise;
    expect(result).toEqual(tracks);
  });

  it('[M2-22 第四層] waitForCapturedTracks 超時返回空陣列', async () => {
    bridge.start();
    const result = await bridge.waitForCapturedTracks(100, 'abc');
    expect(result).toEqual([]);
  });

  it('[M2-22 第四層] waitForCapturedTracks 只返回匹配 videoId 的軌道', async () => {
    bridge.start();
    const tracks = [
      { lang: 'en', baseUrl: '/timedtext?v=abc&lang=en', isAutoGenerated: false, videoId: 'abc' },
      { lang: 'zh', baseUrl: '/timedtext?v=xyz&lang=zh', isAutoGenerated: false, videoId: 'xyz' },
    ];
    window.dispatchEvent(
      new MessageEvent('message', { data: { __aiTrans: true, type: 'ai-trans:track-info', payload: tracks } })
    );
    const result = await bridge.waitForCapturedTracks(1000, 'abc');
    expect(result).toEqual([tracks[0]]);
  });
});
