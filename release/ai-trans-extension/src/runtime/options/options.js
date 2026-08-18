"use strict";
(() => {
  // src/domain/models/config.ts
  var DEFAULT_LOCAL_TRANSLATION_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";
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

  // src/runtime/options/options.ts
  var store = new ChromeStorageConfigStore();
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
  var BG_PRESETS = {
    none: "transparent",
    gray: "rgba(32, 32, 32, 0.7)",
    black: "rgba(0, 0, 0, 0.7)"
  };
  function parseRgba(value) {
    const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (!match) return null;
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    const a = match[4] ? parseFloat(match[4]) : 1;
    const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
    return { color: hex, opacity: Math.round(a * 100) };
  }
  function matchPreset(value) {
    for (const [key, preset] of Object.entries(BG_PRESETS)) {
      if (value === preset) return key;
    }
    return "custom";
  }
  var DEBUG_CATEGORY_IDS = [
    ["overlay", "dbg-overlay"],
    ["llm", "dbg-llm"],
    ["capture", "dbg-capture"],
    ["pipeline", "dbg-pipeline"],
    ["strategy", "dbg-strategy"],
    ["content", "dbg-content"],
    ["bridge", "dbg-bridge"],
    ["interceptor", "dbg-interceptor"]
  ];
  function readDebugLog() {
    const out = { ...DEBUG_LOG_OFF };
    for (const [category, id] of DEBUG_CATEGORY_IDS) {
      out[category] = $(id).checked;
    }
    return out;
  }
  function fillDebugLog(config) {
    const merged = { ...DEBUG_LOG_OFF, ...config };
    for (const [category, id] of DEBUG_CATEGORY_IDS) {
      $(id).checked = merged[category];
    }
  }
  function readForm() {
    const translationType = $("translation-type").value;
    const asrType = $("asr-type").value;
    const modelTier = $("asr-tier").value;
    const profile = $("performance-profile").value;
    const preset = $("style-bg-preset").value;
    let bgColor;
    if (preset === "custom") {
      const color = $("style-bg-color").value;
      const opacity = parseInt($("style-bg-opacity").value, 10);
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      bgColor = `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
    } else {
      bgColor = BG_PRESETS[preset] ?? "transparent";
    }
    const config = {
      translation: {
        type: translationType,
        model: $("translation-model").value || void 0,
        endpoint: $("translation-endpoint").value || void 0,
        fallbackType: $("translation-fallback").value || void 0,
        localModelName: DEFAULT_LOCAL_TRANSLATION_MODEL
      },
      asr: {
        type: asrType,
        modelTier,
        endpoint: $("asr-endpoint").value || void 0,
        customModelPath: $("asr-custom-model").value || void 0
      },
      targetLang: $("target-lang").value || "zh-Hant",
      displayMode: $("display-mode").value,
      performanceProfile: profile,
      subtitleStyle: {
        "font-size": $("style-font-size").value,
        color: $("style-color").value,
        "background-color": bgColor
      },
      debugLog: readDebugLog()
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
    $("asr-custom-model").value = config.asr.customModelPath ?? "";
    $("target-lang").value = config.targetLang;
    $("display-mode").value = config.displayMode;
    $("performance-profile").value = config.performanceProfile;
    $("style-font-size").value = config.subtitleStyle?.["font-size"] ?? "24px";
    $("style-color").value = config.subtitleStyle?.color ?? "#ffffff";
    const bgColor = config.subtitleStyle?.["background-color"] ?? "transparent";
    const preset = matchPreset(bgColor);
    $("style-bg-preset").value = preset;
    const customArea = document.getElementById("style-bg-custom");
    if (preset === "custom") {
      const parsed = parseRgba(bgColor);
      if (parsed) {
        $("style-bg-color").value = parsed.color;
        $("style-bg-opacity").value = String(parsed.opacity);
        $("style-bg-opacity-val").textContent = String(parsed.opacity);
      }
      if (customArea) customArea.style.display = "";
    } else {
      if (customArea) customArea.style.display = "none";
    }
    fillDebugLog(config.debugLog);
  }
  async function loadKeysIntoForm() {
    const llmKey = await store.getApiKey("llm");
    const asrKey = await store.getApiKey("asr");
    $("translation-api-key").value = llmKey ?? "";
    $("asr-api-key").value = asrKey ?? "";
  }
  async function save() {
    const config = readForm();
    try {
      await store.set(config);
      await store.setApiKey("llm", $("translation-api-key").value.trim());
      await store.setApiKey("asr", $("asr-api-key").value.trim());
      showStatus("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
    } catch (err) {
      console.warn("[AI_Trans] config save failed:", err);
      showStatus(`\u4FDD\u5B58\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    let config;
    try {
      config = await store.get();
    } catch (err) {
      showStatus(`\u8B80\u53D6\u914D\u7F6E\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
      config = DEFAULT_CONFIG;
    }
    fillForm(config);
    try {
      await loadKeysIntoForm();
    } catch (err) {
      showStatus(`\u8B80\u53D6\u5BC6\u9470\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
    }
    $("performance-profile").addEventListener("change", () => {
      const prof = PROFILE_DEFAULTS[$("performance-profile").value];
      if (prof) {
        $("asr-tier").value = prof.asr.modelTier ?? "base";
        $("display-mode").value = prof.displayMode;
      }
    });
    const customArea = document.getElementById("style-bg-custom");
    $("style-bg-preset").addEventListener("change", () => {
      const preset = $("style-bg-preset").value;
      if (customArea) customArea.style.display = preset === "custom" ? "" : "none";
    });
    $("style-bg-opacity").addEventListener("input", () => {
      $("style-bg-opacity-val").textContent = $("style-bg-opacity").value;
    });
    $("btn-save").addEventListener("click", () => void save());
    $("btn-reset").addEventListener("click", () => {
      fillForm(DEFAULT_CONFIG);
    });
    initLocalOnnxModelUI();
    const versionEl = $("version");
    if (versionEl) {
      try {
        const manifest = chrome.runtime.getManifest();
        versionEl.textContent = `v${manifest.version}`;
      } catch {
        versionEl.textContent = "v0.0.0";
      }
    }
  }
  void init();
  function initLocalOnnxModelUI() {
    const statusBadge = $("local-model-status-badge");
    const progressContainer = $("local-model-progress-container");
    const progressBar = $("local-model-progress-bar");
    const progressText = $("local-model-progress-text");
    const progressDetail = $("local-model-progress-detail");
    const btnDownload = $("btn-download-model");
    const btnClear = $("btn-clear-model");
    function updateStatusBadge(status, message) {
      const styles = {
        checking: { bg: "#eee", color: "#666", text: "\u6AA2\u6E2C\u4E2D..." },
        "not-downloaded": { bg: "#fff3cd", color: "#856404", text: "\u672A\u4E0B\u8F09" },
        downloading: { bg: "#cce5ff", color: "#004085", text: "\u4E0B\u8F09\u4E2D..." },
        downloaded: { bg: "#d4edda", color: "#155724", text: "\u5DF2\u5C31\u7DD2" },
        error: { bg: "#f8d7da", color: "#721c24", text: "\u932F\u8AA4" }
      };
      const style = styles[status];
      statusBadge.style.background = style.bg;
      statusBadge.style.color = style.color;
      statusBadge.textContent = message ?? style.text;
    }
    function setProgressVisible(visible) {
      progressContainer.style.display = visible ? "" : "none";
    }
    function updateProgress(percent, detail) {
      progressBar.value = percent;
      progressText.textContent = `${Math.round(percent)}%`;
      if (detail) progressDetail.textContent = detail;
    }
    async function checkModelStatus() {
      updateStatusBadge("checking");
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "local-onnx:check-status"
        });
        const res = response;
        if (res.ok && res.result?.downloaded) {
          updateStatusBadge("downloaded");
          btnDownload.disabled = true;
          btnClear.disabled = false;
        } else {
          updateStatusBadge("not-downloaded");
          btnDownload.disabled = false;
          btnClear.disabled = true;
        }
      } catch (err) {
        updateStatusBadge("error", "\u6AA2\u6E2C\u5931\u6557");
        console.warn("[AI_Trans] check model status failed:", err);
      }
    }
    async function downloadModel() {
      updateStatusBadge("downloading");
      setProgressVisible(true);
      updateProgress(0, "\u6B63\u5728\u521D\u59CB\u5316...");
      btnDownload.disabled = true;
      const progressListener = (message, _sender, _sendResponse) => {
        const msg = message;
        console.log("[AI_Trans:options] received message:", msg.type, msg);
        if (msg.type === "local-onnx:download-progress") {
          const progressMsg = msg;
          updateProgress(
            progressMsg.progress,
            `${formatBytes(progressMsg.loaded)} / ${formatBytes(progressMsg.total)}`
          );
        } else if (msg.type === "local-onnx:download-complete") {
          const completeMsg = msg;
          chrome.runtime.onMessage.removeListener(progressListener);
          setProgressVisible(false);
          if (completeMsg.ok) {
            updateStatusBadge("downloaded");
            btnClear.disabled = false;
            showStatus("\u6A21\u578B\u4E0B\u8F09\u5B8C\u6210");
          } else {
            updateStatusBadge("error", "\u4E0B\u8F09\u5931\u6557");
            btnDownload.disabled = false;
            showStatus(`\u4E0B\u8F09\u5931\u6557: ${completeMsg.error ?? "unknown error"}`);
          }
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);
      try {
        void chrome.runtime.sendMessage({
          topic: "local-onnx:download"
        });
      } catch (err) {
        chrome.runtime.onMessage.removeListener(progressListener);
        setProgressVisible(false);
        updateStatusBadge("error", "\u4E0B\u8F09\u5931\u6557");
        btnDownload.disabled = false;
        showStatus(`\u4E0B\u8F09\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    async function clearModelCache() {
      if (!confirm("\u78BA\u5B9A\u8981\u6E05\u9664\u672C\u5730\u6A21\u578B\u5FEB\u53D6\u55CE\uFF1F\u9019\u5C07\u91CB\u653E\u7D04 350 MB \u7684\u5132\u5B58\u7A7A\u9593\u3002")) return;
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "local-onnx:clear-cache"
        });
        const res = response;
        if (res.ok) {
          updateStatusBadge("not-downloaded");
          btnDownload.disabled = false;
          btnClear.disabled = true;
          showStatus("\u6A21\u578B\u5FEB\u53D6\u5DF2\u6E05\u9664");
        } else {
          showStatus("\u6E05\u9664\u5FEB\u53D6\u5931\u6557");
        }
      } catch (err) {
        showStatus(`\u6E05\u9664\u5FEB\u53D6\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    function formatBytes(bytes) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }
    btnDownload.addEventListener("click", () => void downloadModel());
    btnClear.addEventListener("click", () => void clearModelCache());
    void checkModelStatus();
  }
})();

