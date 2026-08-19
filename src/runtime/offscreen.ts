// Offscreen Document 入口：MV3 中負責音頻捕獲與處理。
// Service Worker 無法處理長時間音頻流（會被回收），故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script 透過 chrome.runtime.connect 建立 port 長連接（避免 SW 掛起）。
// 同時負責本地 ONNX 翻譯模型的推理（Transformers.js + ONNX Runtime Web）。
import { recordDiagnostic } from '../infrastructure/diagnostics';
import { DEFAULT_LOCAL_TRANSLATION_MODEL } from '../domain/models/config';

/** Offscreen Document 接收的消息類型（ASR + 本地 ONNX 翻譯）。 */
type OffscreenRequest =
  | { type: 'startCapture'; streamId: string }
  | { type: 'stopCapture' }
  | { type: 'local-onnx:check-status' }
  | { type: 'local-onnx:warmup' }
  | { type: 'local-onnx:download' }
  | { type: 'local-onnx:clear-cache' }
  | { type: 'local-onnx:translate'; text: string; targetLang: string; sourceLang?: string };

/** Offscreen Document 發送的響應類型。 */
type OffscreenResponse =
  | { type: 'captureStarted' }
  | { type: 'captureStopped' }
  | { type: 'audioChunk'; pcm: Float32Array; sampleRate: number; timestamp: number }
  | { type: 'error'; message: string }
  | { type: 'local-onnx:status'; downloaded: boolean; modelName: string }
  | { type: 'local-onnx:warmup-complete'; ok: boolean; error?: string }
  | { type: 'local-onnx:download-progress'; progress: number; loaded: number; total: number }
  | { type: 'local-onnx:download-complete'; ok: boolean; error?: string }
  | { type: 'local-onnx:cache-cleared'; ok: boolean }
  | { type: 'local-onnx:translate-result'; ok: boolean; translatedText?: string; error?: string; notDownloaded?: boolean };

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let currentPort: chrome.runtime.Port | null = null;

/** 啟動 tabCapture 音頻捕獲。 */
async function startCapture(streamId: string, port: chrome.runtime.Port): Promise<void> {
  // §5.4：啟動前先清理舊 capture（ASR → ASR 視頻切換時可能有多個 MediaStream 同時活躍）。
  await stopCapture();
  try {
    // 使用 getMediaStreamId 獲取的 streamId 請求媒體流。
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints);
    mediaStream = stream;

    // 建立 AudioContext 解碼音頻流。
    audioContext = new AudioContext({ sampleRate: 16000 }); // Whisper 輸入 16kHz
    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessorNode 提取 PCM 數據（16kHz mono）。
    // bufferSize 4096 ≈ 256ms @ 16kHz，平衡延遲與 CPU。
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (event) => {
      const portRef = currentPort;
      if (!portRef) return;
      const inputData = event.inputBuffer.getChannelData(0);
      // 複製 Float32Array（事件回收後數據失效）。
      const pcm = new Float32Array(inputData.length);
      pcm.set(inputData);
      const response: OffscreenResponse = {
        type: 'audioChunk',
        pcm,
        sampleRate: audioContext?.sampleRate ?? 16000,
        timestamp: performance.now(),
      };
      portRef.postMessage(response);
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    currentPort = port;
    port.postMessage({ type: 'captureStarted' } satisfies OffscreenResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ type: 'error', message: `tabCapture failed: ${message}` } satisfies OffscreenResponse);
    // §5.6：tabCapture 失敗必須落診斷。
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'audio',
        code: 'tab-capture-failed',
        recoverable: true,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    });
    await stopCapture();
  }
}

/** 停止音頻捕獲並清理資源。 */
async function stopCapture(): Promise<void> {
  // §5.4：所有資源必須在 stop 時清理（音頻軌、AudioContext、ScriptProcessor）。
  const portRef = currentPort;
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }
  currentPort = null;
  if (portRef) {
    portRef.postMessage({ type: 'captureStopped' } satisfies OffscreenResponse);
  }
}

/** 處理來自 content-script 的 port 消息（ASR 音頻捕獲）。 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-asr') return;

  port.onMessage.addListener(async (msg: OffscreenRequest) => {
    switch (msg.type) {
      case 'startCapture':
        await startCapture(msg.streamId, port);
        break;
      case 'stopCapture':
        await stopCapture();
        port.postMessage({ type: 'captureStopped' } satisfies OffscreenResponse);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // port 斷開時清理音頻資源（§5.4）。
    void stopCapture();
  });
});

/**
 * 處理來自 Service Worker 轉發的 local-onnx 消息（通過 port 連接）。
 * 進度/狀態消息透過 chrome.runtime.sendMessage 廣播給所有 extension contexts（含 Options 頁面）。
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { topic?: string; type?: string };
  const type = msg.topic ?? msg.type;
  if (!type?.startsWith('local-onnx:')) return false;

  switch (type) {
    case 'local-onnx:check-status':
      void checkModelStatus().then((status) => {
        sendResponse(status);
        broadcastToAll(status);
      });
      return true;
    case 'local-onnx:warmup':
      // M2-24 補充修復十三：手動/自動預加載——模型快取存在時載入記憶體，
      // 消除首次翻譯的 30-60s 載入延遲（此前首塊 request 超時被 SW 拒絕）。
      void warmupModel().then((result) => {
        sendResponse(result);
        broadcastToAll(result);
      });
      return true;
    case 'local-onnx:download':
      void downloadModel().then((result) => {
        sendResponse(result);
        // 廣播完成消息給所有 extension contexts（Options 頁面監聽）。
        broadcastToAll(result);
      });
      return true;
    case 'local-onnx:clear-cache':
      void clearModelCache().then((result) => {
        sendResponse(result);
        broadcastToAll(result);
      });
      return true;
    case 'local-onnx:translate': {
      // 若 SW 轉發 port 通道已建立，本入口跳過——由 port 路徑處理，避免雙重推理
      // （chrome.runtime.sendMessage 會同時廣播給 SW 與 offscreen）。
      if (onnxPortConnected) return false;
      const translateMsg = message as {
        topic: string;
        payload?: { text?: string; targetLang?: string; sourceLang?: string };
        text?: string;
        targetLang?: string;
        sourceLang?: string;
      };
      void runInference(
        translateMsg.payload?.text ?? translateMsg.text ?? '',
        translateMsg.payload?.targetLang ?? translateMsg.targetLang ?? '',
        translateMsg.payload?.sourceLang ?? translateMsg.sourceLang
      ).then((result) => {
        sendResponse(result);
        broadcastToAll(result);
      });
      return true;
    }
  }
  return false;
});

/**
 * 主動建立 port 連接到 Service Worker。
 * 確保消息傳遞鏈路可靠（避免 chrome.runtime.sendMessage 的廣播循環問題）。
 */
let onnxPortConnected = false;
function connectToServiceWorker(): void {
  const port = chrome.runtime.connect({ name: 'offscreen-onnx' });
  onnxPortConnected = true;

  port.onMessage.addListener(async (message: unknown) => {
    const msg = message as {
      topic?: string;
      type?: string;
      messageId?: string;
      payload?: { text?: string; targetLang?: string; sourceLang?: string };
      text?: string;
      targetLang?: string;
      sourceLang?: string;
    };
    const type = msg.topic ?? msg.type;
    const messageId = msg.messageId;

    let result: unknown;
    let error: string | undefined;

    try {
      switch (type) {
        case 'local-onnx:check-status':
          result = await checkModelStatus();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:warmup':
          result = await warmupModel();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:download':
          result = await downloadModel();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:clear-cache':
          result = await clearModelCache();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:translate':
          // 統一消息形狀：優先 payload（provider 用 { payload: { text } }），兼容舊頂層 text。
          result = await runInference(
            msg.payload?.text ?? msg.text ?? '',
            msg.payload?.targetLang ?? msg.targetLang ?? '',
            msg.payload?.sourceLang ?? msg.sourceLang
          );
          broadcastToAll(result as OffscreenResponse);
          break;
        default:
          error = `Unknown message type: ${type}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // 返回響應給 Service Worker。
    port.postMessage({ messageId, result, error });
  });

  port.onDisconnect.addListener(() => {
    // Port 斷開時重新連接（Service Worker 可能重啟）。
    onnxPortConnected = false;
    setTimeout(() => connectToServiceWorker(), 1000);
  });
}

// 啟動時建立 port 連接。
connectToServiceWorker();

/** 廣播消息給所有 extension contexts（Options 頁面、content-script 等）。 */
function broadcastToAll(response: OffscreenResponse): void {
  try {
    chrome.runtime.sendMessage(response).catch(() => {
      // 無監聽者時忽略（正常情況：無頁面打開）。
    });
  } catch {
    // 非擴充環境忽略。
  }
}

// ============================================================
// 本地 ONNX 翻譯模型（Qwen2.5-0.5B-Instruct）處理
// ============================================================

/** 本地 ONNX 翻譯 pipeline 實例（延遲初始化；Offscreen 重啟後重置為 null）。 */
let translationPipeline: unknown = null;

/** 共享載入 Promise——防止並發重複載入（§5.5 async 組裝）。 */
let loadPromise: Promise<unknown> | null = null;

/** 模型名稱（唯讀，預設為 Qwen2.5-0.5B）。 */
const LOCAL_MODEL_NAME = DEFAULT_LOCAL_TRANSLATION_MODEL;

/** transformers.js 進度回調結構。 */
interface TransformersProgress {
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
  name?: string;
  file?: string;
}

/**
 * 統一錯誤轉換——ORT/transformers 可能拋出「數字型」錯誤碼（如 wasm trap 的
 * 1835858576，非 Error 對象文本），轉為保留 code/stack 的可讀 Error（§5.6 留痕）。
 */
function toReadableError(err: unknown): Error {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codeStr =
      typeof code === 'string' || typeof code === 'number' ? `code=${String(code)}` : '';
    const details = [err.message, codeStr, err.stack]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' | ');
    return new Error(details || 'unknown error');
  }
  return new Error(`[non-Error ${typeof err}] ${String(err)}`);
}

/**
 * 載入本地 ONNX 翻譯 pipeline（共享邏輯）。
 * download / check-status 預熱 / runInference lazy 載入三處複用；
 * env 配置統一在此設置，避免各調用點不一致導致行為漂移。
 */
async function loadPipeline(
  progressCallback?: (p: TransformersProgress) => void
): Promise<unknown> {
  const transformers = await import('@huggingface/transformers');
  const { pipeline, env } = transformers;

  // 執行後端配置：WASM（WebGPU 可後續優化）。
  env.allowLocalModels = false;
  // 詳細日誌：輸出 [ort] 初始化與推理錯誤，便於診斷本地 ONNX 失敗根因（wasm trap / 記憶體 / 算子）。
  // 類型聲明缺失 logLevel，運行時為 transformers.js/ORT 共用 env 的有效字段。
  (env as unknown as { logLevel: string }).logLevel = 'info';
  // WASM 本地化：transformers.js v3 默認從 jsdelivr CDN 載入 wasm，
  // 網絡不可達會導致 InferenceSession 初始化失敗。改指向擴充內資源。
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
    // numThreads 交由 transformers.js 自決：Offscreen 無 crossOriginIsolated 時自動降為 1，
    // 避免手動設 4 與 threaded wasm 初始化衝突（wasm trap 頭號嫌疑）。
  }

  // 加載模型（首次會從 HuggingFace Hub 下載到 Cache API）。
  // dtype: 'q4' 下載 INT4 量化版（onnx/model_q4.onnx，約 350MB），避免默認 fp32 大檔。
  return await pipeline('text-generation', LOCAL_MODEL_NAME, {
    dtype: 'q4',
    device: 'wasm',
    ...(progressCallback ? { progress_callback: progressCallback } : {}),
  });
}

/**
 * 確保 pipeline 已載入——已載入直接返回；否則觸發載入（並發安全）。
 * 用於 runInference 的 lazy 恢復與 check-status 預熱。
 */
async function ensurePipelineLoaded(
  progressCallback?: (p: TransformersProgress) => void
): Promise<unknown> {
  if (translationPipeline !== null) return translationPipeline;
  if (!loadPromise) {
    loadPromise = loadPipeline(progressCallback)
      .then((p) => {
        translationPipeline = p;
        return p;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

/**
 * 預加載本地 ONNX 模型到記憶體（M2-24 補充修復十三）。
 * 與 check-status 的後台預熱不同：本函數**等待載入完成**才返回，
 * 供 Options「預加載模型」按鈕 / Orchestrator 啟動前 warmup 阻塞確認。
 * 模型未下載時返回 ok:false（不觸發下載），調用方據此提示用戶先下載。
 */
async function warmupModel(): Promise<OffscreenResponse> {
  if (translationPipeline !== null) {
    return { type: 'local-onnx:warmup-complete', ok: true } satisfies OffscreenResponse;
  }
  try {
    if (!(await hasModelInCache())) {
      return {
        type: 'local-onnx:warmup-complete',
        ok: false,
        error: 'Local ONNX model not downloaded',
      } satisfies OffscreenResponse;
    }
    await ensurePipelineLoaded();
    return { type: 'local-onnx:warmup-complete', ok: true } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：預加載失敗必須落診斷（不靜默）。
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-warmup-failed',
        recoverable: true,
        cause: error,
      },
    });
    return {
      type: 'local-onnx:warmup-complete',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  }
}

/**
 * 檢查模型狀態——以 Cache API 真實快取為準。
 * transformers.js v3 用 Cache API（非 IndexedDB），且不依賴內存 translationPipeline，
 * 因此 Offscreen 重啟後狀態依然準確（不再誤報「未下載」）。
 */
async function checkModelStatus(): Promise<OffscreenResponse> {
  try {
    const downloaded = await hasModelInCache();
    // 快取存在且未載入 → 後台預熱（非阻塞；失敗僅記錄診斷，不影響狀態判定）。
    if (downloaded && translationPipeline === null) {
      void ensurePipelineLoaded().catch((err) => {
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: 'local-onnx-pipeline-warmup-failed',
            recoverable: true,
            cause: toReadableError(err),
          },
        });
      });
    }

    return {
      type: 'local-onnx:status',
      downloaded,
      modelName: LOCAL_MODEL_NAME,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：狀態檢查失敗必須落診斷。
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-status-check-failed',
        recoverable: true,
        cause: toReadableError(err),
      },
    });
    return {
      type: 'local-onnx:status',
      downloaded: false,
      modelName: LOCAL_MODEL_NAME,
    } satisfies OffscreenResponse;
  }
}

/**
 * 查詢本地模型快取——transformers.js v3 使用 Cache API（'transformers-cache'），
 * 檢查其中是否有模型檔案（.onnx）。不依賴內存 translationPipeline，
 * Offscreen 重啟後依然準確。
 */
async function hasModelInCache(): Promise<boolean> {
  try {
    const cachesApi = globalThis.caches;
    if (typeof cachesApi === 'undefined' || typeof cachesApi.keys !== 'function') {
      return false;
    }
    const cacheNames = await cachesApi.keys();
    const target = cacheNames.find((name) => name === 'transformers-cache');
    if (!target) return false;

    const cache = await cachesApi.open(target);
    const requests = await cache.keys();
    // 模型檔案（.onnx）存在即視為已下載。
    return requests.some((r) => r.url.includes('.onnx') || r.url.includes(LOCAL_MODEL_NAME));
  } catch {
    // 快取不可查時視為未下載；狀態檢查失敗留痕由調用方（checkModelStatus）記錄。
    return false;
  }
}

/**
 * 下載模型——使用 transformers.js pipeline 加載模型到 IndexedDB。
 * 透過 progress_callback 實時回報下載進度。
 */
async function downloadModel(): Promise<OffscreenResponse> {
  try {
    // 進度回調：實時回報下載進度給 Options 頁面。
    const progressCallback = (progress: TransformersProgress): void => {
      // §5.6：記錄所有進度回調以便診斷（進度始終為 0 問題）。
      console.log('[AI_Trans:local-onnx] progress_callback:', {
        status: progress.status,
        progress: progress.progress,
        loaded: progress.loaded,
        total: progress.total,
        name: progress.name,
        file: progress.file,
      });

      if (progress.status === 'progress' && progress.progress !== undefined) {
        broadcastToAll({
          type: 'local-onnx:download-progress',
          progress: progress.progress,
          loaded: progress.loaded ?? 0,
          total: progress.total ?? 0,
        });
      } else if (progress.status === 'initiate') {
        // 開始下載——發送初始進度。
        console.log('[AI_Trans:local-onnx] download initiated for:', progress.name ?? progress.file);
        broadcastToAll({
          type: 'local-onnx:download-progress',
          progress: 0,
          loaded: 0,
          total: progress.total ?? 0,
        });
      } else if (progress.status === 'done') {
        // 單個檔案下載完成。
        console.log('[AI_Trans:local-onnx] file download done:', progress.name ?? progress.file);
      } else if (progress.status === 'ready') {
        // 模型準備就緒。
        console.log('[AI_Trans:local-onnx] model ready');
        broadcastToAll({
          type: 'local-onnx:download-progress',
          progress: 100,
          loaded: progress.total ?? 0,
          total: progress.total ?? 0,
        });
      }
    };

    // 加載模型（首次會從 HuggingFace Hub 下載到 Cache API；env 配置統一在 loadPipeline）。
    await ensurePipelineLoaded(progressCallback);

    return {
      type: 'local-onnx:download-complete',
      ok: true,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：下載失敗必須落診斷。
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-download-failed',
        recoverable: true,
        cause: error,
      },
    });
    return {
      type: 'local-onnx:download-complete',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  }
}

/**
 * 清除模型快取——刪除 IndexedDB 中的 transformers-cache。
 */
async function clearModelCache(): Promise<OffscreenResponse> {
  try {
    // 清除 pipeline 實例。
    translationPipeline = null;

    // 刪除 IndexedDB 中的 transformers-cache database。
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name === 'transformers-cache' || db.name === 'transformers') {
        indexedDB.deleteDatabase(db.name);
      }
    }

    // 同時清除 Cache API（transformers.js 可能使用）。
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      for (const key of keys) {
        if (key.includes('transformers') || key.includes('huggingface')) {
          await caches.delete(key);
        }
      }
    }

    return {
      type: 'local-onnx:cache-cleared',
      ok: true,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：快取清理失敗必須落診斷。
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-cache-clear-failed',
        recoverable: true,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    });
    return {
      type: 'local-onnx:cache-cleared',
      ok: false,
    } satisfies OffscreenResponse;
  }
}

/**
 * 執行翻譯推理——使用本地 ONNX 模型翻譯文本。
 * 構造 Qwen2.5 Prompt 並解析生成結果。
 */
async function runInference(
  text: string,
  targetLang: string,
  _sourceLang: string | undefined
): Promise<OffscreenResponse> {
  // lazy 恢復：pipeline 未載入但快取存在 → 自動載入（Offscreen 重啟後無需重新下載）。
  if (translationPipeline === null) {
    try {
      if (await hasModelInCache()) {
        await ensurePipelineLoaded();
      }
    } catch (err) {
      // §5.6：lazy 載入失敗必須落診斷（不靜默回 notDownloaded）。
      const error = toReadableError(err);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-pipeline-load-failed',
          recoverable: true,
          cause: error,
        },
      });
      return {
        type: 'local-onnx:translate-result',
        ok: false,
        notDownloaded: true,
        error: error.message,
      } satisfies OffscreenResponse;
    }
    if (translationPipeline === null) {
      // 快取不存在 → 模型確實未下載。
      return {
        type: 'local-onnx:translate-result',
        ok: false,
        notDownloaded: true,
        error: 'Local ONNX model not downloaded',
      } satisfies OffscreenResponse;
    }
  }

  try {
    // 構造 Qwen2.5 翻譯 Prompt（ChatML + 行號標記 + few-shot）。
    // M2-24 補充修復十一：純文本指令對 0.5B 小模型遵循度極低 → 模型回顯原文
    // （兩行一模一樣的英文）；改 ChatML 格式 + 行號對齊 + 示例。
    const sourceLines = text.split('\n');
    const prompt = buildPrompt(text, targetLang);

    // 執行推理（使用 pipeline 的 text-generation 功能）。
    // 貪婪解碼 + repetition_penalty 抑制回顯；max_new_tokens 分塊後輸入變短，
    // 256 足夠完成翻譯（96 曾把預算耗在回顯上）。
    const pipelineFn = translationPipeline as (
      input: string,
      options?: Record<string, unknown>
    ) => Promise<Array<{ generated_text: string }>>;

    const result = await pipelineFn(prompt, {
      max_new_tokens: 256,
      do_sample: false,
      repetition_penalty: 1.1,
    });

    // 解析生成結果——按行號還原譯文。
    const generatedText = result[0]?.generated_text ?? '';
    // 麵包屑：保留原始生成文本前 500 字符，供診斷模型行為（§5.6 留痕）。
    console.log('[AI_Trans:local-onnx] generated_text:', JSON.stringify(generatedText.slice(0, 500)));

    const { translatedLines, echoed } = parseNumberedOutput(generatedText, sourceLines);

    if (echoed) {
      // §5.6：模型回顯原文屬低質量輸出——落診斷，popup「最近失敗」可查。
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-echo-output',
          recoverable: true,
          cause: new Error(
            'local ONNX model echoed input instead of translating (low quality output)'
          ),
        },
      });
    }

    return {
      type: 'local-onnx:translate-result',
      ok: true,
      translatedText: translatedLines.join('\n'),
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：推理失敗必須落診斷。
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-inference-failed',
        recoverable: true,
        cause: error,
      },
    });
    return {
      type: 'local-onnx:translate-result',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  }
}

/**
 * 目標語言 few-shot 示例（英 → 目標語）。
 * 小模型對示例的遵循度遠高於文字指令（M1-55 教訓）；示例行號用 9/10 與實際輸入行號
 * （1..N）區分，避免模型把示例當作輸入內容。未覆蓋語言僅用行號指令（大模型可理解）。
 */
const FEW_SHOT_LINES: Record<string, Array<[string, string]>> = {
  'Traditional Chinese': [
    ['Hello, world.', '你好，世界。'],
    ['How are you?', '你好嗎？'],
  ],
  'Simplified Chinese': [
    ['Hello, world.', '你好，世界。'],
    ['How are you?', '你好吗？'],
  ],
  Japanese: [
    ['Hello, world.', 'こんにちは、世界。'],
    ['How are you?', 'お元気ですか？'],
  ],
  Korean: [
    ['Hello, world.', '안녕하세요, 세계.'],
    ['How are you?', '잘 지내세요?'],
  ],
  Spanish: [
    ['Hello, world.', 'Hola, mundo.'],
    ['How are you?', '¿Cómo estás?'],
  ],
  French: [
    ['Hello, world.', 'Bonjour le monde.'],
    ['How are you?', 'Comment allez-vous ?'],
  ],
  German: [
    ['Hello, world.', 'Hallo, Welt.'],
    ['How are you?', 'Wie geht es dir?'],
  ],
  Portuguese: [
    ['Hello, world.', 'Olá, mundo.'],
    ['How are you?', 'Como você está?'],
  ],
  Russian: [
    ['Hello, world.', 'Привет, мир.'],
    ['How are you?', 'Как дела?'],
  ],
};

/**
 * 構造翻譯 Prompt——ChatML 格式 + 行號標記 + 目標語言 few-shot。
 * Qwen2.5 系列（0.5B~72B）均使用 ChatML，換更大 Qwen 模型天然兼容；
 * 換非 Qwen 架構時僅需修改本函數（單點改動）。
 * 行號對齊讓模型按「行號 → 譯文」輸出，避免多行重排/錯位導致譯文落回原文。
 */
function buildPrompt(text: string, targetLang: string): string {
  const langName = getLanguageName(targetLang);
  const numbered = text
    .split('\n')
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n');

  const fewShot = FEW_SHOT_LINES[langName];
  const fewShotText = fewShot
    ? `\nExamples:\n${fewShot.map(([src, dst]) => `9. ${src}\n9. ${dst}`).join('\n')}`
    : '';

  return `<|im_start|>system
You are a professional subtitle translator. Translate each numbered line into ${langName}. Keep the same line numbers and output ONLY the translation after each number, one line per input line, no explanations.${fewShotText}
<|im_end|>
<|im_start|>user
${numbered}
<|im_end|>
<|im_start|>assistant
`;
}

/**
 * 解析模型的「行號 → 譯文」輸出，按輸入行序還原譯文數組。
 * 缺行/無效行以原文兜底；全部回顯原文時標記低質量（echo），供調用方留診斷。
 */
function parseNumberedOutput(
  generated: string,
  sourceLines: string[]
): { translatedLines: string[]; echoed: boolean } {
  const parsed = new Map<number, string>();
  for (const line of generated.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]?\s+(.+)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      const val = m[2].trim();
      if (idx >= 0 && val.length > 0) parsed.set(idx, val);
    }
  }
  const translatedLines = sourceLines.map((src, i) => parsed.get(i)?.trim() || src);
  const echoed =
    sourceLines.length > 0 && translatedLines.every((t, i) => t === sourceLines[i]);
  return { translatedLines, echoed };
}

/** 語言代碼映射為語言名稱（用於 Prompt）。 */
function getLanguageName(langCode: string): string {
  const map: Record<string, string> = {
    'zh-Hant': 'Traditional Chinese',
    'zh-Hans': 'Simplified Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    ru: 'Russian',
    ar: 'Arabic',
    hi: 'Hindi',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    ms: 'Malay',
    it: 'Italian',
    nl: 'Dutch',
    tr: 'Turkish',
    pl: 'Polish',
    uk: 'Ukrainian',
  };
  return map[langCode] ?? langCode;
}

// ============================================================
// 測試導出（僅集成測試引用；runtime 入口不受影響）
// ============================================================

/** 重置模組內模型載入狀態（避免跨測試污染）。 */
export function resetLocalOnnxModuleForTest(): void {
  translationPipeline = null;
  loadPromise = null;
}

/** 供測試直接調用內部狀態檢查/推理邏輯。 */
export const _testExports = {
  hasModelInCache,
  checkModelStatus,
  runInference,
  clearModelCache,
  buildPrompt,
  parseNumberedOutput,
  warmupModel,
};
