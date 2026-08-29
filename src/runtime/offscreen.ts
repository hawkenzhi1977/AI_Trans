// Offscreen Document 入口：MV3 中負責音頻捕獲與處理。
// Service Worker 無法處理長時間音頻流（會被回收），故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script 透過 chrome.runtime.connect 建立 port 長連接（避免 SW 掛起）。
// 同時負責本地 ONNX 翻譯模型的推理（Transformers.js + ONNX Runtime Web）。
import { recordDiagnostic } from '../infrastructure/diagnostics';
import { IdleTimeout } from '../infrastructure/idle-timeout';
import { LOCAL_ONNX_MODEL } from '../domain/models/config';
import OpenCC from 'opencc-js';

/** 簡體→繁體轉換器（部分模型仍可能輸出簡體，zh-Hant 目標統一轉繁體安全網）。 */
const s2tConverter = OpenCC.Converter({ from: 'cn', to: 't' });

/** Offscreen Document 接收的消息類型（ASR + 本地 ONNX 翻譯）。 */
type OffscreenRequest =
  | { type: 'startCapture'; streamId: string }
  | { type: 'stopCapture' }
  | { type: 'local-onnx:check-status' }
  | { type: 'local-onnx:warmup' }
  | { type: 'local-onnx:download' }
  | { type: 'local-onnx:clear-cache' }
  | { type: 'local-onnx:translate'; text: string; targetLang: string; sourceLang?: string }
  | { type: 'asr-whisper:check-status'; payload: { modelId: string } }
  | { type: 'asr-whisper:download'; payload: { modelId: string } }
  | { type: 'asr-whisper:clear-cache'; payload?: { modelId?: string } }
  | { type: 'asr-whisper:warmup'; payload: { modelId: string } }
  | { type: 'asr-whisper:transcribe'; payload: { pcm: Float32Array; sampleRate: number; hintLang?: string } };

/** Offscreen Document 發送的響應類型。 */
type OffscreenResponse =
  | { type: 'captureStarted' }
  | { type: 'captureStopped' }
  | { type: 'audioChunk'; pcm: Float32Array; sampleRate: number; timestamp: number }
  | { type: 'error'; message: string }
  | { type: 'local-onnx:status'; downloaded: boolean; modelName: string; loaded?: boolean; loading?: boolean; downloading?: boolean }
  | { type: 'local-onnx:warmup-complete'; ok: boolean; error?: string }
  | { type: 'local-onnx:download-progress'; progress: number; loaded: number; total: number; fileCount?: number; completedFiles?: number }
  | { type: 'local-onnx:download-complete'; ok: boolean; error?: string }
  | { type: 'local-onnx:cache-cleared'; ok: boolean }
  | { type: 'local-onnx:translate-result'; ok: boolean; translatedText?: string; error?: string; notDownloaded?: boolean; echoed?: boolean; degenerate?: boolean; wrongLanguage?: boolean }
  | { type: 'asr-whisper:status'; downloaded: boolean; modelId: string; downloading?: boolean }
  | { type: 'asr-whisper:download-progress'; progress: number; loaded: number; total: number; fileCount?: number; completedFiles?: number }
  | { type: 'asr-whisper:download-complete'; ok: boolean; error?: string }
  | { type: 'asr-whisper:cache-cleared'; ok: boolean }
  | { type: 'asr-whisper:warmup-complete'; ok: boolean; error?: string }
  | { type: 'asr-whisper:transcribe-result'; ok: boolean; text?: string; chunks?: Array<{ text: string; timestamp?: [number, number] }>; error?: string; rtf?: number };

/**
 * 代理 Cache 實現：Offscreen/Content-script 受 CORS 限制無法直接 fetch HuggingFace，
 * 透過 Service Worker 代理 fetch（SW 有 host_permissions 即可跨域）。
 * 結果存入共享 Cache API（transformers-cache），transformers.js 從 Cache 讀取。
 *
 * 實現 transformers.js 的 customCache 接口（match + put）。
 */
class ProxyCache {
  private cacheName = 'transformers-cache';

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    const cache = await caches.open(this.cacheName);
    // 先檢查是否已緩存（可能由其他上下文寫入）。
    const cached = await cache.match(url);
    if (cached) return cached;
    // 未緩存 → 請求 SW 代理 fetch → SW 寫入 Cache → 再讀取。
    const response = await chrome.runtime.sendMessage({
      topic: 'sw:proxy-fetch',
      payload: { url },
    });
    const res = response as { ok: boolean; error?: string };
    if (!res.ok) {
      throw new Error(`ProxyCache fetch failed: ${res.error ?? 'unknown error'}`);
    }
    return cache.match(url);
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    // transformers.js 調用 put 時，數據已由 match 預填充，此處為 no-op。
    // 保留接口以滿足 customCache 合約。
    void request;
    void response;
  }
}

/** 全局 ProxyCache 實例（供 loadPipeline 和 ASR 下載共用）。 */
const proxyCache = new ProxyCache();

/**
 * 全局下載進度聚合器（供 SW 進度廣播使用）。
 * SW 串流下載時廣播 `sw:download-progress`，Offscreen 監聽並轉發給 UI。
 */
let globalDownloadAggregator: DownloadProgressAggregator | null = null;

/**
 * 監聽 SW 的串流下載進度廣播，轉發給 UI。
 * SW 的 `sw:proxy-fetch` 分塊讀取響應並廣播進度，此處接收並轉換為 UI 可消費的格式。
 */
chrome.runtime.onMessage.addListener((message: unknown): boolean => {
  const msg = message as { type?: string; url?: string; loaded?: number; total?: number };
  if (msg.type === 'sw:download-progress' && globalDownloadAggregator) {
    const url = msg.url ?? '';
    const loaded = msg.loaded ?? 0;
    const total = msg.total ?? 0;
    // 從 URL 提取檔案名作為 key（與 transformers.js progress.file 格式一致）。
    const fileKey = url.split('/').pop() ?? url;
    const agg = globalDownloadAggregator.update(fileKey, loaded, total);
    // 根據當前下載類型廣播對應的進度消息。
    if (asrDownloadInProgress) {
      broadcastToAll({
        type: 'asr-whisper:download-progress',
        progress: agg.progress,
        loaded: agg.loaded,
        total: agg.total,
        fileCount: agg.fileCount,
        completedFiles: agg.completedFiles,
      });
    } else if (localOnnxDownloadInProgress) {
      broadcastToAll({
        type: 'local-onnx:download-progress',
        progress: agg.progress,
        loaded: agg.loaded,
        total: agg.total,
        fileCount: agg.fileCount,
        completedFiles: agg.completedFiles,
      });
    }
  }
  return false;
});

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let currentPort: chrome.runtime.Port | null = null;

// ============================================================
// 空閒生命週期（M2-25）：offscreen 與 popup 共享 extension 進程，
// 空閒時必須釋放 WASM 模型 + 音頻資源並關閉 document，否則進程被佔滿
// 導致 popup 無法創建（真實環境「播放後 popup 彈不出」根因修復）。
// ============================================================

/** 空閒超時（毫秒）：10 分鐘無活動（翻譯/下載/音頻流）則關閉。 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** in-flight 守衛的重試間隔（有請求在飛時延後關閉）。 */
const IDLE_RETRY_MS = 30_000;
/** in-flight 請求計數——非 0 時不允許空閒關閉，避免打斷在飛請求。 */
let busyCount = 0;
/** 是否已發起空閒關閉（防止重複觸發）。 */
let idleCloseRequested = false;

/** 標記一次活動——重置空閒計時（翻譯/下載/音頻流都算活動）。 */
function markActivity(): void {
  idleTimeout.reset();
}

/** 空閒超時回調：in-flight 時延後重查；否則釋放資源並請求 SW 關閉。 */
function onIdleTimeout(): void {
  if (busyCount > 0) {
    // in-flight 守衛：有請求在飛時短延遲後再查，避免關閉打斷正在處理的推理/下載。
    setTimeout(onIdleTimeout, IDLE_RETRY_MS);
    return;
  }
  void shutdownForIdle();
}

/**
 * 空閒關閉：釋放音頻捕獲 + WASM 模型記憶體後，通知 SW 調用 chrome.offscreen.closeDocument()
 * （只有 SW 能關閉 offscreen document；本頁面不能自關）。
 * §5.4：關閉前必須完整清理（stopCapture / dispose pipeline / 停止計時器）。
 */
async function shutdownForIdle(): Promise<void> {
  if (idleCloseRequested) return;
  idleCloseRequested = true;
  idleTimeout.stop(); // 防止關閉流程中計時器重複觸發。
  console.warn('[AI_Trans] offscreen idle timeout — releasing resources and closing document');
  // 麵包屑：釋放前的 JS 堆（與載入後對比，驗證 WebGPU/WASM 佔用）。
  logJsHeapBreadcrumb('offscreen 空閒釋放前');

  // 釋放音頻捕獲（MediaStream / AudioContext / ScriptProcessor，§5.4）。
  try {
    await stopCapture();
  } catch (err) {
    console.warn('[AI_Trans] offscreen idle stopCapture failed:', err);
  }

  // 釋放翻譯 pipeline 的 WASM 記憶體（ORT session）。
  if (translationPipeline !== null) {
    try {
      await disposePipeline(translationPipeline);
    } catch (err) {
      console.warn('[AI_Trans] offscreen idle dispose translation pipeline failed:', err);
    }
    translationPipeline = null;
  }

  // 釋放 ASR pipeline（僅下載用，正常已 dispose；兜底清理）。
  if (asrPipeline !== null) {
    try {
      const candidate = asrPipeline as { dispose?: () => unknown | Promise<unknown> };
      if (typeof candidate?.dispose === 'function') {
        await candidate.dispose();
      }
    } catch {
      // dispose 失敗不阻塞關閉。
    }
    asrPipeline = null;
  }

  // 通知 Service Worker 關閉 document。
  try {
    await chrome.runtime.sendMessage({ topic: 'offscreen:idle-close' });
  } catch {
    // SW 可能已回收；document 遲早由瀏覽器回收。
  }
}

/** 空閒計時器（模組載入即啟動；每次活動 reset）。 */
const idleTimeout = new IdleTimeout({
  timeoutMs: IDLE_TIMEOUT_MS,
  onTimeout: onIdleTimeout,
});

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
      // 音頻流動即活動——重置空閒計時（音頻活躍期間 offscreen 不得空閒關閉）。
      markActivity();
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
    // ASR 捕獲相關消息也算活動——重置空閒計時。
    markActivity();
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
 * 處理來自 Service Worker 轉發的 local-onnx / asr-whisper 消息（通過 port 連接）。
 * 進度/狀態消息透過 chrome.runtime.sendMessage 廣播給所有 extension contexts（含 Options 頁面）。
 * 
 * 注意：此監聽器不调用 sendResponse()，只廣播結果。
 * 直接回應由 SW 透過 port 轉發並包裝為 { ok: true, result } 格式，確保 Options 頁面收到正確格式。
 * 若此處直接回應，會與 SW 的回應競爭，導致 Options 頁面收到未包裝的原始格式（Bug 2 根因）。
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender) => {
  const msg = message as { topic?: string; type?: string; payload?: { modelId?: string } };
  const type = msg.topic ?? msg.type;
  if (!type?.startsWith('local-onnx:') && !type?.startsWith('asr-whisper:')) return false;

  // 本地模型消息即活動——重置空閒計時（翻譯/下載/狀態查詢都算活動）。
  markActivity();

  // in-flight 守衛：處理期間 busyCount 遞增，防止空閒關閉打斷（§5.5）。
  busyCount += 1;
  const broadcast = (result: OffscreenResponse): void => {
    busyCount = Math.max(0, busyCount - 1);
    broadcastToAll(result);
  };

  switch (type) {
    case 'local-onnx:check-status':
      void checkModelStatus().then(broadcast);
      return false;
    case 'local-onnx:warmup':
      // M2-24 補充修復十三：手動/自動預加載——模型快取存在時載入記憶體，
      // 消除首次翻譯的 30-60s 載入延遲（此前首塊 request 超時被 SW 拒絕）。
      void warmupModel().then(broadcast);
      return false;
    case 'local-onnx:download': {
      void downloadModel().then(broadcast);
      return false;
    }
    case 'local-onnx:clear-cache':
      void clearModelCache().then(broadcast);
      return false;
    case 'local-onnx:translate': {
      // 若 SW 轉發 port 通道已建立，本入口跳過——由 port 路徑處理，避免雙重推理
      // （chrome.runtime.sendMessage 會同時廣播給 SW 與 offscreen）。
      if (onnxPortConnected) {
        busyCount = Math.max(0, busyCount - 1);
        return false;
      }
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
      ).then(broadcast);
      return false;
    }
    case 'asr-whisper:check-status':
      void checkAsrModelStatus(msg.payload?.modelId ?? 'Xenova/whisper-base.en').then(broadcast);
      return false;
    case 'asr-whisper:download':
      void downloadAsrModel(msg.payload?.modelId ?? 'Xenova/whisper-base.en').then(broadcast);
      return false;
    case 'asr-whisper:clear-cache':
      void clearAsrModelCache(msg.payload?.modelId).then(broadcast);
      return false;
    case 'asr-whisper:warmup': {
      const warmupMsg = message as { topic?: string; payload?: { modelId?: string } };
      void warmupAsrPipeline(warmupMsg.payload?.modelId ?? 'Xenova/whisper-base.en').then(broadcast);
      return false;
    }
    case 'asr-whisper:transcribe': {
      const transcribeMsg = message as { topic?: string; payload?: { pcm?: Float32Array; sampleRate?: number; hintLang?: string } };
      void runAsrInference(
        transcribeMsg.payload?.pcm ?? new Float32Array(0),
        transcribeMsg.payload?.sampleRate ?? 16000,
        transcribeMsg.payload?.hintLang
      ).then(broadcast);
      return false;
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
      payload?: { text?: string; targetLang?: string; sourceLang?: string; modelId?: string; pcm?: Float32Array; sampleRate?: number; hintLang?: string };
      text?: string;
      targetLang?: string;
      sourceLang?: string;
    };
    const type = msg.topic ?? msg.type;
    const messageId = msg.messageId;

    // 經 SW 轉發的消息即活動——重置空閒計時。
    markActivity();

    // in-flight 守衛：處理期間 busyCount 遞增，防止空閒關閉打斷（§5.5）。
    busyCount += 1;

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
        case 'local-onnx:download': {
          result = await downloadModel();
          broadcastToAll(result as OffscreenResponse);
          break;
        }
        case 'local-onnx:clear-cache':
          result = await clearModelCache();
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'local-onnx:translate': {
          // 統一消息形狀：優先 payload（provider 用 { payload: { text } }），兼容舊頂層 text。
          result = await runInference(
            msg.payload?.text ?? msg.text ?? '',
            msg.payload?.targetLang ?? msg.targetLang ?? '',
            msg.payload?.sourceLang ?? msg.sourceLang
          );
          broadcastToAll(result as OffscreenResponse);
          break;
        }
        case 'asr-whisper:check-status':
          result = await checkAsrModelStatus(msg.payload?.modelId ?? 'Xenova/whisper-base.en');
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'asr-whisper:download':
          result = await downloadAsrModel(msg.payload?.modelId ?? 'Xenova/whisper-base.en');
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'asr-whisper:clear-cache':
          result = await clearAsrModelCache(msg.payload?.modelId);
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'asr-whisper:warmup':
          result = await warmupAsrPipeline(msg.payload?.modelId ?? 'Xenova/whisper-base.en');
          broadcastToAll(result as OffscreenResponse);
          break;
        case 'asr-whisper:transcribe': {
          const pcmData = msg.payload?.pcm as Float32Array | undefined;
          result = await runAsrInference(
            pcmData ?? new Float32Array(0),
            (msg.payload?.sampleRate as number) ?? 16000,
            msg.payload?.hintLang as string | undefined
          );
          broadcastToAll(result as OffscreenResponse);
          break;
        }
        default:
          error = `Unknown message type: ${type}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busyCount = Math.max(0, busyCount - 1);
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
// 啟動空閒計時器——document 存活期間監控活動，超時觸發資源釋放與關閉。
idleTimeout.start();

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

/** 當前共享載入是否帶進度回調（防護 B：無回調的預熱載入不得被需要進度的下載複用）。 */
let loadPromiseHasProgress = false;

/**
 * 快取世代計數器（補充修復十五）——每次 clearModelCache 遞增。
 * 使載入期間快取被清除的「陳舊載入」結果失效（dispose 且不落地 translationPipeline），
 * 避免「清快取後重新下載」複用到仍在飛的舊載入而直接報錯、無實際下載。
 */
let cacheGeneration = 0;

/** 當前載入的模型名稱（固定為 Qwen2.5-0.5B-Instruct）。 */
let currentModelName: string = LOCAL_ONNX_MODEL;

/**
 * WebGPU 載入後端一次性失敗記憶（M2-26）——首次 webgpu 嘗試失敗後置 true，
 * 後續載入直接走 wasm，避免每次載入都重試不可用的 webgpu（反覆失敗 + 延遲）。
 * 僅影響本 Offscreen Document 生命週期；Document 重建後重置。
 */
let webgpuFailed = false;

/**
 * 決定模型載入後端設備——WebGPU 優先（權重進 GPU VRAM，不佔 extension 渲染進程
 * JS 堆），無 WebGPU（`navigator.gpu` 缺失）或曾失敗時回退 WASM。
 * WebGPU 將 ~350MB INT4 權重移出 extension 渲染進程，解除「popup/options 與
 * offscreen 共用渲染進程被模型撐爆 → popup 打不開」的根因。
 */
function preferWebGpu(): boolean {
  if (webgpuFailed) return false;
  try {
    return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
  } catch {
    return false;
  }
}

/** ASR Whisper pipeline 實例（僅用於下載，推理由 content-script 執行）。 */
let asrPipeline: unknown = null;

/** ASR Whisper 模型下載進行中旗標（M1-59）——供 check-status 讓 Options 頁顯示「下載中」。 */
let asrDownloadInProgress = false;

/** 本地 ONNX 翻譯模型下載進行中旗標——供 SW 進度廣播區分下載類型。 */
let localOnnxDownloadInProgress = false;

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
 * 多檔案下載進度聚合器——transformers.js 的 progress_callback 是 per-file 觸發的，
 * 每個文件各有 initiate → progress(0-100) → done 生命周期。直接廣播單文件進度會導致
 * 進度條在文件切換時從 100% 跳回 0%。此聚合器追蹤所有文件的 loaded/total bytes，
 * 計算整體百分比。
 */
class DownloadProgressAggregator {
  private files = new Map<string, { loaded: number; total: number; done: boolean }>();

  /** 更新單文件進度並返回整體百分比（0-100）與累計 loaded/total。 */
  update(file: string, loaded: number, total: number): { progress: number; loaded: number; total: number; fileCount: number; completedFiles: number } {
    const existing = this.files.get(file);
    const done = existing?.done ?? false;
    this.files.set(file, { loaded, total, done });
    let totalLoaded = 0;
    let totalBytes = 0;
    let completedFiles = 0;
    for (const f of this.files.values()) {
      totalLoaded += f.loaded;
      totalBytes += f.total;
      if (f.done) completedFiles++;
    }
    const progress = totalBytes > 0 ? Math.round((totalLoaded / totalBytes) * 100) : 0;
    return { progress, loaded: totalLoaded, total: totalBytes, fileCount: this.files.size, completedFiles };
  }

  /** 標記文件下載完成。 */
  markDone(file: string): void {
    const existing = this.files.get(file);
    if (existing) {
      existing.done = true;
    }
  }

  reset(): void {
    this.files.clear();
  }
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
 * 
 * 所有模型統一使用 text-generation pipeline + INT4 量化（dtype: 'q4'）。
 * - small (Qwen2-0.5B): ~750MB, chunk size=4
 * - large (Qwen2.5-0.5B): ~750MB, chunk size=5
 */
async function loadPipeline(
  progressCallback?: (p: TransformersProgress) => void
): Promise<unknown> {
  const transformers = await import('@huggingface/transformers');
  const { pipeline, env } = transformers;

  // 執行後端配置：WASM（WebGPU 優先，見 preferWebGpu）。
  env.allowLocalModels = false;
  // 詳細日誌：輸出 [ort] 初始化與推理錯誤，便於診斷本地 ONNX 失敗根因（wasm trap / 記憶體 / 算子）。
  // 類型聲明缺失 logLevel，運行時為 transformers.js/ORT 共用 env 的有效字段。
  (env as unknown as { logLevel: string }).logLevel = 'info';
  // 模型下載鏡像：HuggingFace 在中國大陸可能被牆，改用 hf-mirror.com 加速。
  (env as unknown as { remoteHost: string }).remoteHost = 'https://hf-mirror.com/';
  // 代理 Cache：Offscreen 受 CORS 限制無法直接 fetch HuggingFace，
  // 透過 Service Worker 代理 fetch（SW 有 host_permissions 即可跨域）。
  (env as unknown as { useCustomCache: boolean }).useCustomCache = true;
  (env as unknown as { customCache: ProxyCache }).customCache = proxyCache;
  // WASM 本地化：transformers.js v3 默認從 jsdelivr CDN 載入 wasm，
  // 網絡不可達會導致 InferenceSession 初始化失敗。改指向擴充內資源（webgpu 回退時仍需）。
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
    // numThreads 交由 transformers.js 自決：Offscreen 無 crossOriginIsolated 時自動降為 1，
    // 避免手動設 4 與 threaded wasm 初始化衝突（wasm trap 頭號嫌疑）。
  }

  // 所有模型統一使用 text-generation pipeline + INT4 量化
  const modelName = currentModelName;
  const device: 'webgpu' | 'wasm' = preferWebGpu() ? 'webgpu' : 'wasm';
  
  console.log(`[AI_Trans] 載入 LLM 模型: ${modelName}`);
  try {
    return await pipeline('text-generation', modelName, {
      dtype: 'q4',
      device,
      ...(progressCallback ? { progress_callback: progressCallback } : {}),
    });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // WebGPU 嘗試失敗 → 回退 WASM
    webgpuFailed = true;
    console.warn('[AI_Trans] WebGPU 載入失敗，回退 WASM:', err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'local-onnx-webgpu-fallback',
        recoverable: true,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    });
    return await pipeline('text-generation', modelName, {
      dtype: 'q4',
      device: 'wasm',
      ...(progressCallback ? { progress_callback: progressCallback } : {}),
    });
  }
}

/**
 * 記錄當前 JS 堆使用量麵包屑（M2-26 儀器化）——便於實機驗證 WebGPU 前後
 * extension 渲染進程記憶體差異。`performance.memory` 僅 Chrome 系有，守衛缺失環境。
 */
function logJsHeapBreadcrumb(label: string): void {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) {
      console.warn(`[AI_Trans] ${label} | jsHeapMB=${Math.round(mem.usedJSHeapSize / 1048576)}`);
    } else {
      console.warn(`[AI_Trans] ${label} | jsHeapMB=unknown (performance.memory 缺失)`);
    }
  } catch {
    /* 麵包屑不影響主流程 */
  }
}

/**
 * 標記「載入期間快取被清除」的錯誤——陳舊載入被作廢，供調用方區分並落專屬診斷。
 */
class ModelCacheClearedError extends Error {
  constructor() {
    super('local-onnx: model cache cleared during load');
    this.name = 'ModelCacheClearedError';
  }
}

/**
 * 釋放 pipeline 佔用的 wasm/ORT 記憶體（transformers.js Pipeline.dispose → model.dispose）。
 * 舊 session 不釋放會使反覆清/載後 wasm 堆膨脹，最終觸發 OOM 型 wasm trap。
 * 冪等安全：dispose 失敗不拋錯（避免 double-dispose 導致 "cannot release session" 崩潰）。
 */
async function disposePipeline(pipeline: unknown): Promise<void> {
  const candidate = pipeline as { dispose?: () => unknown | Promise<unknown> };
  if (typeof candidate?.dispose === 'function') {
    try {
      await candidate.dispose();
    } catch (err) {
      console.warn('[AI_Trans] disposePipeline error (ignored for idempotency):', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * 確保 pipeline 已載入——已載入直接返回；否則觸發載入（並發安全）。
 * 用於 runInference 的 lazy 恢復、check-status 預熱與 downloadModel。
  *
  * 補充修復十五（世代失效 + 進度防護）：
  * ① 世代失效——載入期間若快取被清除（cacheGeneration 遞增），載入結果立即 dispose
  *    且不落地 translationPipeline，並拋 ModelCacheClearedError，杜絕「清快取後
  *    重新下載複用陳舊載入」導致的 wasm trap（如 [non-Error number] 1025635888）。
  * ② 進度防護——已存在「無進度回調」的載入（如 check-status 預熱）時，若本次調用
  *    需要進度回調，等待其結束後以帶進度的新鮮載入承接，避免下載無進度可看。
  * ③ dispose 等待——載入前先等待 pending dispose 完成，避免 WASM 狀態衝突。
  */
async function ensurePipelineLoaded(
  progressCallback?: (p: TransformersProgress) => void
): Promise<unknown> {
  if (translationPipeline !== null) return translationPipeline;

  const gen = cacheGeneration;

  // 進度防護：既有載入無進度回調，但本次需要 → 等它結束再以帶進度的載入承接。
  if (loadPromise && !loadPromiseHasProgress && progressCallback) {
    try {
      await loadPromise;
    } catch {
      // 陳舊載入失敗不阻塞本次；失敗診斷由發起方（預熱）記錄，此處靜默等待結束。
    }
    if (translationPipeline !== null) return translationPipeline;
    if (gen !== cacheGeneration) {
      throw new ModelCacheClearedError();
    }
  }

  if (!loadPromise) {
    loadPromiseHasProgress = Boolean(progressCallback);
    const promise = loadPipeline(progressCallback)
      .then(async (p) => {
        // 載入期間快取被清除 → 作廢：dispose 釋放 wasm 記憶體、不落地，並拋專屬錯誤。
        if (gen !== cacheGeneration) {
          await disposePipeline(p);
          throw new ModelCacheClearedError();
        }
        translationPipeline = p;
        // 麵包屑：模型載入完成後的 JS 堆記憶體（驗證 WebGPU 前後差異）。
        logJsHeapBreadcrumb('local-onnx 模型已載入');
        return p;
      })
      .finally(() => {
        // §5.4：只有仍指向本次載入才清除，避免誤清後續的新鮮載入。
        if (loadPromise === promise) {
          loadPromise = null;
          loadPromiseHasProgress = false;
        }
      });
    loadPromise = promise;
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
    // M1-59：背景預熱完成/失敗時主動 broadcast 最新狀態，讓開啟中的 Options 頁即時
    // 從「預加載中」刷新為「已預加載（記憶體）」（此前 Options 只會在頁面生命週期
    // 內主動查一次狀態，背景預熱完成後不會自動刷新）。
    if (downloaded && translationPipeline === null) {
      void ensurePipelineLoaded()
        .then(() => {
          broadcastToAll({
            type: 'local-onnx:status',
            downloaded,
            modelName: currentModelName,
            loaded: true,
            loading: false,
            downloading: false,
          });
        })
        .catch((err) => {
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

    // M1-59：擴充狀態字段——讓 Options 頁能區分「已下載」與「已預加載到記憶體」，
    // 並在地圖背景預熱（check-status 觸發）進行中時顯示「預加載中」。
    const loaded = translationPipeline !== null;
    const loading = loadPromise !== null && !loaded;
    return {
      type: 'local-onnx:status',
      downloaded,
      modelName: currentModelName,
      loaded,
      loading,
      downloading: false,
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
      modelName: currentModelName,
    } satisfies OffscreenResponse;
  }
}

/**
 * 清除指定模型的快取檔案——按 modelName 過濾 Cache API 條目，僅刪除匹配項。
 * 用於檔位切換時清理舊檔位模型，釋放儲存空間。
 */
async function clearCacheForModel(modelName: string): Promise<void> {
  try {
    const cachesApi = globalThis.caches;
    if (typeof cachesApi === 'undefined' || typeof cachesApi.keys !== 'function') return;
    const cacheNames = await cachesApi.keys();
    const target = cacheNames.find((name) => name === 'transformers-cache');
    if (!target) return;

    const cache = await cachesApi.open(target);
    const requests = await cache.keys();
    for (const req of requests) {
      if (req.url.includes(modelName)) {
        await cache.delete(req);
      }
    }
    console.log(`[AI_Trans] 已清除模型快取: ${modelName}`);
  } catch (err) {
    console.warn('[AI_Trans] clearCacheForModel failed:', err);
  }
}

/**
 * 查詢本地模型快取——transformers.js v3 使用 Cache API（'transformers-cache'），
 * 檢查其中是否有當前檔位模型的檔案。不依賴內存 translationPipeline，
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
    // 精確匹配當前檔位模型名稱（避免多檔位共存時誤判）。
    return requests.some((r) => r.url.includes(currentModelName));
  } catch {
    // 快取不可查時視為未下載；狀態檢查失敗留痕由調用方（checkModelStatus）記錄。
    return false;
  }
}

/**
 * 下載模型——使用 transformers.js pipeline 加載模型到 IndexedDB。
 * 透過 progress_callback 實時回報下載進度。
 * SW 串流下載時廣播 `sw:download-progress`，此處監聽並轉發給 UI。
 */
async function downloadModel(): Promise<OffscreenResponse> {
  localOnnxDownloadInProgress = true;
  try {
    // 進度聚合器：多檔案下載時計算整體百分比（避免進度條在文件切換時跳回 0%）。
    const aggregator = new DownloadProgressAggregator();
    globalDownloadAggregator = aggregator;

    // 進度回調：實時回報下載進度給 Options 頁面。
    // 注意：由於 ProxyCache 架構，transformers.js 的 progress_callback 不會收到中間進度，
    // 實際進度由 SW 串流下載廣播，透過 globalDownloadAggregator 更新。
    const progressCallback = (progress: TransformersProgress): void => {
      const fileKey = progress.file ?? progress.name ?? 'unknown';

      if (progress.status === 'progress' && progress.loaded !== undefined) {
        // 此分支在 ProxyCache 架構下不會觸發，保留以備未來直接下載場景。
        const agg = aggregator.update(fileKey, progress.loaded, progress.total ?? 0);
        broadcastToAll({
          type: 'local-onnx:download-progress',
          progress: agg.progress,
          loaded: agg.loaded,
          total: agg.total,
          fileCount: agg.fileCount,
          completedFiles: agg.completedFiles,
        });
      } else if (progress.status === 'initiate') {
        console.log('[AI_Trans:local-onnx] download initiated for:', fileKey, 'total:', progress.total);
        // initiate 時註冊文件（loaded=0），但不廣播 0%（避免進度條跳回）。
        aggregator.update(fileKey, 0, progress.total ?? 0);
      } else if (progress.status === 'done') {
        console.log('[AI_Trans:local-onnx] file download done:', fileKey);
        aggregator.markDone(fileKey);
      } else if (progress.status === 'ready') {
        console.log('[AI_Trans:local-onnx] model ready');
        broadcastToAll({
          type: 'local-onnx:download-progress',
          progress: 100,
          loaded: 0,
          total: 0,
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
    // 補充修復十五：載入期間快取被清除導致陳舊載入作廢 → 落專屬診斷碼，讓用戶/開發者
    // 區分「快取被清除需要重試」與一般下載失敗，而非「下載沒實際開始」的困惑。
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code:
          err instanceof ModelCacheClearedError
            ? 'local-onnx-download-stale-load'
            : 'local-onnx-download-failed',
        recoverable: true,
        cause: error,
      },
    });
    return {
      type: 'local-onnx:download-complete',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  } finally {
    localOnnxDownloadInProgress = false;
    globalDownloadAggregator = null;
  }
}

/**
 * 清除模型快取——刪除 Cache API / IndexedDB 中的 transformers-cache。
 * 補充修復十五：同時重置共享載入狀態（loadPromise/世代），使在飛的陳舊載入失效，
 * 並 dispose 舊 pipeline 釋放 wasm 記憶體——避免「清快取後重新下載」複用陳舊載入。
 */
async function clearModelCache(): Promise<OffscreenResponse> {
  try {
    // 世代遞增：令所有 in-flight 載入結果作廢（ensurePipelineLoaded 內 dispose + 不落地）。
    cacheGeneration += 1;

    // dispose 舊 pipeline（釋放 ORT wasm session 記憶體），再重置共享狀態。
    if (translationPipeline !== null) {
      await disposePipeline(translationPipeline);
    }
    // 清除 pipeline 實例與共享載入狀態。
    translationPipeline = null;
    loadPromise = null;
    loadPromiseHasProgress = false;

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

// ============================================================
// ASR Whisper 模型下載（Offscreen 側）
// ============================================================

/**
 * 檢查指定的 Whisper 模型是否已緩存在 transformers-cache 中。
 * 與翻譯模型區分：僅檢查 URL 包含特定 Whisper 模型 ID 的 .onnx 文件。
 */
async function hasAsrModelInCache(modelId: string): Promise<boolean> {
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
    return requests.some((r) => r.url.includes('.onnx') && r.url.includes(modelId));
  } catch {
    return false;
  }
}

/** 檢查 ASR 模型狀態。 */
async function checkAsrModelStatus(modelId: string): Promise<OffscreenResponse> {
  try {
    const downloaded = await hasAsrModelInCache(modelId);
    return {
      type: 'asr-whisper:status',
      downloaded,
      modelId,
      downloading: asrDownloadInProgress,
    } satisfies OffscreenResponse;
  } catch (err) {
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'asr',
        code: 'asr-whisper-status-check-failed',
        recoverable: true,
        cause: toReadableError(err),
      },
    });
    return {
      type: 'asr-whisper:status',
      downloaded: false,
      modelId,
    } satisfies OffscreenResponse;
  }
}

/** 下載 ASR Whisper 模型——使用 transformers.js pipeline 觸發下載到 Cache API。 */
async function downloadAsrModel(modelId: string): Promise<OffscreenResponse> {
  asrDownloadInProgress = true;
  try {
    // 先檢查是否已緩存，避免重複下載。
    if (await hasAsrModelInCache(modelId)) {
      return {
        type: 'asr-whisper:download-complete',
        ok: true,
      } satisfies OffscreenResponse;
    }

    // 進度聚合器：多檔案下載時計算整體百分比。
    const aggregator = new DownloadProgressAggregator();
    globalDownloadAggregator = aggregator;

    const progressCallback = (progress: TransformersProgress): void => {
      const fileKey = progress.file ?? progress.name ?? 'unknown';

      if (progress.status === 'progress' && progress.loaded !== undefined) {
        // 此分支在 ProxyCache 架構下不會觸發，保留以備未來直接下載場景。
        const agg = aggregator.update(fileKey, progress.loaded, progress.total ?? 0);
        broadcastToAll({
          type: 'asr-whisper:download-progress',
          progress: agg.progress,
          loaded: agg.loaded,
          total: agg.total,
          fileCount: agg.fileCount,
          completedFiles: agg.completedFiles,
        });
      } else if (progress.status === 'initiate') {
        console.log('[AI_Trans:asr-whisper] download initiated for:', fileKey, 'total:', progress.total);
        aggregator.update(fileKey, 0, progress.total ?? 0);
      } else if (progress.status === 'done') {
        console.log('[AI_Trans:asr-whisper] file download done:', fileKey);
        aggregator.markDone(fileKey);
      } else if (progress.status === 'ready') {
        console.log('[AI_Trans:asr-whisper] model ready');
        broadcastToAll({
          type: 'asr-whisper:download-progress',
          progress: 100,
          loaded: 0,
          total: 0,
        });
      }
    };

    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;

    // 模型下載鏡像：HuggingFace 在中國大陸可能被牆，改用 hf-mirror.com 加速。
    (env as unknown as { remoteHost: string }).remoteHost = 'https://hf-mirror.com/';
    // 代理 Cache：Offscreen 受 CORS 限制無法直接 fetch HuggingFace，
    // 透過 Service Worker 代理 fetch（SW 有 host_permissions 即可跨域）。
    (env as unknown as { useCustomCache: boolean }).useCustomCache = true;
    (env as unknown as { customCache: ProxyCache }).customCache = proxyCache;
    // WASM 本地化（與翻譯模型共享 env 配置，但確保已設置）。
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
    }

    asrPipeline = await pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progressCallback,
    });

    // 下載完成後 dispose pipeline——ASR 推理在 content-script 中執行，
    // Offscreen 中的 pipeline 僅用於觸發下載，不需保留在記憶體。
    if (asrPipeline) {
      const candidate = asrPipeline as { dispose?: () => unknown | Promise<unknown> };
      if (typeof candidate?.dispose === 'function') {
        await candidate.dispose();
      }
      asrPipeline = null;
    }

    return {
      type: 'asr-whisper:download-complete',
      ok: true,
    } satisfies OffscreenResponse;
  } catch (err) {
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'asr',
        code: 'asr-whisper-download-failed',
        recoverable: true,
        cause: error,
      },
    });
    // 確保失敗時也清理 pipeline。
    if (asrPipeline) {
      try {
        const candidate = asrPipeline as { dispose?: () => unknown | Promise<unknown> };
        if (typeof candidate?.dispose === 'function') {
          await candidate.dispose();
        }
      } catch { /* dispose 失敗不影響錯誤報告 */ }
      asrPipeline = null;
    }
    return {
      type: 'asr-whisper:download-complete',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  } finally {
    asrDownloadInProgress = false;
    globalDownloadAggregator = null;
  }
}

/** 清除 ASR Whisper 模型緩存——僅刪除 Whisper 相關緩存，不影響翻譯模型。 */
async function clearAsrModelCache(modelId?: string): Promise<OffscreenResponse> {
  try {
    // 先 dispose 已有的 ASR pipeline。
    if (asrPipeline) {
      const candidate = asrPipeline as { dispose?: () => unknown | Promise<unknown> };
      if (typeof candidate?.dispose === 'function') {
        await candidate.dispose();
      }
      asrPipeline = null;
    }

    // 清除 Cache API 中 Whisper 相關的緩存。
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      for (const key of keys) {
        if (key.includes('transformers') || key.includes('huggingface')) {
          const cache = await caches.open(key);
          const requests = await cache.keys();
          for (const req of requests) {
            const url = req.url;
            const shouldDelete = modelId
              ? (url.includes('.onnx') && url.includes(modelId))
              : (url.includes('whisper') || url.includes('Xenova/whisper'));
            if (shouldDelete) {
              await cache.delete(req);
            }
          }
        }
      }
    }

    // 清除 IndexedDB 中 Whisper 相關的數據庫。
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name === 'transformers-cache' || db.name === 'transformers') {
        // 對於 IndexedDB，我們無法精確按條目刪除，所以僅在有具體 modelId 時
        // 嘗試刪除整個數據庫（與翻譯模型共享時這會有副作用）。
        // 無 modelId 時不刪 IndexedDB 以避免誤刪翻譯模型。
        if (modelId) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    }

    return {
      type: 'asr-whisper:cache-cleared',
      ok: true,
    } satisfies OffscreenResponse;
  } catch (err) {
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'asr',
        code: 'asr-whisper-cache-clear-failed',
        recoverable: true,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    });
    return {
      type: 'asr-whisper:cache-cleared',
      ok: false,
    } satisfies OffscreenResponse;
  }
}

/**
 * M2-37：預加載 ASR Whisper 模型到記憶體（供推理使用）。
 * 與 downloadAsrModel 不同：本函數保留 pipeline 實例供後續推理使用，
 * 而非下載後立即 dispose。
 */
async function warmupAsrPipeline(modelId: string): Promise<OffscreenResponse> {
  if (asrPipeline !== null) {
    return { type: 'asr-whisper:warmup-complete', ok: true } satisfies OffscreenResponse;
  }
  try {
    // 先檢查是否已緩存，未緩存時返回錯誤（不觸發下載）。
    if (!(await hasAsrModelInCache(modelId))) {
      return {
        type: 'asr-whisper:warmup-complete',
        ok: false,
        error:
          'ASR model not downloaded. Please download it from the Options page first. / 請先在選項頁面下載 ASR 模型',
      } satisfies OffscreenResponse;
    }

    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;

    // env 配置與 downloadAsrModel 一致。
    (env as unknown as { remoteHost: string }).remoteHost = 'https://hf-mirror.com/';
    (env as unknown as { useCustomCache: boolean }).useCustomCache = true;
    (env as unknown as { customCache: ProxyCache }).customCache = proxyCache;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/runtime/ort/');
    }

    asrPipeline = await pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
      dtype: 'q8',
    });

    console.warn('[AI_Trans] ASR Whisper pipeline loaded for inference');
    return { type: 'asr-whisper:warmup-complete', ok: true } satisfies OffscreenResponse;
  } catch (err) {
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'asr',
        code: 'asr-whisper-warmup-failed',
        recoverable: true,
        cause: error,
      },
    });
    const isNetwork = /Failed to fetch|NetworkError|network/i.test(error.message);
    return {
      type: 'asr-whisper:warmup-complete',
      ok: false,
      error: isNetwork
        ? `ASR warmup failed (network error). Check your connection and download the ASR model from Options. / ASR 預熱失敗（網絡錯誤），請檢查網絡並從選項頁面下載模型: ${error.message}`
        : `ASR warmup failed: ${error.message}`,
    } satisfies OffscreenResponse;
  }
}

/**
 * M2-37：執行 ASR 推理——使用本地 Whisper 模型識別音頻。
 * 接收 PCM 音頻數據，返回識別結果。
 */
async function runAsrInference(
  pcm: Float32Array,
  sampleRate: number,
  hintLang?: string
): Promise<OffscreenResponse> {
  const startTime = performance.now();

  // lazy 恢復：pipeline 未載入但快取存在 → 自動載入。
  if (asrPipeline === null) {
    try {
      // 嘗試使用默認模型 ID 載入。
      const defaultModelId = 'Xenova/whisper-base.en';
      if (await hasAsrModelInCache(defaultModelId)) {
        await warmupAsrPipeline(defaultModelId);
      }
    } catch (err) {
      const error = toReadableError(err);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-whisper-pipeline-load-failed',
          recoverable: true,
          cause: error,
        },
      });
      return {
        type: 'asr-whisper:transcribe-result',
        ok: false,
        error: error.message,
      } satisfies OffscreenResponse;
    }
  }

  if (asrPipeline === null) {
    return {
      type: 'asr-whisper:transcribe-result',
      ok: false,
      error: 'ASR pipeline not loaded',
    } satisfies OffscreenResponse;
  }

  try {
    const pipelineFn = asrPipeline as (
      audio: Float32Array,
      options?: { language?: string; task?: string; return_timestamps?: boolean }
    ) => Promise<{ text?: string; chunks?: Array<{ text: string; timestamp?: [number, number] }> }>;

    const result = await pipelineFn(pcm, {
      language: hintLang,
      task: 'transcribe',
      return_timestamps: true,
    });

    const durationMs = performance.now() - startTime;
    const audioDurationMs = (pcm.length / sampleRate) * 1000;
    const rtf = durationMs / audioDurationMs;

    return {
      type: 'asr-whisper:transcribe-result',
      ok: true,
      text: result.text ?? '',
      chunks: result.chunks,
      rtf,
    } satisfies OffscreenResponse;
  } catch (err) {
    const error = toReadableError(err);
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'asr',
        code: 'asr-whisper-inference-failed',
        recoverable: true,
        cause: error,
      },
    });
    return {
      type: 'asr-whisper:transcribe-result',
      ok: false,
      error: error.message,
    } satisfies OffscreenResponse;
  }
}

/**
 * 計算文本中唯一 n-gram 佔總 n-gram 的比例。
 * 比例越低表示重複越嚴重（退化輸出）。
 *
 * 正常翻譯：80-100% 唯一
 * "我希望我希望我希望..."：~0.2% 唯一
 * "捉捉捉捉捉..."：~0.1% 唯一
 */
function calcUniqueNgramRatio(text: string, n: number): number {
  if (text.length < n) return 1.0;
  const unique = new Set<string>();
  let total = 0;
  for (let i = 0; i <= text.length - n; i++) {
    unique.add(text.slice(i, i + n));
    total++;
  }
  return unique.size / total;
}

/**
 * 執行翻譯推理——使用本地 ONNX 模型翻譯文本。
 * 使用 ChatML Prompt + generated_text 解析，chunk size 由配置決定。
 */
async function runInference(
  text: string,
  targetLang: string,
  _sourceLang: string | undefined,
  retriedWithWasm = false
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
    const inferStartedAt = performance.now();

    // 所有模型統一使用 ChatML Prompt + text-generation pipeline
    console.log(`[AI_Trans:local-onnx] 開始翻譯, text length:`, text.length, 'targetLang:', targetLang);
    const sourceLines = text.split('\n');
    const prompt = buildPrompt(text, targetLang);
    console.log(`[AI_Trans:local-onnx] prompt 構建完成, prompt length:`, prompt.length);

    const pipelineFn = translationPipeline as (
      input: string,
      options?: Record<string, unknown>
    ) => Promise<Array<{ generated_text: string }>>;

    console.log(`[AI_Trans:local-onnx] 開始推理...`);
    const result = await pipelineFn(prompt, {
      max_new_tokens: 256,
      do_sample: false,
      repetition_penalty: 1.1,
      return_full_text: false,
    });
    console.log(`[AI_Trans:local-onnx] 推理完成`);

    // 解析生成結果——按行號還原譯文。
    const generatedText = result[0]?.generated_text ?? '';
    console.log('[AI_Trans:local-onnx] generated_text:', JSON.stringify(generatedText.slice(0, 500)));
    console.log('[AI_Trans:local-onnx] generated_text.length:', generatedText.length, 'tail:', JSON.stringify(generatedText.slice(-500)));

    const { translatedLines, echoed, parsedCount, similarCount, degenerate, wrongLanguage } = parseNumberedOutput(generatedText, sourceLines, targetLang);

    // 當檢測到 echo 時，輸出詳細診斷信息
    if (echoed) {
      console.log('[AI_Trans:local-onnx] ECHO DETECTED!');
      console.log('[AI_Trans:local-onnx] similarCount:', similarCount, '/', sourceLines.length);
      console.log('[AI_Trans:local-onnx] parsedCount:', parsedCount);
      console.log('[AI_Trans:local-onnx] sourceLines (first 3):', JSON.stringify(sourceLines.slice(0, 3)));
      console.log('[AI_Trans:local-onnx] translatedLines (first 3):', JSON.stringify(translatedLines.slice(0, 3)));
      console.log('[AI_Trans:local-onnx] generated_text (full):', JSON.stringify(generatedText));
      
      const elapsedMs = Math.round(performance.now() - inferStartedAt);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-echo-output',
          recoverable: true,
          cause: new Error(
            `local ONNX echoed input (parsed ${parsedCount}/${sourceLines.length} lines, similar ${similarCount}/${sourceLines.length}, took ${elapsedMs}ms); raw output: ${JSON.stringify(
              generatedText.slice(0, 200)
            )}`
          ),
        },
      });
    }

    // 當檢測到退化輸出時，記錄診斷
    if (degenerate) {
      console.log('[AI_Trans:local-onnx] DEGENERATE OUTPUT DETECTED!');
      console.log('[AI_Trans:local-onnx] generated_text (full):', JSON.stringify(generatedText));
      
      const elapsedMs = Math.round(performance.now() - inferStartedAt);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-degenerate-output',
          recoverable: true,
          cause: new Error(
            `local ONNX degenerate output detected (took ${elapsedMs}ms); raw output: ${JSON.stringify(
              generatedText.slice(0, 200)
            )}`
          ),
        },
      });
    }

    // 當檢測到語言錯誤時，記錄診斷
    if (wrongLanguage) {
      console.log('[AI_Trans:local-onnx] WRONG LANGUAGE DETECTED!');
      console.log('[AI_Trans:local-onnx] targetLang:', targetLang);
      console.log('[AI_Trans:local-onnx] generated_text (full):', JSON.stringify(generatedText));
      
      const elapsedMs = Math.round(performance.now() - inferStartedAt);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-wrong-language-output',
          recoverable: true,
          cause: new Error(
            `local ONNX output wrong language (target: ${targetLang}, no Chinese in output, took ${elapsedMs}ms); raw output: ${JSON.stringify(
              generatedText.slice(0, 200)
            )}`
          ),
        },
      });
    }

    let finalText = translatedLines.join('\n');
    // 簡繁轉換安全網：即使 prompt 已要求輸出繁體，部分模型仍可能輸出簡體，
    // 對 zh-Hant 目標統一轉換（對已是繁體的內容為冪等操作）。
    if (targetLang === 'zh-Hant') {
      finalText = s2tConverter(finalText);
    }

    return {
      type: 'local-onnx:translate-result',
      ok: true,
      translatedText: finalText,
      echoed,
      degenerate,
      wrongLanguage,
    } satisfies OffscreenResponse;
  } catch (err) {
    // §5.6：推理失敗必須落診斷。
    const error = toReadableError(err);
    const errorMsg = error.message.toLowerCase();
    
    // M2-35：檢測 WebGPU 推論失敗（createBuffer failed / device lost / GPU 錯誤）
    const isWebGpuError = errorMsg.includes('createbuffer') || 
                          errorMsg.includes('webgpu') || 
                          errorMsg.includes('device lost') ||
                          errorMsg.includes('gpu');
    
    // 檢測 WASM 記憶體錯誤（memory access out of bounds / wasm trap / unaligned 等）
    // 這類錯誤通常需要重新載入模型來恢復
    const isWasmMemoryError = errorMsg.includes('memory access out of bounds') ||
                              errorMsg.includes('wasm trap') ||
                              errorMsg.includes('out of memory') ||
                              errorMsg.includes('unreachable') ||
                              errorMsg.includes('unaligned');
    
    if (isWebGpuError && !retriedWithWasm) {
      webgpuFailed = true;
      console.warn('[AI_Trans] WebGPU 推論失敗，回退 WASM:', error.message);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-webgpu-inference-fallback',
          recoverable: true,
          cause: error,
        },
      });
      // 釋放失敗的 WebGPU pipeline，避免記憶體洩漏
      await disposePipeline(translationPipeline);
      translationPipeline = null;
      // 重新載入（preferWebGpu() 現在返回 false → 自動使用 WASM）
      try {
        await ensurePipelineLoaded();
      } catch (loadErr) {
        // WASM 載入也失敗，返回錯誤
        const loadError = toReadableError(loadErr);
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: 'local-onnx-wasm-fallback-failed',
            recoverable: false,
            cause: loadError,
          },
        });
        return {
          type: 'local-onnx:translate-result',
          ok: false,
          error: `WebGPU inference failed and WASM fallback failed: ${loadError.message}`,
        } satisfies OffscreenResponse;
      }
      // 重試推論一次（遞歸調用，帶重試標誌避免無限循環）
      return runInference(text, targetLang, _sourceLang, true);
    }
    
    // WASM 記憶體錯誤：嘗試重新載入模型並重試一次
    if (isWasmMemoryError && !retriedWithWasm) {
      console.warn('[AI_Trans] WASM 記憶體錯誤，嘗試重新載入模型:', error.message);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'translation',
          code: 'local-onnx-wasm-memory-error',
          recoverable: true,
          cause: error,
        },
      });
      // 釋放當前 pipeline
      await disposePipeline(translationPipeline);
      translationPipeline = null;
      loadPromise = null;
      loadPromiseHasProgress = false;
      
      // 重新載入模型
      try {
        await ensurePipelineLoaded();
      } catch (loadErr) {
        const loadError = toReadableError(loadErr);
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'translation',
            code: 'local-onnx-model-reload-failed',
            recoverable: false,
            cause: loadError,
          },
        });
        return {
          type: 'local-onnx:translate-result',
          ok: false,
          error: `Model reload failed after WASM memory error: ${loadError.message}`,
        } satisfies OffscreenResponse;
      }
      // 重試推論一次
      return runInference(text, targetLang, _sourceLang, true);
    }
    
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
 * 解析帶行號的模型輸出，並檢測 echo（回顯原文）、退化輸出（token 重複亂碼）和語言錯誤。
 * 
 * 檢測邏輯：
 * 1. Echo 檢測：已解析行與原文相似度 > 40% 視為 echo
 * 2. 退化檢測：3-gram 唯一率 < 0.2 視為退化（token 重複亂碼）
 * 3. 短輸出檢測：輸出長度 / 輸入長度 < 0.2 視為退化
 * 4. 語言錯誤檢測：目標語言為中文但輸出無中文字符視為語言錯誤
 */
function parseNumberedOutput(
  generated: string,
  sourceLines: string[],
  targetLang: string
): { translatedLines: string[]; echoed: boolean; parsedCount: number; similarCount: number; degenerate: boolean; wrongLanguage: boolean } {
  console.log('[AI_Trans:local-onnx] parseNumberedOutput: starting, generated length:', generated.length);
  console.log('[AI_Trans:local-onnx] parseNumberedOutput: sourceLines count:', sourceLines.length);
  console.log('[AI_Trans:local-onnx] parseNumberedOutput: targetLang:', targetLang);
  
  const parsed = new Map<number, string>();
  for (const line of generated.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]?\s+(.+)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      const val = m[2].trim();
      if (idx >= 0 && val.length > 0) parsed.set(idx, val);
    }
  }
  console.log('[AI_Trans:local-onnx] parseNumberedOutput: parsed numbered lines count:', parsed.size);
  
  // 退化檢測 1：短輸出（輸出長度 / 輸入長度 < 0.2）
  const sourceText = sourceLines.join('\n');
  const lengthRatio = generated.length / Math.max(sourceText.length, 1);
  const shortOutputDegenerate = lengthRatio < 0.2 && generated.length < 100;
  if (shortOutputDegenerate) {
    console.log('[AI_Trans:local-onnx] parseNumberedOutput: short output detected, lengthRatio:', lengthRatio.toFixed(3));
  }
  
  // 退化檢測 2：3-gram 唯一率（檢測 token 重複亂碼）
  const ngramRatio = calcUniqueNgramRatio(generated, 3);
  const ngramDegenerate = ngramRatio < 0.2 && generated.length > 50;
  if (ngramDegenerate) {
    console.log('[AI_Trans:local-onnx] parseNumberedOutput: degenerate output detected, ngramRatio:', ngramRatio.toFixed(3));
  }
  
  // 語言錯誤檢測：目標語言為中文但輸出無中文字符
  const isTargetChinese = targetLang === 'zh-Hant' || targetLang === 'zh-Hans';
  const hasChinese = /[\u4e00-\u9fff]/.test(generated);
  const wrongLanguage = isTargetChinese && !hasChinese && parsed.size > 0;
  if (wrongLanguage) {
    console.log('[AI_Trans:local-onnx] parseNumberedOutput: WRONG LANGUAGE detected - target is Chinese but output has no Chinese characters');
  }
  
  // F6: 回退解析器——如果沒有編號行但輸出包含中文，直接使用原始輸出
  if (parsed.size === 0) {
    console.log('[AI_Trans:local-onnx] parseNumberedOutput: no numbered lines, hasChinese:', hasChinese);
    if (hasChinese) {
      // 使用原始輸出作為翻譯（按行分割）
      const rawLines = generated.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      // 映射到源行（如果行數不足則回退到原文）
      const translatedLines = sourceLines.map((src, i) => rawLines[i] || src);
      console.log('[AI_Trans:local-onnx] Fallback: using raw Chinese output as translation, rawLines count:', rawLines.length);
      return { translatedLines, echoed: false, parsedCount: 0, similarCount: 0, degenerate: shortOutputDegenerate || ngramDegenerate, wrongLanguage: false };
    } else {
      console.log('[AI_Trans:local-onnx] parseNumberedOutput: no Chinese detected, will fallback to source');
    }
  }
  
  const translatedLines = sourceLines.map((src, i) => parsed.get(i)?.trim() || src);
  console.log('[AI_Trans:local-onnx] parseNumberedOutput: final translatedLines count:', translatedLines.length);
  
  // F4 + F7: 改進 echo 偵測邏輯
  // 檢查模型是否回顯原文（parsed 的行與 sourceLines 相同）
  let similarCount = 0;
  if (parsed.size > 0) {
    // 當有編號行時，檢查這些行是否與原文相同
    for (let i = 0; i < sourceLines.length; i++) {
      const translated = parsed.get(i)?.trim();
      const source = sourceLines[i];
      if (!translated) continue; // 沒有解析到，跳過
      
      // 檢查是否相同或相似
      if (translated === source) {
        similarCount++;
      } else {
        // 檢查是否相似：長度差異 < 30% 且包含相同單詞 > 50%
        const lengthDiff = Math.abs(translated.length - source.length);
        const lengthThreshold = source.length * 0.3;
        if (lengthDiff < lengthThreshold) {
          const translatedWords = translated.toLowerCase().split(/\s+/);
          const sourceWords = source.toLowerCase().split(/\s+/);
          const overlappingWords = translatedWords.filter(w => sourceWords.includes(w)).length;
          if (overlappingWords > sourceWords.length * 0.5) {
            similarCount++;
          }
        }
      }
    }
  }
  
  // 如果超過 40% 的已解析行都相似，認為是 echo（降低閾值從 80% 到 40%）
  const echoed = parsed.size > 0 && similarCount > parsed.size * 0.4;
  const degenerate = shortOutputDegenerate || ngramDegenerate;
  
  return { translatedLines, echoed, parsedCount: parsed.size, similarCount, degenerate, wrongLanguage };
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
  loadPromiseHasProgress = false;
  cacheGeneration = 0;
  // 重置空閒生命週期狀態（避免測試間互相污染）。
  busyCount = 0;
  idleCloseRequested = false;
  // 重置 WebGPU 失敗記憶（M2-26；避免測試間互相污染）。
  webgpuFailed = false;
  // M1-59：重置 ASR 下載進行中旗標（避免測試間互相污染）。
  asrDownloadInProgress = false;
  // M2-37：重置 ASR pipeline（避免測試間互相污染）。
  asrPipeline = null;
  // 重置模型名稱為預設值
  currentModelName = LOCAL_ONNX_MODEL;
}

/** 供測試直接調用內部狀態檢查/推理邏輯。 */
export const _testExports = {
  hasModelInCache,
  checkModelStatus,
  runInference,
  clearModelCache,
  downloadModel,
  ensurePipelineLoaded,
  buildPrompt,
  parseNumberedOutput,
  warmupModel,
  shutdownForIdle,
  // M1-59：ASR 狀態檢查/下載（供測試驗證 downloading 旗標與狀態字段）。
  checkAsrModelStatus,
  downloadAsrModel,
  hasAsrModelInCache,
  // M2-37：ASR 推理（供測試驗證 warmup/transcribe 消息處理）。
  warmupAsrPipeline,
  runAsrInference,
  // M2-26：WebGPU 設備決策（供測試驗證 webgpu/wasm 選擇與回退）。
  preferWebGpu,
  // M2-26：webgpuFailed 記憶旗標（getter；供測試斷言回退後不再嘗試 webgpu）。
  get webgpuFailed(): boolean {
    return webgpuFailed;
  },
  // 進度聚合器（供測試驗證多檔案下載進度計算）。
  DownloadProgressAggregator,
  // 退化輸出檢測（供測試驗證 n-gram 唯一率計算）。
  calcUniqueNgramRatio,
  // 清理舊模型快取（供測試驗證）。
  clearCacheForModel,
};
