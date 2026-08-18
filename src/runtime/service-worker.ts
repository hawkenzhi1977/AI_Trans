// Service Worker 入口：MV3 中負責全局配置與消息路由。
// M1 的重點邏輯在 Content Script 側；SW 保持輕量，避免被回收中斷。
// 同時負責本地 ONNX 翻譯模型的消息路由（轉發給 Offscreen Document）。
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';

// 保持 SW 存活以供配置存取；實際業務在 Content Script。
const store = new ChromeStorageConfigStore();

void store.get(); // 預熱存儲緩存

/** Offscreen Document reason（用於 chrome.offscreen.createDocument）。 */
const OFFSCREEN_REASON = 'LOCAL_ONNX_INFERENCE';
/** Offscreen Document 的 URL（copy-static 拷貝到 dist/src/runtime/offscreen.html，故含子路徑）。 */
const OFFSCREEN_URL = 'src/runtime/offscreen.html';

/** Offscreen Document 的 port 連接（用於 local-onnx 消息）。 */
let offscreenPort: chrome.runtime.Port | null = null;

/**
 * 確保 Offscreen Document 存在——MV3 中 SW 無法持有大模型，
 * 故將 ONNX 推理移至 Offscreen Document（具備完整 DOM 與 WebGPU/WASM 支援）。
 */
async function ensureOffscreenDocument(): Promise<void> {
  // 檢查是否已有 offscreen document。
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existingContexts.length > 0) return;

  // 建立 offscreen document。
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: OFFSCREEN_REASON,
  });
}

/**
 * 發送消息給 Offscreen Document 並等待響應。
 * 使用 port 連接確保消息只發送給 Offscreen Document（避免廣播循環）。
 */
async function sendToOffscreen<T>(message: unknown): Promise<T> {
  await ensureOffscreenDocument();

  // 等待 Offscreen Document 建立 port 連接（最多 5 秒）。
  const maxWait = 5000;
  const startTime = Date.now();
  while (!offscreenPort && Date.now() - startTime < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!offscreenPort) {
    throw new Error('Offscreen Document port not established within timeout');
  }

  // 通過 port 發送消息，並等待響應。
  return new Promise((resolve, reject) => {
    const messageId = Math.random().toString(36).substring(7);
    const msg = message as Record<string, unknown>;

    // 監聽 port 消息，等待響應。
    const responseListener = (response: unknown) => {
      const res = response as { messageId?: string; result?: unknown; error?: string };
      if (res.messageId === messageId) {
        offscreenPort?.onMessage.removeListener(responseListener);
        if (res.error) {
          reject(new Error(res.error));
        } else {
          resolve(res.result as T);
        }
      }
    };
    offscreenPort!.onMessage.addListener(responseListener);

    // 發送消息。
    offscreenPort!.postMessage({ ...msg, messageId });

    // 超時處理（30 秒）。
    setTimeout(() => {
      offscreenPort?.onMessage.removeListener(responseListener);
      reject(new Error('Offscreen Document response timeout'));
    }, 30000);
  });
}

/**
 * 監聽 Offscreen Document 的 port 連接。
 * Offscreen Document 啟動時主動連接，建立雙向通信通道。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-onnx') {
    offscreenPort = port;
    port.onDisconnect.addListener(() => {
      offscreenPort = null;
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { topic?: string; payload?: unknown };

  // 配置相關消息處理。
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

  // 本地 ONNX 翻譯模型相關消息——轉發給 Offscreen Document。
  if (msg.topic?.startsWith('local-onnx:')) {
    void sendToOffscreen(msg)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: `local-onnx operation failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    return true;
  }

  return false;
});
