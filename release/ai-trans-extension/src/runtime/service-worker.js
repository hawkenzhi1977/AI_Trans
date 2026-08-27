// src/domain/models/config.ts
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
  console.warn("[AI_Trans:sw] offscreen created");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: OFFSCREEN_REASON
  });
}
async function sendToOffscreen(message) {
  return sendToOffscreenInternal(message, false);
}
async function sendToOffscreenInternal(message, isRetry) {
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
    const currentPort = offscreenPort;
    const responseListener = (response) => {
      const res = response;
      if (res.messageId === messageId) {
        currentPort.onMessage.removeListener(responseListener);
        if (res.error) {
          reject(new Error(res.error));
        } else {
          resolve(res.result);
        }
      }
    };
    currentPort.onMessage.addListener(responseListener);
    const disconnectListener = () => {
      currentPort.onMessage.removeListener(responseListener);
      currentPort.onDisconnect.removeListener(disconnectListener);
      const err = new Error("Offscreen Document disconnected before response");
      if (!isRetry) {
        offscreenPort = null;
        void sendToOffscreenInternal(message, true).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    };
    currentPort.onDisconnect.addListener(disconnectListener);
    try {
      currentPort.postMessage({ ...msg, messageId });
    } catch (err) {
      currentPort.onMessage.removeListener(responseListener);
      currentPort.onDisconnect.removeListener(disconnectListener);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Extension context invalidated") && !isRetry) {
        offscreenPort = null;
        void sendToOffscreenInternal(message, true).then(resolve).catch(reject);
      } else {
        reject(err instanceof Error ? err : new Error(errMsg));
      }
      return;
    }
    setTimeout(() => {
      currentPort.onMessage.removeListener(responseListener);
      currentPort.onDisconnect.removeListener(disconnectListener);
      reject(new Error("Offscreen Document response timeout"));
    }, 12e4);
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "offscreen-onnx") {
    offscreenPort = port;
    port.onDisconnect.addListener(() => {
      offscreenPort = null;
    });
  }
  if (port.name === "content-onnx") {
    port.onMessage.addListener(async (message) => {
      const msg = message;
      const messageId = msg.messageId;
      if (msg.topic !== "local-onnx:translate") return;
      try {
        const result = await sendToOffscreen(msg);
        port.postMessage({ messageId, result });
      } catch (err) {
        port.postMessage({ messageId, error: err instanceof Error ? err.message : String(err) });
      }
    });
    port.onDisconnect.addListener(() => {
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
  if (msg.topic === "offscreen:idle-close") {
    chrome.offscreen.closeDocument().then(() => {
      offscreenPort = null;
      console.warn("[AI_Trans] offscreen document closed after idle timeout");
    }).catch((err) => {
      const cause = err instanceof Error ? err : new Error(String(err));
      console.warn("[AI_Trans] offscreen closeDocument failed:", cause);
      recordDiagnostic({
        type: "pipeline-error",
        error: {
          port: "audio",
          code: "offscreen-close-failed",
          recoverable: true,
          cause
        }
      });
    });
    return false;
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
  if (msg.topic?.startsWith("asr-whisper:")) {
    void sendToOffscreen(msg).then((result) => sendResponse({ ok: true, result })).catch(
      (err) => sendResponse({
        ok: false,
        error: `asr-whisper operation failed: ${err instanceof Error ? err.message : String(err)}`
      })
    );
    return true;
  }
  if (msg.topic === "sw:proxy-fetch") {
    const payload = msg.payload;
    const url = payload?.url;
    if (!url) {
      sendResponse({ ok: false, error: "sw:proxy-fetch: missing url" });
      return false;
    }
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          sendResponse({
            ok: false,
            error: `sw:proxy-fetch: HTTP ${response.status} ${response.statusText}`
          });
          return;
        }
        const contentLength = Number(response.headers.get("content-length")) || 0;
        const reader = response.body?.getReader();
        const chunks = [];
        let loaded = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
              loaded += value.length;
              chrome.runtime.sendMessage({
                type: "sw:download-progress",
                url,
                loaded,
                total: contentLength
              }).catch(() => {
              });
            }
          }
        }
        const blob = new Blob(chunks);
        const headers = new Headers(response.headers);
        const cachedResponse = new Response(blob, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
        const cache = await caches.open("transformers-cache");
        await cache.put(new Request(url), cachedResponse);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: `sw:proxy-fetch: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    })();
    return true;
  }
  if (msg.topic === "sw:proxy-fetch-llm") {
    const payload = msg.payload;
    const url = payload?.url;
    if (!url) {
      sendResponse({ ok: false, error: "sw:proxy-fetch-llm: missing url" });
      return false;
    }
    void (async () => {
      try {
        const response = await fetch(url, {
          method: payload.method ?? "POST",
          headers: payload.headers,
          body: payload.body
        });
        const text = await response.text();
        sendResponse({
          ok: response.ok,
          status: response.status,
          body: text
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: `sw:proxy-fetch-llm: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    })();
    return true;
  }
  return false;
});
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => console.warn("[AI_Trans:sw] SW onStartup"));
}
if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => console.warn("[AI_Trans:sw] SW onInstalled"));
}
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => console.warn("[AI_Trans:sw] SW onSuspend"));
}

