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
  return false;
});

