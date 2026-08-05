"use strict";
(() => {
  // src/domain/models/config.ts
  var PROFILE_DEFAULTS = {
    streaming: {
      asr: { type: "local-whisper", modelTier: "tiny" },
      displayMode: "mono"
    },
    balanced: {
      asr: { type: "local-whisper", modelTier: "base" },
      displayMode: "bilingual"
    },
    quality: {
      asr: { type: "local-whisper", modelTier: "small" },
      displayMode: "bilingual"
    }
  };
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

  // src/runtime/options/options.ts
  var store = new ChromeStorageConfigStore();
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
  function readForm() {
    const translationType = $("translation-type").value;
    const asrType = $("asr-type").value;
    const modelTier = $("asr-tier").value;
    const profile = $("performance-profile").value;
    const config = {
      translation: {
        type: translationType,
        model: $("translation-model").value || void 0,
        endpoint: $("translation-endpoint").value || void 0,
        fallbackType: $("translation-fallback").value || void 0
      },
      asr: {
        type: asrType,
        modelTier,
        endpoint: $("asr-endpoint").value || void 0
      },
      targetLang: $("target-lang").value || "zh-Hant",
      displayMode: $("display-mode").value,
      performanceProfile: profile,
      subtitleStyle: {
        "font-size": $("style-font-size").value,
        color: $("style-color").value,
        "background-color": $("style-bg").value || "transparent"
      }
    };
    const prof = PROFILE_DEFAULTS[profile];
    if (prof) {
      config.asr = { ...config.asr, ...prof.asr };
      if (modelTier === "base" && profile !== "balanced") {
        config.asr.modelTier = prof.asr.modelTier;
      }
    }
    return config;
  }
  function fillForm(config) {
    $("translation-type").value = config.translation.type;
    $("translation-model").value = config.translation.model ?? "";
    $("translation-endpoint").value = config.translation.endpoint ?? "";
    $("translation-fallback").value = config.translation.fallbackType ?? "mt";
    $("asr-type").value = config.asr.type;
    $("asr-tier").value = config.asr.modelTier ?? "base";
    $("asr-endpoint").value = config.asr.endpoint ?? "";
    $("target-lang").value = config.targetLang;
    $("display-mode").value = config.displayMode;
    $("performance-profile").value = config.performanceProfile;
    $("style-font-size").value = config.subtitleStyle?.["font-size"] ?? "24px";
    $("style-color").value = config.subtitleStyle?.color ?? "#ffffff";
    $("style-bg").value = config.subtitleStyle?.["background-color"] ?? "transparent";
  }
  async function loadKeysIntoForm() {
    const llmKey = await store.getApiKey("llm");
    const asrKey = await store.getApiKey("asr");
    $("translation-api-key").value = llmKey ?? "";
    $("asr-api-key").value = asrKey ?? "";
  }
  async function save() {
    const config = readForm();
    await store.set(config);
    await store.setApiKey("llm", $("translation-api-key").value.trim());
    await store.setApiKey("asr", $("asr-api-key").value.trim());
    showStatus("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
  }
  var statusTimer = null;
  function showStatus(msg) {
    const el = $("status");
    el.textContent = msg;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      el.textContent = "";
      statusTimer = null;
    }, 2e3);
  }
  async function init() {
    const config = await store.get();
    fillForm(config);
    await loadKeysIntoForm();
    $("performance-profile").addEventListener("change", () => {
      const prof = PROFILE_DEFAULTS[$("performance-profile").value];
      if (prof) {
        $("asr-tier").value = prof.asr.modelTier ?? "base";
        $("display-mode").value = prof.displayMode;
      }
    });
    $("btn-save").addEventListener("click", () => void save());
    $("btn-reset").addEventListener("click", () => {
      fillForm(DEFAULT_CONFIG);
    });
  }
  void init();
})();

