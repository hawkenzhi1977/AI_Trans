"use strict";
(() => {
  // src/domain/models/config.ts
  var LOCAL_ONNX_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";
  var DEBUG_LOG_OFF = {
    overlay: false,
    llm: false,
    capture: false,
    pipeline: false,
    strategy: false,
    content: false,
    bridge: false,
    interceptor: false,
    "local-onnx": false,
    popup: false
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
    enabled: true,
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
    debugLog: DEBUG_LOG_OFF,
    falseSeekThresholdMs: 1e4
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
        // M2-34：debugLog 深合併——使用 base.debugLog 而非 DEFAULT_CONFIG.debugLog，
        // 避免部分 patch（如 Popup 切換 enabled）覆蓋已保存的調試設置。
        debugLog: { ...base.debugLog, ...patch.debugLog ?? {} }
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
    ["interceptor", "dbg-interceptor"],
    ["local-onnx", "dbg-local-onnx"],
    ["popup", "dbg-popup"]
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
      enabled: $("enable-toggle").checked,
      translation: {
        type: translationType,
        model: $("translation-model").value || void 0,
        endpoint: $("translation-endpoint").value || void 0,
        fallbackType: $("translation-fallback").value || void 0,
        localOnnxChunkSize: Number($("local-onnx-chunk-size").value) || 5,
        localModelName: LOCAL_ONNX_MODEL
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
    $("enable-toggle").checked = config.enabled;
    $("translation-type").value = config.translation.type;
    $("translation-model").value = config.translation.model ?? "";
    $("translation-endpoint").value = config.translation.endpoint ?? "";
    $("translation-fallback").value = config.translation.fallbackType ?? "mt";
    $("local-onnx-chunk-size").value = String(config.translation.localOnnxChunkSize ?? 5);
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
    console.log("[AI_Trans:options] Options page loading...");
    let config;
    try {
      config = await store.get();
    } catch (err) {
      const errorMsg = `\u8B80\u53D6\u914D\u7F6E\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[AI_Trans:options]", errorMsg, err);
      showStatus(errorMsg);
      config = DEFAULT_CONFIG;
    }
    try {
      fillForm(config);
    } catch (err) {
      const errorMsg = `\u586B\u5145\u8868\u55AE\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[AI_Trans:options]", errorMsg, err);
      showStatus(errorMsg);
    }
    try {
      await loadKeysIntoForm();
    } catch (err) {
      const errorMsg = `\u8B80\u53D6\u5BC6\u9470\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[AI_Trans:options]", errorMsg, err);
      showStatus(errorMsg);
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
    initAsrModelUI();
    const versionEl = $("version");
    if (versionEl) {
      try {
        const manifest = chrome.runtime.getManifest();
        versionEl.textContent = `v${manifest.version}`;
      } catch {
        versionEl.textContent = "v0.0.0";
      }
    }
    console.log("[AI_Trans:options] Options page loaded successfully");
  }
  void init().catch((err) => {
    console.error("[AI_Trans:options] Options page failed to load:", err);
    const body = document.body;
    if (body) {
      body.innerHTML = `<div style="color: red; padding: 20px; font-family: monospace;">Options page error: ${err instanceof Error ? err.message : String(err)}<br><br>Stack: ${err instanceof Error ? err.stack : "N/A"}</div>`;
    }
  });
  function initLocalOnnxModelUI() {
    const statusBadge = $("local-model-status-badge");
    const progressContainer = $("local-model-progress-container");
    const progressBar = $("local-model-progress-bar");
    const progressText = $("local-model-progress-text");
    const progressDetail = $("local-model-progress-detail");
    const btnDownload = $("btn-download-model");
    const btnWarmup = $("btn-warmup-model");
    const btnClear = $("btn-clear-model");
    const sizeInfo = $("local-model-size-info");
    sizeInfo.textContent = "\u7D04 750 MB";
    function updateStatusBadge(status, message) {
      const styles = {
        checking: { bg: "#eee", color: "#666", text: "\u6AA2\u6E2C\u4E2D..." },
        "not-downloaded": { bg: "#fff3cd", color: "#856404", text: "\u672A\u4E0B\u8F09" },
        downloading: { bg: "#cce5ff", color: "#004085", text: "\u4E0B\u8F09\u4E2D..." },
        preloading: { bg: "#e2e3f9", color: "#3b3d99", text: "\u9810\u52A0\u8F09\u4E2D..." },
        preloaded: { bg: "#d1ecf1", color: "#0c5460", text: "\u5DF2\u9810\u52A0\u8F09\uFF08\u8A18\u61B6\u9AD4\uFF09" },
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
    function applyModelStatus(status) {
      if (status.downloading) {
        updateStatusBadge("downloading");
        btnDownload.disabled = true;
        btnWarmup.disabled = true;
        btnClear.disabled = false;
        return;
      }
      if (status.loaded) {
        updateStatusBadge("preloaded");
        btnDownload.disabled = true;
        btnWarmup.disabled = true;
        btnClear.disabled = false;
        return;
      }
      if (status.loading) {
        updateStatusBadge("preloading");
        btnDownload.disabled = true;
        btnWarmup.disabled = true;
        btnClear.disabled = false;
        return;
      }
      if (status.downloaded) {
        updateStatusBadge("downloaded");
        btnDownload.disabled = true;
        btnWarmup.disabled = false;
        btnClear.disabled = false;
      } else {
        updateStatusBadge("not-downloaded");
        btnDownload.disabled = false;
        btnWarmup.disabled = true;
        btnClear.disabled = true;
      }
    }
    async function checkModelStatus() {
      updateStatusBadge("checking");
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "local-onnx:check-status"
        });
        const res = response;
        if (res.ok && res.result) {
          applyModelStatus(res.result);
        } else {
          updateStatusBadge("not-downloaded");
          btnDownload.disabled = false;
          btnWarmup.disabled = true;
          btnClear.disabled = true;
        }
      } catch (err) {
        updateStatusBadge("error", "\u6AA2\u6E2C\u5931\u6557");
        console.warn("[AI_Trans] check model status failed:", err);
      }
    }
    async function warmupModel() {
      updateStatusBadge("preloading");
      btnWarmup.disabled = true;
      btnDownload.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ topic: "local-onnx:warmup" });
        const res = response;
        if (res.ok) {
          updateStatusBadge("preloaded");
          showStatus("\u6A21\u578B\u5DF2\u9810\u52A0\u8F09\uFF0C\u7FFB\u8B6F\u9996\u97FF\u61C9\u5C07\u5373\u6642");
        } else {
          updateStatusBadge("error", "\u9810\u52A0\u8F09\u5931\u6557");
          btnDownload.disabled = false;
          btnWarmup.disabled = false;
          showStatus(`\u9810\u52A0\u8F09\u5931\u6557: ${res.error ?? "unknown error"}`);
        }
      } catch (err) {
        updateStatusBadge("error", "\u9810\u52A0\u8F09\u5931\u6557");
        btnDownload.disabled = false;
        btnWarmup.disabled = false;
        showStatus(`\u9810\u52A0\u8F09\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    async function downloadModel() {
      updateStatusBadge("downloading");
      setProgressVisible(true);
      updateProgress(0, "\u6B63\u5728\u521D\u59CB\u5316...");
      btnDownload.disabled = true;
      btnWarmup.disabled = true;
      const progressListener = (message, _sender, _sendResponse) => {
        const msg = message;
        console.log("[AI_Trans:options] received message:", msg.type, msg);
        if (msg.type === "local-onnx:download-progress") {
          const progressMsg = msg;
          const fileProgress = progressMsg.fileCount ? `\u6A94\u6848 ${progressMsg.completedFiles ?? 0}/${progressMsg.fileCount}` : "";
          const byteProgress = `${formatBytes(progressMsg.loaded)} / ${formatBytes(progressMsg.total)}`;
          updateProgress(
            progressMsg.progress,
            fileProgress ? `${fileProgress}\uFF08${byteProgress}\uFF09` : byteProgress
          );
        } else if (msg.type === "local-onnx:download-complete") {
          const completeMsg = msg;
          chrome.runtime.onMessage.removeListener(progressListener);
          setProgressVisible(false);
          if (completeMsg.ok) {
            updateStatusBadge("downloaded");
            btnClear.disabled = false;
            btnWarmup.disabled = false;
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
          btnWarmup.disabled = true;
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
    btnWarmup.addEventListener("click", () => void warmupModel());
    btnClear.addEventListener("click", () => void clearModelCache());
    chrome.runtime.onMessage.addListener(
      (message) => {
        const msg = message;
        if (msg.type === "local-onnx:status") {
          const statusMsg = msg;
          applyModelStatus(statusMsg);
        }
        return false;
      }
    );
    void checkModelStatus();
  }
  var WHISPER_MODEL_IDS = {
    tiny: "Xenova/whisper-tiny.en",
    base: "Xenova/whisper-base.en",
    small: "Xenova/whisper-small.en"
  };
  var WHISPER_MODEL_SIZES = {
    "Xenova/whisper-tiny.en": "\u7D04 40 MB",
    "Xenova/whisper-base.en": "\u7D04 80 MB",
    "Xenova/whisper-small.en": "\u7D04 180 MB"
  };
  function initAsrModelUI() {
    const modelNameInput = $("asr-model-name");
    const sizeInfo = $("asr-model-size-info");
    const statusBadge = $("asr-model-status-badge");
    const progressContainer = $("asr-model-progress-container");
    const progressBar = $("asr-model-progress-bar");
    const progressText = $("asr-model-progress-text");
    const progressDetail = $("asr-model-progress-detail");
    const btnDownload = $("btn-download-asr-model");
    const btnClear = $("btn-clear-asr-model");
    const tierSelect = $("asr-tier");
    const customModelInput = $("asr-custom-model");
    function getCurrentModelId() {
      const customPath = customModelInput.value.trim();
      if (customPath) return customPath;
      return WHISPER_MODEL_IDS[tierSelect.value] ?? WHISPER_MODEL_IDS.base;
    }
    function updateModelName() {
      const modelId = getCurrentModelId();
      modelNameInput.value = modelId;
      const size = WHISPER_MODEL_SIZES[modelId] ?? "\u5927\u5C0F\u672A\u77E5";
      sizeInfo.textContent = size;
    }
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
    function formatBytes(bytes) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }
    function applyModelStatus(status) {
      if (status.downloading) {
        updateStatusBadge("downloading");
        btnDownload.disabled = true;
        btnClear.disabled = false;
        return;
      }
      if (status.downloaded) {
        updateStatusBadge("downloaded");
        btnDownload.disabled = true;
        btnClear.disabled = false;
      } else {
        updateStatusBadge("not-downloaded");
        btnDownload.disabled = false;
        btnClear.disabled = true;
      }
    }
    async function checkModelStatus() {
      const modelId = getCurrentModelId();
      updateModelName();
      updateStatusBadge("checking");
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "asr-whisper:check-status",
          payload: { modelId }
        });
        const res = response;
        if (res.ok && res.result) {
          applyModelStatus(res.result);
        } else {
          updateStatusBadge("not-downloaded");
          btnDownload.disabled = false;
          btnClear.disabled = true;
        }
      } catch (err) {
        updateStatusBadge("error", "\u6AA2\u6E2C\u5931\u6557");
        console.warn("[AI_Trans] check ASR model status failed:", err);
      }
    }
    async function downloadModel() {
      const modelId = getCurrentModelId();
      updateStatusBadge("downloading");
      setProgressVisible(true);
      updateProgress(0, "\u6B63\u5728\u521D\u59CB\u5316...");
      btnDownload.disabled = true;
      btnClear.disabled = true;
      const progressListener = (message, _sender, _sendResponse) => {
        const msg = message;
        if (msg.type === "asr-whisper:download-progress") {
          const progressMsg = msg;
          const fileProgress = progressMsg.fileCount ? `\u6A94\u6848 ${progressMsg.completedFiles ?? 0}/${progressMsg.fileCount}` : "";
          const byteProgress = `${formatBytes(progressMsg.loaded)} / ${formatBytes(progressMsg.total)}`;
          updateProgress(
            progressMsg.progress,
            fileProgress ? `${fileProgress}\uFF08${byteProgress}\uFF09` : byteProgress
          );
        } else if (msg.type === "asr-whisper:download-complete") {
          const completeMsg = msg;
          chrome.runtime.onMessage.removeListener(progressListener);
          setProgressVisible(false);
          if (completeMsg.ok) {
            updateStatusBadge("downloaded");
            btnClear.disabled = false;
            showStatus("ASR \u6A21\u578B\u4E0B\u8F09\u5B8C\u6210");
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
          topic: "asr-whisper:download",
          payload: { modelId }
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
      if (!confirm("\u78BA\u5B9A\u8981\u6E05\u9664 ASR \u6A21\u578B\u5FEB\u53D6\u55CE\uFF1F")) return;
      const modelId = getCurrentModelId();
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "asr-whisper:clear-cache",
          payload: { modelId }
        });
        const res = response;
        if (res.ok) {
          updateStatusBadge("not-downloaded");
          btnDownload.disabled = false;
          btnClear.disabled = true;
          showStatus("ASR \u6A21\u578B\u5FEB\u53D6\u5DF2\u6E05\u9664");
        } else {
          showStatus("\u6E05\u9664\u5FEB\u53D6\u5931\u6557");
        }
      } catch (err) {
        showStatus(`\u6E05\u9664\u5FEB\u53D6\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    btnDownload.addEventListener("click", () => void downloadModel());
    btnClear.addEventListener("click", () => void clearModelCache());
    chrome.runtime.onMessage.addListener(
      (message) => {
        const msg = message;
        if (msg.type === "asr-whisper:status") {
          const statusMsg = msg;
          applyModelStatus(statusMsg);
        }
        return false;
      }
    );
    tierSelect.addEventListener("change", () => void checkModelStatus());
    customModelInput.addEventListener("input", () => void checkModelStatus());
    updateModelName();
    void checkModelStatus();
  }
})();

