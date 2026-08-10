// content-script 側的消息橋：接收 MAIN world 攔截器捕獲的 timedtext 響應，
// 存最新一份供字幕管線複用；同時負責把攔截器腳本注入 MAIN world。
//
// 核心能力（M1-43）：
// - 常駐輪詢器（每 2 秒）：探查播放狀態（video 已播放/非暫停）與捕獲就緒度。
//   「已播放」是播放器發出 timedtext 請求的信號——播放器無法在頁面加載早期就
//   拿到字幕（pot 綁定請求上下文），播放時才發。輪詢器在捕獲就緒後通知等待者。
// - `waitForCapture(timeoutMs)`：fetchTracks 在無捕獲值時等待播放器捕獲，超時回退。
// - `stop()`（restart 用）保留 latest 緩存；`dispose()`（真正銷毀）清空。
//
// 與內容腳本的生命週期綁定：start 注入並啟動輪詢、stop/dispose 清理（R4 洩漏零容忍）。
import type { TimedTextCapture } from './yt-timedtext-interceptor';
import { diagLog } from '../infrastructure/debug-log';

/** content-script 注入 MAIN world 腳本時使用的 runtime URL（web_accessible_resources 聲明）。 */
export const INTERCEPTOR_SCRIPT_URL = 'src/runtime/yt-timedtext-interceptor.js';

/** 消息通道常量（與 interceptor 側一致）。 */
const CAPTURE_EVENT = 'ai-trans:timedtext-capture';

/** 輪詢探查間隔（毫秒）：每 2 秒檢查一次播放狀態與捕獲就緒度（M1-43）。 */
export const POLL_INTERVAL_MS = 2_000;

/** 播放器 video 元素選擇器（真實 YouTube + mock）。 */
const VIDEO_SELECTOR = 'video.html5-main-video, #mock-player video';

/**
 * 複用播放器 timedtext 響應的橋。
 * - `inject()`：把攔截器腳本動態注入 MAIN world（每次調用冪等）。
 * - `start()`：註冊 message 監聽 + 啟動 2s 輪詢器。
 * - `waitForCapture(timeoutMs)`：等待最新捕獲值（無則超時返回 null）。
 * - `stop()`：移除監聽 + 停輪詢，但**保留 latest**（restart 不丟已捕獲響應）。
 * - `dispose()`：全清（監聽 + 輪詢 + latest），真正銷毀時用。
 */
export class TimedTextBridge {
  private latest: TimedTextCapture | null = null;
  private readonly onMessageBound: (event: MessageEvent) => void;
  private injected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 等待捕獲的 Promise 解析器隊列（waitForCapture 多路等待）。 */
  private readonly waiters = new Set<() => void>();

  constructor() {
    // R1：監聽器作回調傳遞前綁定接收者（避免移除時 this 丟失）。
    this.onMessageBound = this.onMessage.bind(this);
  }

  /** 注入 MAIN world 攔截腳本；重複調用安全（腳本內部有冪等標記）。 */
  inject(): void {
    if (this.injected) return;
    this.injected = true;
    // chrome.runtime.getURL 返回 extension://<id>/...，可在頁面 script 標籤中加載
    // （需 manifest.web_accessible_resources 放行）。
    const url = chrome.runtime.getURL(INTERCEPTOR_SCRIPT_URL);
    // R3：腳本必須掛到自己創建的元素上，不碰宿主 DOM。
    const script = document.createElement('script');
    script.src = url;
    script.dataset.aiTrans = 'timedtext-interceptor';
    (document.head ?? document.documentElement).appendChild(script);
  }

  /** 啟動監聽 + 輪詢器；重複調用安全（先清理再重建）。 */
  start(): void {
    globalThis.removeEventListener('message', this.onMessageBound);
    globalThis.addEventListener('message', this.onMessageBound);
    this.ensurePolling();
  }

  /**
    * 等待最新捕獲值；超時返回 null（由調用方回退直接 fetch）。
    * 已在途的捕獲（latest 就緒且匹配）立即返回；否則掛起等待 message 事件或輪詢通知。
    * §5.4：所有 timer/listener 在 stop/dispose 時清理，不殘留。
    * expectedVideoId（M1-45）：僅接受屬於該視頻的捕獲——避免換視頻（SPA 導航）後
    * 複用上一個視頻的 stale 捕獲（不同視頻的 timedtext 響應不能互用）。
    */
   waitForCapture(timeoutMs: number, expectedVideoId?: string): Promise<TimedTextCapture | null> {
     diagLog('bridge', 'waitForCapture called, timeoutMs:', timeoutMs, 'expectedVideoId:', expectedVideoId, 'hasLatest:', !!this.latest);
     const current = this.latest;
     if (current && this.matchesVideo(current, expectedVideoId)) {
       diagLog('bridge', 'waitForCapture: latest available, returning immediately');
       return Promise.resolve(current);
     }
     return new Promise<TimedTextCapture | null>((resolve) => {
       let settled = false;
       const timer = setTimeout(() => {
         if (settled) return;
         settled = true;
         this.waiters.delete(onCapture);
          diagLog('bridge', 'waitForCapture: timeout after', timeoutMs, 'ms, returning null');
         // §5.4/M1-45：超時只解除本次等待，不釋放輪詢器引用（輪詢器由
         // ensurePolling/stop 統一管理；此處置 null 會讓 stop 無法清理 interval）。
         resolve(null);
       }, timeoutMs);
       const onCapture = (): void => {
         if (settled) return;
         const latest = this.latest;
         if (!latest || !this.matchesVideo(latest, expectedVideoId)) return; // 等待匹配視頻的捕獲
         settled = true;
         clearTimeout(timer);
         this.waiters.delete(onCapture);
          diagLog('bridge', 'waitForCapture: capture received, videoId:', latest.videoId);
         resolve(latest);
       };
       // 註冊等待者（message 事件與輪詢都會通知）。
       this.waiters.add(onCapture);
       // 已註冊後再查一次 latest（輪詢間隙捕獲到的情況）。
       if (this.latest && this.matchesVideo(this.latest, expectedVideoId)) onCapture();
     });
   }

  /** 捕獲是否屬於指定視頻（無 expectedVideoId 或捕獲無 videoId 時視為可接受）。 */
  private matchesVideo(capture: TimedTextCapture, expectedVideoId?: string): boolean {
    if (!expectedVideoId) return true;
    // 捕獲未帶 videoId（老版本 interceptor / URL 無 v 參數）時無法判別，
    // 保守接受（比「誤判為 stale 永不複用」更好——只有明確知道是別的視頻才拒絕）。
    if (!capture.videoId) return true;
    return capture.videoId === expectedVideoId;
  }

  /** 最新捕獲的 timedtext 響應；無則 null。 */
  getLatest(): TimedTextCapture | null {
    return this.latest;
  }

  /** 清空 latest 緩存（視頻切換時調用，避免複用舊視頻字幕）。 */
  clearLatest(): void {
    this.latest = null;
  }

  /** 停止監聽與輪詢，但保留 latest 緩存（restart 熱重載時不丟已捕獲響應）。 */
  stop(): void {
    globalThis.removeEventListener('message', this.onMessageBound);
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 徹底銷毀：移除監聽 + 停輪詢 + 清空 latest 與等待者。 */
  dispose(): void {
    this.stop();
    this.latest = null;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** 啟動 2s 輪詢（僅一份；探查播放狀態以維持捕獲通道活性）。 */
  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      // 探查播放狀態：已播放/非暫停時播放器通常已發過 timedtext 請求。
      // 不主動重新請求（pot 無法由我們生成），僅維持捕獲通道 + 通知等待者。
      const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
      const isPlaying = !!video && !video.paused && !video.ended && video.currentTime > 0;
      void isPlaying;
      this.notifyWaiters();
    }, POLL_INTERVAL_MS);
  }

  /** 通知所有 waitForCapture 等待者檢查最新值。 */
  private notifyWaiters(): void {
    if (this.latest) {
      for (const w of Array.from(this.waiters)) w();
    }
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data;
    // R7：外部消息必須容錯——非本擴充消息（__aiTrans 標記）直接忽略。
    if (!data || typeof data !== 'object' || !data.__aiTrans) return;
    if (data.type === CAPTURE_EVENT) {
      const payload = data.payload as TimedTextCapture;
      if (!payload || typeof payload.url !== 'string' || typeof payload.responseText !== 'string') return;
      // 取最新（後到的覆蓋先到的；雙軌字幕時 en 軌通常最後到）。
      this.latest = payload;
      this.notifyWaiters();
    }
  }
}

export type { TimedTextCapture };
