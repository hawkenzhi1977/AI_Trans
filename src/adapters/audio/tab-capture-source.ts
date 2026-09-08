// TabCapture 音頻源適配器：通過 Offscreen Document 捕獲標籤頁音頻。
// MV3 Service Worker 無法處理長時間音頻流，故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script ↔ Offscreen Document 透過 port 長連接（避免 SW 掛起）。
//
// M2-46 根因修復：streamId 是 Chrome tabCapture 一次性 TTL token，持久化後重複消費必然失效。
// 新機制：popup 調用 getMediaStreamId 後立即透過 tabs.sendMessage 送入 content-script 記憶體，
// content-script 保存 streamId 並在 start() 時一次性交付給 offscreen；後續複用已有 MediaStream
// 不再需要 streamId，完全繞開 TTL 問題。
import type { AudioSourceProvider } from '../../domain/ports/audio-source';
import type { AudioSourceHandle } from '../../domain/models/audio';
import type { AudioChunk } from '../../domain/models/audio';
import type { PlatformAdapter } from '../../domain/ports/platform-adapter';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

/** Offscreen Document 接收的消息類型。 */
type OffscreenRequest =
  | { type: 'startCapture'; streamId: string | null }
  | { type: 'stopCapture' };

/** Offscreen Document 發送的響應類型。 */
type OffscreenResponse =
  | { type: 'captureStarted' }
  | { type: 'captureStopped' }
  | { type: 'audioChunk'; pcm: Float32Array; sampleRate: number; timestamp: number }
  | { type: 'error'; message: string };

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

/**
 * 通過 Service Worker 確保 Offscreen Document 存在。
 * chrome.offscreen API 僅在 Service Worker 中可用，content-script 必須透過消息路由。
 */
async function ensureOffscreenViaServiceWorker(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ topic: 'offscreen:ensure-created' });
  const res = response as { ok: boolean; error?: string };
  if (!res.ok) {
    throw new Error(res.error ?? 'offscreen:ensure-created failed');
  }
}

/**
 * in-memory streamId 提供者介面。
 * content-script 實現此介面，在 popup 送入 streamId 後提供一次性消費。
 * 已有 MediaStream 可複用時返回 null（offscreen 複用已有流，無需 streamId）。
 */
export interface TabStreamIdProvider {
  /**
   * 消費一次 streamId。
   * - 有待消費的 id：返回該 id 並清除（一次性，防 TTL 重複消費）。
   * - 無待消費的 id 但 offscreen 已有 MediaStream（複用路徑）：返回 null。
   * - 無待消費的 id 且 offscreen 無 MediaStream：返回 undefined（未授權）。
   */
  consumeStreamId(): string | null | undefined;
  /** offscreen 是否已持有可複用的 MediaStream（由 offscreen captureStarted 確認後設置）。 */
  hasActiveStream(): boolean;
  /** offscreen 確認已建立 MediaStream 後通知 provider（設置複用標誌）。 */
  onStreamEstablished(): void;
  /** offscreen 空閒完整釋放後通知 provider（清除複用標誌）。 */
  onStreamReleased(): void;
}

export class TabCaptureAudioSource implements AudioSourceProvider {
  readonly kind = 'tab-capture' as const;
  private port: chrome.runtime.Port | null = null;
  private chunkCallback: ((chunk: AudioChunk) => void) | null = null;
  private offscreenCreated = false;
  private streamIdProvider: TabStreamIdProvider | null = null;

  /** 注入 in-memory streamId 提供者（由 composition.ts 在組裝時傳入）。 */
  setStreamIdProvider(provider: TabStreamIdProvider): void {
    this.streamIdProvider = provider;
  }

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

  /** 創建 Offscreen Document 並建立 port 連接，交付 streamId（或複用已有流）。 */
  private async start(): Promise<void> {
    // 通過 Service Worker 創建 Offscreen Document（chrome.offscreen 僅在 SW 可用）。
    if (!this.offscreenCreated) {
      try {
        await withTimeout(
          ensureOffscreenViaServiceWorker(),
          CHROME_API_TIMEOUT_MS,
          'offscreen:ensure-created'
        );
        this.offscreenCreated = true;
      } catch (err) {
        // §5.6：創建失敗必須落診斷。
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

    // M2-46：從 in-memory provider 消費 streamId（一次性 TTL token）。
    // - consumeStreamId() 返回 string：首次或重新授權，用於 getUserMedia。
    // - consumeStreamId() 返回 null：offscreen 已有 MediaStream，複用路徑。
    // - consumeStreamId() 返回 undefined：未授權，拋錯。
    let streamId: string | null;
    if (this.streamIdProvider) {
      const consumed = this.streamIdProvider.consumeStreamId();
      if (consumed === undefined) {
        // 未授權且無複用流——落診斷後拋錯。
        // M2-54 修復：不在此處寫 chrome.storage.local.set({ tabCaptureAuthorized: false })。
        // 原因：此寫入會觸發 content-script 的 onAsrAuthChanged（newValue=false），
        // 引發第二次 restart()，把 asr:stream-id handler 剛設好的記憶體授權值 true
        // 覆蓋回 false → Orchestrator 以 enableAsr:false 建立 → inject() 不被調用。
        // 授權狀態的重置由 content-script 統一管理（onEvent 處理 tab-capture-not-authorized
        // 診斷碼時負責更新記憶體值），不在 adapter 層直接寫 storage。
        const err = new Error('tabCapture not authorized: no streamId and no active stream');
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'audio',
            code: 'tab-capture-not-authorized',
            recoverable: true,
            cause: err,
          },
        });
        throw err;
      }
      streamId = consumed; // string（新 id）或 null（複用）
    } else {
      // 無 provider（舊路徑兼容）：從 storage 讀取（degraded mode）。
      const authState = await withTimeout(
        chrome.storage.local.get(['tabCaptureAuthorized', 'tabCaptureStreamId']),
        CHROME_API_TIMEOUT_MS,
        'chrome.storage.local.get'
      );
      if (!authState.tabCaptureAuthorized || !authState.tabCaptureStreamId) {
        throw new Error('tabCapture not authorized or streamId missing');
      }
      streamId = authState.tabCaptureStreamId as string;
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

    // 發送 startCapture（streamId 為 null 時 offscreen 複用已有流）。
    this.port.postMessage({
      type: 'startCapture',
      streamId,
    } satisfies OffscreenRequest);
  }

  /** 軟停止：detach 生產鏈，保留 MediaStream 供複用（不發 offscreen:idle-close）。 */
  private async stop(): Promise<void> {
    // §5.4：斷開 port，讓 offscreen 做軟停止（detachAudioProcessing）。
    if (this.port) {
      this.port.postMessage({ type: 'stopCapture' } satisfies OffscreenRequest);
      this.port.disconnect();
      this.port = null;
    }
    // 不再發 offscreen:idle-close——空閒計時由 offscreen 自管（10 分鐘空閒後自行完整釋放）。
    // 這樣下次 start() 可複用已有 MediaStream，繞開 streamId TTL。
    seqCounter = 0; // 重置序號計數器。
  }

  /** 處理來自 Offscreen Document 的消息。 */
  private handleMessage(msg: OffscreenResponse): void {
    switch (msg.type) {
      case 'captureStarted': {
        // offscreen 確認 MediaStream 已建立（首次或複用均通知）。
        this.streamIdProvider?.onStreamEstablished();
        break;
      }
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
      case 'captureStopped':
        // 狀態通知，無需處理。
        break;
    }
  }
}
