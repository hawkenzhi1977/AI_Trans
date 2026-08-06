// MAIN world 注入腳本：攔截 YouTube 播放器發往 /api/timedtext 的請求（XHR 與 fetch 雙 hook），
// 捕獲其真實響應（含 pot token 驗證的完整 URL + 字幕數據），通過 window.postMessage 橋回 content-script。
//
// 背景：YouTube 2024+ 對 timedtext API 引入 pot（proof-of-origin token）防護，
// content-script isolated world 直接 fetch 無 pot 的 baseUrl 會拿到空響應。
// 本腳本運行在 MAIN world，能 hook 播放器自身的 XMLHttpRequest 與 fetch，
// 直接把播放器已成功請求到的響應複用給字幕管線，繞過 pot 生成。
// 播放器可能用 XHR 或 fetch 發字幕請求（不同頁面/版本不一），故兩者都 hook（M1-43）。
//
// §5.1/R1：宿主方法（XMLHttpRequest.prototype.open/send、window.fetch、window.postMessage、
// addEventListener）一律綁定接收者；hook 內部用 apply 保留實例接收者（brand check）。
// §5.3/R3：不改動任何宿主容器/DOM 節點，僅 hook 原型方法與監聽消息，對頁面零侵入。
// §5.4/R4：臨時監聽器（XHR load）用完自除；fetch 包裝無持久監聽器。

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
  /** 該 timedtext 請求所屬的視頻 ID（從 URL `v` 參數提取）；無法判定時為空串。 */
  videoId?: string;
}

/** 注入標記：防止 content-script 重複注入本腳本（SPA 導航/restart 場景）。 */
const INSTALL_FLAG = '__aiTransTimedtextInterceptorInstalled';

/** 判斷 URL 是否為 timedtext 字幕請求（M1-46：放寬 hostname 限制，只匹配路徑）。 */
function isTimedText(url: string): boolean {
  try {
    const u = new URL(url, globalThis.location?.href ?? url);
    // M1-46：manifest matches 已限定 youtube.com，且 YouTube 歷史上用過多種域名變體
    // （video.google.com、m.youtube.com 等），僅匹配 pathname 含 'timedtext'，
    // 不再限制 hostname（保留 localhost 供 E2E）。
    return u.pathname.includes('timedtext');
  } catch {
    return false;
  }
}

/** 從 timedtext URL 的 `v` query 參數提取視頻 ID；無則返回空串。 */
function extractVideoId(url: string): string {
  try {
    const u = new URL(url, globalThis.location?.href ?? url);
    return u.searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

/** 捕獲並 postMessage 一份響應（非空才轉發，避免污染最新值）。 */
function emitCapture(
  url: string,
  responseText: string,
  contentType: string,
  location: Location
): void {
  if (!responseText) return; // 空響應（無登錄態/無字幕）不轉發，也不更新 lastCapture（重播不發空）。
  captureRequestCount++;
  const capture: TimedTextCapture = {
    url,
    responseText,
    contentType: contentType || 'unknown',
    capturedAt: Date.now(),
    videoId: extractVideoId(url),
  };
  // M1-46：更新 lastCapture 供重播，並更新調試輔助全局變量。
  lastCapture = capture;
  Reflect.set(globalThis, '__aiTransTimedtextRequests', captureRequestCount);
  Reflect.set(globalThis, '__aiTransTimedtextLastCapture', capture);
  // 即時 postMessage（新開監聽器的場景直接命中）。
  const postMsg = globalThis.postMessage.bind(globalThis);
  postMsg(
    { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: capture },
    location.origin
  );
}

/** 最近一次捕獲的 timedtext 響應（M1-46 重播機制）。 */
let lastCapture: TimedTextCapture | null = null;

/** 捕獲計數器（調試輔助）：記錄攔截器命中 timedtext 的請求總數。 */
let captureRequestCount = 0;

/**
 * 啟動重播定時器：周期性 postMessage 最近捕獲，讓晚註冊的監聽器也能收到（M1-46）。
 * 背景：M1-45 把攔截器提前到 document_start（MAIN world），但 bridge 監聽器仍在
 * content-script（document_idle）才註冊——播放器在 document_idle 前發的字幕請求
 * 被捕獲後 postMessage，但**監聽器尚未就位，消息丟失** → waitForCapture(15s) 超時
 * → 回退直接 fetch（無 pot）→ 空 body 永久失敗。重播機制使監聽器最遲 1.5s 內收到。
 */
function startReplay(): void {
  const REPLAY_INTERVAL_MS = 1_500;
  setInterval(() => {
    if (!lastCapture) return;
    const postMsg = globalThis.postMessage.bind(globalThis);
    postMsg(
      { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: lastCapture },
      globalThis.location.origin
    );
  }, REPLAY_INTERVAL_MS);
}

function install(): void {
  if (Reflect.get(globalThis, INSTALL_FLAG)) return;
  Reflect.set(globalThis, INSTALL_FLAG, true);
  // M1-46：啟動重播定時器（周期性重發最近捕獲）。
  startReplay();
  // 調試輔助（M1-27 真實環境驗證）：暴露計數器與最近捕獲對象到 window。
  Reflect.set(globalThis, '__aiTransTimedtextRequests', 0);
  Reflect.set(globalThis, '__aiTransTimedtextLastCapture', null);

  // ── XHR hook（播放器常用路徑）──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    const urlStr = typeof url === 'string' ? url : url.href;
    if (isTimedText(urlStr)) {
      (this as unknown as { __aiTransUrl?: string }).__aiTransUrl = urlStr;
    }
    return origOpen.apply(this, [method, url, async ?? true, username, password]);
  };

  XMLHttpRequest.prototype.send = function (
    ...args: [body?: Document | XMLHttpRequestBodyInit | null]
  ): void {
    const urlStr = (this as unknown as { __aiTransUrl?: string }).__aiTransUrl;
    if (urlStr) {
      // R4：load 監聽器在請求完成後移除自身，不產生累積洩漏。
      const onLoad = (): void => {
        this.removeEventListener('load', onLoad);
        try {
          const responseText = String(
            (this as unknown as { responseText?: string }).responseText ?? ''
          );
          const contentType =
            (this as unknown as { getResponseHeader?: (h: string) => string | null })
              .getResponseHeader?.('content-type') ?? 'unknown';
          emitCapture(urlStr, responseText, contentType, globalThis.location);
        } catch {
          // §5.7：外部響應解析失敗不允許冒泡破壞播放器——吞掉（捕獲失敗僅意味著本輪不複用）。
        }
      };
      this.addEventListener('load', onLoad);
    }
    return origSend.apply(this, args);
  };

  // ── fetch hook（播放器變體路徑，M1-43）──
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    let urlStr: string;
    try {
      urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
    } catch {
      return origFetch(input, init);
    }
    if (!isTimedText(urlStr)) return origFetch(input, init);

    const captured = origFetch(input, init);
    // 透傳原響應（不阻塞播放器）；另克隆 body 讀取以捕獲響應文本（§5.4：無持久監聽器）。
    void captured.then((res) => {
      try {
        const clone = res.clone();
        void clone.text().then((text) => {
          emitCapture(
            urlStr,
            text,
            res.headers.get('content-type') ?? 'unknown',
            globalThis.location
          );
        });
      } catch {
        // §5.7：克隆/讀取失敗僅意味著本輪不複用，不影響播放器原請求。
      }
    });
    return captured;
  };
}

install();
