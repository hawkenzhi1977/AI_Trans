// Service Worker 入口：MV3 中負責全局配置與消息路由。
// M1 的重點邏輯在 Content Script 側；SW 保持輕量，避免被回收中斷。
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';

// 保持 SW 存活以供配置存取；實際業務在 Content Script。
const store = new ChromeStorageConfigStore();

void store.get(); // 預熱存儲緩存

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { topic?: string; payload?: unknown };
  if (msg.topic === 'config:get') {
    void store.get().then(sendResponse);
    return true; // 異步響應
  }
  return false;
});
