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

### 2.16 字幕解析格式與時間戳範圍診斷（M1-54，「翻譯成功但字幕不顯示」定位）

- **現象**: 日誌顯示翻譯成功（`parsed map size = N`、`emit segments-ready/updated`、`render() called, cues: N`），但 overlay 持續 `draw() no active cue for currentTime: <大值> cues: N`，且 `first cue range` 的數值遠小於 `currentTime`（如 cue 範圍 `16 - 6287` vs currentTime `1548650`）——所有 cue 的時間戳「擠」在視頻開頭幾秒，與播放位置不匹配，字幕永不命中。
- **根因方向**: 字幕時間戳單位異常——若源數據以「秒」為單位卻被當作「毫秒」（缺少 ×1000），或格式識別走錯分支（srv3 毫秒 vs 傳統秒），會導致 cue 時間範圍與 `<video>.currentTime`（毫秒）錯位。overlay 的 `draw()` 用 `currentTime >= c.start && currentTime < c.end` 匹配，單位錯位則永遠無 active cue。
- **診斷日誌**（`capture` 分類，默認關；Options 開啟「捕獲」調試分類後輸出）:
  - `parseTimedText: lang: <lang> format: <json|xml> length: <N> prefix: "<前120字符>"` — 進入解析時記錄原始響應的格式判定與前綴片段，用於區分 json3 / srv3 / 傳統格式。
  - `parseJson: events: <N> first tStartMs: <值> first dDurationMs: <值>` — json3 分支的原始時間戳（應為毫秒）。
  - `parseXml: detected srv3 format (timedtext>p, t/d 為毫秒)` / `parseXml: legacy format (transcript/text, start/dur 為秒→×1000), root: <tag> nodes: <N>` — XML 分支走 srv3（毫秒）還是傳統（秒×1000）。
  - `<source>: segments: <N> start range: <min> - <max> max end: <值> median dur: <值> ms [— SUSPECT: timestamps may be seconds treated as ms (missing ×1000)]` — 每個解析分支結束時輸出時間戳範圍與中位時長；當「段數 ≥ 50 且 maxStart < 10_000ms」時追加 SUSPECT 標記，提示單位可能為秒被當毫秒。
- **開發者響應**: 對照 `parseTimedText` 的 `format` 與各分支 `start range`——若 SUSPECT 出現，說明源時間戳單位與解析分支假設不符（如 srv3 的 `t` 實際為秒、或傳統格式漏乘 1000）；再核對 overlay `first cue range` 與 `currentTime` 量級是否一致（都應為毫秒）。
- **真實環境定位結果（2026-08-10）**: 開啟「捕獲」調試分類後日誌完整輸出——`format: json`、prefix 為 `{ "wireMagic": "pb3", "pens": [...] }`（**pb3 格式**，與 json3 結構兼容：均有 `events[].tStartMs/dDurationMs/segs[].utf8`，`parseJson` 直接解析成功）；`parseJson: events: 431 first tStartMs: 16 first dDurationMs: 6271`；`parseJson: segments: 431 start range: 16 - 2312116 max end: 2328666 median dur: 1261 ms`——時間戳單位**正確**（毫秒）、`currentTime: 1460953` 落在 `16 - 2312116` 範圍內、**無 SUSPECT 標記**。**結論：非時間戳單位問題，而是 M1-52 分塊翻譯進度**——翻譯從片頭開始，用戶把進度條拉到遠位置（24 分鐘）時首塊僅覆蓋前幾秒（`first cue range: 16 - 6287`），需等翻譯進度追上播放位置才出現字幕；換用更快本地模型後自愈。
- **過程教訓**: M1-54 診斷日誌最初「永遠缺失」——不是調用鏈斷，而是 `dist/` 未重建（舊構建不含診斷代碼），`npm run build` + 重新加載擴充後才正常輸出。**改動影響 `dist/` 產物的代碼必須重新構建部署，否則診斷「永遠缺失」會被誤判為上游斷鏈**。
- **代碼落點**: src/adapters/platform/youtube/timedtext.ts（`parseTimedText` 入口日誌、`parseJson`/`parseSrv3`/`parseXml`(legacy) 分支日誌、`logSegmentTimespan` 輔助）

### 2.17 timedtext 空響應 pot 重驅動（M2-24 補充修復十二，「重新加載插件後完全無字幕」定位）

- **現象**: 控制台顯示 `XHR timedtext response received, length: 0 content-type: text/html; charset=UTF-8` → `emitCapture: empty response, skipping (pot re-drive scheduled)`，最終 `native: run failed — timedtext XML: parse error (not valid XML) — root <html>, (empty body)` 且**連原文字幕都無**（native 全鏈失敗 → lookahead M3 未實現 → realtime-asr 未授權）。
- **根因**: 攔截器捕獲的首次 timedtext 請求**無 pot**（YouTube pot 防護探測信號）→ 空 body。播放器內部稍後才用 pot 重試，但 `ensureCaptionModuleLoaded` 選軌後**固定 3 秒復位** `setOption('captions','track',{})` 打斷了尚未完成的 pot 重試鏈 → 播放器不再發第二次請求 → `waitForCapture(15s)` 超時 → 直接 fetch（無 pot）空 body。
- **修復後行為**: 空響應觸發 `schedulePotRedrive()`（2s 間隔、上限 6 次）——切換軌 off→on 強制播放器重發帶 pot 請求；復位改為「成功捕獲後 800ms 抑制原生字幕」+ 10 秒截止，不再用固定 3 秒冒險打斷重試。
- **調試日誌**（`interceptor` 分類）: `pot re-drive scheduled, attempt: <N>` / `pot re-drive executing, attempt: <N>` / `pot re-drive exhausted after <N> attempts` / `Caption track reset after successful capture to suppress native rendering` / `Caption track reset (10s deadline) to suppress native rendering`。
- **調試輔助全局變量**（MAIN world）: `window.__aiTransTimedtextEmptyResponses`（空響應累計，pot 防護命中次數）、`window.__aiTransPotRedriveAttempts`（已執行的重驅動次數）——`EmptyResponses>0 但 Attempts=0` → 重驅動被取消（成功捕獲/換視頻）或達上限；`Attempts>0 但字幕仍無` → 播放器對重驅動也不響應，需檢查直接 fetch/ASR 降級。
- **用戶響應**: 重新加載頁面（觸發新的字幕驅動週期）；確認播放器字幕軌存在（`__aiTransCaptionTracks >= 1`）。
- **開發者響應**: 用調試輔助分流——`__aiTransTimedtextEmptyResponses===0` → 攔截器未捕獲到任何 timedtext 請求（isTimedText 未匹配/播放器未請求）；`EmptyResponses>0` 且 `Attempts` 正常 → pot 重試已由重驅動逼出，檢查下游（parseTimedText / bridge / 翻譯管線）。
- **代碼落點**: src/runtime/yt-timedtext-interceptor.ts（`schedulePotRedrive`/`redrivePlayerCaptions`/`resetPotRedrive`/`scheduleSuppressNative`/`scheduleSuppressDeadline`/`emitCapture` 空響應分支）

### 2.18 local-onnx 翻譯首響應卡死 + 模型預加載（M2-24 補充修復十三）

- **現象**: 字幕捕獲成功（`segments: 431`）後 overlay 持續 `draw() no active cue for currentTime: <大值> cues: 0`（~71 秒），錯誤列表全為 `local-onnx operation failed: Offscreen Document response timeout`（每次 30s），最終才 `translation failed, falling back to original subtitles`。
- **根因**: Offscreen 首次收到翻譯請求時模型未載入記憶體（`translationPipeline === null`），`runInference` lazy 載入 350MB 模型需 30-60s；SW `sendToOffscreen` 的 response 超時僅 30s → 首塊 request 被誤殺；provider 分 87 chunks（431/5）逐個 sendMessage，每個都在模型載入窗口內 30s 超時 → 整體卡 71+ 秒。
- **修復後行為**: ①SW 超時提升至 120s（安全網）；②新增 `local-onnx:warmup` 消息 + `warmupModel()`——Orchestrator 啟動時非阻塞預熱 primary、Options「預加載模型」按鈕手動觸發，模型在首次翻譯前已載入記憶體（30-60s 提前發生），後續翻譯首塊立即響應。
- **診斷碼**: `local-onnx-warmup-failed`（warmup/預加載失敗——模型載入出錯、快取損壞等）
- **觸發條件**: `warmupModel()` 內 `ensurePipelineLoaded()` 拋錯，或 `LocalONNXTranslationProvider.warmup()` 收到 `ok:false`/通信失敗
- **用戶響應**: Options「本地兜底模型」分區查看「預加載失敗」提示與原因；模型未下載時先點「下載模型」再預加載。
- **開發者響應**: `local-onnx-warmup-failed` 診斷 message 含 ORT/transformers 錯誤細節（`toReadableError` 保留 code/stack）；對照 Options 狀態——「未下載」→ 提示先下載；「已預加載（記憶體）」→ 模型已就緒。
- **代碼落點**: src/runtime/offscreen.ts（`warmupModel`/`local-onnx:warmup` 兩入口）、src/adapters/translation/local-onnx-translation.ts（`warmup()`）、src/application/orchestrator.ts（啟動預熱 + degraded 事件）、src/runtime/service-worker.ts（超時 120s）

### 2.19 清快取後重新下載模型永遠失敗（M2-24 補充修復十五）

- **現象**: 用戶在 Options 點「清除快取」後再點「下載模型」——下載進度恆 0、最終報「下載失敗」；Offscreen console 見 `[non-Error number] 1025635888`（`0x3D21F630`，wasm C++ 裸指針異常，非 Error 物件，`_OrtCreateSession` 在 wasm 初始化失敗模組上拋）。
- **根因**: `clearModelCache()` 原只刪快取、未重置共享載入狀態——`checkModelStatus()` 後台預熱建立的「無進度回調」`loadPromise` 在清快取後仍在飛、持有已刪快取句柄；`downloadModel(progressCallback)` → `ensurePipelineLoaded(progressCallback)` 見 `loadPromise` 存在**直接複用並丟棄新 callback** → 陳舊載入從已刪快取讀截斷位元組 → ORT session 建立失敗 → wasm 初始化失敗且 **Offscreen 生命週期不可恢復**，之後每次下載重複失敗。
- **修復後行為**: `clearModelCache()` 遞增 `cacheGeneration` + `disposePipeline()` + 重置共享載入狀態；載入完成世代比對（`gen !== cacheGeneration` → dispose + 不落地 + 拋 `ModelCacheClearedError`）；`loadPromiseHasProgress` 進度防護（無回調預熱載入不得被帶進度下載複用）；`downloadModel` 對 `ModelCacheClearedError` 落專屬診斷碼。
- **診斷碼**: `local-onnx-download-stale-load`（下載期間快取被清除、載入作廢——需重新點「下載模型」）
- **觸發條件**: `downloadModel()` catch 中 `err instanceof ModelCacheClearedError`
- **用戶響應**: Options「本地兜底模型」顯示「下載失敗：…快取被清除…」時直接再點一次「下載模型」即可（本次會以新鮮載入真正下載並回報進度）。
- **開發者響應**: 區分 `local-onnx-download-stale-load`（被清快取打斷，重試即可）vs `local-onnx-download-failed`（真實下載/載入失敗，需查 ORT/網絡）；診斷 message 含 `toReadableError` 轉出的錯誤細節。
- **代碼落點**: src/runtime/offscreen.ts（`cacheGeneration`/`loadPromiseHasProgress`/`disposePipeline`/`ModelCacheClearedError`/`ensurePipelineLoaded` 世代+進度防護/`clearModelCache` 重置/`downloadModel` 診斷碼區分）


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

### 3.4 晚捕獲重試失敗

- **診斷碼**: native-capture-late-retry
- **用戶可見消息**: 最近失敗: 錯誤: Error: native capture arrived after no-caption fallback — retry failed (<timestamp>)
- **觸發條件**: `pipeline-error(no-caption-strategy)` 置位後 bridge 捕獲晚到，`retryAfterLateCapture()` 重跑 Orchestrator 仍失敗
- **根因**: pot 重驅動鏈（無 pot 掛起 → 2s 排程 → 播放器帶 pot 重發 → 響應）超過 15s `waitForCapture` 窗口；捕獲最終成功但重跑策略鏈再次失敗（如捕獲被清、翻譯再錯）
- **用戶響應**: 等待重試（自動至多 3 次、5s 冷卻）；仍失敗則刷新頁面
- **開發者響應**: 檢查 `__aiTransLateCaptureRetries` / `__aiTransCaptureLatencyMs` 調試全局（真實環境可用 console 讀取）；對照 bridge 捕獲麵包屑（`emitCapture: success` 時間）與 no-caption 置位時間，確認捕獲是否在窗口後才到達
- **代碼落點**: src/runtime/content-script.ts（`retryAfterLateCapture()`）

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

### 4.12 LLM 輸出不完整/重複診斷（M1-55）

- **診斷碼**: `console.warn` 麵包屑（§5.6 不靜默，不落 recordDiagnostic）
- **用戶可見消息**: 無直接消息；缺失的段顯示原文（`translatedText=sourceText`），雙語模式下可能出現「英文+英文」；重複翻譯導致英中不同步
- **觸發條件**: **(a) 不完整**——`translateChunkOnce()` 解析 LLM 響應後 `map.size < chunk.length`（LLM 返回行數少於輸入段數）；**(b) 重複**——相同翻譯出現在多個 index（`valueCounts` 有重複值）
- **根因**: **(a) 不完整**——LLM 服務端 `max_tokens` 限制導致輸出截斷（M1-55 已設 `max_tokens: 4096` 緩解）；模型不願/無法一次性翻譯全部行（跳行/省略）；網絡中斷導致響應不完整；**(b) 重複**——小模型在長輸出中「迷失」，對不同 index 輸出相同翻譯，導致後續所有翻譯與原文錯位。**M1-55 修復背景**：`CHUNK_SIZE=60` 過大時本地 LLM 日誌顯示 60 段僅返回 30-34 行翻譯，且對 index 31, 43, 44, 45 等都輸出相同翻譯「>> 但結果是以色列總理並不滿意該計劃」，導致英中不同步。修復：分塊縮小至 15 + 明確 `max_tokens` + Prompt 改用 few-shot 示例格式（小模型對示例遵循度遠高於文字說明）
- **用戶響應**: 若大量段顯示原文或英中不同步，檢查本地模型是否支援長輸出；可嘗試換用更快的模型或調整 `CHUNK_SIZE`
- **開發者響應**: 觀察 `console.warn` 的 `expected N lines, got M (missing K)` 判斷截斷程度；觀察 `duplicate translations detected — N values appear multiple times` 判斷重複程度；若頻繁出現且 `max_tokens` 已設大，可能是模型能力問題而非配置問題
- **代碼落點**: src/adapters/translation/llm-translation.ts（`translateChunkOnce` 解析後 `map.size < chunk.length` 判斷 + `valueCounts` 重複檢測 + `console.warn` 輸出）

### 4.13 本地 ONNX 翻譯模型未下載（M2-24）

- **診斷碼**: local-onnx-not-downloaded
- **用戶可見消息**: 最近失敗: 錯誤: Error: local ONNX translation model not downloaded (<timestamp>)
- **觸發條件**: `LocalONNXTranslationProvider.translate()` 被調用，但模型尚未下載到 IndexedDB
- **根因**: 用戶未在 Options 頁點擊「下載模型」；模型快取被清除；下載中斷未完成
- **用戶響應**: 前往 Options 頁「本地兜底模型」分區點擊「下載模型」按鈕
- **開發者響應**: 確認 `local-onnx:check-status` 消息正確返回 `not-downloaded`；檢查 Offscreen Document 下載邏輯
- **代碼落點**: src/adapters/translation/local-onnx-translation.ts:30-35

### 4.14 本地 ONNX 翻譯推理失敗（M2-24）

- **診斷碼**: local-onnx-translation-failed: <錯誤>
- **用戶可見消息**: 最近失敗: 錯誤: Error: local-onnx-translation-failed: <錯誤> (<timestamp>)
- **觸發條件**: Offscreen Document 的 `local-onnx:translate` 消息處理拋錯（模型加載失敗/推理異常/記憶體不足）
- **根因**: 瀏覽器記憶體不足（ONNX 模型約 350MB）；WebAssembly 執行環境異常；模型檔案損壞
- **用戶響應**: 關閉其他分頁釋放記憶體；重新下載模型；刷新頁面
- **開發者響應**: 檢查 Offscreen Document console 錯誤；確認 `@huggingface/transformers` pipeline 初始化是否正常
- **代碼落點**: src/runtime/offscreen.ts（`local-onnx:translate` 消息處理）

### 4.15 本地 ONNX 翻譯消息通信失敗（M2-24）

- **診斷碼**: local-onnx-communication-failed: <錯誤>
- **用戶 Visible 消息**: 最近失敗: 錯誤: Error: local-onnx-communication-failed: <錯誤> (<timestamp>)
- **觸發條件**: content-script 向 Service Worker 發送 `local-onnx:*` 消息失敗（SW 未啟動/Offscreen Document 未創建）
- **根因**: Service Worker 被掛起後未正確喚醒；Offscreen Document 創建失敗；消息路由異常
- **用戶響應**: 刷新頁面；重啟瀏覽器
- **開發者響應**: 檢查 `ensureOffscreenDocument()` 邏輯；確認消息監聽器註冊
- **代碼落點**: src/adapters/translation/local-onnx-translation.ts:25-28（`sendMessage` 失敗處理）

### 4.16 本地 ONNX 模型預加載失敗（M2-24 補充修復十三）

- **診斷碼**: local-onnx-warmup-failed: <錯誤>
- **用戶可見消息**: Options「本地兜底模型」分區顯示「預加載失敗: <錯誤>」；Orchestrator 啟動時 warmup 失敗發 `engine-degraded`（port: 'translation'，reason: 'Translation warmup failed: <錯誤>'），popup「最近失敗」可查
- **觸發條件**: `warmupModel()`（offscreen）內 `ensurePipelineLoaded()` 拋錯，或 `LocalONNXTranslationProvider.warmup()` 收到 `ok:false`（如模型未下載）/通信失敗
- **根因**: 模型快取損壞/載入記憶體失敗（ORT wasm trap、記憶體不足）；模型未下載時誤觸預加載
- **用戶響應**: 模型未下載時先點「下載模型」再「預加載模型」；載入失敗可「清除快取」後重新下載
- **開發者響應**: 錯誤 message 經 `toReadableError` 保留 code/stack（數字型 ORT 錯誤碼可讀化）；對照 Options 狀態「未下載/已預加載（記憶體）/預加載失敗」
- **代碼落點**: src/runtime/offscreen.ts（`warmupModel`）+ src/adapters/translation/local-onnx-translation.ts（`warmup()`）+ src/application/orchestrator.ts（啟動預熱 catch）

### 4.17 本地 ONNX 下載期間快取被清除（M2-24 補充修復十五）

- **診斷碼**: local-onnx-download-stale-load: <錯誤>
- **用戶可見消息**: Options「本地兜底模型」顯示「下載失敗: local-onnx: model cache cleared during load」；popup「最近失敗」可查
- **觸發條件**: 下載/載入期間用戶點「清除快取」→ `cacheGeneration` 遞增 → 該載入完成時世代比對失敗 → `ModelCacheClearedError` → `downloadModel` catch 落此碼
- **根因**: `clearModelCache()` 後在飛的陳舊載入（含 check-status 後台預熱）作廢；舊實現複用其結果會從已刪快取讀截斷位元組 → ORT session 建立失敗 → wasm 初始化失敗且 Offscreen 生命週期不可恢復
- **用戶響應**: 此碼為「快取被清除、載入作廢」的良性可重試信號——直接再點一次「下載模型」即會以新鮮載入真正下載並回報進度
- **開發者響應**: 與 `local-onnx-download-failed`（真實下載/載入失敗）區分——前者是清快取競態、重試即可；後者需查 ORT/網絡/記憶體
- **代碼落點**: src/runtime/offscreen.ts（`downloadModel` catch 分支 `err instanceof ModelCacheClearedError`）


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

## 11. ASR 管線診斷（M2）

### 11.1 tabCapture 授權失敗

- **診斷碼**: tab-capture-not-authorized
- **用戶可見消息**: 最近失敗: 錯誤: Error: tabCapture not authorized — user denied or not triggered (<timestamp>)
- **觸發條件**: `chrome.tabCapture.getMediaStream` 被用戶拒絕或未經用戶手勢觸發
- **根因**: 用戶點擊「拒絕」授權對話框；Popup 按鈕未以用戶手勢觸發
- **用戶響應**: 點擊 Popup「啟用 ASR」按鈕重新授權；確認瀏覽器未全局禁用 tabCapture
- **開發者響應**: 確認 `chrome.tabCapture.getMediaStream` 在用戶手勢（click）事件處理器中調用；檢查 manifest `tabCapture` 權限
- **代碼落點**: src/adapters/audio/tab-capture-source.ts（`open()` catch 分支）

### 11.2 tabCapture 捕獲失敗

- **診斷碼**: tab-capture-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: tabCapture failed: <錯誤詳情> (<timestamp>)
- **觸發條件**: `chrome.tabCapture.getMediaStream` 拋錯（非用戶拒絕，如權限不足、標籤頁已關閉）
- **根因**: 標籤頁已被關閉；MV3 權限模型限制；Offscreen Document 創建失敗
- **用戶響應**: 確認標籤頁仍打開；刷新頁面重試
- **開發者響應**: 檢查 Offscreen Document 是否成功創建（`chrome.offscreen.createDocument`）；確認 port 連接狀態
- **代碼落點**: src/runtime/offscreen.ts（tabCapture 錯誤處理）；src/adapters/audio/tab-capture-source.ts（port 錯誤事件）

### 11.3 Offscreen Document 通信失敗

- **診斷碼**: offscreen-communication-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: offscreen communication failed: <錯誤> (<timestamp>)
- **觸發條件**: port `onDisconnect` 觸發且 `lastError` 非空；或 port `postMessage` 拋錯
- **根因**: Offscreen Document 崩潰；port 被 SW 回收；MV3 同時只允許一個 Offscreen（重複創建衝突）
- **用戶響應**: 刷新頁面重試
- **開發者響應**: 檢查 Offscreen Document 生命週期管理（`createDocument` / `deleteDocument`）；確認 port 在 `stop()` 正確斷開
- **代碼落點**: src/adapters/audio/tab-capture-source.ts（port `onDisconnect` 處理）

### 11.3a 音頻 handle 關閉失敗（M2-19）

- **診斷碼**: audio-handle-stop-failed
- **用戶可見消息**: 最近失敗: 錯誤: Error: audio handle stop failed: <錯誤> (<timestamp>)
- **觸發條件**: `RealtimeASRStrategy.stop()` 調用 `audioHandle.stop()` 時拋錯（fire-and-forget + catch）
- **根因**: Offscreen Document 已被提前關閉；port 斷開導致 `postMessage` 失敗；`chrome.offscreen.closeDocument` 失敗
- **用戶響應**: 刷新頁面重試（通常不影響功能，僅資源洩漏）
- **開發者響應**: 檢查 `TabCaptureAudioSource.stop()` 的 port/offscreen 清理邏輯；確認 `RealtimeASRStrategy.stop()` 正確調用 handle.stop
- **代碼落點**: src/application/strategies/realtime-asr-strategy.ts（`stop()` fire-and-forget catch）

### 11.4 ASR 引擎失敗

- **診斷碼**: asr-engine-failed
- **用戶可見消息**: 最近失敗: 降級: asr engine <engineId> failed: <錯誤> (<timestamp>)
- **觸發條件**: `ASRProvider.transcribe` / `transcribeStream` 拋錯
- **根因**: 本地 Whisper 模型加載失敗（記憶體不足、模型損壞）；雲端 ASR API 錯誤（4xx/5xx、WebSocket 斷開）
- **用戶響應**: 切換 ASR 引擎（本地 ↔ 雲端）；檢查雲端 API Key；降低模型檔位（small → base → tiny）
- **開發者響應**: 檢查 `ASRProvider` 實現；確認 `warmup()` 是否成功；查看 `engine-degraded` 事件詳情
- **代碼落點**: src/application/asr-pipeline.ts（catch 分支發 `engine-degraded`）

### 11.5 ASR 性能降檔

- **診斷碼**: asr-performance-degraded
- **用戶可見消息**: 最近失敗: 降級: asr performance degraded — RTF <rtf> > 1.0, switching to <tier> (<timestamp>)
- **觸發條件**: `PerfMetrics` 偵測 RTF > 1.0 持續 30s → 自動降檔（small → base → tiny）
- **根因**: 本地 Whisper 推理速度跟不上實時音頻（低端設備、大型模型）
- **用戶響應**: 切換到雲端 ASR；或接受降檔後的較低準確率
- **開發者響應**: 檢查 `PerfMetrics.summary()` 的 RTF 分佈；確認 `warmup()` 是否充分預熱
- **代碼落點**: src/infrastructure/perf/metrics.ts（動態降檔邏輯）

### 11.6 VAD 靜音切分

- **診斷碼**: (非錯誤，觀測日誌)
- **用戶可見消息**: 無（`diagLog('pipeline', ...)` 門控輸出）
- **觸發條件**: `EnergyVAD.process(pcm)` RMS < 閾值 → `isSpeech = false`
- **根因**: 音頻片段為靜音或背景噪音
- **用戶響應**: 無需操作（VAD 正常過濾靜音，節省 ASR 算力）
- **開發者響應**: 開啟「pipeline」調試日誌分類可觀察 VAD 切分頻率；調整 `asr.vadThreshold` 可改變靈敏度
- **代碼落點**: src/infrastructure/vad.ts（`EnergyVAD.process`）

### 11.7 本地 Whisper 模型下載

- **診斷碼**: (非錯誤，狀態通知)
- **用戶可見消息**: Options 頁「模型管理」區顯示下載進度
- **觸發條件**: `LocalWhisperASR.warmup()` 首次加載模型 → 從 HuggingFace Hub 下載到 IndexedDB
- **根因**: 模型未預先安裝
- **用戶響應**: 等待下載完成（tiny ~150MB、base ~300MB、small ~1GB）
- **開發者響應**: 檢查 IndexedDB 存儲空間；確認 `@huggingface/transformers` 版本
- **代碼落點**: src/adapters/asr/local-whisper.ts（`warmup()` 下載邏輯）；src/runtime/options/options.ts（進度條 UI）

### 11.8 雲端 ASR 端點識別

- **診斷碼**: (非錯誤，路由日誌)
- **用戶可見消息**: 無（`diagLog('pipeline', ...)` 門控輸出）
- **觸發條件**: `CloudASR` 依 `config.asr.endpoint` 自動識別：含 `deepgram` → WebSocket；其他 → OpenAI 兼容
- **根因**: 用戶填寫不同雲端服務商端點
- **用戶響應**: 無需操作（自動識別正確路由）
- **開發者響應**: 開啟「pipeline」調試日誌分類可觀察路由決策；確認端點格式
- **代碼落點**: src/adapters/asr/cloud-asr.ts（端點識別邏輯）


---

## 12. 診斷設計原則

1. **不靜默失敗**: 每個關鍵節點的失敗都必須留下可被用戶/開發者查詢的痕跡
2. **區分三態**: 找不到數據源 vs 數據源無字幕 vs 解析失敗,必須可區分
3. **附帶證據**: 錯誤消息包含實際證據(URL、HTTP 狀態、響應片段、root tag 等)
4. **用戶可見**: Popup「最近失敗」和 Options 頁必須能告訴用戶原因
5. **開發者可追蹤**: 診斷/事件流必須能定位到具體節點
6. **不影響主流程**: 診斷記錄失敗不得阻塞翻譯/字幕流程

---

## 13. 調試日誌門控（M1-51，F-12）

普通用戶的 console 不應被開發性日誌淹沒,但真實環境（content-script / MAIN world 攔截器）定位問題又依賴詳細日誌。M1-51 以中央門控分離「調試日誌」與「診斷/錯誤日誌」。

### 13.1 分類與開關

- **八分類**: `overlay` / `llm` / `capture` / `pipeline` / `strategy` / `content` / `bridge` / `interceptor`,各一個布爾開關。
- **預設全關**: `DEBUG_LOG_OFF`——普通用戶零噪音。
- **輸出格式**: `diagLog(category, ...)` 僅在對應分類開啟時 `console.log`,前綴 `[AI_Trans:diag][<category>]`,便於過濾。
- **持久化與同步**: 開關存 `EngineConfig.debugLog`（`chrome.storage.local`）;Options 頁「調試日誌」分區勾選;content-script 讀取後 `setDebugFlags()` 寫入模組內存,並 `dispatchEvent(new CustomEvent('ai-trans:set-debug-flags'))` 同步給無法訪問 `chrome.storage` 的 MAIN world 攔截器。
- **代碼落點**: src/infrastructure/debug-log.ts（`DebugLogCategory` / `diagLog` / `setDebugFlags` / `getDebugFlags`）、src/domain/models/config.ts（`DebugLogConfig` / `DEBUG_LOG_OFF` / `EngineConfig.debugLog`）、src/runtime/content-script.ts（讀配置 + CustomEvent 中繼）、src/runtime/yt-timedtext-interceptor.ts（監聽 `ai-trans:set-debug-flags`）、src/runtime/options/options.ts（`readDebugLog` / `fillDebugLog`）。

### 13.2 與診斷/錯誤日誌的邊界（§5.6 紅線）

- **錯誤/降級不受門控**: 所有失敗路徑的 `console.warn` + `recordDiagnostic`（本文件 §1–§11 全部診斷條目）**不經過 `diagLog`**,調試開關全關時仍照常輸出——「字幕沒出來」的原因永遠可見。
- **`diagLog` 僅承載正常流轉的觀測日誌**（掛載/渲染/捕獲複用/塊流轉等），關閉不損失任何失敗痕跡。
- **判斷標準**: 關閉全部調試日誌後,用戶遇功能失效仍能在 Popup「最近失敗」/Options 頁看到原因;開發者開啟對應分類即可補足流轉細節。
