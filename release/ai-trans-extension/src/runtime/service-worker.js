// src/domain/models/config.ts
var DEFAULT_CONFIG = {
  translation: { type: "cloud-llm", fallbackType: "mt" },
  asr: { type: "local-whisper", modelTier: "base" },
  targetLang: "zh-Hant",
  displayMode: "bilingual",
  performanceProfile: "balanced"
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
      asr: { ...base.asr, ...patch.asr ?? {} }
    };
  }
};

// src/runtime/service-worker.ts
var store = new ChromeStorageConfigStore();
void store.get();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message;
  if (msg.topic === "config:get") {
    void store.get().then(sendResponse);
    return true;
  }
  if (msg.topic === "config:set") {
    const patch = msg.payload ?? {};
    void store.set(patch).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

