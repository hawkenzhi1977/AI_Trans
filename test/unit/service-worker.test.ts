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
