# AI_Trans 項目進展文檔

> 版本：v0.1
> 狀態：M1 開發中（測試基礎設施進行中）
> 最後更新：2026-08-04

---

## 1. 里程碑總覽

項目按**風險遞進**順序分三個開發階段（來自需求設計 §8 / 架構設計 §12）。

| 里程碑 | 名稱 | 對應功能 | 目標 | 狀態 |
|---|---|---|---|---|
| **M1** | 原生字幕翻譯 | F-01, F-02, F-03, F-04, F-05 | 一級策略：抓 YouTube 原生字幕 → 翻譯 → 覆蓋層 + 配置界面 | 🟡 **進行中** |
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
| M1-20 | **測試基礎設施**：Vitest 三層配置 / stub 引擎 / mock 平台 / timedtext 契約樣本 / Mock YouTube 站點 / Playwright E2E | P0 | 3 | 🟡 進行中 | `test/` + `vitest.*.config.ts` + `playwright.config.ts` |
| M1-21 | **腳本閉環**：build / serve-mock / merge-reports / cleanup | P0 | 3 | 🟡 進行中 | `scripts/*.mjs` |
| M1-22 | **測試用例**：16 單元 + 5 契約 + 5 集成 + 5 E2E = 31 全綠 | P0 | 3 | 🟡 進行中 | `test/**` |
| M1-23 | **CI 自動化（GitHub Actions）**：構建→部署→測試→報告→清理 | P1 | 4 | ⬜ 待完成 | `.github/workflows/` |
| M1-24 | **Options/Popup 配置界面**：引擎選擇、API Key/端點、語言、樣式 | P0 | 4 | ⬜ 待完成 | `src/runtime/options/` + `src/runtime/popup/` |
| M1-25 | **配置 → 適配器實際注入**（LLM 密鑰從 apiKeyRef 安全解析、真實調用） | P0 | 4 | ⬜ 待完成 | `src/runtime/composition.ts` |
| M1-26 | **播放器就緒後自動掛載 + 播放狀態驅動渲染**（現僅初始化時渲染一次） | P1 | 4 | ⬜ 待完成 | `src/runtime/content-script.ts` |
| M1-27 | **真實 YouTube 頁面驗證**（手動冒煙 + 自動字幕接口容錯） | P1 | 4 | ⬜ 待完成 | E2E + 手動 |

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
- **測試基礎設施已搭**：31 個測試全綠（16 單元 + 5 契約 + 5 集成 + 5 E2E），`npm run test:all` 一次通過，含構建→測試→報告合併→環境清理（M1-20~22）。視為**進行中**——用例集與 CI 閉環將持續擴展。
- **已修復 2 個測試暴露的真 bug**：翻譯管線降級事件被吞、mock 站點 `/watch` 路由 404。

## 5. 進行中與下一步

- **進行中**：M1 里程碑（測試基礎設施使用中，進入 M1 剩餘交付項）。
- **下一步優先**：
  1. M1-23 CI 自動化（GitHub Actions workflow）。
  2. M1-24 Options/Popup 配置界面（配置 → 適配器實注入的前提）。
  3. M1-25/26 配置實際注入與播放狀態驅動渲染。

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
