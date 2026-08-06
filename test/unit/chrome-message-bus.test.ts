import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChromeMessageBus } from '../../src/infrastructure/chrome-message-bus';

// 針對 §5.6（跨組件消息失敗不靜默）與 R4（監聽器註冊必解除）的專屬回歸測試。
// ChromeMessageBus 當前未接入主流程（M2 起用），但作為基礎設施必須在接入前合規。

function stubChromeRuntime() {
  const listeners = new Set<(msg: unknown) => void>();
  const removeSpy = vi.fn((cb: (msg: unknown) => void) => {
    listeners.delete(cb);
  });
  const sendSpy = vi.fn(() => Promise.resolve({}));
  const stub = {
    onMessage: {
      addListener: (cb: (msg: unknown) => void) => {
        listeners.add(cb);
      },
      removeListener: removeSpy,
    },
    sendMessage: sendSpy,
  };
  // 暴露 listeners 集合供測試驅動消息分發。
  (stub as unknown as { __listeners: typeof listeners }).__listeners = listeners;
  vi.stubGlobal('chrome', { runtime: stub });
  return { stub, removeSpy, sendSpy, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChromeMessageBus — §5.6 跨組件發送失敗區分', () => {
  it('無接收方（Receiving end does not exist）→ 靜默（常態，非失敗）', () => {
    const { sendSpy } = stubChromeRuntime();
    sendSpy.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new ChromeMessageBus();
    bus.publish('topic', { a: 1 });
    // 無接收方是常態：不應打警告
    return Promise.resolve().then(() => {
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('其他錯誤（序列化失敗/端口斷開）→ console 警告留痕，不靜默丟棄', () => {
    const { sendSpy } = stubChromeRuntime();
    sendSpy.mockRejectedValueOnce(new Error('DataCloneError: Failed to serialize'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new ChromeMessageBus();
    bus.publish('topic', { a: 1 });
    return Promise.resolve().then(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DataCloneError'));
      warnSpy.mockRestore();
    });
  });
});

describe('ChromeMessageBus — R4 註冊必解除', () => {
  it('dispose() 移除 runtime.onMessage 監聽並清空訂閱', () => {
    const { removeSpy } = stubChromeRuntime();
    const bus = new ChromeMessageBus();
    const unsub = bus.subscribe('t', () => {});
    unsub();
    bus.dispose();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('消息分發：僅觸發匹配 topic 的訂閱者', () => {
    const { listeners } = stubChromeRuntime();
    const bus = new ChromeMessageBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('alpha', a);
    bus.subscribe('beta', b);
    // 驅動 runtime.onMessage 分發
    for (const cb of listeners) cb({ topic: 'alpha', payload: 42 });
    expect(a).toHaveBeenCalledWith(42);
    expect(b).not.toHaveBeenCalled();
  });
});
