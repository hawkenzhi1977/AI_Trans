// Offscreen Document 入口：MV3 中負責音頻捕獲與處理。
// Service Worker 無法處理長時間音頻流（會被回收），故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script 透過 chrome.runtime.connect 建立 port 長連接（避免 SW 掛起）。
import { recordDiagnostic } from '../infrastructure/diagnostics';

/** Offscreen Document 接收的消息類型。 */
type OffscreenRequest =
  | { type: 'startCapture'; streamId: string }
  | { type: 'stopCapture' };

/** Offscreen Document 發送的響應類型。 */
type OffscreenResponse =
  | { type: 'captureStarted' }
  | { type: 'captureStopped' }
  | { type: 'audioChunk'; pcm: Float32Array; sampleRate: number; timestamp: number }
  | { type: 'error'; message: string };

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let currentPort: chrome.runtime.Port | null = null;

/** 啟動 tabCapture 音頻捕獲。 */
async function startCapture(streamId: string, port: chrome.runtime.Port): Promise<void> {
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

/** 處理來自 content-script 的 port 消息。 */
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
