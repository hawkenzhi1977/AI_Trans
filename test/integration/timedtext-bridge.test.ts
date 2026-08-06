import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimedTextBridge } from '../../src/runtime/timedtext-bridge';

// TimedTextBridge：MAIN world 攔截器 → content-script 的消息橋。
// 覆蓋 R4（註冊必配解除）、R7（外部消息容錯）、最新值覆蓋、注入冪等。

describe('TimedTextBridge — 消息接收與存儲', () => {
  let bridge: TimedTextBridge;

  beforeEach(() => {
    bridge = new TimedTextBridge();
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
});
