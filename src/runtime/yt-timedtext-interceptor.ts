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
// M1-51：本腳本運行在 MAIN world，無法訪問 chrome.storage——調試日誌開關由
// content-script 通過 CustomEvent 中繼（'ai-trans:set-debug-flags'）。
import { diagLog, setDebugFlags } from '../infrastructure/debug-log';

/** 消息通道常量：content-script 與 MAIN world 之間的事件名。 */
export const TIMEDTEXT_CAPTURE_EVENT = 'ai-trans:timedtext-capture';
/** 消息通道常量：內容腳本向 MAIN world 請求觸發/狀態查詢。 */
export const TIMEDTEXT_REQUEST_EVENT = 'ai-trans:timedtext-request';
/** 消息通道常量（M1-47）：content-script 通知目標字幕語言（isolated world → MAIN world）。 */
export const SET_TARGET_LANG_EVENT = 'ai-trans:set-target-lang';
/** 消息通道常量（M1-51）：content-script 中繼調試日誌開關（isolated world → MAIN world）。 */
export const SET_DEBUG_FLAGS_EVENT = 'ai-trans:set-debug-flags';

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

/**
 * 安全讀取 XHR 響應文本（M1-47 硬化 + arraybuffer 支援）。
 * 真實瀏覽器中，若播放器把 `responseType` 設為 'json'/'arraybuffer'/'blob'，
 * 讀 `xhr.responseText` 會拋 `InvalidStateError`（jsdom 不拋，故此 bug 只在真實環境暴露）。
 * 此時改從 `xhr.response` 取值：json → JSON.stringify；arraybuffer → UTF-8 解碼；
 * 字符串 → 原樣；其他（blob/document）→ 空串跳過。
 */
function readXhrResponseText(xhr: XMLHttpRequest): string {
  const responseType = (xhr as unknown as { responseType?: string }).responseType ?? '';
  if (responseType === '' || responseType === 'text') {
    return String((xhr as unknown as { responseText?: string }).responseText ?? '');
  }
  const response = (xhr as unknown as { response?: unknown }).response;
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (responseType === 'json') {
    try {
      return JSON.stringify(response);
    } catch {
      return '';
    }
  }
  // arraybuffer：YouTube 可能使用 binary 傳輸，解碼為 UTF-8 文本
  if (responseType === 'arraybuffer' && response instanceof ArrayBuffer) {
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(response));
    } catch {
      return '';
    }
  }
  // blob/document 等二進制或非文本類型：本輪不複用（返回空，emitCapture 會跳過）。
  return '';
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
  if (!responseText) {
    diagLog('interceptor', 'emitCapture: empty response, skipping');
    return; // 空響應（無登錄態/無字幕）不轉發，也不更新 lastCapture（重播不發空）。
  }
  captureRequestCount++;
  const capture: TimedTextCapture = {
    url,
    responseText,
    contentType: contentType || 'unknown',
    capturedAt: Date.now(),
    videoId: extractVideoId(url),
  };
  diagLog('interceptor', 'emitCapture: success, captureRequestCount:', captureRequestCount, 'videoId:', capture.videoId);
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

/** 目標字幕語言（M1-47）：由 content-script 經 SET_TARGET_LANG_EVENT 消息設定。
 *  注意：這是「翻譯目標語言」（如 zh-Hant），用於調試輔助與重驅動觸發信號，
 *  不直接用於選軌（字幕來源語言為視頻原文，見 pickTargetTrack 註釋）。 */
let targetLang: string | null = null;

/** 播放器字幕軌條目（YouTube 未文件化結構，僅取用到的欄位）。 */
interface YtCaptionTrack {
  languageCode?: string;
  languageName?: string;
  kind?: string;
  is_translatable?: boolean;
  vss_id?: string;
  name?: { simpleText?: string } | string;
}

/**
 * 從播放器字幕軌列表挑選要載入的軌（M1-47）。
 * 注意：翻譯「目標語言」（如 zh-Hant）與字幕「來源語言」（視頻原文，常為英文）不同，
 * 故不以翻譯目標匹配軌。偏好人工軌（kind !== 'asr'）以取得質量更佳的原文字幕；
 * 無人工軌時退化為第一軌（通常為自動字幕）。content-script 側最終按需選軌翻譯，
 * 此處只需逼播放器發出**某一軌**帶 pot 的請求供攔截。
 */
function pickTargetTrack(tracklist: YtCaptionTrack[]): YtCaptionTrack {
  const manual = tracklist.find((t) => t.kind !== 'asr');
  return manual ?? tracklist[0];
}

/** 標記字幕模組驅動是否已成功（避免重試定時器無限跑）。 */
let captionModuleDriven = false;

/**
 * 從 DOM 中的 ytInitialPlayerResponse 解析字幕軌列表（M2-18 修復）。
 * 
 * 背景：YouTube 播放器 API `getOption('captions', 'tracklist')` 在某些情況下
 * 持續返回空陣列（即使視頻有字幕），導致字幕驅動失敗。本函式直接從頁面內嵌的
 * `ytInitialPlayerResponse` JSON 提取字幕軌信息，繞過播放器 API。
 * 
 * @returns 字幕軌列表；解析失敗或無字幕時返回 undefined。
 */
function getCaptionTracksFromPlayerResponse(): YtCaptionTrack[] | undefined {
  // 掃描所有內聯腳本，尋找 ytInitialPlayerResponse 賦值。
  // YouTube 頁面中該腳本通常形如 `var ytInitialPlayerResponse = {...};`
  // 或純 JSON（某些頁面/版本）。
  const scripts = document.querySelectorAll('script:not([src])');
  for (const el of Array.from(scripts)) {
    const text = el.textContent ?? '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    
    // 嘗試提取 JSON 對象。
    let jsonStr: string | undefined;
    
    // 形式 1: `var ytInitialPlayerResponse = {...};`（JavaScript 賦值）
    const assignMatch = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
    if (assignMatch) {
      jsonStr = assignMatch[1];
    } else if (text.trim().startsWith('{')) {
      // 形式 2: 純 JSON（script#ytInitialPlayerResponse 可能只含 JSON）
      jsonStr = text.trim();
    }
    
    if (!jsonStr) continue;
    
    try {
      const data = JSON.parse(jsonStr);
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks)) return tracks as YtCaptionTrack[];
    } catch {
      // JSON 解析失敗，繼續嘗試下一個腳本。
    }
  }
  return undefined;
}

/**
 * 主動驅動播放器字幕模組發出 timedtext 請求（M1-47 核心修復 + M2-18 增強）。
 *
 * 背景：真實環境中若用戶未開啟字幕（CC 關閉），播放器**根本不發** timedtext 請求，
 * 攔截器永遠捕獲不到帶 pot 的 URL → waitForCapture 超時 → 回退直接 fetch（無 pot）
 * → YouTube 返回 HTML 登錄頁（empty body）→ 解析失敗。M1-46 的重播只能重發「已捕獲」
 * 的響應，捕獲不到時無濟於事。此函式透過播放器 API 主動載入字幕模組並選軌，
 * 逼播放器自己發帶 pot 的請求，供攔截器捕獲；隨後復位抑制原生字幕顯示。
 *
 * M2-18 增強：`getOption('captions', 'tracklist')` 在某些情況下持續返回空陣列
 * （即使視頻有字幕）。新增 fallback：直接從 DOM 中的 `ytInitialPlayerResponse` 解析
 * 字幕軌信息，繞過播放器 API。
 *
 * 播放器 API（loadModule/getOption/setOption）未文件化且版本多變，全程 try/catch，
 * 失敗不致命（僅回退到原捕獲路徑）。
 */
function ensureCaptionModuleLoaded(): void {
  if (captionModuleDriven) return;
  const player = document.getElementById('movie_player') as unknown as {
    loadModule?: (m: string) => void;
    getOption?: (m: string, k: string) => unknown;
    setOption?: (m: string, k: string, v: unknown) => void;
  } | null;
  
  // 診斷日誌
  if (!player) {
    diagLog('interceptor', 'Player element not found');
    return;
  }
  if (typeof player.loadModule !== 'function' || typeof player.setOption !== 'function') {
    diagLog('interceptor', 'Player API not available');
    return; // 播放器未就緒/API 未暴露：由重試定時器稍後再試。
  }
  
  try {
    player.loadModule('captions');
  } catch {
    // 載入失敗（可能已載入）：繼續嘗試讀軌列表。
  }
  
  // 獲取字幕軌列表：優先從 DOM 解析（M2-18），fallback 到播放器 API。
  let tracklist: YtCaptionTrack[] | undefined;
  let source = 'unknown';
  
  // 優先從 ytInitialPlayerResponse 解析（繞過播放器 API 可能返回空的問題）。
  const domTracks = getCaptionTracksFromPlayerResponse();
  if (domTracks && domTracks.length > 0) {
    tracklist = domTracks;
    source = 'ytInitialPlayerResponse (DOM)';
    diagLog('interceptor', 'Got tracks from ytInitialPlayerResponse:', domTracks.length, 'tracks');
  } else if (typeof player.getOption === 'function') {
    // Fallback: 播放器 API。
    try {
      const raw = player.getOption('captions', 'tracklist');
      diagLog('interceptor', 'getOption tracklist:', raw, 'isArray:', Array.isArray(raw));
      if (Array.isArray(raw) && raw.length > 0) {
        tracklist = raw as YtCaptionTrack[];
        source = 'player.getOption';
      }
    } catch (err) {
      diagLog('interceptor', 'getOption error:', err);
    }
  }
  
  if (!tracklist || tracklist.length === 0) {
    diagLog('interceptor', 'No caption tracks available (video may have no captions)');
    // 無字幕軌：可能真無字幕，或軌列表尚未就緒。標記調試碼，讓重試繼續（真無字幕時無害）。
    Reflect.set(globalThis, '__aiTransCaptionTracks', 0);
    return;
  }
  
  diagLog('interceptor', 'Found', tracklist.length, 'caption tracks from', source);
  Reflect.set(globalThis, '__aiTransCaptionTracks', tracklist.length);
  const track = pickTargetTrack(tracklist);
  
  try {
    // 選軌 → 播放器發帶 pot 的 timedtext 請求（被 XHR/fetch hook 捕獲）。
    player.setOption('captions', 'track', track);
    captionModuleDriven = true;
    diagLog('interceptor', 'Caption module driven successfully, selected track:', track);
    // M1-48：增加延遲到 3000ms，確保 timedtext 請求完成後再復位（避免取消請求）。
    // 原生字幕可能短暫顯示，但捕獲成功後可接受。
    setTimeout(() => {
      try {
        player.setOption!('captions', 'track', {});
        diagLog('interceptor', 'Caption track reset to suppress native rendering');
      } catch {
        /* 復位失敗無害：原生字幕可能短暫顯示，不影響捕獲。 */
      }
    }, 3000);
  } catch (err) {
    diagLog('interceptor', 'setOption error:', err);
    // 選軌失敗：不標記成功，重試定時器會再試。
  }
}

/** 啟動字幕模組驅動重試（M1-47）：播放器異步就緒，周期重試直到成功。 */
function startCaptionModuleDriver(): void {
  const RETRY_INTERVAL_MS = 1_000;
  const MAX_RETRIES = 60; // 最多 60 秒等播放器就緒（YouTube 播放器加載可能較慢）
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    ensureCaptionModuleLoaded();
    if (captionModuleDriven || attempts >= MAX_RETRIES) {
      clearInterval(timer);
    }
  }, RETRY_INTERVAL_MS);
}

/** SPA 換視頻時重置驅動狀態並重新觸發（M1-47）。 */
function resetAndRedriveCaptionModule(): void {
  captionModuleDriven = false;
  // 立即嘗試一次（處理播放器已就緒的情況）
  ensureCaptionModuleLoaded();
  // 如果未成功，啟動定時器重試（處理播放器尚未就緒的情況）
  if (!captionModuleDriven) {
    startCaptionModuleDriver();
  }
}

function install(): void {
  if (Reflect.get(globalThis, INSTALL_FLAG)) return;
  Reflect.set(globalThis, INSTALL_FLAG, true);
  // M1-46：啟動重播定時器（周期性重發最近捕獲）。
  startReplay();
  // M1-47：接收 content-script 的目標語言，並啟動字幕模組主動驅動。
  // 使用 CustomEvent 替代 postMessage，避免 isolated world 與 MAIN world 之間的通信問題。
  const onSetTargetLang = (ev: Event): void => {
    const detail = (ev as CustomEvent).detail as { targetLang?: string } | undefined;
    targetLang = typeof detail?.targetLang === 'string' ? detail.targetLang : null;
    // 調試輔助：暴露目標語言，供真實環境確認消息通道已通。
    Reflect.set(globalThis, '__aiTransTargetLang', targetLang);
    diagLog('interceptor', 'Received set-target-lang message, targetLang:', targetLang);
    // 收到語言後（重）啟動驅動：涵蓋首次啟動與 SPA 換視頻後 restart 重發。
    resetAndRedriveCaptionModule();
  };
  document.addEventListener('ai-trans:set-target-lang', onSetTargetLang);
  // M1-51：接收 content-script 中繼的調試日誌開關（MAIN world 無法訪問 chrome.storage，
  // 只能靠 CustomEvent 同步；content-script 每次 start/restart 都會重發）。
  const onSetDebugFlags = (ev: Event): void => {
    const detail = (ev as CustomEvent).detail as { flags?: Record<string, boolean> } | undefined;
    setDebugFlags(detail?.flags);
    diagLog('interceptor', 'debug flags updated:', detail?.flags);
  };
  document.addEventListener(SET_DEBUG_FLAGS_EVENT, onSetDebugFlags);
  // 即使未收到語言消息也啟動一次驅動（用第一/人工軌），避免消息時序問題導致完全不驅動。
  startCaptionModuleDriver();
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
      diagLog('interceptor', 'XHR timedtext request detected:', urlStr);
      (this as unknown as { __aiTransUrl?: string }).__aiTransUrl = urlStr;
    }
    return origOpen.apply(this, [method, url, async ?? true, username, password]);
  };

  XMLHttpRequest.prototype.send = function (
    ...args: [body?: Document | XMLHttpRequestBodyInit | null]
  ): void {
    const urlStr = (this as unknown as { __aiTransUrl?: string }).__aiTransUrl;
    if (urlStr) {
      diagLog('interceptor', 'XHR timedtext request sending:', urlStr);
      // R4：load 監聽器在請求完成後移除自身，不產生累積洩漏。
      const onLoad = (): void => {
        this.removeEventListener('load', onLoad);
        try {
          const responseType = (this as unknown as { responseType?: string }).responseType ?? '';
          const status = (this as unknown as { status?: number }).status ?? 0;
          diagLog('interceptor', 'XHR timedtext onLoad: status:', status, 'responseType:', responseType);
          const responseText = readXhrResponseText(this);
          const contentType =
            (this as unknown as { getResponseHeader?: (h: string) => string | null })
              .getResponseHeader?.('content-type') ?? 'unknown';
          diagLog('interceptor', 'XHR timedtext response received, length:', responseText.length, 'content-type:', contentType);
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

    diagLog('interceptor', 'fetch timedtext request detected:', urlStr);
    const captured = origFetch(input, init);
    // 透傳原響應（不阻塞播放器）；另克隆 body 讀取以捕獲響應文本（§5.4：無持久監聽器）。
    void captured.then((res) => {
      diagLog('interceptor', 'fetch timedtext response received, status:', res.status);
      try {
        const clone = res.clone();
        void clone.text().then((text) => {
          diagLog('interceptor', 'fetch timedtext response body length:', text.length);
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
