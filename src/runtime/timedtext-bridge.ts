// content-script 側的消息橋：接收 MAIN world 攔截器捕獲的 timedtext 響應，
// 存最新一份供字幕管線複用；同時負責把攔截器腳本注入 MAIN world。
//
// 與內容腳本的生命週期綁定：start 注入、stop/dispose 移除監聽（R4 洩漏零容忍）。
import type { TimedTextCapture } from './yt-timedtext-interceptor';

/** content-script 注入 MAIN world 腳本時使用的 runtime URL（web_accessible_resources 聲明）。 */
export const INTERCEPTOR_SCRIPT_URL = 'src/runtime/yt-timedtext-interceptor.js';

/** 消息通道常量（與 interceptor 側一致）。 */
const CAPTURE_EVENT = 'ai-trans:timedtext-capture';

/**
 * 複用播放器 timedtext 響應的橋。
 * - `inject()`：把攔截器腳本動態注入 MAIN world（每次調用冪等）。
 * - 監聽 `message`，捕獲 `timedtext-capture` 事件並存最新值。
 * - `getLatest()`：供 FetchCaptionSource 優先複用；無捕獲值時返回 null（走原 fetch 回退）。
 */
export class TimedTextBridge {
  private latest: TimedTextCapture | null = null;
  private readonly onMessageBound: (event: MessageEvent) => void;
  private injected = false;

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

  /** 啟動監聽；在 content-script 註冊消息接收（與注入配合）。 */
  start(): void {
    globalThis.addEventListener('message', this.onMessageBound);
  }

  /** 最新捕獲的 timedtext 響應；無則 null。 */
  getLatest(): TimedTextCapture | null {
    return this.latest;
  }

  /** 移除監聽（R4：註冊必配解除）。 */
  dispose(): void {
    globalThis.removeEventListener('message', this.onMessageBound);
    this.latest = null;
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data;
    // R7：外部消息必須容錯——非本擴充消息（__aiTrans 標記）直接忽略。
    if (!data || typeof data !== 'object' || !data.__aiTrans) return;
    if (data.type === CAPTURE_EVENT) {
      const payload = data.payload as TimedTextCapture;
      if (!payload || typeof payload.url !== 'string' || typeof payload.responseText !== 'string') return;
      // 取最新（後到的覆蓋先到的；同源優先——雙軌字幕時 en 軌通常最後到）。
      this.latest = payload;
    }
  }
}

export type { TimedTextCapture };
