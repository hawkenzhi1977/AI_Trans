// src/domain/models/config.ts
var DEBUG_LOG_OFF = {
  overlay: false,
  llm: false,
  capture: false,
  pipeline: false,
  strategy: false,
  content: false,
  bridge: false,
  interceptor: false
};
var DEFAULT_CONFIG = {
  translation: { type: "cloud-llm", fallbackType: "mt" },
  asr: { type: "local-whisper", modelTier: "base" },
  targetLang: "zh-Hant",
  displayMode: "bilingual",
  performanceProfile: "balanced",
  subtitleStyle: {
    "font-size": "24px",
    color: "#ffffff",
    "background-color": "rgba(32, 32, 32, 0.7)"
  },
  debugLog: DEBUG_LOG_OFF
};

// src/infrastructure/chrome-config-store.ts
var ChromeStorageConfigStore = class _ChromeStorageConfigStore {
  static KEY = "engineConfig";
  static KEYS_KEY = "engineConfigKeys";
  async get() {
    const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEY);
    const raw = stored[_ChromeStorageConfigStore.KEY];
    return this.merge(DEFAULT_CONFIG, raw ?? {});
  }
  async set(patch) {
    const current = await this.get();
    const next = this.merge(current, patch);
    await chrome.storage.local.set({ [_ChromeStorageConfigStore.KEY]: next });
    for (const cb of this.subscribers) cb(next);
  }
  /** 讀取某引擎的 API 密鑰（獨立安全 key）。 */
  async getApiKey(slot) {
    const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEYS_KEY);
    const keys = stored[_ChromeStorageConfigStore.KEYS_KEY] ?? {};
    return keys[slot];
  }
  /** 寫入某引擎的 API 密鑰。 */
  async setApiKey(slot, value) {
    const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEYS_KEY);
    const keys = stored[_ChromeStorageConfigStore.KEYS_KEY] ?? {};
    keys[slot] = value;
    await chrome.storage.local.set({ [_ChromeStorageConfigStore.KEYS_KEY]: keys });
  }
  subscribe(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
  subscribers = /* @__PURE__ */ new Set();
  merge(base, patch) {
    return {
      ...base,
      ...patch,
      translation: { ...base.translation, ...patch.translation ?? {} },
      asr: { ...base.asr, ...patch.asr ?? {} },
      // M1-51：debugLog 深合併——舊配置缺 debugLog 時補全鍵，避免 undefined 崩壞。
      debugLog: { ...DEFAULT_CONFIG.debugLog, ...patch.debugLog ?? {} }
    };
  }
};

// src/runtime/service-worker.ts
var store = new ChromeStorageConfigStore();
void store.get();
var OFFSCREEN_REASON = "LOCAL_ONNX_INFERENCE";
var OFFSCREEN_URL = "src/runtime/offscreen.html";
var offscreenPort = null;
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: OFFSCREEN_REASON
  });
}
async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  const maxWait = 5e3;
  const startTime = Date.now();
  while (!offscreenPort && Date.now() - startTime < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!offscreenPort) {
    throw new Error("Offscreen Document port not established within timeout");
  }
  return new Promise((resolve, reject) => {
    const messageId = Math.random().toString(36).substring(7);
    const msg = message;
    const responseListener = (response) => {
      const res = response;
      if (res.messageId === messageId) {
        offscreenPort?.onMessage.removeListener(responseListener);
        if (res.error) {
          reject(new Error(res.error));
        } else {
          resolve(res.result);
        }
      }
    };
    offscreenPort.onMessage.addListener(responseListener);
    offscreenPort.postMessage({ ...msg, messageId });
    setTimeout(() => {
      offscreenPort?.onMessage.removeListener(responseListener);
      reject(new Error("Offscreen Document response timeout"));
    }, 3e4);
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "offscreen-onnx") {
    offscreenPort = port;
    port.onDisconnect.addListener(() => {
      offscreenPort = null;
    });
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message;
  if (msg.topic === "config:get") {
    void store.get().then((config) => sendResponse({ ok: true, config })).catch(
      (err) => sendResponse({
        ok: false,
        error: `config:get failed: ${err instanceof Error ? err.message : String(err)}`
      })
    );
    return true;
  }
  if (msg.topic === "config:set") {
    const patch = msg.payload ?? {};
    void store.set(patch).then(() => sendResponse({ ok: true })).catch(
      (err) => sendResponse({
        ok: false,
        error: `config:set failed: ${err instanceof Error ? err.message : String(err)}`
      })
    );
    return true;
  }
  if (msg.topic?.startsWith("local-onnx:")) {
    void sendToOffscreen(msg).then((result) => sendResponse({ ok: true, result })).catch(
      (err) => sendResponse({
        ok: false,
        error: `local-onnx operation failed: ${err instanceof Error ? err.message : String(err)}`
      })
    );
    return true;
  }
  return false;
});

