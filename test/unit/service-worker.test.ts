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
});
