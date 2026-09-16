import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';

// service-worker.ts 在 import 時註冊 onMessage 監聽。測試動態 import 後取出監聽器驅動。
// 驗證 §5.6：storage 讀/寫失敗必須 sendResponse 錯誤，不讓調用方 Promise 永久掛起。

function getListener(): (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => boolean {
  const chromeMock = chrome as unknown as {
    runtime: {
      onMessage: {
        addListener: ReturnType<typeof vi.fn>;
      };
    };
  };
  const addListenerMock = chromeMock.runtime.onMessage.addListener;
  expect(addListenerMock).toHaveBeenCalled();
  return addListenerMock.mock.calls[0][0];
}

async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import('../../src/runtime/service-worker');
}

describe('Service Worker — §5.6 配置路由失敗響應', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  it('config:get 成功 → sendResponse({ok:true, config})', async () => {
    await loadWorker();
    const listener = getListener();
    await chrome.storage.local.set({
      engineConfig: { translation: { type: 'mt' }, asr: { type: 'cloud' } },
    });
    const sendResponse = vi.fn();
    const keep = listener({ topic: 'config:get' }, {}, sendResponse);
    expect(keep).toBe(true); // 異步響應
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true })
    );
  });

  it('config:get 失敗 → sendResponse({ok:false, error})（不懸掛）', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage down')
    );
    const sendResponse = vi.fn();
    listener({ topic: 'config:get' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('storage down') })
    );
  });

  it('config:set 失敗 → sendResponse({ok:false, error})（不懸掛）', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('quota exceeded')
    );
    const sendResponse = vi.fn();
    listener({ topic: 'config:set', payload: { targetLang: 'ja' } }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('quota exceeded') })
    );
  });

  it('未知 topic → 返回 false（不 keep 通道）', async () => {
    await loadWorker();
    const listener = getListener();
    expect(listener({ topic: 'unknown' }, {}, vi.fn())).toBe(false);
  });
});

describe('Service Worker — offscreen 空閒關閉（M2-25）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  function getListener(): (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => boolean {
    const chromeMock = chrome as unknown as {
      runtime: {
        onMessage: {
          addListener: ReturnType<typeof vi.fn>;
        };
      };
    };
    return chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
  }

  it('offscreen:idle-close → 調用 chrome.offscreen.closeDocument 並清空 port', async () => {
    await loadWorker();
    const listener = getListener();
    const closeDocMock = chrome.offscreen.closeDocument as ReturnType<typeof vi.fn>;
    expect(listener({ topic: 'offscreen:idle-close' }, {}, vi.fn())).toBe(true); // M2-45: 改為異步響應
    await new Promise((r) => setTimeout(r, 20));
    expect(closeDocMock).toHaveBeenCalledTimes(1);
  });

  it('offscreen:idle-close 關閉失敗 → 落診斷（§5.6 不靜默）', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.offscreen.closeDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('offscreen already closed')
    );
    listener({ topic: 'offscreen:idle-close' }, {}, vi.fn());
    await new Promise((r) => setTimeout(r, 20));
    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toBeDefined();
    expect(rec!.message).toContain('offscreen already closed');
  });
});

// M2-26：SW 生命週期麵包屑（空閒回收/重啟可見）+ offscreen created。
describe('Service Worker — 生命週期麵包屑（M2-26）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  function getLifecycleListener(event: 'onStartup' | 'onInstalled' | 'onSuspend'): () => void {
    const chromeMock = chrome as unknown as {
      runtime: Record<string, { addListener: ReturnType<typeof vi.fn> }>;
    };
    const addListenerMock = chromeMock.runtime[event].addListener;
    expect(addListenerMock).toHaveBeenCalled();
    return addListenerMock.mock.calls[0][0] as () => void;
  }

  it('onStartup / onInstalled / onSuspend → console.warn 麵包屑', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadWorker();

    getLifecycleListener('onStartup')();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SW onStartup'));

    getLifecycleListener('onInstalled')();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SW onInstalled'));

    getLifecycleListener('onSuspend')();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SW onSuspend'));

    warnSpy.mockRestore();
  });

  it('offscreen created → console.warn 麵包屑（createDocument 前）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadWorker();

    const addListenerMock = (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listener = addListenerMock.mock.calls[0][0] as any;

    // 觸發一個需要 ensureOffscreenDocument 的路徑（local-onnx: 轉發）。
    listener({ topic: 'local-onnx:check-status' }, {}, vi.fn());
    await new Promise((r) => setTimeout(r, 20));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('offscreen created'));
    warnSpy.mockRestore();
  });
});

// M2-26 補充：移除 manifest `commands` 鍵後，真實 Chrome 不再注入 `chrome.commands`
// 命名空間（undefined）。頂層未守衛的 `chrome.commands.onCommand` 引用會令 SW 註冊失敗
// （status 15）。jsdom mock 與 E2E Chromium 都注入該命名空間，唯有此回歸測試貼近真實。
describe('Service Worker — chrome.commands 未定義仍可求值（M2-26 補充）', () => {
  beforeEach(() => {
    resetChromeMock();
    // 模擬真實 Chrome：manifest 無 commands 鍵 → chrome.commands 命名空間被裁剪。
    delete (chrome as unknown as { commands?: unknown }).commands;
  });

  it('SW 模組頂層求值不依賴 chrome.commands（不拋 TypeError）', async () => {
    expect((chrome as unknown as { commands?: unknown }).commands).toBeUndefined();
    await expect(loadWorker()).resolves.not.toThrow();
  });
});

// M2-52：asr:get-stream-id 在 SW 中調用 tabCapture.getMediaStreamId（Chrome 116+ render process 限制）。
describe('Service Worker — asr:get-stream-id（M2-52）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  function getListener(): (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => boolean {
    const chromeMock = chrome as unknown as {
      runtime: { onMessage: { addListener: ReturnType<typeof vi.fn> } };
    };
    return chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
  }

  it('成功 → sendResponse({ ok: true, streamId }) 並返回 true（異步響應）', async () => {
    await loadWorker();
    const listener = getListener();
    const getStreamIdMock = (chrome as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } })
      .tabCapture.getMediaStreamId;
    // callback 風格：mock 實現直接調用第二個參數（callback）
    getStreamIdMock.mockImplementationOnce((_opts: unknown, cb: (id: string) => void) => {
      cb('test-stream-id-abc');
    });
    const sendResponse = vi.fn();
    const keep = listener({ topic: 'asr:get-stream-id' }, {}, sendResponse);
    expect(keep).toBe(true); // 異步響應
    await new Promise((r) => setTimeout(r, 20));
    expect(getStreamIdMock).toHaveBeenCalledWith({}, expect.any(Function));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, streamId: 'test-stream-id-abc' });
  });

  it('getMediaStreamId 失敗（lastError 設置）→ sendResponse({ ok: false, error })（§5.6 不靜默掛起）', async () => {
    await loadWorker();
    const listener = getListener();
    const getStreamIdMock = (chrome as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } })
      .tabCapture.getMediaStreamId;
    // 模擬 chrome.runtime.lastError 設置的失敗情境
    getStreamIdMock.mockImplementationOnce((_opts: unknown, cb: (id: string) => void) => {
      // 設置 lastError 後再調用 callback（Chrome API 慣例）
      Object.defineProperty(chrome.runtime, 'lastError', {
        value: { message: 'tabCapture permission denied' },
        configurable: true,
      });
      cb('');
      // callback 返回後清除 lastError
      Object.defineProperty(chrome.runtime, 'lastError', {
        value: undefined,
        configurable: true,
      });
    });
    const sendResponse = vi.fn();
    listener({ topic: 'asr:get-stream-id' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('tabCapture permission denied'),
      })
    );
  });

  it('getMediaStreamId 拋出例外 → sendResponse({ ok: false, error })（§5.6 不靜默掛起）', async () => {
    await loadWorker();
    const listener = getListener();
    const getStreamIdMock = (chrome as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } })
      .tabCapture.getMediaStreamId;
    getStreamIdMock.mockImplementationOnce(() => {
      throw new Error('API not available');
    });
    const sendResponse = vi.fn();
    listener({ topic: 'asr:get-stream-id' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('API not available'),
      })
    );
  });

  it('M2-67：offscreen port 存在時先發 asr:release-stream 再調 getMediaStreamId', async () => {
    await loadWorker();
    const listener = getListener();

    // 模擬 offscreen port 已連接（offscreen-onnx）。
    const postMessageMock = vi.fn();
    const onMessageAddMock = vi.fn();
    const onDisconnectAddMock = vi.fn();
    const fakePort = {
      name: 'offscreen-onnx',
      postMessage: postMessageMock,
      onMessage: { addListener: onMessageAddMock, removeListener: vi.fn() },
      onDisconnect: { addListener: onDisconnectAddMock, removeListener: vi.fn() },
      disconnect: vi.fn(),
    };
    const onConnectAdd = (chrome.runtime.onConnect.addListener as ReturnType<typeof vi.fn>);
    onConnectAdd.mock.calls[0][0](fakePort as unknown as chrome.runtime.Port);

    // 模擬 offscreen 回應 release-stream（sendToOffscreen 等待 messageId 匹配）。
    // sendToOffscreen 會生成隨機 messageId，我們需要攔截 postMessage 並回傳。
    postMessageMock.mockImplementation((msg: { messageId?: string }) => {
      // 找到已註冊的 responseListener 並觸發。
      const listenerCb = onMessageAddMock.mock.calls[0]?.[0];
      if (listenerCb && msg.messageId) {
        listenerCb({ messageId: msg.messageId, result: { released: true } });
      }
    });

    const getStreamIdMock = (chrome as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } })
      .tabCapture.getMediaStreamId;
    getStreamIdMock.mockImplementationOnce((_opts: unknown, cb: (id: string) => void) => {
      cb('fresh-stream-id');
    });

    const sendResponse = vi.fn();
    listener({ topic: 'asr:get-stream-id' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 50));

    // release-stream 消息已發送給 offscreen。
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'asr:release-stream' })
    );
    // getMediaStreamId 在 release 之後調用。
    expect(getStreamIdMock).toHaveBeenCalled();
    // 最終響應成功。
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, streamId: 'fresh-stream-id' });
  });

  it('M2-67：offscreen port 不存在時跳過 release，直接調 getMediaStreamId', async () => {
    await loadWorker();
    const listener = getListener();

    // 不連接任何 offscreen port（offscreenPort 為 null）。
    const getStreamIdMock = (chrome as unknown as { tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> } })
      .tabCapture.getMediaStreamId;
    getStreamIdMock.mockImplementationOnce((_opts: unknown, cb: (id: string) => void) => {
      cb('direct-stream-id');
    });

    const sendResponse = vi.fn();
    listener({ topic: 'asr:get-stream-id' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 50));

    // getMediaStreamId 仍被調用（release 跳過不阻塞）。
    expect(getStreamIdMock).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, streamId: 'direct-stream-id' });
  });
});

// M2-45：Content-script 透過 SW 創建 Offscreen Document（chrome.offscreen 僅在 SW 可用）。
describe('Service Worker — offscreen:ensure-created（M2-45）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  function getListener(): (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => boolean {
    const chromeMock = chrome as unknown as {
      runtime: {
        onMessage: {
          addListener: ReturnType<typeof vi.fn>;
        };
      };
    };
    return chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
  }

  it('offscreen:ensure-created → 調用 chrome.offscreen.createDocument 並響應 ok', async () => {
    await loadWorker();
    const listener = getListener();
    const createDocMock = chrome.offscreen.createDocument as ReturnType<typeof vi.fn>;
    const sendResponse = vi.fn();
    const keep = listener({ topic: 'offscreen:ensure-created' }, {}, sendResponse);
    expect(keep).toBe(true); // 異步響應
    await new Promise((r) => setTimeout(r, 20));
    expect(createDocMock).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('offscreen:ensure-created 失敗 → sendResponse({ok:false, error})', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.offscreen.createDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('offscreen create failed')
    );
    const sendResponse = vi.fn();
    listener({ topic: 'offscreen:ensure-created' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('offscreen create failed') })
    );
  });

  it('M2-69：createDocument 被拒 single offscreen + getContexts 查到已存在 → 視為成功（ok:true）', async () => {
    await loadWorker();
    const listener = getListener();
    // 模擬真實 Chrome：createDocument 拋「Only a single offscreen document may be created」。
    (chrome.offscreen.createDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Only a single offscreen document may be created.')
    );
    // getContexts 重查時返回已存在的 offscreen context（首次檢查返空 → 觸發 createDocument）。
    const getContextsMock = chrome.runtime.getContexts as ReturnType<typeof vi.fn>;
    getContextsMock
      .mockResolvedValueOnce([]) // 首次 hasOffscreenDocument → 空 → createDocument
      .mockResolvedValueOnce([{ contextType: 'OFFSCREEN_DOCUMENT' }]); // catch 重查 → 已存在
    const sendResponse = vi.fn();
    listener({ topic: 'offscreen:ensure-created' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    // 被拒後重查確認存在 → 不拋錯 → ok:true。
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('M2-69：createDocument 被拒 single offscreen + getContexts 仍查不到 → 拋錯（ok:false）', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.offscreen.createDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Only a single offscreen document may be created.')
    );
    // getContexts 始終返空（重查也查不到）→ 應拋錯。
    (chrome.runtime.getContexts as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const sendResponse = vi.fn();
    listener({ topic: 'offscreen:ensure-created' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('single offscreen document') })
    );
  });

  it('M2-69：createDocument 被拒非 single offscreen 錯誤 → 直接拋錯（不重查）', async () => {
    await loadWorker();
    const listener = getListener();
    (chrome.offscreen.createDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('offscreen api unavailable')
    );
    const sendResponse = vi.fn();
    listener({ topic: 'offscreen:ensure-created' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('offscreen api unavailable') })
    );
  });
});
