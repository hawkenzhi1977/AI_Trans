// MAIN world 注入腳本：攔截 YouTube 播放器發往 /api/timedtext 的 XHR 請求，
// 捕獲其真實響應（含 pot token 驗證的完整 URL + 字幕數據），通過 window.postMessage 橋回 content-script。
//
// 背景：YouTube 2024+ 對 timedtext API 引入 pot（proof-of-origin token）防護，
// content-script isolated world 直接 fetch 無 pot 的 baseUrl 會拿到空響應。
// 本腳本運行在 MAIN world，能 hook 播放器自身的 XMLHttpRequest（播放器用 XHR 而非 fetch 發字幕請求），
// 直接把播放器已成功請求到的響應複用給字幕管線，繞過 pot 生成。
//
// §5.1/R1：宿主方法（XMLHttpRequest.prototype.open/send、window.postMessage、addEventListener）一律綁定接收者。
// §5.3/R3：不改動任何宿主容器/DOM 節點，僅 hook 原型方法與監聽消息，對頁面零侵入。

/** 消息通道常量：content-script 與 MAIN world 之間的事件名。 */
export const TIMEDTEXT_CAPTURE_EVENT = 'ai-trans:timedtext-capture';
/** 消息通道常量：內容腳本向 MAIN world 請求觸發/狀態查詢。 */
export const TIMEDTEXT_REQUEST_EVENT = 'ai-trans:timedtext-request';

/** 發送給 content-script 的捕獲結果。 */
export interface TimedTextCapture {
  /** 播放器請求的完整 timedtext URL（含 pot 等簽名參數）。 */
  url: string;
  /** 響應原始文本（JSON3/XML/srv3）。 */
  responseText: string;
  /** 響應 content-type（證據用途）。 */
  contentType: string;
  /** 捕獲時間戳（供最新優先）。 */
  capturedAt: number;
}

/** 注入標記：防止 content-script 重複注入本腳本（SPA 導航/restart 場景）。 */
const INSTALL_FLAG = '__aiTransTimedtextInterceptorInstalled';

function install(): void {
  if (Reflect.get(globalThis, INSTALL_FLAG)) return;
  Reflect.set(globalThis, INSTALL_FLAG, true);

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // §5.1/R1：宿主方法必須綁定接收者。此處用 apply(this) 透傳——包裝函數作為實例方法被
  // 調用時 this 即為實例，apply(this) 保留原接收者，不丟失 brand/上下文（Illegal invocation 防護）。

  // R7：精確匹配 timedtext 路徑，避免誤攔其他請求。
  const isTimedText = (url: string): boolean => {
    try {
      const u = new URL(url, globalThis.location?.href ?? url);
      return u.hostname.endsWith('youtube.com') && u.pathname.includes('timedtext');
    } catch {
      return false;
    }
  };

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    // 記錄請求 URL 到實例，供 send 時判斷是否攔截。
    const urlStr = typeof url === 'string' ? url : url.href;
    if (isTimedText(urlStr)) {
      // 非標準字段：TS 標記為自有擴展（運行時無副作用）。
      (this as unknown as { __aiTransUrl?: string }).__aiTransUrl = urlStr;
    }
    return origOpen.apply(this, [method, url, async ?? true, username, password]);
  };

  XMLHttpRequest.prototype.send = function (...args: [body?: Document | XMLHttpRequestBodyInit | null]): void {
    const urlStr = (this as unknown as { __aiTransUrl?: string }).__aiTransUrl;
    if (urlStr) {
      // R4：註冊必配解除——load 監聽器在請求完成後移除自身，不產生累積洩漏。
      const onLoad = (): void => {
        this.removeEventListener('load', onLoad);
        try {
          const responseText = String((this as unknown as { responseText?: string }).responseText ?? '');
          if (!responseText) return; // 空響應（無登錄態/無字幕）不轉發，避免污染最新值。
          const capture: TimedTextCapture = {
            url: urlStr,
            responseText,
            contentType:
              (this as unknown as { getResponseHeader?: (h: string) => string | null }).getResponseHeader?.('content-type') ??
              'unknown',
            capturedAt: Date.now(),
          };
          const postMsg = globalThis.postMessage.bind(globalThis);
          postMsg(
            { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: capture },
            globalThis.location.origin
          );
        } catch {
          // §5.7：外部響應解析失敗不允許冒泡破壞播放器——吞掉但保持空響應行為。
          // （不影響播放器自身字幕顯示；捕獲失敗僅意味著本輪不複用。）
        }
      };
      this.addEventListener('load', onLoad);
    }
    return origSend.apply(this, args);
  };
}

install();
