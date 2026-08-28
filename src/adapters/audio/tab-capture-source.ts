// TabCapture 音頻源適配器：通過 Offscreen Document 捕獲標籤頁音頻。
// MV3 Service Worker 無法處理長時間音頻流，故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script ↔ Offscreen Document 透過 port 長連接（避免 SW 掛起）。
import type { AudioSourceProvider } from '../../domain/ports/audio-source';
import type { AudioSourceHandle } from '../../domain/models/audio';
import type { AudioChunk } from '../../domain/models/audio';
import type { PlatformAdapter } from '../../domain/ports/platform-adapter';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

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

/** Offscreen Document URL（相對路徑，Chrome 會解析為擴充內部 URL）。 */
const OFFSCREEN_URL = 'src/runtime/offscreen.html';

/** M2-44：超時時間（毫秒）：Chrome API 調用超時保護。 */
const CHROME_API_TIMEOUT_MS = 5_000;

/** 音頻塊序號計數器（單調遞增）。 */
let seqCounter = 0;

/** M2-44：Promise 超時包裝器。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${message} (timeout after ${timeoutMs}ms)`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class TabCaptureAudioSource implements AudioSourceProvider {
  readonly kind = 'tab-capture' as const;
  private port: chrome.runtime.Port | null = null;
  private chunkCallback: ((chunk: AudioChunk) => void) | null = null;
  private offscreenCreated = false;

  async open(_platform: PlatformAdapter): Promise<AudioSourceHandle> {
    return {
      kind: 'tab-capture',
      start: () => this.start(),
      stop: () => this.stop(),
    };
  }

  onChunk(cb: (chunk: AudioChunk) => void): void {
    this.chunkCallback = cb;
  }

  /** 創建 Offscreen Document 並建立 port 連接。 */
  private async start(): Promise<void> {
    // 創建 Offscreen Document（MV3 同時只允許一個，重複創建會拋錯）。
    if (!this.offscreenCreated) {
      try {
        // M2-44：增加超時機制，防止 Chrome API 掛起導致策略鏈卡住。
        await withTimeout(
          chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: 'ASR audio processing: tabCapture + PCM extraction',
          }),
          CHROME_API_TIMEOUT_MS,
          'chrome.offscreen.createDocument'
        );
        this.offscreenCreated = true;
      } catch (err) {
        // 已存在時忽略（MV3 限制），但仍嘗試建立 port。
        if (!(err instanceof Error && err.message.includes('only one'))) {
          // §5.6：超時或其他錯誤必須落診斷。
          recordDiagnostic({
            type: 'pipeline-error',
            error: {
              port: 'audio',
              code: 'offscreen-create-failed',
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err)),
            },
          });
          throw err;
        }
      }
    }

    // 建立 port 長連接（避免 SW 掛起）。
    this.port = chrome.runtime.connect({ name: 'offscreen-asr' });
    this.port.onMessage.addListener((msg: OffscreenResponse) => {
      this.handleMessage(msg);
    });
    this.port.onDisconnect.addListener(() => {
      // §5.6：port 意外斷開必須落診斷。
      if (this.port) {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          recordDiagnostic({
            type: 'pipeline-error',
            error: {
              port: 'audio',
              code: 'offscreen-communication-failed',
              recoverable: true,
              cause: new Error(lastError.message),
            },
          });
        }
      }
      this.port = null;
    });

    // 從存儲讀取 streamId（Popup「啟用 ASR」按鈕授權時獲取）。
    // M2-44：增加超時機制。
    const authState = await withTimeout(
      chrome.storage.local.get(['tabCaptureAuthorized', 'tabCaptureStreamId']),
      CHROME_API_TIMEOUT_MS,
      'chrome.storage.local.get'
    );
    if (!authState.tabCaptureAuthorized || !authState.tabCaptureStreamId) {
      throw new Error('tabCapture not authorized or streamId missing');
    }
    this.port.postMessage({
      type: 'startCapture',
      streamId: authState.tabCaptureStreamId,
    } satisfies OffscreenRequest);
  }

  /** 停止音頻捕獲並清理資源。 */
  private async stop(): Promise<void> {
    // §5.4：所有資源必須在 stop 時清理（port、Offscreen Document）。
    if (this.port) {
      this.port.postMessage({ type: 'stopCapture' } satisfies OffscreenRequest);
      this.port.disconnect();
      this.port = null;
    }
    if (this.offscreenCreated) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // 已關閉時忽略。
      }
      this.offscreenCreated = false;
    }
    seqCounter = 0; // 重置序號計數器。
  }

  /** 處理來自 Offscreen Document 的消息。 */
  private handleMessage(msg: OffscreenResponse): void {
    switch (msg.type) {
      case 'audioChunk': {
        if (!this.chunkCallback) return;
        // 構造 AudioChunk（VAD 標記由下游 EnergyVAD 處理）。
        const chunk: AudioChunk = {
          seq: seqCounter++,
          startTime: 0, // Offscreen 無法獲取視頻時間軸，由下游對齊。
          duration: (msg.pcm.length / msg.sampleRate) * 1000, // ms
          sampleRate: msg.sampleRate,
          channels: 1,
          pcm: msg.pcm,
          isSpeech: true, // 默認 true，VAD 會重新標記。
        };
        this.chunkCallback(chunk);
        break;
      }
      case 'error': {
        // §5.6：Offscreen 錯誤必須落診斷。
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'audio',
            code: 'tab-capture-failed',
            recoverable: true,
            cause: new Error(msg.message),
          },
        });
        break;
      }
      case 'captureStarted':
      case 'captureStopped':
        // 狀態通知，無需處理。
        break;
    }
  }
}
