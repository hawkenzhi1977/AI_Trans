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
      const translateMsg = message as { topic: string; text: string; targetLang: string; sourceLang?: string };
      void runInference(translateMsg.text, translateMsg.targetLang, translateMsg.sourceLang).then((result) => {
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
function connectToServiceWorker(): void {
  const port = chrome.runtime.connect({ name: 'offscreen-onnx' });

  port.onMessage.addListener(async (message: unknown) => {
    const msg = message as { topic?: string; type?: string; messageId?: string; text?: string; targetLang?: string; sourceLang?: string };
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
        case 'local-onnx:download':
          result = await downloadModel();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:clear-cache':
          result = await clearModelCache();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:translate':
          result = await runInference(msg.text ?? '', msg.targetLang ?? '', msg.sourceLang);
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

/** 本地 ONNX 翻譯 pipeline 實例（延遲初始化）。 */
let translationPipeline: unknown = null;

/** 模型名稱（唯讀，預設為 Qwen2.5-0.5B）。 */
const LOCAL_MODEL_NAME = DEFAULT_LOCAL_TRANSLATION_MODEL;

/**
 * 檢查模型狀態——查詢 IndexedDB 是否已有模型快取。
 * 使用 transformers.js 的 env.cacheDir 查詢機制。
 */
async function checkModelStatus(): Promise<OffscreenResponse> {
  try {
    // 動態導入 transformers.js（避免硬依賴，esbuild 會 tree-shake）。
    const transformers = await import('@huggingface/transformers');
    const { env } = transformers;

    // 檢查 cache 中是否有模型（transformers.js 使用 IndexedDB 快取）。
    // 嘗試打開 pipeline，若模型未下載會拋錯或返回 null。
    const downloaded = translationPipeline !== null || (await hasModelInCache(env));

    const response: OffscreenResponse = {
      type: 'local-onnx:status',
      downloaded,
      modelName: LOCAL_MODEL_NAME,
    };
    return response;
  } catch (err) {
    // §5.6：狀態檢查失敗必須落診斷。
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-status-check-failed',
        recoverable: true,
        cause: err instanceof Error ? err : new Error(String(err)),
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
 * 查詢 IndexedDB 中是否有模型快取。
 * transformers.js v3 使用 IndexedDB 快取模型檔案。
 */
async function hasModelInCache(_env: { cacheDir?: string }): Promise<boolean> {
  try {
    // transformers.js v3 使用 IndexedDB 快取，database 名稱為 'transformers-cache'。
    const dbs = await indexedDB.databases();
    const hasTransformersCache = dbs.some(
      (db) => db.name === 'transformers-cache' || db.name === 'transformers'
    );
    if (!hasTransformersCache) return false;

    // 嘗試打開 cache database 檢查是否有對應模型的 entry。
    // 簡化檢查：若存在 transformers-cache database 且 translationPipeline 已初始化，視為已下載。
    return translationPipeline !== null;
  } catch {
    return false;
  }
}

/**
 * 下載模型——使用 transformers.js pipeline 加載模型到 IndexedDB。
 * 透過 progress_callback 實時回報下載進度。
 */
async function downloadModel(): Promise<OffscreenResponse> {
  try {
    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;

    // 配置執行後端：優先 WebGPU，自動退化至 WASM。
    env.allowLocalModels = false;
    // 設置 WASM 線程數（若可用）。
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 4;
      // M2-24：WASM 本地化——transformers.js v3 默認從 jsdelivr CDN 載入 wasm，
      // 網絡不可達會導致模型下載完成後 InferenceSession 初始化失敗。改指向擴充內資源。
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
    }

    // 進度回調：實時回報下載進度給 Options 頁面。
    const progressCallback = (progress: {
      status: string;
      progress?: number;
      loaded?: number;
      total?: number;
      name?: string;
      file?: string;
    }) => {
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

    // 加載模型（首次會從 HuggingFace Hub 下載到 IndexedDB）。
    // dtype: 'q4' 下載 INT4 量化版（onnx/model_q4.onnx，約 350MB），避免默認 fp32 大檔。
    translationPipeline = await pipeline(
      'text-generation',
      LOCAL_MODEL_NAME,
      {
        dtype: 'q4',
        device: 'wasm', // 使用 WASM 以確保兼容性（WebGPU 可後續優化）。
        progress_callback: progressCallback,
      }
    );

    return {
      type: 'local-onnx:download-complete',
      ok: true,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：下載失敗必須落診斷。
    const error = err instanceof Error ? err : new Error(String(err));
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
  if (!translationPipeline) {
    // 模型尚未下載，返回 notDownloaded 標記。
    return {
      type: 'local-onnx:translate-result',
      ok: false,
      notDownloaded: true,
      error: 'Local ONNX model not downloaded',
    } satisfies OffscreenResponse;
  }

  try {
    // 構造 Qwen2.5 翻譯 Prompt。
    const langName = getLanguageName(targetLang);
    const prompt = `You are a professional subtitle translator. Translate the following text into ${langName}. Output ONLY the translated text without explanations.\n\nText: ${text}`;

    // 執行推理（使用 pipeline 的 text-generation 功能）。
    const pipelineFn = translationPipeline as (
      input: string,
      options?: Record<string, unknown>
    ) => Promise<Array<{ generated_text: string }>>;

    const result = await pipelineFn(prompt, {
      max_new_tokens: 128,
      temperature: 0.1,
      do_sample: false,
    });

    // 解析生成結果——提取翻譯文本。
    const generatedText = result[0]?.generated_text ?? '';
    // 移除 prompt 前綴，只保留翻譯結果。
    const translatedText = generatedText.replace(prompt, '').trim();

    return {
      type: 'local-onnx:translate-result',
      ok: true,
      translatedText,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：推理失敗必須落診斷。
    const error = err instanceof Error ? err : new Error(String(err));
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
