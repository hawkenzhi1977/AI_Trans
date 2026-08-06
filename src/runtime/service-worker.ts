// Service Worker 入口：MV3 中負責全局配置與消息路由。
// M1 的重點邏輯在 Content Script 側；SW 保持輕量，避免被回收中斷。
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';

// 保持 SW 存活以供配置存取；實際業務在 Content Script。
const store = new ChromeStorageConfigStore();

void store.get(); // 預熱存儲緩存

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { topic?: string; payload?: unknown };
  if (msg.topic === 'config:get') {
    // §5.6：storage 讀取失敗必須 sendResponse 錯誤，否則調用方 Promise 永久掛起（靜默）。
    void store
      .get()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: `config:get failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    return true; // 異步響應
  }
  if (msg.topic === 'config:set') {
    // Options 保存配置 → 寫入存儲；訂閱者（content-script）收到變更。
    // §5.6：寫入失敗同樣必須 sendResponse 錯誤而非不觸發（避免調用方懸掛）。
    const patch = (msg.payload ?? {}) as Parameters<ChromeStorageConfigStore['set']>[0];
    void store
      .set(patch)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: `config:set failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    return true;
  }
  return false;
});
