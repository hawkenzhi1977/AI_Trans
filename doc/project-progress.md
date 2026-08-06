# AI_Trans 項目進展文檔

> 版本：v0.1
> 狀態：M1 收尾完成（原生字幕全鏈路 + 配置界面 + 本地 LLM 服務兼容 + E2E 擴充驗證閉環 + 可靠性紅線加固 + 翻譯失敗診斷可見性）
> 最後更新：2026-08-05

---

## 1. 里程碑總覽

項目按**風險遞進**順序分三個開發階段（來自需求設計 §8 / 架構設計 §12）。

| 里程碑 | 名稱 | 對應功能 | 目標 | 狀態 |
|---|---|---|---|---|
| **M1** | 原生字幕翻譯 | F-01, F-02, F-03, F-04, F-05, F-10, F-11 | 一級策略：抓 YouTube 原生字幕 → 翻譯 → 覆蓋層 + 配置界面 + 本地 LLM 服務兼容 + 翻譯失敗診斷可見性 | ✅ **完成** |
| **M2** | 實時擷取 ASR | F-06, F-07 | 三級策略：tabCapture 音頻 → ASR（雲端/本地可配）→ 翻譯 → 顯示 | ⚪ 待完成 |
| **M3** | 預緩衝提前處理 | F-08 | 二級策略（高風險優化）：M2 管線上做音頻來源前置 | ⚪ 待完成 |

> 需求設計中還有 **M4 — 體驗與穩定性**（F-09 字幕樣式、多語言優化、性能檔位、改版加固），屬持續優化，非核心三階段。

---

## 2. 開發順序與優先級

| 順序 | 里程碑 | 優先級 | 理由 |
|---|---|---|---|
| 1 | **M1 原生字幕** | **P0** | 風險最低，先打通「字幕→翻譯→渲染」全鏈路，驗證架構 |
| 2 | **M2 實時 ASR** | **P1** | 覆蓋無字幕場景，打通實時管線（ASR+翻譯+對齊+渲染） |
| 3 | **M3 預緩衝** | **P2** | 高風險；與 M2 共用管線，僅換音頻數據來源，作為優化 |

> 設計文檔明確：二級與三級共用「ASR+翻譯+對齊+渲染」管線，差異僅在音頻來源。M1 先定義全部端口，後續里程碑只加適配器。

---

## 3. 技術點清單與進度

> 圖例：✅ 已完成　🟡 進行中　⬜ 待完成
> 優先級：P0=必須　P1=重要　P2=優化

### 3.1 M1 — 原生字幕翻譯（P0，進行中）

| # | 技術點 | 優先級 | 開發順序 | 狀態 | 落點 |
|---|---|---|---|---|---|
| M1-01 | **端口定義**：PlatformAdapter / CaptionStrategy / TranslationProvider / SubtitleRenderer / ConfigStore / MessageBus / ASRProvider / AudioSource | P0 | 1 | ✅ 已完成 | `src/domain/ports/*.ts`（8 個端口全定義） |
| M1-02 | **內部穩定數據結構**：SubtitleSegment / CaptionTrack / TranslationRequest / PlaybackState / EngineConfig / PipelineEvent / PipelineError | P0 | 1 | ✅ 已完成 | `src/domain/models/*.ts` |
| M1-03 | **Hexagonal 分層目錄**：domain / application / adapters / infrastructure / runtime 依賴單向 | P0 | 1 | ✅ 已完成 | `src/` 目錄結構 |
| M1-04 | **註冊表 Registry + selectPlatform** | P0 | 2 | ✅ 已完成 | `src/application/registry.ts` |
| M1-05 | **字幕抓取**：YouTube timedtext 解析（JSON + XML 雙格式） | P0 | 2 | ✅ 已完成 | `src/adapters/platform/youtube/timedtext.ts` |
| M1-06 | **YouTube 平台適配器**：播放狀態監聽 / 字幕軌發現 / 掛載點 | P0 | 2 | ✅ 已完成 | `src/adapters/platform/youtube/platform-adapter.ts` |
| M1-07 | **一級策略 NativeCaptionStrategy**：抓軌 → 翻譯 → 推送 segments-ready | P0 | 2 | ✅ 已完成 | `src/application/strategies/native-caption-strategy.ts` |
| M1-08 | **策略鏈 CaptionStrategyChain + 降級** | P0 | 2 | ✅ 已完成 | `src/application/caption-strategy-chain.ts` |
| M1-09 | **LLM 翻譯適配器**（OpenAI 兼容 /chat/completions） | P0 | 2 | ✅ 已完成 | `src/adapters/translation/llm-translation.ts` |
| M1-10 | **MT 翻譯兜底適配器**（字典實現） | P0 | 2 | ✅ 已完成 | `src/adapters/translation/mt-translation.ts` |
| M1-11 | **混合翻譯管線 TranslationPipeline**：LLM 主 + MT 兜底 | P0 | 2 | ✅ 已完成 | `src/application/translation-pipeline.ts` |
| M1-12 | **覆蓋層渲染器 OverlayRenderer**：單語/雙語、provisional 更新 | P0 | 2 | ✅ 已完成 | `src/adapters/render/overlay-renderer.ts` |
| M1-13 | **總調度 Orchestrator**：選平台 → 組裝管線 → 跑策略鏈 | P0 | 2 | ✅ 已完成 | `src/application/orchestrator.ts` |
| M1-14 | **Chrome storage 配置存儲**（含 merge 默認值） | P0 | 2 | ✅ 已完成 | `src/infrastructure/chrome-config-store.ts` |
| M1-15 | **Chrome runtime 消息總線** | P0 | 2 | ✅ 已完成 | `src/infrastructure/chrome-message-bus.ts` |
| M1-16 | **生產組裝 buildDefaultRegistry** | P0 | 2 | ✅ 已完成 | `src/runtime/composition.ts` |
| M1-17 | **Content Script 入口**：注入頁面啟動 M1 流程 | P0 | 2 | ✅ 已完成 | `src/runtime/content-script.ts` |
| M1-18 | **Service Worker 入口**：配置路由 | P0 | 2 | ✅ 已完成 | `src/runtime/service-worker.ts` |
| M1-19 | **manifest.json（MV3）** | P0 | 2 | ✅ 已完成 | `manifest.json` |
| M1-20 | **測試基礎設施**：Vitest 三層配置 / stub 引擎 / mock 平台 / timedtext 契約樣本 / Mock YouTube 站點 / Playwright E2E | P0 | 3 | ✅ 已完成 | `test/` + `vitest.*.config.ts` + `playwright.config.ts` + `test/e2e/fixtures.ts` |
| M1-21 | **腳本閉環**：build（esbuild 打包）/ serve-mock / merge-reports / cleanup / copy-static | P0 | 3 | ✅ 已完成 | `scripts/*.mjs`（`build.mjs` 4 入口打包、`copy-static.mjs` TEST_PROFILE 注入） |
| M1-22 | **測試用例**：40 單元 + 5 契約 + 50 集成 + 13 E2E = 108 全綠（含 §5 可靠性紅線回歸） | P0 | 3 | ✅ 已完成 | `test/**` |
| M1-23 | **CI 自動化（GitHub Actions）**：構建→部署→測試→報告→清理 | P1 | 4 | ✅ 已完成 | `.github/workflows/system-test.yml` |
| M1-24 | **Options/Popup 配置界面**：引擎選擇、API Key/端點、語言、樣式 | P0 | 4 | ✅ 已完成 | `src/runtime/options/` + `src/runtime/popup/` |
| M1-25 | **配置 → 適配器實際注入**（LLM 密鑰從 apiKeyRef 安全解析、真實調用） | P0 | 4 | ✅ 已完成 | `src/runtime/composition.ts` + `ApiKeyStore`（`chrome-config-store.ts`） |
| M1-26 | **播放器就緒後自動掛載 + 播放狀態驅動渲染**（MutationObserver 等待 + rAF 對齊 + 配置熱重啟） | P1 | 4 | ✅ 已完成 | `src/runtime/content-script.ts`（`SubtitleController`） |
| M1-27 | **真實 YouTube 頁面驗證**（手動冒煙 + 自動字幕接口容錯） | P1 | 4 | 🟡 進行中 | E2E（Mock 已驗證閉環）+ 待手動真實冒煙。用戶回報：連接測試通過但字幕不現——診斷鏈現已能區分「字幕軌抓不到」（no-caption-strategy，含三態：找無 JSON/解析失敗/無字幕軌）與「翻譯失敗」；真實 YouTube 上 popup 曾顯示 `lookahead-asr: not implemented (M3) | realtime-asr: not implemented (M2)`——**native 策略 run 失敗原因被鏈吞掉**（未進 diagnostics），已修復（M1-39 補 run 失敗診斷），需重新加載後讀取 native 真實失敗點 |
| M1-28 | **esbuild 打包基建**：4 入口 bundle（content-script/options/popup 用 IIFE，SW 用 ESM）；解決 MV3 content script 不支持 `import` | P0 | 3 | ✅ 已完成 | `scripts/build.mjs` |
| M1-29 | **TEST_PROFILE 測試構建**：`copy-static.mjs` 於 `TEST_PROFILE=1` 向 manifest 追加 `localhost:8721` match 與 host_permissions；生產構建保持乾淨 | P0 | 3 | ✅ 已完成 | `scripts/copy-static.mjs` + `build:test` |
| M1-30 | **E2E 擴充加載範式**：Playwright `launchPersistentContext` + `ignoreDefaultArgs:['--disable-extensions']` + `channel:'chromium'` 自定義 fixture（chromium.launch 不注入擴充） | P0 | 3 | ✅ 已完成 | `test/e2e/fixtures.ts` |
| M1-31 | **content-script fetch 綁定修復**：`FetchCaptionSource` 直接調用 `window.fetch` 拋 "Illegal invocation"，構造時 `bind(globalThis)`；baseUrl 相對路徑統一解析絕對 URL | P0 | 4 | ✅ 已完成 | `src/adapters/platform/youtube/platform-adapter.ts` |
| M1-32 | **可靠性紅線全庫審計與加固**：修復 restart 訂閱洩漏（observePlayback unsubscribe 未保存）、ensureMounted MutationObserver 洩漏+永久懸掛（加 handle+15s 超時）、`platforms[0]?` 靜默失敗改顯式判空發降級、LLM 默認 fetch 綁定 globalThis、YT `script:not([src])` 誤匹配+JSON.parse 未捕獲、translateStream 無 fallback、overlay cssText 改 setProperty、escapeHtml 補單引號、options showStatus 去抖 | P0 | 5 | ✅ 已完成 | `content-script.ts` / `platform-adapter.ts` / `llm-translation.ts` / `translation-pipeline.ts` / `overlay-renderer.ts` / `options.ts` |
| M1-33 | **發布件與雙語 README**：`npm run release` 生成乾淨未打包擴充 + zip（剔除 sourcemap/.d.ts）；`README.md`/`README.zh-Hant.md` 描述功能特性（已實現/待實現）與三平台安裝/源碼構建步驟；`release/README.md` 快速安裝說明。文檔一致性規則納入 README/發布件 | P1 | 5 | ✅ 已完成 | `scripts/package-release.mjs` / `release/` / `README*.md` / `AGENTS.md` §2 |
| M1-34 | **CI 集成測試環境相容性修復**：首次遠端 CI（Node 20.20.2）集成階段整體崩潰——`jsdom@30` 依賴的 `undici@8.10` 於 import 期調用 `webidl.util.markAsUncloneable`（Node 20 未提供）拋 `TypeError`，致 4 個集成測試文件收集階段失敗（junit `tests="0"`、退出碼 1），`test:ci` 的 `&&` 短路使 contract/E2E 未執行。降級 `jsdom@^26.1.0`（26.x 已移除 undici 依賴，engines `node>=18`）徹底繞開；`npm install` 更新 lockfile 後 undici 退出依賴樹。本地 `test:all` 66 全綠，集成回升 25 | P0 | 4 | ✅ 已完成 | `package.json` / `package-lock.json` |
| M1-35 | **test:ci 分段執行加固**：新增 `scripts/run-ci-tests.mjs`，unit/integration/contract 三段獨立執行，任一段失敗不短路後續段，各自產出 junit，末尾統一判定退出碼（任一段失敗即 exit 1）。根治 M1-34 暴露的「`&&` 串聯 + 收集期崩潰（0 tests）→ 後續段報告缺失」診斷盲區。配套：三個 vitest config 明文 `passWithNoTests: false`（收集 0 用例即失敗）；`merge-reports.mjs` 對 `tests=0` 的 suite 顯式 warn。驗證：正常 `test:all` 66 全綠；人為製造集成段失敗後 contract 仍執行且退出碼為 1 | P1 | 3 | ✅ 已完成 | `scripts/run-ci-tests.mjs` / `scripts/merge-reports.mjs` / `vitest.*.config.ts` / `package.json` |
| M1-36 | **CI action 升級消除 Node 20 runtime 棄用告警**：GitHub 棄用 action 底層 Node 20 runtime（強制跑在 Node 24），將 `actions/checkout@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4` 升至各自最新 major **v7**（底層 Node 24 runtime）。`node-version: 20` 仍指定測試用 Node 20，與 AGENTS.md 一致；不影響測試環境。文檔片段同步 | P2 | 1 | ✅ 已完成 | `.github/workflows/system-test.yml` / `doc/system-test-design.md` §5 |
| M1-37 | **本地 LLM 服務兼容（F-10）**：確診並修復「配置本地 omlx/mlx OpenAI 兼容服務後字幕不生效」四阻斷點——(1) `normalizeEndpoint` 端點規範化（Base URL `/v1` / 完整 `/chat/completions` / 裸 host / 空值 四態，杜絕 404）；(2) `manifest.json` host_permissions 加 `http://127.0.0.1/*` 與 `http://localhost/*`；(3) `stripReasoning` 剝離 reasoning 模型混入 `content` 的 `<think>` 思考塊，避免污染 `ID<TAB>譯文` 解析；(4) LLM `timeoutMs`（默認 30s）+ AbortController，長思考超時降級 MT 兜底（finally 清 timer）；(5) `SubtitleController` 改用 `chrome.storage.onChanged` 監聽 `engineConfig`/`engineConfigKeys`，實現 Options↔content-script 跨上下文配置熱重啟（原 `store.subscribe` 僅通知本進程回調，跨上下文無效）。測試 +11：單元 +4（reasoning 剝離/超時降級）、集成 +6（normalizeEndpoint 五態 + local 端點補全）、E2E +1（TC-R8 storage.onChanged 熱重啟）| P0 | 4 | ✅ 已完成 | `composition.ts`（`normalizeEndpoint`）/ `llm-translation.ts`（`stripReasoning`+timeout）/ `content-script.ts`（storage.onChanged）/ `manifest.json` |
| M1-38 | **翻譯失敗診斷可見性（F-11）**：診斷「本地 LLM 端點配置後字幕仍不生效」——先排除 mixed-content（omlx 日誌證明請求已達，Chrome 對 localhost HTTP 有豁免）；確認根因為 **模型名不符**（omlx 404 Model not found，可用模型為 Gemma-4-31B-JANG_4M-CRACK / Qwen3.6-27B-MLX-6bit / Qwen3.6-35B-A3B-4bit 等）。交付：(1) `src/infrastructure/diagnostics.ts`——`extractDiagnostic`、`recordDiagnostic`（寫 `lastDiagnostic` + `console.warn`，§5.7 try/catch）、`readLastDiagnostic`/`formatDiagnostic`；(2) content-script `onEvent` 非 segments 分支 `void recordDiagnostic(e)`；(3) popup「最近失敗」行**常駐顯示**（無記錄顯示「無」，不再整行隱藏）+ 本地模式顯示實際生效模型名；(4) **Popup「測試連接」按鈕**（`src/runtime/popup/connection-test.ts`）——直接向配置端點發最小 `/chat/completions`，驗證端點可達/模型存在/響應有效，終結「配置 vs 實際請求」猜測；`normalizeEndpoint` 抽為獨立 `src/runtime/endpoint.ts`（composition 與 connection-test 共用，避免 popup bundle 依賴整個組裝鏈）；(5) **「全鏈不適用」不再靜默**（§5.6 對齊）——`NativeCaptionStrategy.isApplicable` 抓軌失敗/為空時把原因寫入 `ctx.diagnostics`；`CaptionStrategyChain` 全鏈無策略接管時統一發 `pipeline-error`（code `no-caption-strategy`，cause 含各策略軟失敗原因），content-script 記錄後 popup 顯示真實原因（「字幕軌抓不到」與「翻譯失敗」得以區分）。**重要澄清**：omlx 日誌中的 `qwen-mlx` 404 記錄系 **E2E 測試污染**（TC-R8 曾寫入 `model:'qwen-mlx', endpoint:'http://127.0.0.1:8000/v1'`，persistent context 真實發起請求）；已改為不可達假端口 `127.0.0.1:59999` 杜絕測試碰真實服務。測試 +12：集成 +5（connection-test）、集成 +1（popup 測試連接）、單元 +6（chain 全鏈診斷 2 + native 軌抓取診斷 4）→ 100 全綠 | P0 | 4 | ✅ 已完成 | `src/infrastructure/diagnostics.ts` / `content-script.ts` / `popup.ts` + `popup.html` / `src/runtime/popup/connection-test.ts` / `src/runtime/endpoint.ts` / `src/application/caption-strategy-chain.ts` / `src/application/strategies/native-caption-strategy.ts` / `src/domain/ports/caption-strategy.ts` |
| M1-39 | **「關鍵流程節點不允許靜默失敗」紅線收口（§5.6 全面強化）**：用戶明確要求「字幕不現」時必須可被定位而非靠猜測。本輪把 §5.6 從單條「不用可選鏈掩蓋缺失」擴展為完整紅線（六類必留痕場景 + 判斷標準：popup「最近失敗」/Options 必須能告訴用戶原因），並補齊代碼：**(1) 軌列表/解析失敗三態可區分**——`FetchCaptionSource.fetchTrackList` 空結果記錄 `lastTrackDiagnostic`（「player response JSON not found」/「parse failed」/「no captionTracks」），經 `getLastTrackDiagnostic()` 暴露，`NativeCaptionStrategy` 空軌時把平台診斷帶入 `ctx.diagnostics`（區分「找無數據」vs「無字幕」）；**(2) Options 保存失敗可見**——`save()` 包 try/catch，失敗顯示「保存失敗: …」而非無聲消失；**(3) M2/M3 佔位策略 `isApplicable` 寫入 `not implemented (M2/M3)` 診斷**，全鏈失敗原因不再空白；**(4) 策略 run 失敗診斷（真實 YouTube 反饋驅動）**——popup 曾顯示 `lookahead-asr: not implemented (M3) | realtime-asr: not implemented (M2)`（native 原因缺席）：`CaptionStrategyChain` 的 catch 分支原只把 run 失敗 cause 壓入 errors 數組、**未進 diagnostics**，導致全鏈失敗時 `pipeline-error` 只剩後續佔位策略原因、真實根因被吞；已修復為 `diagnostics.push('<origin>: run failed — <詳情>')`。測試 +8：集成 +4（platform-adapter 三態診斷）、單元 +4（placeholder-strategies M2/M3 診斷 3 + chain run 失敗診斷 1）→ **108 全綠** | P0 | 4 | ✅ 已完成 | `platform-adapter.ts` / `native-caption-strategy.ts` / `options.ts` / `realtime-asr-strategy.ts` / `lookahead-asr-strategy.ts` / `caption-strategy-chain.ts` / `AGENTS.md` §5.6 |

### 3.2 M2 — 實時擷取 ASR（P1，待完成）

| # | 技術點 | 優先級 | 開發順序 | 狀態 | 落點 |
|---|---|---|---|---|---|
| M2-01 | **ASR 管線 ASRPipeline**：分段 → ASR → seq 有序重排 | P1 | 1 | ✅ 已完成 | `src/application/asr-pipeline.ts` |
| M2-02 | **RealtimeASRStrategy 佔位**（isApplicable 恆 false） | P1 | 1 | ✅ 已完成（佔位） | `src/application/strategies/realtime-asr-strategy.ts` |
| M2-03 | **NoopASR 空實現**（enableAsr=false 時端口可空） | P1 | 1 | ✅ 已完成 | `src/application/orchestrator.ts` |
| M2-04 | **tabCapture 音頻源 TabCaptureAudioSource**（Offscreen 解碼） | P1 | 2 | ⬜ 待完成 | `src/adapters/audio/tab-capture-source.ts` |
| M2-05 | **本地 Whisper ASR（WASM/WebGPU，Offscreen 推理）** | P1 | 2 | ⬜ 待完成 | `src/adapters/asr/local-whisper.ts` |
| M2-06 | **雲端 ASR 適配器 CloudASR**（SW 代理請求） | P1 | 2 | ⬜ 待完成 | `src/adapters/asr/cloud-asr.ts` |
| M2-07 | **VAD 語音活動檢測（靜音切分）** | P1 | 2 | ⬜ 待完成 | `src/infrastructure/vad.ts` |
| M2-08 | **RealtimeASRStrategy 實裝**：tabCapture → ASR → 翻譯 → 推送 | P1 | 2 | ⬜ 待完成 | `src/application/strategies/realtime-asr-strategy.ts` |
| M2-09 | **Offscreen Document 入口**（SW 無法處理音頻/長計算） | P1 | 2 | ⬜ 待完成 | `src/runtime/offscreen.ts` + manifest |
| M2-10 | **ASR 流式接口**（transcribeStream + provisional 部分結果） | P1 | 2 | ⬜ 待完成 | `src/domain/ports/asr-provider.ts`（接口已定，待實裝） |
| M2-11 | **provisional 字幕修正**（segments-updated 事件 + revision） | P1 | 2 | ⬜ 待完成 | 管線 + `overlay-renderer.updateProvisional`（已備接口） |
| M2-12 | **性能觀測 perf/metrics**（RTF、每階段計時、P50/P95） | P1 | 3 | ⬜ 待完成 | `src/infrastructure/perf/metrics.ts` |
| M2-13 | **模型檔位權衡**（tiny/base/small ↔ 延遲） | P1 | 3 | ⬜ 待完成 | 配置 + `PROFILE_DEFAULTS`（已定檔位） |
| M2-14 | **tabCapture 用戶授權流程** | P0 | 2 | ⬜ 待完成 | Popup + Content Script |
| M2-15 | **實時性驗證**（三級 P95 延遲 ≤ 5s，離線基準 + 端到端） | P1 | 4 | ⬜ 待完成 | 測試 + 觀測 |

### 3.3 M3 — 預緩衝提前處理（P2，待完成）

| # | 技術點 | 優先級 | 開發順序 | 狀態 | 落點 |
|---|---|---|---|---|---|
| M3-01 | **BufferedAudioSource 音頻源**（MSE 分片預取 + 解碼拼接） | P2 | 2 | ⬜ 待完成 | `src/adapters/audio/buffered-source.ts` |
| M3-02 | **LookAheadASRStrategy 佔位**（isApplicable 恆 false） | P2 | 1 | ✅ 已完成（佔位） | `src/application/strategies/lookahead-asr-strategy.ts` |
| M3-03 | **LookAheadASRStrategy 實裝**：預取音頻 → 提前 ASR → 翻譯 → 推送 | P2 | 2 | ⬜ 待完成 | `src/application/strategies/lookahead-asr-strategy.ts` |
| M3-04 | **失效自動降級 M2**（預取失敗 → 降級三級實時） | P2 | 2 | ⬜ 待完成 | 策略鏈（機制已就緒） |
| M3-05 | **二級可行性驗證（Spike）**：音頻分片預取穩定性技術預研 | P2 | 0 | ⬜ 待完成 | 預研文檔/原型 |
| M3-06 | **使用條款合規確認**（音頻預取合規邊界） | P2 | 0 | ⬜ 待完成 | 合規審查 |

### 3.4 跨里程碑優化（M4 及橫切）

| # | 技術點 | 優先級 | 開發順序 | 狀態 | 落點 |
|---|---|---|---|---|---|
| X-01 | **延遲遮蔽**：一級全量預翻譯 / 二級 look-ahead / 三級 provisional 首屏 | P1 | 與里程碑並行 | ⬜ 待完成 | 各策略 |
| X-02 | **計算優化**：WebGPU 加速 / int8-fp16 量化 / warmup 預熱常駐 | P2 | M2 後 | ⬜ 待完成 | ASR 適配器 |
| X-03 | **翻譯優化**：LLM 流式輸出 / 短段合批 / 低延遲優先 MT | P2 | M2 後 | ⬜ 待完成 | LLM 適配器 + 管線 |
| X-04 | **管線並行**：跨段並發 / seq 重排 / 背壓與丟段策略 | P2 | M2 後 | ⬜ 待完成 | ASRPipeline |
| X-05 | **傳輸優化**：PCM 留 Offscreen / Transferable / SharedArrayBuffer | P2 | M2 後 | ⬜ 待完成 | 音頻鏈路 |
| X-06 | **渲染優化**：單節點增量更新 / rAF 對齊 / provisional 原地替換 | P2 | M1 後 | ⬜ 待完成 | OverlayRenderer（部分已備） |
| X-07 | **動態引擎選擇**：依 metrics 實測 RTF 自動切檔 | P2 | M2 後 | ⬜ 待完成 | 配置 + 管線 |
| X-08 | **字幕樣式設置 F-09**（字號/顏色/位置/背景） | P2 | M4 | ⬜ 待完成 | Options + Renderer |
| X-09 | **多語言優化** | P2 | M4 | ⬜ 待完成 | 全鏈路 |

---

## 4. 已完成工作摘要

- **全部端口接口**與**內部穩定數據結構**已定義（M1-01/02/03）。
- **一級全鏈路**：YouTube 適配器 → timedtext 解析 → 原生字幕策略 → 翻譯管線（LLM 主 + MT 兜底）→ 覆蓋層渲染 → Orchestrator 調度，已打通並通過測試（M1-05~M1-19）。
- **配置界面與實注入**（M1-24/25）：Options/Popup 引擎/語言/樣式配置；`ApiKeyStore` 獨立安全 key 存密鑰（不明文入 EngineConfig）；`buildDefaultRegistry` 改 async，依配置選主/兜底引擎並解析 apiKey 注入。
- **播放驅動渲染**（M1-26）：`SubtitleController` 用 MutationObserver 等待播放器就緒自動掛載、observePlayback + rAF 對齊重繪、配置變更熱重啟（僅訂閱一次避免累積）。
- **打包與測試構建基建**（M1-28/29）：引入 esbuild 4 入口打包（content-script/options/popup IIFE、SW ESM）；`TEST_PROFILE=1` 向 dist manifest 注入 localhost match 供 E2E。
- **E2E 擴充驗證閉環**（M1-30/31）：以 `launchPersistentContext` 自定義 fixture 加載擴充；修復 content-script 直接調用 `window.fetch` 的 "Illegal invocation"（構造時 bind）。全鏈路在 Mock 站點驗證：注入 → 抓字幕 → 翻譯 → 覆蓋層顯示。
- **CI 自動化**（M1-23）：`.github/workflows/system-test.yml` 串聯 build→test→e2e→report→cleanup。
- **測試基礎設施已搭**：107 個測試全綠（39 單元 + 5 契約 + 50 集成 + 13 E2E），`npm run test:all` 一次通過，含構建→測試→報告合併→環境清理（M1-20~22）。
- **可靠性紅線加固**（M1-32）：全庫審計並修復 restart 訂閱/Observer 洩漏、fetch 未綁定、JSON parse 未容錯、stream 無 fallback 等 MV3 真實環境陷阱；每項配專屬回歸測試（單元/集成/E2E）。AGENTS.md §5 沉澱 8 條紅線，governance skill 加自查清單。
- **CI 環境相容性修復**（M1-34）：首次遠端 CI 集成階段崩潰於 `jsdom@30`→`undici@8` 在 Node 20 的 `webidl.util.markAsUncloneable` 缺失；降級 `jsdom@^26`（無 undici 依賴）根治。教訓：依賴版本須與 CI 目標 Node 版本相容，`EBADENGINE` 警告不可忽視。
- **test:ci 分段執行加固**（M1-35）：`run-ci-tests.mjs` 分段執行 unit/integration/contract，單段失敗不再 `&&` 短路，各自產出 junit、末尾統一判定退出碼；三個 vitest config 明文 `passWithNoTests:false`、merge-reports 對 `tests=0` warn。診斷盲區「收集期崩潰被靜默為 0 tests」已根治。
- **本地 LLM 服務兼容**（M1-37）：修復配置本地 omlx/mlx（OpenAI 兼容）服務後字幕不生效的四阻斷點——端點規範化（`normalizeEndpoint` 兼容 Base URL 與完整路徑，杜絕 404）、本地 host 權限（`http://127.0.0.1/*`、`http://localhost/*`）、reasoning `<think>` 剝離（`stripReasoning`）、LLM 超時降級（30s AbortController → MT 兜底）、跨上下文配置熱重啟（`storage.onChanged` 取代僅本進程有效的 `store.subscribe`）。教訓：擴充內存訂閱不跨上下文；用戶填端點格式多樣須規範化；本地 reasoning 模型延遲與 `<think>` 污染需防禦。
- **翻譯失敗診斷可見性**（M1-38）：交付 `diagnostics.ts` 診斷模塊 + popup「最近失敗」行**常駐顯示** + **「測試連接」按鈕** + **「全鏈不適用」不再靜默**（`NativeCaptionStrategy` 軟失敗寫入 `ctx.diagnostics`，`CaptionStrategyChain` 全鏈無接管時發 `pipeline-error`）——現在「字幕軌抓不到」與「翻譯失敗」可以明確區分並顯示給用戶。**澄清**：omlx 的 `qwen-mlx` 404 日誌實為 E2E 測試污染（TC-R8 曾指真實 8000 端口），已改為不可達假端口。教訓：管線靜默降級掩蓋根因；**策略級軟失敗（isApplicable 內部 catch）也必須可見**；E2E 的持久化配置不得指向真實本地服務。
- **「不允許靜默失敗」紅線收口**（M1-39）：§5.6 擴展為完整紅線（六類必留痕場景），補齊：軌列表三態診斷（找無 JSON/解析失敗/無字幕軌，經 `getLastTrackDiagnostic()` 區分）、Options 保存失敗顯示錯誤狀態、M2/M3 佔位策略 `isApplicable` 寫入 not-implemented 診斷、**策略 run 失敗診斷**（`CaptionStrategyChain` catch 分支把 `<origin>: run failed — <詳情>` 寫入 diagnostics——修復真實 YouTube 上 popup 只剩 M2/M3 佔位原因、native 真實根因被吞的問題）。判斷標準落地：popup「最近失敗」必須能告訴用戶「字幕為什麼不出現」。
- **已修復測試/真實環境暴露的缺陷**：翻譯管線降級事件被吞、mock 站點 `/watch` 路由 404、manifest SW/CS 路徑錯誤、mock 播放器容器 `textContent` 覆寫刪除覆蓋層、content-script fetch 未綁定。

## 5. 進行中與下一步

- **M1 里程碑已完成**：原生字幕全鏈路 + 配置界面 + E2E 擴充驗證閉環 + 翻譯失敗診斷可見性全部交付並測試覆蓋。
- **M1 尾項（P1，非阻塞）**：M1-27 真實 YouTube 頁面手動冒煙驗證。用戶已回報「連接測試通過（端點+模型正確）但字幕不現、omlx 無請求」——新診斷鏈可區分「字幕軌抓不到」（含三態：找無 ytInitialPlayerResponse / JSON 解析失敗 / 確實無字幕軌）與「翻譯失敗」，下一步：重新加載擴充，刷新 YouTube 頁面，從 popup「最近失敗」讀取真實原因（若為 no-caption-strategy 則查看 cause 中 platform 三態診斷，定位 ytInitialPlayerResponse 抓取或真實字幕接口）。
- **下一步優先（M2）**：
  1. M2-04 tabCapture 音頻源 + M2-09 Offscreen Document 入口。
  2. M2-05/06 本地 Whisper / 雲端 ASR 適配器。
  3. M2-08 RealtimeASRStrategy 實裝（tabCapture → ASR → 翻譯 → 推送）。

## 6. 主要風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| YouTube 接口/頁面改版 | 字幕抓取失效 | 適配層隔離（M1-06）；降級策略 |
| 二級預緩衝脆弱（M3） | 音頻分片預取不穩定 | 標記高風險；Spike 預研；失效自動降級 M2 |
| 本地 Whisper 性能 | 低端設備卡頓 | 模型檔位權衡；WebGPU；雲端 ASR 備選 |
| MV3 SW 回收 | 長任務中斷 | 重任務放 Offscreen（M2-09） |
| 實時 ASR 固有延遲 | 三級字幕滯後 | provisional 遮蔽 + 管線化 + 丟段策略 |

---

## 附錄：驗證命令

```bash
npm run typecheck     # 類型檢查
npm run lint          # ESLint
npm run test:all      # 完整閉環：build → 測試 → 報告 → 清理
npm run test:e2e      # 僅 E2E（需先 npm run build 產出 dist/）
```
