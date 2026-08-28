# AI_Trans

**為 YouTube 提供實時翻譯字幕的 Chrome MV3 擴充。**

AI_Trans 會抓取視頻的字幕（未來也支持識別音頻），用可配置的引擎（雲端 LLM 或本地模型）翻譯，並以覆蓋層的形式渲染在播放器上——無需離開頁面。

English version: [README.md](./README.md).

---

## 功能特性

### 已實現（里程碑 M1）

- **原生字幕翻譯**——檢測並抓取 YouTube 原生字幕軌，翻譯後覆蓋顯示在播放器上。兼容 YouTube timedtext 全部真實格式：優先請求穩定 JSON（`fmt=json3`），回退可解析 `srv3` XML（`<timedtext><p t d><s>`）或傳統 `<transcript><text>` XML；非法 HTML（登錄/錯誤頁）被識別為解析錯誤，不再誤報「無字幕」。**兼容 YouTube 對 `/api/timedtext` 的 `pot`（proof-of-origin token）防護**：當播放器自身發起帶 token 驗證的字幕請求（擴充無法自行複製該請求）時，擴充在頁面 MAIN world 捕獲該響應並複用，token 防護下字幕仍能正常載入。攔截器以 manifest 聲明在 `document_start` 的 MAIN world 注入，**頁面最早階段、播放器首次字幕請求前**就已就位（含帶緩存的二次加載/重載）。**SPA 換視頻**——不重載頁面切換視頻（播放清單/側欄導航）經 URL 變化偵測，字幕管線自動熱重啟載入新視頻字幕；舊視頻的殘留字幕捕獲不會被誤用到新視頻。**跨 world 通信採用 CustomEvent**——content script（isolated world）與攔截器（main world）通過 `document` 上派發的 `CustomEvent` 通信，避免 `postMessage` 在跨 isolated world 場景下的不可靠性。**字幕模組驅動增強重試**——攔截器驅動 YouTube 字幕模組最多重試 60 次（60 秒），並在目標語言變更時立即觸發，確保播放器加載較慢時字幕仍能正常載入。**事件驅動晚捕獲重試**——若帶 token 的捕獲響應在管線已降級為「無字幕」**之後**才到達（播放器 token 重驅動鏈可能超過 15s 捕獲窗口，但響應最終成功），擴充把「捕獲到達」當作事件信號，自動重跑字幕管線（至多 3 次、5s 冷卻）而非永久空白；成功即恢復原生字幕，重試失敗會記錄 `native-capture-late-retry` 診斷。
- **覆蓋層字幕渲染**——支持單語或雙語（原文＋譯文），渲染於獨立覆蓋層並對齊播放時間。
- **播放狀態同步**——字幕隨當前時間、暫停、快進同步（媒體事件 + `requestAnimationFrame` 對齊）。
- **可配置翻譯引擎**——雲端 LLM（OpenAI 兼容 `/chat/completions`）為主、傳統 MT 兜底；端點、模型、API Key 由用戶配置。API Key 與配置對象分離存儲。
- **本地 LLM 服務支援**——可搭配本地 OpenAI 兼容服務（mlx / omlx / LM Studio / Ollama）：端點欄位接受「Base URL（如 `http://127.0.0.1:8000/v1`）」或「完整 `/chat/completions` 路徑」（自動規範化）；已授權 `http://127.0.0.1/*` 與 `http://localhost/*` 主機權限；reasoning 模型的 `<think>` 思考塊會自回覆中剝離；請求採用**兩階段超時**——響應頭 30s + 響應 body 5 分鐘（本地 LLM 長輸出不會被 30s 誤殺）；配置變更經 `chrome.storage.onChanged` 跨上下文熱重啟生效。
- **目標語言與字幕樣式**——可選目標語言、顯示模式（單語/雙語）、字號、顏色、背景。
- **Options 與 Popup 配置界面**——完整設定頁 + 快捷彈出頁（狀態顯示 + 重新載入）。
- **可靠性加固的內容腳本**——宿主方法綁定（避免 "Illegal invocation"）、配置熱重載時無訂閱洩漏、外部 JSON 容錯解析（詳見 `AGENTS.md` §5）。
- **翻譯失敗診斷可見性**——翻譯降級/錯誤不再被管線無聲吞掉：失敗原因持久化至 `chrome.storage.local`，並在 Popup 的「最近失敗」行**常駐顯示**（無記錄時顯示「無」，確保可見性）；同時輸出 `console.warn` 麵包屑。**當無任何字幕策略可接管時**（例如視頻原生字幕軌抓取失敗——與「翻譯失敗」不同），也會帶原因報告，讓「抓不到字幕」與「翻譯失敗」可區分。Popup 新增**「測試連接」按鈕**——一鍵向配置端點發最小實時請求，驗證端點可達/模型名/響應結構，直接終結「配置對不對」的猜測。Popup 的翻譯狀態行也會顯示**實際生效的模型名**（本地模式），便於確認保存後 storage 是否真正更新。**所有外部接口調用節點**都留下**證據化診斷**而非猜測：字幕拉取失敗會報告實際 HTTP 狀態、content-type 與 body 片段；LLM 響應異常（body 非 JSON、`choices` 缺失/為空）會被當作失敗並發降級事件留痕，而非靜默回退原文；播放器 15 秒仍未出現會發 `player-not-found` 錯誤；Popup、Options 頁與 service worker 的配置/密鑰讀取失敗都會明確顯示而非無聲失效。
- **翻譯失敗降級顯示原文**——當 LLM 翻譯服務失敗時（如連接中斷、超時），擴充**降級顯示原文字幕**而非完全不顯示。同時發送 `engine-degraded` 事件，Popup 可顯示降級原因。用戶寧可看到原文字幕也不願看到空白。
- **低延遲分塊翻譯**——長視頻按塊翻譯（`CHUNK_SIZE=60` 段）並漸進流式交付：首塊數秒內出現、後續塊增量更新覆蓋層，而非等待整片翻譯數分鐘。塊結果以 LRU 快取（上限 100 條，key = 模型 + 語言 + 內容哈希），重播、切換語言、重載分頁均免重複請求；引擎配置變更時快取自動失效。瞬態失敗（網絡中止、超時、HTTP 429/5xx、body 讀取或 JSON 錯誤）以退避重試 ≤2 次，重試耗盡的塊**回退顯示原文**而不阻塞其餘塊；永久錯誤（如 HTTP 400、響應結構異常）則 fail-fast，觸發管線降級並留下可追蹤診斷。
- **調試日誌門控**——console 日誌分為九個分類（overlay / llm / capture / pipeline / strategy / content / bridge / interceptor / local-onnx），**預設全部關閉**；排查問題時在「設定 → 調試日誌」按需開啟個別分類。輸出行帶 `[AI_Trans:diag][分類]` 前綴便於過濾。錯誤與降級信息**不受門控**——始終顯示，即使關閉調試日誌，「最近失敗」行與 `console.warn` 麵包屑仍可靠可見。

### 已實現（里程碑 M2）

- **無字幕視頻實時 ASR**（`F-06`、`F-07`）——對無原生字幕的視頻，通過 `chrome.tabCapture` 擷取標籤頁音頻，做流式 ASR + 翻譯。**Offscreen Document 架構**——ASR 運行在獨立的 offscreen document（manifest 聲明）中，避免 service worker 掛起問題；通過 `chrome.runtime.connect` port（長連接，非一次性消息）與 content script 通信。**標籤頁音頻捕獲**——`TabCaptureAudioSource` 適配器捕獲標籤頁音頻流；用戶通過 Popup 的「啟用 ASR」按鈕授權，觸發 `chrome.tabCapture.getMediaStream`，含完整的生命週期管理（start/stop 事件）。**能量閾值 VAD**——`EnergyVAD`（RMS 閾值計算，無外部依賴）通過檢測語音活動 vs 靜音，將連續音頻切分為語音段，支持分塊 ASR 處理。**本地 Whisper ASR**——`LocalWhisperASR` 適配器使用 `@huggingface/transformers`（transformers.js v3，WASM/WebGPU）在本地運行 Whisper 模型；模型檔按需下載並緩存至 IndexedDB（非 `chrome.storage.local`，因其有 5MB 限制——Whisper tiny 約 150MB）。**雲端 ASR**——`CloudASR` 適配器同時支持 OpenAI Whisper API（multipart POST 至 `/v1/audio/transcriptions`）和 Deepgram（WebSocket 流式）；端點 URL 自動識別（含 `deepgram` → WebSocket，否則 → OpenAI 兼容）。**流式 ASR 接口**——`ASRPipeline.transcribeStream()` 增量產出分段結果；`RealtimeASRStrategy` 編排完整流程：音頻捕獲 → VAD 分段 → ASR 轉錄 → 翻譯 → 覆蓋層渲染。**臨時字幕修正**——中間 ASR 結果以「臨時」字幕顯示（區分樣式），最終結果到達後自動修正，提供即時反饋。**性能監控**——`PerfMetrics` 以滑動窗口（100 樣本）追蹤 ASR 延遲，計算 P50/P95 統計，當實時因子超過 1.0 持續 30s 時觸發自動降檔（如從本地 Whisper 降級至雲端 ASR，或從高質量模型降級至輕量模型）。**模型檔位配置**——Options UI 支持選擇模型檔位（本地 Whisper 的 tiny/base/small/medium；雲端端點 + 模型 ID）；支持自定義本地 ASR 模型（如 vibevoice）通過端點配置。**完整診斷**——ASR 管線失敗（tabCapture 授權拒絕、捕獲失敗、Offscreen 通信錯誤、ASR 引擎失敗、性能降檔、VAD 靜音切分、模型下載錯誤、端點識別）均發出可追蹤的診斷事件，在 Popup 的「最近失敗」行可見。
- **本地 ONNX 翻譯兜底**（`F-14`）——當雲端 LLM API 失敗（網絡錯誤、配額耗盡、離線）時，擴充自動降級至本地 ONNX 模型進行翻譯，實現完全離線的翻譯兜底。**單一模型**：`onnx-community/Qwen2.5-0.5B-Instruct`（INT4 ONNX，~750MB，高質量），**可配置 chunk size**（4/5）用於性能調優——较小 chunk 適合低配置機器，較大 chunk 吞吐量更高。採用統一 ChatML 提示格式與 text-generation pipeline。**架構**：新增 `LocalONNXTranslationProvider` 適配器（實作 `TranslationProvider` 端口），透過 Chrome Message Bus 發送推理請求給 Service Worker，Service Worker 轉發給 Offscreen Document（具備完整 DOM 與 WASM 支援）執行 ONNX Runtime Web 推理。ONNX Runtime WASM 二進位已打包進擴充（不依賴外部 CDN）。**主引擎支持**：Options「引擎類型」可選「本地 ONNX 模型（離線）」，直接作為主翻譯引擎（無需雲端 API 即可離線翻譯）；local-onnx 失敗時仍可降級至 MT 或原文。**Options UI**：新增「本地兜底模型」分區，包含：(1) 唯讀模型名稱欄位；(2) 模型狀態標籤（`未下載`/`下載中 xx%`/`已就緒`/`預加載中...`/`已預加載（記憶體）`/`下載失敗`）；(3) 下載進度條（實時顯示位元組下載百分比與速度）；(4) 「下載模型」/「**預加載模型**」/「清除快取」按鈕。**模型預加載**：「預加載模型」按鈕（OMLX 風格手動預載入）——模型已下載時可用，點擊即載入記憶體、成功顯示「已預加載（記憶體）」；同時 Orchestrator 啟動時自動對主翻譯引擎非阻塞觸發 `warmup()`（觸發式加載），模型在首次翻譯前已載入。模型同 offscreen 生命週期**只載入一次**，跨視頻不需重載；Chrome 銷毀 offscreen 後從快取 lazy 恢復。**檔位切換清理**：切換 chunk size 時，擴充自動釋放舊模型的記憶體並清除其快取檔案，同時刷新 UI 顯示下載狀態。**降級鏈路**：`TranslationConfig.fallbackType` 新增 `'local-onnx'` 選項，`Orchestrator` 組裝 `TranslationPipeline` 時優先選擇 `local-onnx` 作為 fallback（`local-onnx > mt > undefined`）。若模型尚未下載，拋出錯誤並記錄 `local-onnx-not-downloaded` 診斷，管線繼續降級至 MT 或原文。**清快取一致性**：「清除快取 → 重新下載」穩定可靠——清快取會同時作廢在飛的舊載入（世代計數失效，釋放 ORT 記憶體），下載以全新載入進行並回報真實進度；若下載被「清快取」打斷，Options 顯示可重試的 `local-onnx-download-stale-load` 提示，再點一次「下載模型」即可。**真流式漸進**——`translateStream` 逐 chunk emit 累計全量（首塊數秒內到達 `segments-ready`、後續 `segments-updated`，與 LLM 提供者同語義）；長視頻不再數分鐘完全空白。**echo 診斷儀器**——模型回顯原文時，診斷 cause 內嵌 raw `generated_text`（前 200 字符）+ 解析統計（`parsed x/N`）+ 推理耗時，每個翻譯 chunk 回報 `echoed` 標記並聚合為 `local-onnx-echo-chunks` 診斷，popup「最近失敗」可直接分辨「真回顯」vs「解析誤判」。純診斷——不做任何自動降級行為。**WebGPU 推理後端（M2-26）**——本地 ONNX **翻譯** pipeline 採用 **webgpu-first** 載入：模型權重駐留 GPU VRAM（JS heap 從 ~500MB 降到 ~50–100MB），讓與 popup 共享的 extension 渲染進程在模型載入後仍能存活、popup 持續可用；WebGPU 不可用時無縫回退 WASM（權重進 JS heap）並記錄 `local-onnx-webgpu-fallback` 診斷。本地 Whisper **ASR** pipeline 維持 WASM（模型小、堆壓力低）。

### 待實現（後續里程碑）

- **M3 — 預緩衝提前處理**（`F-08`）：對「無字幕但可預取音頻」的視頻，提前對已緩衝音頻做 ASR（較高風險 / 屬優化）。
- **更多平台**（YouTube 之外）。

> M1（原生字幕路徑）與 M2（實時 ASR）均已達到可用狀態。三級字幕策略（原生 → 預緩衝 ASR → 實時 ASR）已完成三分之二，見 `doc/`。

---

## 方式一：直接使用發布件（無需構建）

預構建的發布件位於 [`release/`](./release/)：

- `release/ai-trans-extension/` — 未打包擴充目錄（推薦）。
- `release/ai-trans-extension-v0.5.0.zip` — 壓縮包。

在 **Windows、macOS、Linux 上加載方式完全相同**，任何 Chromium 內核瀏覽器（Chrome / Edge / Brave）通用：

1. 若下載的是 zip，先解壓得到 `ai-trans-extension/` 目錄。
2. 打開瀏覽器，地址欄輸入 `chrome://extensions`（Edge 為 `edge://extensions`）並回車。
3. 打開右上角的 **開發者模式**。
4. 點擊 **加載已解壓的擴充程序**。
5. 選擇 `ai-trans-extension/` 目錄（含 `manifest.json` 的那一層）。
6. 打開任意 YouTube 視頻頁：`https://www.youtube.com/watch?v=...`。
7. 點擊工具欄的 **AI_Trans** 圖標 → **設定**，配置引擎、目標語言並填入 API Key。

各平台唯一差異僅在文件選擇對話框；擴充本身與平台無關。

> 發布件僅匹配 `https://www.youtube.com/*`。要翻譯視頻，需在設定中填好目標語言，並（使用雲端 LLM 時）填入有效 API Key；否則會退回 MT 字典兜底。

---

## 方式二：從源碼構建發布件（Windows / macOS / Linux）

### 前置需求

- **Node.js ≥ 20**（自帶 npm）。用 `node -v` 確認。
- Git（用於克隆倉庫）。
- 可選：`zip` 命令行工具用於生成壓縮包。若缺失，仍會生成未打包目錄，僅跳過壓縮步驟。
  - macOS/Linux：通常已預裝。
  - Windows：建議用 Git Bash / WSL，或安裝 `zip`；沒有它也能得到 `release/ai-trans-extension/`。

### 構建步驟（三平台命令一致）

```bash
# 1. 獲取代碼
git clone <倉庫地址>
cd AI_Trans

# 2. 安裝依賴
npm install

# 3. 構建發布件到 release/
npm run release
```

該命令依次執行 類型檢查 → esbuild 打包 → 靜態資源拷貝 → 清理打包，產出：

- `release/ai-trans-extension/` — 可加載的未打包擴充。
- `release/ai-trans-extension-v<版本>.zip` — 可分發壓縮包（若系統有 `zip`）。

隨後通過 **加載已解壓的擴充程序** 選擇 `release/ai-trans-extension/`（見方式一步驟 2–7）。

### 其他常用命令

```bash
npm run build        # 生產構建到 dist/（類型檢查 + 打包 + 拷貝）
npm run typecheck    # 僅 TypeScript 類型檢查
npm run lint         # ESLint
npm run test:all     # 完整測試：構建 → 單元 + 集成 + 契約 → E2E → 報告
npm run test:ci      # 單元 + 集成 + 契約（不含 E2E）
npm run test:e2e     # Playwright E2E（需先構建）
```

> Windows 說明：這些腳本為跨平台 Node 腳本，可在 PowerShell、CMD、Git Bash 或 WSL 運行。`build:test` 使用內聯環境變量（`TEST_PROFILE=1`），該寫法適用於 POSIX shell；在原生 Windows CMD/PowerShell 下若要跑 `test:all`，建議用 WSL/Git Bash，或手動設置該變量。

---

## 配置說明

打開擴充的 **設定**（Options 頁）可配置：

- **翻譯引擎**：雲端 LLM / 本地 / 本地 ONNX（離線）/ MT，模型、端點、API Key、兜底引擎。
- **ASR 引擎**：本地 Whisper / 雲端，模型檔位，端點，自定義模型路徑。
- **目標語言**、**顯示模式**（單語/雙語）、**性能檔位**。
- **字幕樣式**：字號、顏色、背景。
- **調試日誌**（用於排查問題）：按需開啟個別分類（overlay / llm / capture / pipeline / strategy / content / bridge / interceptor / local-onnx）。預設全部關閉。

API Key 寫入獨立安全存儲槽，絕不嵌入明文配置對象。

### 使用本地 LLM（mlx / omlx / LM Studio / Ollama）

1. 將**翻譯引擎**設為 `local`，填入伺服器提供的模型 ID。
2. **端點**欄位兩種填法皆可：Base URL（`http://127.0.0.1:8000/v1`）或完整路徑（`http://127.0.0.1:8000/v1/chat/completions`）——會自動規範化。
3. 若伺服器需要驗證，填入 API Key（不需要則任意非空字串）。
4. 儲存。content script 會熱重啟配置；若 YouTube 分頁已開啟，無需手動重新整理即可生效。

> **reasoning 模型提示**：會輸出長 `<think>` 思考的模型已支援（思考塊會被剝離）。採兩階段超時後，body 生成給足 5 分鐘（僅服務不響應/不可達才命中 30s 響應頭超時），但單次翻譯仍可能耗時 30–40s。要即時字幕建議改用非推理（instruct）模型。

> **翻譯模型選擇建議**：要即時字幕請選**翻譯專用（MT）或小參數 instruct 模型**，而非大型通用模型——分塊翻譯仍從片頭開始，慢模型在跳播到遠位置時字幕會明顯落後。實測推薦：
> - **騰訊混元翻譯大模型**——`HY-MT1.5-1.8B` / `HY-MT2-1.8B`：專為機器翻譯設計（約 1.8B 參數），本地服務上速度極快；`HY-MT2-1.8B` 為新一代。
> - **通義千問小參數模型**——`Qwen2.5-3B-Instruct` / `Qwen2.5-7B-Instruct`：通用但體積小，翻譯品質與速度均衡；追求低延遲用 3B，重視品質用 7B。
> 模型 ID 需與伺服器實際名稱完全一致。**避免填 ASR/語音轉文字模型**（如 VibeVoice-ASR）——它們走 `/v1/audio/transcriptions` 而非 `/v1/chat/completions`，連接測試會回 HTTP 400。

> **Ollama 用戶注意**：Chrome 擴充發送的請求帶有 `Origin: chrome-extension://<id>`，Ollama 0.32+ 默認拒絕此來源（返回 HTTP 403 空響應體）。解決方法：啟動 Ollama 前設置環境變量 `OLLAMA_ORIGINS=chrome-extension://*` 或 `OLLAMA_ORIGINS=.`（允許所有來源）。

> **該選哪個引擎？** — **雲端 API**（品質最佳、零本地資源、需網路）→ **Ollama/llama.cpp 本地服務**（品質好、原生速度、隱私、記憶體 <400MB）→ **本地 ONNX**（完全離線、免費、~750MB，但比原生推理慢且質量較低）→ **MT**（即時可用、零設定，但品質最低；適合當最後兜底）。實時字幕建議選快速、翻譯導向（MT）或小型 instruct 模型，避免大型通用模型；本地伺服器勿用 ASR 模型（它們走 `/v1/audio/transcriptions`，不是 `/chat/completions`）。

> **本地 ONNX — 時延與記憶體限制**：本地模型完全在瀏覽器內執行。首次使用需下載模型檔案；下載後**首次翻譯可能耗時 30–60 秒**（載入模型到記憶體）——在設定頁點**「預加載模型」**（或仰賴背景自動預熱），首響應延遲即可接近即時。翻譯以**每 4–5 段一個 chunk**（依設定而定）處理，影片很長時完整翻譯需較久；單次翻譯會話硬性上限**10 分鐘**，以維持擴充穩定。記憶體佔用依後端而異：WASM 模式（預設）約 **~500–750MB JS 堆**（依模型而定）；有 WebGPU 時約 **~50–100MB JS 堆 + GPU VRAM**（權重移入 VRAM）。低記憶體機器建議改用雲端或本地 LLM 引擎。

> **本地 ONNX 模型**：擴充使用單一模型——`onnx-community/Qwen2.5-0.5B-Instruct`（~750MB，INT4 量化）。採用現代 Decoder-only 架構與 BPE 分詞器，使用統一 ChatML 提示格式。Chunk size 可在設定中配置（4 或 5 段/ chunk）以調整性能。

> **⚠️ ONNX 模式固有缺陷**：瀏覽器內 ONNX 運行環境相比原生推理存在根本性限制：
> - **WASM 單線程**：瀏覽器擴充缺乏多線程 SIMD 優化；即使多核 CPU 也僅單線程推理。
> - **JS 堆限制**：擴充與 popup/options 頁共享渲染進程的 JS 堆；大模型可能造成記憶體壓力。
> - **量化精度損失**：WASM 下的 INT8/Q8 量化比原生 INT4/INT8 損失更多精度，特別是 Seq2Seq 翻譯模型。
> - **無原生 CPU 優化**：不同於 llama.cpp/Ollama 使用 AVX2/NEON 多線程，瀏覽器 WASM 同模型速度慢 5–10 倍。
>
> **低配置機器強烈建議使用外置本地模型服務（Ollama/llama.cpp）或雲端 API，而非 ONNX**：
> - **Ollama + Qwen2.5-0.5B (Q4_K_M)**：原生 C++ 推理，支援 CPU AVX2/NEON 多線程，記憶體 <400MB，速度比瀏覽器 WASM 快 5–10 倍。配置為「本地 LLM 服務」，端點填 `http://127.0.0.1:11434/v1`。
> - **雲端 API（Groq、SiliconFlow 矽基流動、Cloudflare Workers AI、Gemini API）**：零本地 CPU/記憶體開銷，端到端延遲 300–800ms，徹底解決低配置電腦發熱與卡頓問題。
>
> **引擎優先級推薦**：**雲端 API**（質量最佳、零本地資源）→ **Ollama/llama.cpp 本地服務**（質量好、原生速度、隱私）→ **本地 ONNX**（Qwen2.5-0.5B-Instruct，~750MB，INT4，離線但較慢）→ **MT**（即時但質量最低）。

> **排查提示 — 字幕不出現時**：先開 Popup 點**「測試連接」**——它會向配置端點發真實請求，直接告訴你失敗在哪一環（端點不可達/模型名不符/響應異常）。也可看**「最近失敗」**行（常駐顯示，如模型 404 `LLM translation failed: HTTP 404`）。若原因為 `no caption strategies applicable`，則屬**字幕軌抓取失敗**（與翻譯失敗不同），cause 會進一步區分三種子情況——找不到 player-response JSON / JSON 解析失敗 / 視頻確實無字幕軌。若原因為 timedtext 解析錯誤，說明字幕響應格式未被識別——擴充現已優先請求 `fmt=json3` 並回退 srv3 XML 解析；若 timedtext 請求被 YouTube 的 `pot` token 防護攔截，擴充會透明複用播放器自身的字幕響應。常見原因：模型 ID 與伺服器實際名稱不符（omlx 會回 404 Model not found）；端點格式（`http://127.0.0.1:8000/v1` 與 `http://127.0.0.1:8000/v1/chat/completions` 都會自動規範化）。**注意**：Chrome 對 `127.0.0.1`/`localhost` 的明文 HTTP 有 mixed-content 豁免，本地端點用 `http://127.0.0.1:PORT/v1` 即可，無需 HTTPS。

---

## 架構（簡述）

六邊形架構（端口與適配器）：穩定的 `domain` 核心、可插拔的 `adapters`、`application` 調度器，以及負責組裝（DI）的 `runtime`。依賴方向恆為 `adapters/application → domain`。

完整設計見 [`doc/`](./doc/)：

- `doc/requirements-design.md` — 需求、功能（F-01…F-13）、里程碑。
- `doc/architecture-design.md` — 端口、適配器、數據結構、實時性分析。
- `doc/system-test-design.md` — 測試策略、分層用例（TC-*）。
- `doc/project-progress.md` — 實時進度表。

工程守則（含內容腳本可靠性紅線）見 [`AGENTS.md`](./AGENTS.md)。

---

## 授權

MIT — 見 [LICENSE](./LICENSE)。
