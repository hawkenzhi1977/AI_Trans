// TabCapture 音頻源適配器：通過 Offscreen Document 捕獲標籤頁音頻。
// MV3 Service Worker 無法處理長時間音頻流，故將 tabCapture + 音頻解碼移至 Offscreen Document。
// 通信協議：content-script ↔ Offscreen Document 透過 port 長連接（避免 SW 掛起）。
//
// M2-46 根因修復：streamId 是 Chrome tabCapture 一次性 TTL token，持久化後重複消費必然失效。
// 新機制：popup 調用 getMediaStreamId 後立即透過 tabs.sendMessage 送入 content-script 記憶體，
// content-script 保存 streamId 並在 start() 時一次性交付給 offscreen；後續複用已有 MediaStream
// 不再需要 streamId，完全繞開 TTL 問題。
//
// M2-55 根因修復：tabCaptureAuthorized 持久化但串流能力（streamId / 活 MediaStream）是 ephemeral。
// tab 重載/SPA 換視頻後 content-script 記憶體 streamId 重置，舊 start() 在 consumeStreamId()===undefined
// 時「連接 offscreen 之前」就拋錯，從不探測 offscreen 是否仍持有可複用串流 → ASR 永久卡死、字幕不出現。
// 新機制：offscreen 為串流狀態唯一真相源。start() 改為「樂觀探測」——無 fresh streamId 時先送
// startCapture(null) 讓 offscreen 決定（仍有活 MediaStream 則複用，否則回報 need-stream-id）；
// 收到 need-stream-id 再透過 StreamIdAcquirer 向 SW 自動重取 fresh streamId（SW 用 sender.tab.id
// 作 targetTabId，per-tab grant 重載後通常仍有效）；重取不可用/失敗才落可行動診斷要求用戶重新授權。
import type { AudioSourceProvider } from '../../domain/ports/audio-source';
import type { AudioSourceHandle } from '../../domain/models/audio';
import type { AudioChunk } from '../../domain/models/audio';
import type { PlatformAdapter } from '../../domain/ports/platform-adapter';
import { recordDiagnostic } from '../../infrastructure/diagnostics';
import { diagLog } from '../../infrastructure/debug-log';
import { decodePcmFloat32 } from '../../infrastructure/pcm-encoding';

/** Offscreen Document 接收的消息類型。 */
type OffscreenRequest =
  | { type: 'startCapture'; streamId: string | null }
  | { type: 'stopCapture' };

/** Offscreen Document 發送的響應類型。 */
type OffscreenResponse =
  | { type: 'captureStarted' }
  | { type: 'captureStopped' }
  | { type: 'audioChunk'; pcm: string; sampleRate: number; timestamp: number }
  // M2-55：error 帶結構化 code，讓 adapter 精確區分「需重取 streamId」與一般捕獲失敗。
  // - need-stream-id：offscreen 無 MediaStream 且未收到 streamId（複用探測失敗，觸發自動重取）。
  // - capture-failed：getUserMedia / 音頻處理拋錯。
  // - stream-ended：捕獲軌意外結束（tab 重載/串流失效），死串流已丟棄。
  | { type: 'error'; message: string; code?: 'need-stream-id' | 'capture-failed' | 'stream-ended' };

/** M2-44：超時時間（毫秒）：Chrome API 調用超時保護。 */
const CHROME_API_TIMEOUT_MS = 5_000;

/**
 * M2-55：offscreen 捕獲握手超時（毫秒）。
 * start() 送 startCapture 後等待 captureStarted/error 響應；超時當錯誤處理，
 * 避免 offscreen 無響應時 start() 永久懸掛（§5.5）。getUserMedia(tab) 不需用戶確認，
 * 正常 <1s 完成，10s 為寬裕上限。
 */
const CAPTURE_HANDSHAKE_TIMEOUT_MS = 10_000;

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

/**
 * M2-55：fresh streamId 自動重取介面。
 * content-script 實現此介面，向 SW 請求新 streamId（SW 用 sender.tab.id 作 targetTabId
 * 調用 getMediaStreamId）。用於 tab 重載/SPA 換視頻後 content-script 記憶體 streamId 已重置、
 * 但持久化授權（tabCaptureAuthorized）仍在的場景——無需用戶重新點擊 popup 即可自動恢復捕獲。
 */
export interface StreamIdAcquirer {
  /** 請求 fresh streamId；成功返回 string，失敗（無用戶手勢/權限不足）返回 null。 */
  acquire(): Promise<string | null>;
}

/** start() 與 offscreen 握手的結果（內部決策用）。 */
type HandshakeResult =
  | { kind: 'started' }
  | { kind: 'need-auth' }
  | { kind: 'error'; message: string };

export class TabCaptureAudioSource implements AudioSourceProvider {
  readonly kind = 'tab-capture' as const;
  private port: chrome.runtime.Port | null = null;
  private chunkCallback: ((chunk: AudioChunk) => void) | null = null;
  private offscreenCreated = false;
  private streamIdProvider: TabStreamIdProvider | null = null;
  // M2-55：fresh streamId 自動重取器（content-script 注入，向 SW 請求）。
  private streamIdAcquirer: StreamIdAcquirer | null = null;
  // M2-55：待決的捕獲握手 resolver（start() 等待 captureStarted/error；handleMessage 解決它）。
  private pendingStart: ((r: HandshakeResult) => void) | null = null;
  // M2-58：audioChunk 接收統計（§5.6 breadcrumb）——首塊 + 5s 窗口計數，
  // 區分「offscreen 未送出」與「已送達但下游丟棄」（chunkCallback 缺失時統計仍可見）。
  private receivedChunkCount = 0;
  private chunkWindowStart = 0;

  /** 注入 in-memory streamId 提供者（由 composition.ts 在組裝時傳入）。 */
  setStreamIdProvider(provider: TabStreamIdProvider): void {
    this.streamIdProvider = provider;
  }

  /** M2-55：注入 fresh streamId 自動重取器（由 composition.ts 在組裝時傳入）。 */
  setStreamIdAcquirer(acquirer: StreamIdAcquirer): void {
    this.streamIdAcquirer = acquirer;
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

  /**
   * 創建 Offscreen Document、建立 port 連接並交付 streamId（或複用/自動重取）。
   * M2-55：改為 await offscreen 握手響應，讓策略鏈能感知捕獲是否真正建立。
   */
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
  void recordDiagnostic({
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

    // 建立 port 長連接（避免 SW 掛起）。
    this.connectPort();

    // M2-55：解析初始 streamId。
    // provider 路徑 consumeStreamId() 三態：string（fresh id）/ null（本地複用旗標）/
    // undefined（無 fresh id 且無本地旗標）。undefined 不再直接拋錯——改為「樂觀探測」：
    // 送 startCapture(null) 讓 offscreen（串流真相源）決定複用或回報 need-stream-id。
    const initialId = await this.resolveInitialStreamId();

    // 發送 startCapture 並等待 offscreen 握手響應（captureStarted / error）。
    let result = await this.sendStartCaptureAndWait(initialId);

    // M2-55（#2）：offscreen 無活串流（need-auth）→ 透過 StreamIdAcquirer 自動重取 fresh streamId。
    // 場景：tab 重載/SPA 換視頻後 content-script 記憶體 streamId 已重置，但持久化授權仍在。
    if (result.kind === 'need-auth' && this.streamIdAcquirer) {
      let freshId: string | null = null;
      try {
        freshId = await withTimeout(
          this.streamIdAcquirer.acquire(),
          CHROME_API_TIMEOUT_MS,
          'streamId acquire'
        );
      } catch (err) {
        // §5.6：重取失敗必須落診斷（下面 need-auth 分支會統一落 reauth 診斷，此處記錄原因）。
  void recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'audio',
            code: 'tab-capture-reauth-needed',
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        });
      }
      if (freshId) {
        result = await this.sendStartCaptureAndWait(freshId);
      }
    }

    if (result.kind === 'started') {
      // captureStarted 已由 handleMessage 通知 provider.onStreamEstablished()。
      return;
    }

    // 建立失敗：落可行動診斷後拋錯（讓策略鏈降級，§5.6 不靜默）。
    if (result.kind === 'need-auth') {
      // 無 acquirer 或重取失敗——需要用戶重新授權（popup「啟用 ASR」）。
      const err = new Error(
        'tabCapture re-authorization needed: no active stream and streamId acquisition unavailable or failed'
      );
  void recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'audio',
          code: 'tab-capture-reauth-needed',
          recoverable: true,
          cause: err,
        },
      });
      throw err;
    }

    // 一般捕獲失敗（getUserMedia 拋錯 / 握手超時 / port 斷開）。
    const err = new Error(result.message);
  void recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'audio',
        code: 'tab-capture-failed',
        recoverable: true,
        cause: err,
      },
    });
    throw err;
  }

  /**
   * M2-55：解析初始 streamId。
   * - provider 路徑：consumeStreamId() 返回 string/null 直接用；undefined → null（樂觀探測）。
   * - 無 provider（舊路徑兼容）：從 storage 讀取；無則 null（探測 offscreen 是否仍有活串流）。
   */
  private async resolveInitialStreamId(): Promise<string | null> {
    if (this.streamIdProvider) {
      const consumed = this.streamIdProvider.consumeStreamId();
      return consumed === undefined ? null : consumed;
    }
    // 無 provider（舊路徑兼容）：從 storage 讀取（degraded mode）。
    const authState = await withTimeout(
      chrome.storage.local.get(['tabCaptureAuthorized', 'tabCaptureStreamId']),
      CHROME_API_TIMEOUT_MS,
      'chrome.storage.local.get'
    );
    if (authState.tabCaptureAuthorized && authState.tabCaptureStreamId) {
      return authState.tabCaptureStreamId as string;
    }
    return null;
  }

  /** 建立 port 長連接並註冊監聽（§5.4：onDisconnect 解除監聽 + 落診斷 + 解決待決握手避免懸掛）。 */
  private connectPort(): void {
    this.port = chrome.runtime.connect({ name: 'offscreen-asr' });
    // §5.4：保存回調引用，斷開時成對解除（防監聽器隨 start/stop 循環累積洩漏）。
    const onMessage = (msg: OffscreenResponse) => {
      this.handleMessage(msg);
    };
    const onDisconnect = () => {
      if (this.port) {
        this.port.onMessage.removeListener(onMessage);
        this.port.onDisconnect.removeListener(onDisconnect);
      }
    // §5.6：port 意外斷開必須落診斷（void + catch——recordDiagnostic 返回 Promise，
    // listener 是同步函數，不接住會成 unhandled rejection）。
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      void recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'audio',
          code: 'offscreen-communication-failed',
          recoverable: true,
          cause: new Error(lastError.message),
        },
      }).catch(() => {});
    }
      this.port = null;
      // M2-55：port 斷開時若有待決握手，以錯誤解決（避免 start() 永久懸掛，§5.5）。
      if (this.pendingStart) {
        this.pendingStart({
          kind: 'error',
          message: 'offscreen port disconnected before capture handshake completed',
        });
      }
    };
    this.port.onMessage.addListener(onMessage);
    this.port.onDisconnect.addListener(onDisconnect);
  }

  /**
   * M2-55：發送 startCapture 並等待 offscreen 握手響應。
   * 解析為 HandshakeResult（started / need-auth / error），帶超時保護避免永久懸掛。
   */
  private sendStartCaptureAndWait(streamId: string | null): Promise<HandshakeResult> {
    return new Promise<HandshakeResult>((resolve) => {
      if (!this.port) {
        resolve({ kind: 'error', message: 'offscreen port not connected' });
        return;
      }
      // 超時保護：offscreen 未在窗口內響應 → 當錯誤處理（§5.5 不留懸掛 Promise）。
      const timer = setTimeout(() => {
        if (this.pendingStart) {
          this.pendingStart = null;
          resolve({
            kind: 'error',
            message: `offscreen capture handshake timeout after ${CAPTURE_HANDSHAKE_TIMEOUT_MS}ms`,
          });
        }
      }, CAPTURE_HANDSHAKE_TIMEOUT_MS);
      // 包裝 resolve：清除超時計時器並清空 pendingStart（§5.4，防重複解決）。
      this.pendingStart = (r: HandshakeResult) => {
        clearTimeout(timer);
        this.pendingStart = null;
        resolve(r);
      };
      this.port.postMessage({ type: 'startCapture', streamId } satisfies OffscreenRequest);
    });
  }

  /** 軟停止：detach 生產鏈，保留 MediaStream 供複用（不發 offscreen:idle-close）。 */
  private async stop(): Promise<void> {
    // §5.4：斷開 port，讓 offscreen 做軟停止（detachAudioProcessing）。
    if (this.port) {
      this.port.postMessage({ type: 'stopCapture' } satisfies OffscreenRequest);
      this.port.disconnect();
      this.port = null;
    }
    // M2-55：清除待決握手（避免 stop 與 start 競態時 start() 懸掛，§5.5）。
    if (this.pendingStart) {
      this.pendingStart({ kind: 'error', message: 'capture stopped before handshake completed' });
    }
    // 不再發 offscreen:idle-close——空閒計時由 offscreen 自管（10 分鐘空閒後自行完整釋放）。
    // 這樣下次 start() 可複用已有 MediaStream，繞開 streamId TTL。
    seqCounter = 0; // 重置序號計數器。
    this.receivedChunkCount = 0; // M2-58：重置接收統計，避免跨會話累積誤讀。
    this.chunkWindowStart = 0;
  }

  /** 處理來自 Offscreen Document 的消息。 */
  private handleMessage(msg: OffscreenResponse): void {
    switch (msg.type) {
      case 'captureStarted': {
        // offscreen 確認 MediaStream 已建立（首次/複用/重取均通知）。
        this.streamIdProvider?.onStreamEstablished();
        // M2-55：解決待決握手（start() 據此返回成功）。
        if (this.pendingStart) {
          this.pendingStart({ kind: 'started' });
        }
        break;
      }
      case 'audioChunk': {
        // M2-59：base64 → Float32Array（修復 extension messaging 對 typed array 序列化損毀）。
        const pcm = decodePcmFloat32(msg.pcm);
        // M2-58：接收 breadcrumb（§5.6）——先計數再判 callback，
        // chunkCallback 缺失（靜默丟棄）時統計仍可見，不再無聲。
        this.receivedChunkCount++;
        if (this.receivedChunkCount === 1) {
          diagLog(
            'audio',
            'first audioChunk received from offscreen (samples:', pcm.length, ', sampleRate:', msg.sampleRate, ')',
          );
        } else {
          const now = performance.now();
          if (this.chunkWindowStart === 0) this.chunkWindowStart = now;
          if (now - this.chunkWindowStart >= 5000) {
            diagLog('audio', `audioChunk stats — received=${this.receivedChunkCount} (last 5s)`);
            this.receivedChunkCount = 0;
            this.chunkWindowStart = now;
          }
        }
        if (!this.chunkCallback) return;
        // 構造 AudioChunk（VAD 標記由下游 EnergyVAD 處理）。
        const chunk: AudioChunk = {
          seq: seqCounter++,
          startTime: 0, // Offscreen 無法獲取視頻時間軸，由下游對齊。
          duration: (pcm.length / msg.sampleRate) * 1000, // ms
          sampleRate: msg.sampleRate,
          channels: 1,
          pcm,
          isSpeech: true, // 默認 true，VAD 會重新標記。
        };
        this.chunkCallback(chunk);
        break;
      }
      case 'error': {
        if (this.pendingStart) {
          // M2-55：初始握手期間的錯誤 → 交給 start() 決策。
          // need-stream-id 可觸發 StreamIdAcquirer 自動重取，其餘當一般錯誤。
          this.pendingStart(
            msg.code === 'need-stream-id'
              ? { kind: 'need-auth' }
              : { kind: 'error', message: msg.message }
          );
        } else {
          // 捕獲中途的錯誤（如 stream-ended 死串流）→ 落診斷 + best-effort 恢復。
          this.handleMidCaptureError(msg);
        }
        break;
      }
      case 'captureStopped':
        // 狀態通知，無需處理。
        break;
    }
  }

  /**
   * M2-55：處理捕獲中途（無待決握手）的錯誤。
   * stream-ended（tab 重載/串流失效）：清除複用旗標並 best-effort 自動重取恢復（單次，不循環）。
   * 其餘：僅落診斷（§5.6 不靜默）。
   * 全程 try/catch：handleMessage 由 port listener 同步調用，任何異常不得逃逸成
   * unhandled rejection（§5.6 頂層兜底紅線）。
   */
  private handleMidCaptureError(msg: { message: string; code?: string }): void {
    try {
      const code =
        msg.code === 'stream-ended' ? 'tab-capture-stream-ended' : 'tab-capture-failed';
  void recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'audio',
          code,
          recoverable: true,
          cause: new Error(msg.message),
        },
      });
    } catch {
      // recordDiagnostic 自身異常不許冒泡（診斷不可用時寧可丟診斷也不崩捕獲鏈）。
    }
    if (msg.code === 'stream-ended' && this.streamIdAcquirer) {
      // 死串流已丟棄：清除本地複用旗標，best-effort 自動重取恢復（失敗已有自身兜底）。
      this.streamIdProvider?.onStreamReleased();
      void this.tryReacquireAfterStreamEnded().catch(() => {
        // 最終兜底：tryReacquire 內部已 try/catch，此處防意外逃逸。
      });
    }
  }

  /**
   * M2-55：stream-ended 後 best-effort 自動重取（單次）。
   * 成功則重送 startCapture(freshId)，後續 captureStarted 由 handleMessage 處理；
   * 失敗則落 reauth 診斷（下次 restart 或用戶點擊 popup 再試）。
   */
  private async tryReacquireAfterStreamEnded(): Promise<void> {
    if (!this.streamIdAcquirer || !this.port) return;
    try {
      const freshId = await withTimeout(
        this.streamIdAcquirer.acquire(),
        CHROME_API_TIMEOUT_MS,
        'streamId acquire'
      );
      if (freshId && this.port) {
        this.port.postMessage({ type: 'startCapture', streamId: freshId } satisfies OffscreenRequest);
      }
    } catch (err) {
  void recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'audio',
          code: 'tab-capture-reauth-needed',
          recoverable: true,
          cause: err instanceof Error ? err : new Error(String(err)),
        },
      });
    }
  }
}
