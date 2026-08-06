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

  it('waitForCapture：超時返回 null，且 timer 不殘留（R4）', async () => {
    vi.useFakeTimers();
    bridge.start();
    const p = bridge.waitForCapture(500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeNull();
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
});
