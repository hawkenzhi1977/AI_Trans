# AI_Trans 診斷設計文檔

本文件按業務流程章節組織,列出所有診斷信息、錯誤消息、觸發條件、根因、用戶響應、開發者響應及代碼落點。

---

## 1. Content Script 啟動流程

### 1.1 配置讀取失敗

- **診斷碼**: config-load-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: <chrome.storage 錯誤信息> (<timestamp>)
- **觸發條件**: content-script 啟動時 ChromeStorageConfigStore.get() 拋錯
- **根因**: chrome.storage.local 權限不足、存儲損壞、擴充被卸載
- **用戶響應**: 重啟瀏覽器;檢查擴充權限;重新安裝擴充
- **開發者響應**: 檢查 chrome.storage API 調用;確認 manifest permissions
- **代碼落點**: src/runtime/content-script.ts:226-242

### 1.2 播放器未找到

- **診斷碼**: player-not-found
- **用戶可見消息**: 最近失敗: 錯誤: Error: player not found within 15000ms (selector: div#movie_player, .html5-video-player, #mock-player) (<timestamp>)
- **觸發條件**: MutationObserver 等待 15 秒後仍未找到播放器 DOM 節點
- **根因**: YouTube 播放器異步加載超時;SPA 導航後播放器未重新渲染;頁面變體無標準播放器
- **用戶響應**: 刷新頁面;等待頁面完全加載;確認是 YouTube watch 頁
- **開發者響應**: 檢查 PLAYER_SELECTOR 是否匹配當前 YouTube DOM;調整超時閾值
- **代碼落點**: src/runtime/content-script.ts:186-199

### 1.3 無平台適配器

- **診斷碼**: no-platform-adapter
- **用戶可見消息**: 最近失敗: 錯誤: Error: registry.platforms is empty (<timestamp>)
- **觸發條件**: buildDefaultRegistry 返回的 registry.platforms 為空數組
- **根因**: 當前 URL 不匹配任何平台適配器的 matches() 規則;組裝邏輯錯誤
- **用戶響應**: 確認是 YouTube watch 頁(youtube.com/watch?v=...)
- **開發者響應**: 檢查 buildDefaultRegistry 的平台匹配邏輯;確認 watchUrlRe 正則
- **代碼落點**: src/runtime/content-script.ts:86-96

### 1.4 配置熱重載失敗

- **診斷碼**: config-hot-reload-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: <restart 錯誤信息> (<timestamp>)
- **觸發條件**: Options 頁保存配置後,content-script 的 chrome.storage.onChanged 監聽觸發 restart(),但 restart() 拋錯
- **根因**: 新配置無效導致 Orchestrator 啟動失敗;播放器已移除無法重新掛載
- **用戶響應**: 刷新頁面;檢查 Options 配置是否合法
- **開發者響應**: 檢查 restart() 的 stop/start 流程;確認配置校驗邏輯
- **代碼落點**: src/runtime/content-script.ts:46-58

### 1.5 頂層未捕獲異常

- **診斷碼**: content-script-start-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: <未捕獲異常信息> (<timestamp>)
- **觸發條件**: start() 函數的 Promise 被 reject 且未被內部 catch 捕獲
- **根因**: 任何未預期的異步錯誤(組裝失敗、DOM 操作異常等)
- **用戶響應**: 刷新頁面;報告錯誤信息給開發者
- **開發者響應**: 根據錯誤堆棧定位問題;檢查是否有未 await 的 Promise
- **代碼落點**: src/runtime/content-script.ts:247-258

---

## 2. 平台適配器與字幕軌發現

### 2.1 播放器響應 JSON 未找到

- **診斷碼**: player response JSON not found (ytInitialPlayerResponse missing/empty)
- **用戶可見消息**: 通過策略鏈診斷累加器顯示:native: no caption tracks found — player response JSON not found (ytInitialPlayerResponse missing/empty)
- **觸發條件**: findPlayerResponseJson() 無法在頁面找到 ytInitialPlayerResponse 變量
- **根因**: YouTube 頁面結構變更;腳本加載順序問題;非 watch 頁
- **用戶響應**: 刷新頁面;確認是 YouTube watch 頁
- **開發者響應**: 檢查 YouTube DOM 結構是否變更;更新 findPlayerResponseJson 選擇器
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:46-48

### 2.2 播放器響應 JSON 解析失敗

- **診斷碼**: player response JSON parse failed: <JSON.parse 錯誤>
- **用戶可見消息**: native: no caption tracks found — player response JSON parse failed: <錯誤>
- **觸發條件**: JSON.parse() 解析 ytInitialPlayerResponse 文本失敗
- **根因**: YouTube 返回的 JSON 格式異常;腳本內容被截斷;XSS 防護干擾
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查 JSON 提取正則;確認是否需要處理轉義字符
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:56-60

### 2.3 播放器響應無字幕軌

- **診斷碼**: player response has no captionTracks (video may have no captions)
- **用戶可見消息**: native: no caption tracks found — player response has no captionTracks (video may have no captions)
- **觸發條件**: captionTracks 數組為空
- **根因**: 視頻確實無字幕(創作者未上傳、YouTube 未生成自動字幕)
- **用戶響應**: 等待 YouTube 生成自動字幕;聯繫視頻創作者添加字幕
- **開發者響應**: 此為正常情況,無需修復
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:62-63

### 2.4 Timedtext URL 構造失敗

- **診斷碼**: timedtext URL construct failed: <URL 構造錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext URL construct failed: <錯誤> (<timestamp>)
- **觸發條件**: new URL(baseUrl, ...) 拋錯(baseUrl 非法)
- **根因**: YouTube 返回的 baseUrl 格式異常;相對路徑解析失敗
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查 baseUrl 格式;確認 globalThis.location.href 是否可用
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:96-102

### 2.5 Timedtext 網絡請求失敗

- **診斷碼**: timedtext fetch failed: <網絡錯誤> (url: <URL>)
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext fetch failed: <錯誤> (url: <URL>) (<timestamp>)
- **觸發條件**: fetch() 拋錯(DNS 失敗、CORS 攔截、mixed-content、斷網)
- **根因**: 網絡問題;YouTube timedtext 端點 CORS 策略變更;HTTPS 頁面請求 HTTP 資源
- **用戶響應**: 檢查網絡連接;確認 YouTube 可訪問
- **開發者響應**: 檢查 fetch 綁定(§5.1);確認 URL 絕對化(§5.2);排查 mixed-content
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:113-119

### 2.6 Timedtext HTTP 非 2xx

- **診斷碼**: timedtext fetch HTTP <status> (url: <URL>)
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext fetch HTTP <status> (url: <URL>) (<timestamp>)
- **觸發條件**: HTTP 響應狀態碼非 2xx(404、500 等)
- **根因**: YouTube timedtext 端點返回錯誤;字幕軌已過期;權限不足
- **用戶響應**: 刷新頁面;等待後重試
- **開發者響應**: 檢查 HTTP 狀態碼;確認 URL 是否有效
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:120-124

### 2.7 Timedtext 響應體讀取失敗

- **診斷碼**: timedtext body read failed: <讀取錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext body read failed: <錯誤> (<timestamp>)
- **觸發條件**: res.text() 拋錯(連接中斷、流讀取失敗)
- **根因**: 網絡連接不穩定;YouTube 服務器提前關閉連接
- **用戶響應**: 刷新頁面;檢查網絡
- **開發者響應**: 檢查 fetch 綁定;確認是否需要重試邏輯
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts:126-132

### 2.8 Timedtext JSON 解析失敗

- **診斷碼**: timedtext JSON parse failed: <解析錯誤> — body snippet: "<片段>"
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext JSON parse failed: <錯誤> — body snippet: "<片段>" (content-type: <type>) (<timestamp>)
- **觸發條件**: JSON.parse() 解析 timedtext 響應失敗
- **根因**: YouTube 返回 HTML 錯誤頁而非 JSON;響應格式變更
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查 content-type 和 body snippet;確認是否需要更新解析邏輯
- **代碼落點**: src/adapters/platform/youtube/timedtext.ts:40-47

### 2.9 Timedtext JSON 缺少 events 數組

- **診斷碼**: timedtext JSON: missing events array
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext JSON: missing events array (<timestamp>)
- **觸發條件**: 解析的 JSON 對象無 events 屬性或不是數組
- **根因**: YouTube timedtext JSON 格式變更
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查 YouTube timedtext 格式;更新解析邏輯
- **代碼落點**: src/adapters/platform/youtube/timedtext.ts:48-50

### 2.10 Timedtext XML 解析錯誤

- **診斷碼**: timedtext XML: parse error (not valid XML) — root <<tag>>, body snippet: "<片段>"
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext XML: parse error (not valid XML) — root <<tag>>, body snippet: "<片段>" (<timestamp>)
- **觸發條件**: DOMParser 解析 XML 時發現 <parsererror>
- **根因**: 響應為 HTML 錯誤頁/登錄頁而非 XML;XML 格式損壞;**YouTube pot token 防護導致無 pot 請求返回空 body（root <html>, empty body）——已由 M1-42 MAIN world 攔截複用機制繞過（優先複用播放器帶 pot 的成功響應）**
- **用戶響應**: 刷新頁面;確認已登錄 YouTube;**若持續出現 root <html> + 空 body，確認擴充的 MAIN world 攔截器已注入（web_accessible_resources 放行）且播放器已實際請求過字幕**
- **開發者響應**: 檢查 root tag 和 body snippet;確認是否為登錄重定向;**root <html> + 空 body 特徵指向 pot 防護——檢查 `timedtext-bridge` 是否收到 `ai-trans:timedtext-capture` 捕獲（`CaptionCaptureProvider.getLatest()` 是否有值）**
- **代碼落點**: src/adapters/platform/youtube/timedtext.ts:67-73;src/runtime/yt-timedtext-interceptor.ts;src/runtime/timedtext-bridge.ts

### 2.11 Timedtext XML 缺少 transcript 根

- **診斷碼**: timedtext XML: missing transcript root — actual root <<tag>>, body snippet: "<片段>"
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext XML: missing transcript root — actual root <<tag>>, body snippet: "<片段>" (<timestamp>)
- **觸發條件**: XML 解析成功但無 <transcript> 或 <timedtext> 根節點
- **根因**: YouTube 返回非預期 XML 結構;HTML 錯誤頁被 DOMParser 接受為合法 XML
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查 actual root tag;確認是否需要支持新格式
- **代碼落點**: src/adapters/platform/youtube/timedtext.ts:88-93

### 2.12 Timedtext 捕獲複用失敗回退（M1-42）

- **診斷碼**: timedtext capture parse failed: <錯誤> — fall back to direct fetch
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext capture parse failed: <錯誤> — fall back to direct fetch (<timestamp>)
- **觸發條件**: MAIN world 攔截器捕獲的播放器 timedtext 響應存在，但 content-script 側 `parseTimedText` 解析失敗（非字幕內容/空響應）——捕獲值被忽略，回退直接 fetch
- **根因**: 捕獲的響應非字幕內容（可能是其他 timedtext 請求的響應，如自動翻譯軌/預覽）；pot 防護對「捕獲響應複用」不適用但響應本身異常
- **用戶響應**: 無需操作——擴充已自動回退直接 fetch（若直接 fetch 亦被 pot 攔截，診斷會轉為 timedtext XML: parse error）
- **開發者響應**: 檢查捕獲內容為何解析失敗；確認攔截器是否過濾了非目標字幕響應
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts（`tryReuseCapture`/`waitForCaptureReuse`）;src/runtime/timedtext-bridge.ts;src/runtime/yt-timedtext-interceptor.ts

### 2.13 Timedtext 捕獲等待超時回退（M1-43）

- **診斷碼**: timedtext capture wait timeout (<<ms>> ms) — fall back to direct fetch
- **用戶可見消息**: 最近失敗: 錯誤: Error: timedtext capture wait timeout (15000 ms) — fall back to direct fetch (<timestamp>)
- **觸發條件**: `FetchCaptionSource.fetchTracks` 進入 `waitForCapture` 等待窗口（默認 15,000ms）但播放器始終未發出可捕獲的 timedtext 請求（或請求未帶 pot/未成功），超時後回退直接 fetch
- **根因**: 攔截器注入時序錯誤（播放器請求早於注入被漏）；播放器未開字幕（無 timedtext 請求）；`isTimedText` 未匹配播放器實際請求 URL；播放器使用未被 hook 的請求路徑；**捕獲早於 `TimedTextBridge` 監聽器註冊，`postMessage` 無接收者而丟失（M1-46 已由 1.5s `lastCapture` 重播修復）**
- **用戶響應**: 無需操作——擴充自動回退直接 fetch（無 pot 時極可能再現 `timedtext XML: parse error` 空 body 診斷，說明 pot 防護仍在生效）
- **開發者響應**: 確認 content-script `start()` 第一行已 `bridge.inject()`（早於任何 await）；`waitForCapture` 超時 timer 是否被清理（§5.4）；播放器實際請求的 timedtext URL 是否命中 `isTimedText`（XHR + fetch 雙 hook 均裝）；**用 §2.14 調試輔助分流：`window.__aiTransTimedtextRequests === 0` → hook 未觸發（isTimedText 沒匹配/播放器未請求）；有值但字幕不顯示 → 捕獲成功但解析/複用斷**
- **代碼落點**: src/adapters/platform/youtube/platform-adapter.ts（`waitForCaptureReuse`/`waitForCaptureTimeoutMs`）;src/runtime/timedtext-bridge.ts（`waitForCapture`）;src/runtime/yt-timedtext-interceptor.ts（`isTimedText`/`startReplay`）;src/runtime/content-script.ts（inject 提前）

### 2.14 攔截器捕獲調試輔助（M1-46，非診斷碼，控制台一鍵分流）

- **輔助全局變量**（MAIN world，`window` 上）:
  - `window.__aiTransTimedtextInterceptorInstalled`（boolean）：攔截器是否已在 MAIN world 裝載（hook 就位）。
  - `window.__aiTransTimedtextRequests`（number）：命中 `isTimedText` 且成功捕獲（HTTP 200 + 非空 body）的請求計數。
  - `window.__aiTransTimedtextLastCapture`（object|null）：最近一次捕獲對象（含 `videoId`、`text`、`url` 等），供比對當前視頻。
- **用途**: 真實 YouTube 登錄環境（M1-27）手動冒煙時，於頁面 DevTools Console 讀取三值一鍵分流故障——
  - `Installed !== true` → MAIN world 腳本未載入（檢查 manifest `world:"MAIN"` 條目與 `web_accessible_resources` 放行）。
  - `Installed === true` 但 `__aiTransTimedtextRequests === 0` → hook 已裝但從未捕獲：`isTimedText` 未匹配播放器實際 URL，或播放器未發字幕請求（未開字幕）。
  - `__aiTransTimedtextRequests > 0` 但字幕仍不顯示 → 捕獲成功但下游斷：對照 `__aiTransTimedtextLastCapture.videoId` 是否為當前視頻（跨視頻 stale），或 content-script `parseTimedText` 解析失敗（見 §2.12），或消息未達 bridge（M1-46 前的競態，已由重播修復）。
- **代碼落點**: src/runtime/yt-timedtext-interceptor.ts（`install`/`emitCapture`/`startReplay`）

### 2.15 XHR arraybuffer 響應類型支援（M1-50，timedtext 空響應根因修復）

- **現象**: 控制台顯示 `XHR timedtext response received, length: 0 content-type: text/html; charset=UTF-8`，隨後 `emitCapture: empty response, skipping`，最終 `parse error (not valid XML) — root <html>`。
- **根因**: YouTube 播放器可能將 XHR `responseType` 設為 `arraybuffer`（二進制傳輸），`readXhrResponseText()` 原代碼對 arraybuffer 類型返回空串，導致字幕響應被丟棄。
- **修復**: `readXhrResponseText()` 新增 `arraybuffer` 分支——當 `responseType === 'arraybuffer'` 且 `response instanceof ArrayBuffer` 時，用 `TextDecoder('utf-8')` 解碼為文本。
- **診斷增強**: XHR onLoad 中新增 `xhr.status` 和 `xhr.responseType` 日誌，便於區分「空響應」是 HTTP 錯誤、responseType 不支援、還是真實無字幕。
- **代碼落點**: src/runtime/yt-timedtext-interceptor.ts（`readXhrResponseText` arraybuffer 分支 + onLoad status/responseType 日誌）


---

## 3. 策略鏈執行

### 3.1 策略不適用(軟失敗)

- **診斷碼**: strategy-not-applicable
- **用戶可見消息**: 通過診斷累加器:native: no caption tracks found — <原因> | realtime-asr: not implemented (M2) | lookahead-asr: not implemented (M3)
- **觸發條件**: 策略的 isApplicable() 返回 false
- **根因**: 原生策略:無字幕軌;實時 ASR:M2 未實現;預緩衝 ASR:M3 未實現
- **用戶響應**: 確認視頻有字幕;等待 M2/M3 實現
- **開發者響應**: 檢查診斷累加器內容;確認策略降級邏輯
- **代碼落點**: src/application/caption-strategy-chain.ts:33-39

### 3.2 策略執行失敗

- **診斷碼**: strategy-failed
- **用戶可見消息**: native: run failed — <錯誤信息>
- **觸發條件**: 策略的 run() 方法拋錯
- **根因**: 字幕軌抓取失敗;翻譯異常;DOM 操作錯誤
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查錯誤堆棧;確認策略實現
- **代碼落點**: src/application/caption-strategy-chain.ts:50-72

### 3.3 全鏈無策略接管

- **診斷碼**: no-caption-strategy
- **用戶可見消息**: 最近失敗: 錯誤: Error: native: no caption tracks found — <原因> | realtime-asr: not implemented (M2) | lookahead-asr: not implemented (M3) (<timestamp>)
- **觸發條件**: 所有策略的 isApplicable() 返回 false 或 run() 拋錯
- **根因**: 視頻無字幕且 M2/M3 未實現;所有策略執行失敗
- **用戶響應**: 確認視頻有字幕;等待 M2/M3 實現
- **開發者響應**: 檢查診斷累加器;確認各策略的 isApplicable 邏輯
- **代碼落點**: src/application/caption-strategy-chain.ts:76-92

---

## 4. 翻譯管線

### 4.1 翻譯引擎降級(報告)

- **診斷碼**: engine ${engineId} reported degraded
- **用戶可見消息**: 最近失敗: 降級: engine <engineId> reported degraded (<timestamp>)
- **觸發條件**: 翻譯引擎返回 result.degraded = true
- **根因**: 引擎內部檢測到問題(如 fallback 被使用)
- **用戶響應**: 檢查翻譯引擎配置;確認端點可達
- **開發者響應**: 檢查引擎實現;確認降級邏輯
- **代碼落點**: src/application/translation-pipeline.ts:33-39

### 4.2 翻譯引擎降級(主引擎失敗)

- **診斷碼**: primary failed: <錯誤>
- **用戶可見消息**: 最近失敗: 降級: primary failed: <錯誤> (<timestamp>)
- **觸發條件**: 主翻譯引擎拋錯,降級到 fallback
- **根因**: 主引擎網絡失敗;API 限流;模型不存在
- **用戶響應**: 檢查主引擎配置;確認端點和模型
- **開發者響應**: 檢查錯誤信息;確認 fallback 邏輯
- **代碼落點**: src/application/translation-pipeline.ts:42-49

### 4.3 翻譯流式失敗

- **診斷碼**: primary stream failed: <錯誤>
- **用戶可見消息**: 最近失敗: 降級: primary stream failed: <錯誤> (<timestamp>)
- **觸發條件**: 流式翻譯 translateStream() 拋錯
- **根因**: 流式連接中斷;引擎不支持流式;超時
- **用戶響應**: 刷新頁面;檢查引擎配置
- **開發者響應**: 檢查流式實現;確認降級到非流式邏輯
- **代碼落點**: src/application/translation-pipeline.ts:82-94

### 4.4 翻譯失敗(無 fallback)

- **診斷碼**: translation-failed
- **用戶可見消息**: 最近失敗: 錯誤: <錯誤信息> (<timestamp>)
- **觸發條件**: 翻譯拋錯且無 fallback 引擎
- **根因**: 翻譯引擎完全失敗;網絡問題;API 錯誤
- **用戶響應**: 檢查翻譯引擎配置;確認端點可達;檢查 API 密鑰
- **開發者響應**: 檢查錯誤堆棧;確認引擎實現
- **代碼落點**: src/application/translation-pipeline.ts:101-111

### 4.5 LLM 翻譯請求失敗

- **診斷碼**: LLM translation request failed: <錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM translation request failed: <錯誤> (<timestamp>)
- **觸發條件**: fetch() 拋錯(網絡錯誤、超時、AbortError)
- **根因**: 端點不可達;CORS 攔截;mixed-content;請求超時
- **用戶響應**: 檢查端點 URL;確認網絡連接;檢查防火牆
- **開發者響應**: 檢查 fetch 綁定(§5.1);確認端點正規化;調整超時
- **代碼落點**: src/adapters/translation/llm-translation.ts:69-74

### 4.6 LLM 翻譯 HTTP 錯誤

- **診斷碼**: LLM translation failed: HTTP <status>
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM translation failed: HTTP <status> (<timestamp>)
- **觸發條件**: HTTP 響應狀態碼非 2xx
- **根因**: API 限流(429);模型不存在(404);認證失敗(401);服務器錯誤(500)
- **用戶響應**: 檢查 API 密鑰;確認模型名稱;等待限流解除
- **開發者響應**: 檢查 HTTP 狀態碼;確認請求格式
- **代碼落點**: src/adapters/translation/llm-translation.ts:78-80

### 4.7 LLM 翻譯響應非 JSON

- **診斷碼**: LLM translation response is not valid JSON: <錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM translation response is not valid JSON: <錯誤> (<timestamp>)
- **觸發條件**: res.json() 拋出**語法錯誤**（`SyntaxError`，響應為 HTML 錯誤頁或純文本）
- **根因**: 本地服務返回 HTML 錯誤頁;代理返回非 JSON 響應
- **用戶響應**: 檢查端點是否正確;確認服務器狀態
- **開發者響應**: 檢查響應內容;確認端點正規化
- **代碼落點**: src/adapters/translation/llm-translation.ts:87-107

### 4.7.1 LLM 翻譯響應 body 讀取失敗（連接中斷）

- **診斷碼**: LLM translation response body read failed (connection lost): <錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM translation response body read failed (connection lost): <錯誤> (<timestamp>)
- **觸發條件**: res.text() 拋錯（HTTP 響應頭已收到、200 已返回，但 body 流在傳輸中被中止/重置/超時中止）。**M1-53 兩階段超時後此消息涵蓋兩種場景**：(a) 服務器斷連（`Failed to fetch`/`NetworkError`）；(b) body 生成超時（`The user aborted a request`——headers 已到但 body 超過 `bodyTimeoutMs`（默認 `BODY_TIMEOUT_MS=300_000`，5 分鐘）仍未生成完，本地 LLM 長輸出場景）
- **根因**: 本地模型服務在發送 200 響應頭後、body 傳輸中途斷連（推理異常/超時關閉連接）；代理/VPN 中斷；服務器主動重置；或單塊翻譯輸出極慢超過 5min body 超時窗口
- **用戶響應**: 檢查本地模型服務進程是否正常、是否超時；重試。**若 body 超時（`The user aborted a request`）而服務正常**，可考慮縮小 `CHUNK_SIZE` 或調大 `bodyTimeoutMs`（本地長輸出模型）
- **開發者響應**: 與「響應非 JSON」區分——`Failed to fetch` 是網絡層連接中斷，非格式問題；`The user aborted a request` 是 body 超時中止。兩者均為瞬態（重試可能恢復）。檢查服務端日誌的推理/斷連原因；`LLM: fetch completed in X ms` 麵包屑顯示 headers 到達耗時，X 小（<1s）而後續超時 → body 生成慢
- **代碼落點**: src/adapters/translation/llm-translation.ts:87-107

### 4.8 LLM 翻譯響應無有效 choices

- **診斷碼**: LLM translation response has no valid choices[0].message.content (possibly rate-limited or schema changed)
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM translation response has no valid choices[0].message.content (possibly rate-limited or schema changed) (<timestamp>)
- **觸發條件**: 響應 JSON 無 choices[0].message.content
- **根因**: API 限流返回 {error};響應結構變更
- **用戶響應**: 檢查 API 限流;等待後重試
- **開發者響應**: 檢查響應結構;確認是否需要更新解析邏輯
- **代碼落點**: src/adapters/translation/llm-translation.ts:100-104

### 4.8.1 LLM 請求超時——兩階段（headers/body，M1-53）

- **診斷碼**: (a) headers 階段：`LLM request timed out (aborted)`；(b) body 階段：`LLM translation response body read failed (connection lost): The user aborted a request`
- **用戶可見消息**: 最近失敗: 錯誤: Error: LLM request timed out (aborted) (<timestamp>)；或最近失敗: 錯誤: Error: LLM translation response body read failed (connection lost): The user aborted a request (<timestamp>)
- **觸發條件**: `fetchDirectly()` 兩階段超時之一觸發 abort：(a) **headers 超時**——`fetch()` 等待響應頭超過 `timeoutMs`（默認 30_000），服務無響應/連接 lost；(b) **body 超時**——headers 已到達但 `res.text()` 讀取超過 `bodyTimeoutMs`（默認 `BODY_TIMEOUT_MS=300_000`，5 分鐘），本地 LLM 長輸出未生成完
- **根因**: **(a)** 端點不可達/CORS/mixed-content/服務器不響應；**(b)** 本地 LLM 單塊（60 段）翻譯輸出耗時 >5min、或 body 傳輸中斷。**M1-53 修復背景**：M1-52 舊實現用單一 30s 定時器覆蓋 `fetch`+`res.text()` 全程，本地服務 11ms 回 headers 但 body 生成需 >30s → 在 body 讀取階段被誤殺，每塊 3 次重試全超時 → 全片回退原文；兩階段解耦後 body 給足 5min
- **用戶響應**: (a) 檢查端點與服務狀態；(b) 檢查服務推理進度，正常則無需操作（5min 窗口足夠絕大部分輸出）
- **開發者響應**: 看 `LLM: fetch completed in X ms` 麵包屑——X 小（<1s）而後續超時 → body 生成慢（階段 b）；X 大或無此日誌 → headers 未到達（階段 a）。兩者均為瞬態（`transient=true`），重試 ≤2 次
- **代碼落點**: src/adapters/translation/llm-translation.ts（`fetchDirectly` / `BODY_TIMEOUT_MS` / `timeoutMs` / `bodyTimeoutMs`）

### 4.9 LLM 分塊瞬態失敗重試（M1-52）

- **診斷碼**: (console.warn 麵包屑，不落 recordDiagnostic)
- **用戶可見消息**: 無（重試對用戶透明；耗盡後該塊原文兜底，其餘塊正常翻譯）
- **觸發條件**: 單塊翻譯遇瞬態錯誤（`LLMRequestError.transient=true`：網絡中止/超時、HTTP 429/5xx、body 讀取失敗、JSON 解析失敗），`translateChunkWithRetry` 重試 ≤2 次（500ms→1500ms 退避）
- **根因**: 本地服務瞬時抖動;限流;推理超時;連接短暫中斷
- **用戶響應**: 無需操作;若整片大量塊回退原文，檢查服務穩定性與 timeoutMs
- **開發者響應**: 觀察重試麵包屑判斷抖動頻率;瞬態 vs 永久由 `LLMRequestError.transient` 判別（4xx 非 429 為永久，立即拋錯走管線降級，不重試）。**兩階段超時後**超時即 abort 對應 §4.8.1 的 headers 或 body 階段
- **代碼落點**: src/adapters/translation/llm-translation.ts（`translateChunkWithRetry` / `LLMRequestError` / `MAX_RETRIES=2` / `RETRY_DELAYS_MS=[500,1500]` / `BODY_TIMEOUT_MS`）

### 4.10 LLM 分塊耗盡重試後原文兜底（M1-52）

- **診斷碼**: (該塊 translatedText=sourceText，不拋錯不中斷)
- **用戶可見消息**: 該塊字幕顯示原文（未翻譯），其餘塊正常
- **觸發條件**: 單塊重試耗盡（3 次請求全敗）仍為瞬態錯誤
- **根因**: 服務持續不可用但屬瞬態類別（未達永久失敗條件）
- **用戶響應**: 檢查翻譯服務;個別塊原文屬預期降級行為，不阻塞整片
- **開發者響應**: 與永久失敗區分——永久失敗（choices 缺失、4xx 非 429）立即拋錯降級整條管線;此處為單塊軟降級
- **代碼落點**: src/adapters/translation/llm-translation.ts（`translateChunkWithRetry` 兜底分支）

### 4.11 LLM 快取失效（配置變更，M1-52）

- **診斷碼**: (invalidateLlmCache 全量清空，無錯誤)
- **用戶可見消息**: 無（改配置後重新請求翻譯，非失敗）
- **觸發條件**: `chrome.storage.onChanged` 偵測 `engineConfig` 變更 → `invalidateLlmCache()`
- **根因**: 端點/模型/語言變更後舊快取鍵空間不再匹配，全量清空最安全
- **用戶響應**: 無需操作
- **開發者響應**: `ensureLlmCacheInvalidationHook` 以 once-guard 防重複註冊（§5.4）;非擴充環境無 `chrome.storage` 時 try/catch 守護後無操作
- **代碼落點**: src/adapters/translation/llm-translation.ts（`LruCache` / `invalidateLlmCache` / `ensureLlmCacheInvalidationHook`）


---

## 5. Popup 診斷顯示

### 5.1 Popup 配置讀取失敗

- **診斷碼**: 配置讀取失敗: <錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: 配置讀取失敗: <錯誤>
- **觸發條件**: Popup 初始化時 store.get() 拋錯
- **根因**: chrome.storage 權限問題;存儲損壞
- **用戶響應**: 重啟瀏覽器;重新安裝擴充
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/runtime/popup/popup.ts:22-29

### 5.2 連接測試:端點未填寫

- **診斷碼**: 未填寫端點(Endpoint)
- **用戶可見消息**: 連接測試: 未填寫端點(Endpoint)。
- **觸發條件**: 配置無 translation.endpoint
- **根因**: 用戶未配置端點
- **用戶響應**: 在 Options 頁填寫端點 URL
- **開發者響應**: 無需修復
- **代碼落點**: src/runtime/popup/connection-test.ts:31-33

### 5.3 連接測試:模型 ID 未填寫

- **診斷碼**: 未填寫模型 ID
- **用戶可見消息**: 連接測試: 未填寫模型 ID。
- **觸發條件**: 配置無 translation.model 且無法推斷默認
- **根因**: 用戶未配置模型
- **用戶響應**: 在 Options 頁填寫模型名稱
- **開發者響應**: 無需修復
- **代碼落點**: src/runtime/popup/connection-test.ts:37-39

### 5.4 連接測試:HTTP 錯誤

- **診斷碼**: HTTP <status> — <服務器錯誤消息>
- **用戶可見消息**: 連接測試: HTTP <status> — <消息>
- **觸發條件**: 測試請求返回非 2xx 狀態碼
- **根因**: 模型不存在(404);認證失敗(401);限流(429)
- **用戶響應**: 檢查模型名稱;確認 API 密鑰;等待限流解除
- **開發者響應**: 檢查 HTTP 狀態碼和服務器消息
- **代碼落點**: src/runtime/popup/connection-test.ts:61-73

### 5.5 連接測試:響應結構異常

- **診斷碼**: 響應結構異常:無 choices 數組
- **用戶可見消息**: 連接測試: 響應結構異常:無 choices 數組。
- **觸發條件**: 響應 JSON 無 choices 數組
- **根因**: 端點返回非 OpenAI 兼容格式;代理干擾
- **用戶響應**: 確認端點為 OpenAI 兼容 API
- **開發者響應**: 檢查響應結構;確認端點正規化
- **代碼落點**: src/runtime/popup/connection-test.ts:80-82

### 5.6 連接測試:請求超時

- **診斷碼**: 請求超時(10s)。檢查端點與服務狀態。
- **用戶可見消息**: 連接測試: 請求超時(10s)。檢查端點與服務狀態。
- **觸發條件**: AbortController 超時觸發
- **根因**: 端點不可達;服務器響應慢;網絡問題
- **用戶響應**: 檢查端點 URL;確認服務器狀態;檢查網絡
- **開發者響應**: 檢查 fetch 綁定;確認端點正規化;調整超時
- **代碼落點**: src/runtime/popup/connection-test.ts:87-93

### 5.7 連接測試:網絡失敗

- **診斷碼**: 網絡失敗: <錯誤>
- **用戶可見消息**: 連接測試: 網絡失敗: <錯誤>
- **觸發條件**: fetch() 拋錯(非超時)
- **根因**: DNS 失敗;連接拒絕;mixed-content;CORS
- **用戶響應**: 檢查端點 URL;確認網絡連接
- **開發者響應**: 檢查 fetch 綁定;確認 URL 絕對化
- **代碼落點**: src/runtime/popup/connection-test.ts:84-93

### 5.8 重新載入:未找到活動標籤頁

- **診斷碼**: 未找到活動標籤頁
- **用戶可見消息**: 重新載入: 未找到活動標籤頁
- **觸發條件**: chrome.tabs.query 返回空數組或 tab 無 id
- **根因**: 無活動標籤頁;權限不足
- **用戶響應**: 打開 YouTube 頁面後重試
- **開發者響應**: 檢查 tabs 權限
- **代碼落點**: src/runtime/popup/popup.ts:88-93

### 5.9 重新載入失敗

- **診斷碼**: <tabs.reload 錯誤>
- **用戶可見消息**: 重新載入: <錯誤>
- **觸發條件**: chrome.tabs.reload() 拋錯
- **根因**: 標籤頁已關閉;權限問題
- **用戶響應**: 手動刷新頁面
- **開發者響應**: 檢查 tabs 權限
- **代碼落點**: src/runtime/popup/popup.ts:95-99


---

## 6. Options 頁診斷

### 6.1 Options 配置讀取失敗

- **診斷碼**: 讀取配置失敗: <錯誤>
- **用戶可見消息**: 讀取配置失敗: <錯誤>(狀態欄顯示 2 秒)
- **觸發條件**: Options 初始化時 store.get() 拋錯
- **根因**: chrome.storage 權限問題;存儲損壞
- **用戶響應**: 重啟瀏覽器;重新安裝擴充
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/runtime/options/options.ts:107-112

### 6.2 Options 密鑰讀取失敗

- **診斷碼**: 讀取密鑰失敗: <錯誤>
- **用戶可見消息**: 讀取密鑰失敗: <錯誤>(狀態欄顯示 2 秒)
- **觸發條件**: loadKeysIntoForm() 拋錯
- **根因**: chrome.storage 權限問題;密鑰存儲損壞
- **用戶響應**: 重新輸入 API 密鑰
- **開發者響應**: 檢查密鑰存儲邏輯
- **代碼落點**: src/runtime/options/options.ts:114-119

### 6.3 Options 配置保存失敗

- **診斷碼**: 保存失敗: <錯誤>
- **用戶可見消息**: 保存失敗: <錯誤>(狀態欄顯示 2 秒)
- **觸發條件**: store.set() 或 store.setApiKey() 拋錯
- **根因**: chrome.storage 寫入失敗;配額超限
- **用戶響應**: 檢查存儲配額;重啟瀏覽器
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/runtime/options/options.ts:81-89

---

## 7. Service Worker 消息處理

### 7.1 config:get 失敗

- **診斷碼**: config:get failed: <錯誤>
- **用戶可見消息**: 通過消息響應返回 {ok: false, error: "config:get failed: <錯誤>"}
- **觸發條件**: Service Worker 中 store.get() 拋錯
- **根因**: chrome.storage 權限問題;存儲損壞
- **用戶響應**: 重啟瀏覽器;重新安裝擴充
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/runtime/service-worker.ts:14-22

### 7.2 config:set 失敗

- **診斷碼**: config:set failed: <錯誤>
- **用戶可見消息**: 通過消息響應返回 {ok: false, error: "config:set failed: <錯誤>"}
- **觸發條件**: Service Worker 中 store.set() 拋錯
- **根因**: chrome.storage 寫入失敗;配額超限
- **用戶響應**: 檢查存儲配額;重啟瀏覽器
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/runtime/service-worker.ts:29-37

---

## 8. 消息總線

### 8.1 消息發布失敗(非接收方缺失)

- **診斷碼**: message bus publish("<topic>") failed: <錯誤>
- **用戶可見消息**: Console 警告:[AI_Trans] message bus publish("<topic>") failed: <錯誤>
- **觸發條件**: chrome.runtime.sendMessage() 拋錯且錯誤非「Receiving end does not exist」或「message port closed」
- **根因**: 序列化失敗;端口斷開;其他 chrome.runtime 錯誤
- **用戶響應**: 刷新頁面;報告問題
- **開發者響應**: 檢查錯誤信息;確認消息格式
- **代碼落點**: src/infrastructure/chrome-message-bus.ts:28-32

---

## 9. 診斷記錄機制

### 9.1 診斷記錄失敗

- **診斷碼**: (無聲失敗)
- **用戶可見消息**: 無
- **觸發條件**: chrome.storage.local.set() 在 recordDiagnostic() 中拋錯
- **根因**: chrome.storage 權限問題;存儲配額超限
- **用戶響應**: 無(設計上允許診斷記錄失敗,不影響主流程)
- **開發者響應**: 檢查 chrome.storage API 調用;確認診斷寫入邏輯
- **代碼落點**: src/infrastructure/diagnostics.ts:59-63

### 9.2 診斷讀取失敗

- **診斷碼**: (返回 undefined)
- **用戶可見消息**: Popup 顯示「最近失敗: 無」
- **觸發條件**: chrome.storage.local.get() 在 readLastDiagnostic() 中拋錯
- **根因**: chrome.storage 權限問題;存儲損壞
- **用戶響應**: 重啟瀏覽器;重新安裝擴充
- **開發者響應**: 檢查 chrome.storage API 調用
- **代碼落點**: src/infrastructure/diagnostics.ts:67-82

---

## 10. 診斷信息聚合與顯示

### 10.1 診斷記錄格式

DiagnosticRecord 結構:
- kind: degraded | error
- timestamp: ISO 8601 格式時間戳
- message: 人類可讀的錯誤原因

### 10.2 Popup 顯示邏輯

- 有診斷記錄: 顯示「最近失敗: <kind>: <message> (<timestamp>)」
- 無診斷記錄: 顯示「最近失敗: 無」
- 診斷讀取失敗: 顯示「最近失敗: 無」(不阻塞 popup 其餘功能)

### 10.3 Console 麵包屑

所有降級/錯誤事件都會在 console 輸出警告:
- 格式: [AI_Trans] translation degraded: <message>
- 目的: DevTools 直接可見,不含敏感信息

---

## 11. 診斷設計原則

1. **不靜默失敗**: 每個關鍵節點的失敗都必須留下可被用戶/開發者查詢的痕跡
2. **區分三態**: 找不到數據源 vs 數據源無字幕 vs 解析失敗,必須可區分
3. **附帶證據**: 錯誤消息包含實際證據(URL、HTTP 狀態、響應片段、root tag 等)
4. **用戶可見**: Popup「最近失敗」和 Options 頁必須能告訴用戶原因
5. **開發者可追蹤**: 診斷/事件流必須能定位到具體節點
6. **不影響主流程**: 診斷記錄失敗不得阻塞翻譯/字幕流程

---

## 12. 調試日誌門控（M1-51，F-12）

普通用戶的 console 不應被開發性日誌淹沒,但真實環境（content-script / MAIN world 攔截器）定位問題又依賴詳細日誌。M1-51 以中央門控分離「調試日誌」與「診斷/錯誤日誌」。

### 12.1 分類與開關

- **八分類**: `overlay` / `llm` / `capture` / `pipeline` / `strategy` / `content` / `bridge` / `interceptor`,各一個布爾開關。
- **預設全關**: `DEBUG_LOG_OFF`——普通用戶零噪音。
- **輸出格式**: `diagLog(category, ...)` 僅在對應分類開啟時 `console.log`,前綴 `[AI_Trans:diag][<category>]`,便於過濾。
- **持久化與同步**: 開關存 `EngineConfig.debugLog`（`chrome.storage.local`）;Options 頁「調試日誌」分區勾選;content-script 讀取後 `setDebugFlags()` 寫入模組內存,並 `dispatchEvent(new CustomEvent('ai-trans:set-debug-flags'))` 同步給無法訪問 `chrome.storage` 的 MAIN world 攔截器。
- **代碼落點**: src/infrastructure/debug-log.ts（`DebugLogCategory` / `diagLog` / `setDebugFlags` / `getDebugFlags`）、src/domain/models/config.ts（`DebugLogConfig` / `DEBUG_LOG_OFF` / `EngineConfig.debugLog`）、src/runtime/content-script.ts（讀配置 + CustomEvent 中繼）、src/runtime/yt-timedtext-interceptor.ts（監聽 `ai-trans:set-debug-flags`）、src/runtime/options/options.ts（`readDebugLog` / `fillDebugLog`）。

### 12.2 與診斷/錯誤日誌的邊界（§5.6 紅線）

- **錯誤/降級不受門控**: 所有失敗路徑的 `console.warn` + `recordDiagnostic`（本文件 §1–§11 全部診斷條目）**不經過 `diagLog`**,調試開關全關時仍照常輸出——「字幕沒出來」的原因永遠可見。
- **`diagLog` 僅承載正常流轉的觀測日誌**（掛載/渲染/捕獲複用/塊流轉等），關閉不損失任何失敗痕跡。
- **判斷標準**: 關閉全部調試日誌後,用戶遇功能失效仍能在 Popup「最近失敗」/Options 頁看到原因;開發者開啟對應分類即可補足流轉細節。
