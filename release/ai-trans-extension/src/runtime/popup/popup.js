"use strict";
(() => {
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

  // src/runtime/popup/popup.ts
  var store = new ChromeStorageConfigStore();
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
  async function init() {
    const config = await store.get();
    $("status-translation").textContent = describeTranslation(config);
    $("status-asr").textContent = describeAsr(config);
    $("status-lang").textContent = `\u76EE\u6A19\u8A9E\u8A00: ${config.targetLang} \xB7 ${config.displayMode === "mono" ? "\u50C5\u8B6F\u6587" : "\u96D9\u8A9E"}`;
    $("btn-options").addEventListener("click", () => {
      void chrome.runtime.openOptionsPage();
    });
    $("btn-reload").addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) void chrome.tabs.reload(tab.id);
    });
  }
  function describeTranslation(c) {
    const type = c.translation.type;
    const model = c.translation.model ?? "";
    switch (type) {
      case "cloud-llm":
        return `\u7FFB\u8B6F: \u96F2\u7AEF LLM${model ? ` (${model})` : ""}`;
      case "local":
        return "\u7FFB\u8B6F: \u672C\u5730\u6A21\u578B";
      case "mt":
        return "\u7FFB\u8B6F: \u50B3\u7D71 MT";
    }
  }
  function describeAsr(c) {
    if (c.asr.type === "local-whisper") return `ASR: \u672C\u5730 Whisper (${c.asr.modelTier ?? "base"})`;
    return "ASR: \u96F2\u7AEF";
  }
  void init();
})();

