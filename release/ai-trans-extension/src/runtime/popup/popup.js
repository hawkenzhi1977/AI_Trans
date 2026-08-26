"use strict";
(() => {
  // src/domain/models/config.ts
  var LOCAL_TRANSLATION_MODELS = {
    /** 小型翻譯模型（MarianMT），專為翻譯設計，記憶體小、速度快。僅支援英→中。 */
    small: "Xenova/opus-mt-en-zh",
    /** 大型通用 LLM 模型（Qwen2.5），高質量翻譯，但記憶體大、速度較慢。 */
    large: "onnx-community/Qwen2.5-0.5B-Instruct"
  };
  var DEFAULT_LOCAL_TRANSLATION_MODEL = LOCAL_TRANSLATION_MODELS.small;
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

  // src/infrastructure/diagnostics.ts
  var DIAGNOSTIC_KEY = "lastDiagnostic";
  function extractDiagnostic(e) {
    switch (e.type) {
      case "engine-degraded":
        if (e.port === "translation" || e.port === "asr") {
          return { kind: "degraded", message: e.reason };
        }
        return void 0;
      case "pipeline-error":
        return { kind: "error", message: formatCause(e.error.cause) };
      default:
        return void 0;
    }
  }
  function formatCause(cause) {
    if (cause instanceof Error) {
      return `${cause.name}: ${cause.message}`;
    }
    return String(cause ?? "unknown error");
  }
  function isUserActionable(message) {
    const patterns = [
      // 網絡錯誤
      "Failed to fetch",
      "NetworkError",
      "CORS",
      "Mixed Content",
      "net::ERR_",
      // HTTP 狀態碼
      "401",
      "403",
      "404",
      "429",
      "500",
      "502",
      "503",
      "504",
      // 權限類
      "tab-capture-not-authorized",
      "not authorized",
      "permission",
      "access denied",
      // 配置類
      "model",
      "endpoint",
      "API key",
      "not found",
      "invalid"
    ];
    const lower = message.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }
  async function recordDiagnostic(e) {
    const diag = extractDiagnostic(e);
    if (!diag) return;
    const record = {
      kind: diag.kind,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message: diag.message,
      actionable: isUserActionable(diag.message)
    };
    console.warn(`[AI_Trans] translation degraded: ${diag.message}`);
    try {
      await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: record });
    } catch {
    }
  }
  async function readLastDiagnostic() {
    try {
      const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
      const rec = stored[DIAGNOSTIC_KEY];
      if (rec && typeof rec === "object" && typeof rec.message === "string") {
        return rec;
      }
      return void 0;
    } catch {
      return void 0;
    }
  }
  function formatDiagnostic(rec) {
    if (!rec) return void 0;
    const kind = rec.kind === "degraded" ? "\u964D\u7D1A" : "\u932F\u8AA4";
    return `${kind}: ${rec.message} (${rec.timestamp})`;
  }

  // src/runtime/endpoint.ts
  function normalizeEndpoint(raw) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return "https://api.openai.com/v1/chat/completions";
    const base = trimmed.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  // src/runtime/popup/connection-test.ts
  function createSwProxyFetch() {
    return async (input, init2) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = await chrome.runtime.sendMessage({
        topic: "sw:proxy-fetch-llm",
        payload: {
          url,
          method: init2?.method ?? "POST",
          headers: init2?.headers,
          body: init2?.body
        }
      });
      const res = response;
      if (res.error && !res.status) {
        throw new Error(res.error);
      }
      return new Response(res.body ?? "", {
        status: res.status ?? 200,
        statusText: res.ok ? "OK" : "Error"
      });
    };
  }
  async function testConnection(config, apiKey, fetchFn = createSwProxyFetch(), timeoutMs = 1e4) {
    const tc = config.translation;
    if (tc.type !== "cloud-llm" && tc.type !== "local") {
      return { ok: false, error: "\u7576\u524D\u5F15\u64CE\u985E\u578B\u4E0D\u9700\u7DB2\u7D61\u9023\u7DDA\uFF08MT \u5B57\u5178 / \u672C\u5730 ONNX\uFF09\u3002\u8ACB\u9078\u96F2\u7AEF LLM \u6216\u672C\u5730\u6A21\u578B\u3002" };
    }
    if (!tc.endpoint) {
      return { ok: false, error: "\u672A\u586B\u5BEB\u7AEF\u9EDE\uFF08Endpoint\uFF09\u3002" };
    }
    const endpoint = normalizeEndpoint(tc.endpoint);
    const model = tc.model ?? (tc.type === "cloud-llm" ? "gpt-4o-mini" : "");
    if (!model) {
      return { ok: false, error: "\u672A\u586B\u5BEB\u6A21\u578B ID\u3002" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "user", content: "ping" }
          ],
          max_tokens: 1
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        let serverMsg = "";
        let hasErrorBody = false;
        try {
          const body = await res.json();
          serverMsg = body.error?.message ?? "";
          hasErrorBody = true;
        } catch {
        }
        if (res.status === 403 && !hasErrorBody) {
          return {
            ok: false,
            error: "HTTP 403 \u2014 \u670D\u52D9\u7AEF\u62D2\u7D55\u8ACB\u6C42\u4E14\u672A\u8FD4\u56DE\u932F\u8AA4\u8A73\u60C5\uFF08\u5E38\u898B\u65BC\u672C\u5730 LLM \u670D\u52D9\u7684 Origin \u6AA2\u67E5\uFF0C\u8ACB\u53C3\u8003\u6587\u6A94\u914D\u7F6E\u5141\u8A31\u7684\u4F86\u6E90\uFF09"
          };
        }
        return {
          ok: false,
          error: `HTTP ${res.status}${serverMsg ? ` \u2014 ${serverMsg}` : ""}`
        };
      }
      const data = await res.json();
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        return { ok: false, error: "\u97FF\u61C9\u7D50\u69CB\u7570\u5E38\uFF1A\u7121 choices \u6578\u7D44\u3002" };
      }
      return { ok: true, detail: `\u7AEF\u9EDE\u53EF\u9054\uFF0C\u6A21\u578B ${model} \u56DE\u61C9\u6B63\u5E38\u3002` };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const timeoutHit = err instanceof DOMException && err.name === "AbortError";
      return {
        ok: false,
        error: timeoutHit ? `\u8ACB\u6C42\u8D85\u6642\uFF08${timeoutMs / 1e3}s\uFF09\u3002\u6AA2\u67E5\u7AEF\u9EDE\u8207\u670D\u52D9\u72C0\u614B\u3002` : `\u7DB2\u7D61\u5931\u6557: ${reason}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // src/runtime/popup/popup.ts
  var store = new ChromeStorageConfigStore();
  var OPTIONS_URL = chrome.runtime.getURL("src/runtime/options/options.html");
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
  function popupDiag(msg) {
    const el = document.getElementById("popup-diag-dom");
    if (!el) return;
    const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 19);
    const line = `${ts} ${msg}`;
    el.textContent = el.textContent ? `${el.textContent}
${line}` : line;
    console.log(`[AI_Trans:popup:diag] ${msg}`);
  }
  var INIT_SLOW_MS = 3e3;
  var INIT_TIMEOUT_MS = 1e4;
  var initSlowFired = false;
  var initTimer;
  var initTimeoutTimer;
  function startInitWatchdog() {
    initTimer = setTimeout(() => {
      if (initSlowFired) return;
      initSlowFired = true;
      console.warn("[AI_Trans:popup] init-slow | >3s\uFF0C\u53EF\u80FD\u88AB offscreen \u6A21\u578B\u8F09\u5165/OOM \u62D6\u7D2F");
      popupDiag("init-slow >3s");
      void recordDiagnostic({
        type: "pipeline-error",
        error: { port: "platform", code: "popup-init-slow", recoverable: true, cause: new Error("popup init exceeded 3s") }
      });
    }, INIT_SLOW_MS);
    initTimeoutTimer = setTimeout(fireInitTimeout, INIT_TIMEOUT_MS);
  }
  function stopInitWatchdog() {
    if (initTimer !== void 0) {
      clearTimeout(initTimer);
      initTimer = void 0;
    }
    if (initTimeoutTimer !== void 0) {
      clearTimeout(initTimeoutTimer);
      initTimeoutTimer = void 0;
    }
  }
  function fireInitTimeout() {
    console.error("[AI_Trans:popup] init-timeout | >10s\uFF0Cinit \u672A\u8FD4\u56DE\uFF08\u6975\u53EF\u80FD\u9032\u7A0B\u88AB OOM/\u639B\u8D77\uFF09");
    popupDiag("init-timeout >10s");
    void recordDiagnostic({
      type: "pipeline-error",
      error: { port: "platform", code: "popup-init-timeout", recoverable: true, cause: new Error("popup init did not complete within 10s") }
    });
  }
  async function openOptionsPage() {
    try {
      const tabs = await chrome.tabs.query({ url: OPTIONS_URL });
      if (tabs.length > 0 && tabs[0].id != null) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        popupDiag("options tab focused");
      } else {
        await chrome.tabs.create({ url: OPTIONS_URL });
        popupDiag("options tab created");
      }
    } catch (err) {
      popupDiag(`options open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async function init() {
    const t0 = performance.now();
    console.log("[AI_Trans:popup] init-start | elapsed=0ms");
    popupDiag("init-start");
    startInitWatchdog();
    $("btn-options").addEventListener("click", () => {
      console.log("[AI_Trans:popup] btn-options-click | elapsed=%dms", performance.now() - t0);
      popupDiag("btn-options clicked");
      void openOptionsPage();
    });
    let config;
    console.log("[AI_Trans:popup] store-get-start | elapsed=%dms", performance.now() - t0);
    try {
      config = await store.get();
      console.log(
        "[AI_Trans:popup] store-get-done | elapsed=%dms | type=%s",
        performance.now() - t0,
        config.translation.type
      );
      popupDiag("store-get done");
    } catch (err) {
      console.warn(
        "[AI_Trans:popup] store-get-error | elapsed=%dms | %s",
        performance.now() - t0,
        err instanceof Error ? err.message : String(err)
      );
      popupDiag(`store-get error: ${err instanceof Error ? err.message : String(err)}`);
      $("status-diagnostic").textContent = `\u6700\u8FD1\u5931\u6557: \u932F\u8AA4: \u914D\u7F6E\u8B80\u53D6\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`;
      $("status-diagnostic").classList.add("warn");
      const toggle2 = $("enable-toggle");
      toggle2.checked = true;
      bindActions(configFallback());
      stopInitWatchdog();
      return;
    }
    $("status-translation").textContent = describeTranslation(config);
    $("status-asr").textContent = describeAsr(config);
    $("status-lang").textContent = `\u76EE\u6A19\u8A9E\u8A00: ${config.targetLang} \xB7 ${config.displayMode === "mono" ? "\u50C5\u8B6F\u6587" : "\u96D9\u8A9E"}`;
    const toggle = $("enable-toggle");
    toggle.checked = config.enabled;
    document.body.classList.toggle("disabled", !config.enabled);
    if (!config.enabled) {
      $("status-translation").textContent = "\u7FFB\u8B6F: \u5DF2\u505C\u7528";
      $("status-asr").textContent = "ASR: \u5DF2\u505C\u7528";
      $("status-lang").textContent = "\u76EE\u6A19\u8A9E\u8A00: \u2014";
    }
    let diagText;
    console.log("[AI_Trans:popup] diag-read-start | elapsed=%dms", performance.now() - t0);
    try {
      const diag = await readLastDiagnostic();
      console.log(
        "[AI_Trans:popup] diag-read-done | elapsed=%dms | hasDiag=%s",
        performance.now() - t0,
        diag ? "yes" : "no"
      );
      if (diag && diag.actionable !== false) {
        diagText = formatDiagnostic(diag);
      }
    } catch {
      console.warn("[AI_Trans:popup] diag-read-error | elapsed=%dms", performance.now() - t0);
      diagText = void 0;
    }
    const diagEl = $("status-diagnostic");
    if (diagText) {
      diagEl.textContent = `\u6700\u8FD1\u5931\u6557: ${diagText}`;
      diagEl.classList.add("warn");
    } else {
      diagEl.textContent = "\u6700\u8FD1\u5931\u6557: \u7121";
    }
    console.log("[AI_Trans:popup] bind-actions | elapsed=%dms", performance.now() - t0);
    bindActions(config);
    await updateAsrButton();
    console.log("[AI_Trans:popup] init-done | elapsed=%dms", performance.now() - t0);
    popupDiag("init-done");
    stopInitWatchdog();
  }
  async function updateAsrButton() {
    const btn = $("btn-asr");
    const authorized = await chrome.storage.local.get("tabCaptureAuthorized");
    if (authorized.tabCaptureAuthorized) {
      btn.textContent = "ASR \u5DF2\u555F\u7528";
      btn.disabled = true;
      btn.style.opacity = "0.6";
    } else {
      btn.textContent = "\u555F\u7528 ASR";
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  }
  function bindActions(config) {
    const toggle = $("enable-toggle");
    toggle.addEventListener("change", async () => {
      const connEl = $("status-connection");
      connEl.textContent = "\u5207\u63DB\u4E2D\u2026";
      connEl.classList.remove("warn", "ok");
      try {
        await store.set({ enabled: toggle.checked });
        connEl.textContent = toggle.checked ? "\u9023\u63A5\u6E2C\u8A66: \u5DF2\u555F\u7528" : "\u9023\u63A5\u6E2C\u8A66: \u5DF2\u505C\u7528";
        connEl.classList.add("ok");
        document.body.classList.toggle("disabled", !toggle.checked);
        if (!toggle.checked) {
          $("status-translation").textContent = "\u7FFB\u8B6F: \u5DF2\u505C\u7528";
          $("status-asr").textContent = "ASR: \u5DF2\u505C\u7528";
          $("status-lang").textContent = "\u76EE\u6A19\u8A9E\u8A00: \u2014";
        } else {
          $("status-translation").textContent = describeTranslation(config);
          $("status-asr").textContent = describeAsr(config);
          $("status-lang").textContent = `\u76EE\u6A19\u8A9E\u8A00: ${config.targetLang} \xB7 ${config.displayMode === "mono" ? "\u50C5\u8B6F\u6587" : "\u96D9\u8A9E"}`;
        }
      } catch (err) {
        connEl.textContent = `\u5207\u63DB\u5931\u6557: ${err instanceof Error ? err.message : String(err)}`;
        connEl.classList.add("warn");
        toggle.checked = !toggle.checked;
      }
    });
    $("btn-test").addEventListener("click", async () => {
      const connEl = $("status-connection");
      connEl.textContent = "\u9023\u63A5\u6E2C\u8A66: \u6E2C\u8A66\u4E2D\u2026";
      connEl.classList.remove("warn", "ok");
      try {
        const apiKey = await store.getApiKey("llm") ?? "";
        const status = await testConnection(config, apiKey);
        if (status.ok) {
          connEl.textContent = `\u9023\u63A5\u6E2C\u8A66: ${status.detail}`;
          connEl.classList.add("ok");
        } else {
          connEl.textContent = `\u9023\u63A5\u6E2C\u8A66: ${status.error}`;
          connEl.classList.add("warn");
        }
      } catch (err) {
        connEl.textContent = `\u9023\u63A5\u6E2C\u8A66: ${err instanceof Error ? err.message : String(err)}`;
        connEl.classList.add("warn");
      }
    });
    $("btn-reload").addEventListener("click", async () => {
      const connEl = $("status-connection");
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab?.id) {
          connEl.textContent = "\u91CD\u65B0\u8F09\u5165: \u672A\u627E\u5230\u6D3B\u52D5\u6A19\u7C64\u9801";
          connEl.classList.remove("ok");
          connEl.classList.add("warn");
          return;
        }
        await chrome.tabs.reload(tab.id);
      } catch (err) {
        connEl.textContent = `\u91CD\u65B0\u8F09\u5165: ${err instanceof Error ? err.message : String(err)}`;
        connEl.classList.remove("ok");
        connEl.classList.add("warn");
      }
    });
    $("btn-asr").addEventListener("click", async () => {
      const connEl = $("status-connection");
      connEl.textContent = "ASR \u6388\u6B0A: \u8ACB\u6C42\u4E2D\u2026";
      connEl.classList.remove("warn", "ok");
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({});
        await chrome.storage.local.set({
          tabCaptureAuthorized: true,
          tabCaptureStreamId: streamId
        });
        connEl.textContent = "ASR \u6388\u6B0A: \u6210\u529F";
        connEl.classList.add("ok");
        await updateAsrButton();
      } catch (err) {
        connEl.textContent = `ASR \u6388\u6B0A: \u5931\u6557 \u2014 ${err instanceof Error ? err.message : String(err)}`;
        connEl.classList.add("warn");
        void recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "audio",
            code: "tab-capture-not-authorized",
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err))
          }
        });
      }
    });
  }
  function configFallback() {
    return DEFAULT_CONFIG;
  }
  function describeTranslation(c) {
    const type = c.translation.type;
    const model = c.translation.model ?? "";
    switch (type) {
      case "cloud-llm":
        return `\u7FFB\u8B6F: \u96F2\u7AEF LLM${model ? ` (${model})` : ""}`;
      case "local":
        return `\u7FFB\u8B6F: \u672C\u5730\u6A21\u578B${model ? ` (${model})` : ""}`;
      case "mt":
        return "\u7FFB\u8B6F: \u50B3\u7D71 MT";
      case "local-onnx":
        return "\u7FFB\u8B6F: \u672C\u5730 ONNX \u6A21\u578B";
    }
  }
  function describeAsr(c) {
    if (c.asr.type === "local-whisper") return `ASR: \u672C\u5730 Whisper (${c.asr.modelTier ?? "base"})`;
    return "ASR: \u96F2\u7AEF";
  }
  var _testExports = {
    startInitWatchdog,
    stopInitWatchdog,
    fireInitTimeout,
    resetWatchdogForTest() {
      initSlowFired = false;
      stopInitWatchdog();
    }
  };
  void init();
})();

