# AI_Trans 系統測試設計文檔

> 版本：v0.1（草案）
> 狀態：系統測試設計 — 全閉環自動化測試、測試用例
> 關聯文檔：`doc/requirements-design.md`、`doc/architecture-design.md`
> 最後更新：2026-08-10（**M2-18 治理回填**：新增 TC-M2-09 ASR warmup 模塊解析 + 字幕攔截器 DOM 解析（M2-17/M2-18，esbuild 打包 `@huggingface/transformers` 進 IIFE + `getCaptionTracksFromPlayerResponse()` DOM 首要來源兜底 `getOption` 空陣列））；先前：回填治理缺口 TC-F26 LLM 直接 fetch 架構（F-04/M1-48）、TC-F27 interceptor arraybuffer 支援 + 渲染日誌降壓（F-01/F-11/M1-50）、TC-F09 字幕樣式已實裝（F-09/M1-49）、TC-F24 調試日誌門控（F-12/M1-51）、TC-F25 字幕翻譯分塊/快取/重試（F-13/M1-52/M1-53）；先前：TC-F11~F23；測試合計 unit 93 + integration 124 + contract 11 = 228

---

## 1. 測試目標與原則

### 1.1 目標

實現**無人力介入的全閉環系統測試**：一條命令（或一次 CI 觸發）即自動完成

```
構建 → 部署（測試環境）→ 執行測試 → 生成報告 → 環境恢復
```

全程無需人工操作，結果可重複、可追溯。

### 1.2 原則

| 原則 | 說明 |
|---|---|
| 確定性 | 測試不依賴真實 YouTube / 真實雲端 API，結果穩定可復現。 |
| 隔離性 | 外部易變依賴全部以 Mock/Stub 替換，經**可插拔註冊表**注入。 |
| 自恢復 | 每次運行後自動清理進程、Profile、臨時文件，工作區回到乾淨狀態。 |
| 可追溯 | 每個測試用例綁定需求編號（F-01~F-09 / 非功能項），需求可追蹤閉環。 |
| 分層 | 遵循測試金字塔，底層多、頂層少，快速反饋與全鏈路驗證兼顧。 |

### 1.3 與架構的呼應

架構文檔的**端口與適配器 + 可插拔註冊表**是本測試方案能閉環的根本：測試環境只需向 `Registry` 注入 stub 適配器（假 YouTube、假 ASR、假翻譯），核心管線邏輯即可在無外部依賴下被完整驗證。

---

## 2. 測試架構總覽

### 2.1 分層測試金字塔

```
            ┌──────────────────────┐
            │   E2E（Playwright）    │  少量：加載擴充，全鏈路
            │  Mock 站點 + Stub 引擎 │
            ├──────────────────────┤
            │   契約測試 Contract    │  外部易變接口的契約鎖定
            │  （字幕解析/引擎調用）  │
            ├──────────────────────┤
            │   集成測試 Integration │  適配器×註冊表組裝、策略鏈降級
            ├──────────────────────┤
            │   單元測試 Unit        │  大量：domain 模型/管線純邏輯
            └──────────────────────┘
```

| 層級 | 測試對象 | 運行時 | Mock 邊界 |
|---|---|---|---|
| 單元 | `domain/models`、`application/pipelines` 純邏輯 | Node（Vitest） | 全部依賴以接口 mock |
| 集成 | 適配器 + `Registry` 組裝、`CaptionStrategyChain` 降級 | Node + jsdom | 外部 I/O 用 stub |
| 契約 | YouTube 字幕解析、引擎請求/響應契約 | Node（Vitest） | 固定契約 fixture |
| E2E | 擴充完整鏈路（加載→字幕→渲染→降級） | Chromium（Playwright） | Mock 站點 + stub 引擎 |

### 2.2 閉環的關鍵機制：註冊表注入

測試通過環境變量/構建標誌切換到「測試組裝」，在 `runtime` 組裝點注入 stub：

```typescript
// test/harness/test-registry.ts（示意）
export function buildTestRegistry(overrides?: Partial<Registry>): Registry {
  return {
    platforms: [new MockYouTubeAdapter()],      // 假 YouTube 頁面適配
    strategies: [                                // 真實策略鏈（被測對象）
      new NativeCaptionStrategy(),
      new LookAheadASRStrategy(),
      new RealtimeASRStrategy(),
    ],
    asr: new Map([['stub-asr', new StubASR()]]), // 假 ASR，確定性輸出
    translation: new Map([['stub-llm', new StubLLM()],
                          ['stub-mt', new StubMT()]]),
    renderer: new OverlayRenderer(),             // 真實渲染器
    ...overrides,
  };
}
```

> 被測的是**真實的策略鏈、管線、渲染、降級邏輯**；只有「外部世界」被替換。這保證測試既閉環又有效。

---

## 3. 測試環境與依賴管理

### 3.1 Mock YouTube 站點

- 位置：`test/fixtures/mock-youtube/`
- 形態：本地靜態站點 + HTML5 `<video>` 播放器，模擬 YouTube DOM 結構與播放器容器。
- 提供多種頁面變體，覆蓋不同場景：
  - `index.html`：基礎播放器（`/watch` 回退），含 `#mock-player` 容器與 `<video class="html5-main-video">` 供 observePlayback；視頻占位文本置於獨立 `#mock-caption` 子節點，避免覆寫覆蓋層。
  - `with-native-captions.html`：帶原生字幕軌（內嵌 `ytInitialPlayerResponse` JSON，`baseUrl` 指向 `/timedtext`）
  - `no-captions.html`：無字幕（觸發 ASR 路徑，M2）
  - `changed-dom.html`：模擬 YouTube 改版（驗證適配器隔離與降級，M2/M3）
- `app.js` 每 100ms 推進時鐘並同步 `video.currentTime` + `dispatchEvent('timeupdate')`（模擬真實媒體事件驅動 observePlayback）。
- 由 `scripts/serve-mock.mjs` 在固定端口 8721 提供（含 `/timedtext` JSON 端點），E2E 經 Playwright `webServer` 自動拉起。

### 3.2 Stub 引擎（確定性）

| Stub | 行為 |
|---|---|
| `StubASR` | 依輸入音頻 fixture 的 `seq` 返回預定文本與時間軸；可配置延遲、`isPartial`、失敗。 |
| `StubLLM` | 依輸入原文返回可預測譯文（如 `"[zh]"+原文`）；可模擬超時/超額。 |
| `StubMT` | 兜底譯文（如 `"[mt]"+原文`），用於驗證 LLM→MT 降級。 |
| `MockYouTubeAdapter` | 提供假 `PlaybackState`、`CaptionTrack`、`AudioSourceHandle`。 |

### 3.3 測試數據

- 位置：`test/fixtures/data/`
- 內容：字幕樣本（含時間軸）、音頻 fixture（PCM/波形描述 + 期望識別文本）、期望譯文對照表、時間軸校驗基準。
- 原則：所有斷言基於**固定 fixture**，不依賴模型隨機性。

### 3.4 測試依賴與 CI Node 版本相容性（硬約束）

集成測試在 **jsdom** 環境運行，其依賴鏈必須與 CI 目標 Node 版本相容，否則會在 **import/收集階段整體崩潰**（junit `tests="0"`、退出碼 1），而非單個用例失敗——這類問題在本地新版 Node 上不暴露，只在 CI 才復現。

| 依賴 | 約束 | 原因 |
|---|---|---|
| `jsdom` | 鎖定 `^26.x` | 26.x 已移除對 `undici` 的依賴，engines `node>=18`；**禁止升到 30.x**（其依賴 `undici@8` 在 import 期調用 `webidl.util.markAsUncloneable`，Node 20.x 未提供該 API → `TypeError` 致集成收集期崩潰）。 |
| CI Node | `system-test.yml` 固定 `node-version: 20`，與 AGENTS.md「node>=20」一致 | 換 Node 大版本須同步核對 jsdom/undici 相容矩陣並重跑 `test:all`。 |

**紅線**：任何依賴變更（尤其 `jsdom`）後，必須本地 `npm install` 更新 lockfile 並跑 `test:ci` 確認**集成用例數不為 0**；`npm warn EBADENGINE` 不可忽視。`test:ci` 現由 `scripts/run-ci-tests.mjs` 分段執行（unit → integration → contract），單段失敗不短路後續段、各自產出 junit、末尾統一判定退出碼；三個 vitest config 明文 `passWithNoTests: false`（收集 0 用例即失敗）。`merge-reports.mjs` 對 `tests=0` 的 suite 顯式 warn——若再遇到應以完整 CI 日誌（非僅 junit）確認真實錯誤。

---

## 4. 分層測試設計

### 4.1 單元測試（Vitest）

| 用例組 | 覆蓋內容 |
|---|---|
| U-MODEL | `SubtitleSegment`/`AudioChunk` 等結構的構造、`revision` 遞增、去重與更新 |
| U-ASRPIPE | `ASRPipeline` 亂序 `seq` 重排、partial→final 合併、丟段策略 |
| U-TRANSPIPE | `TranslationPipeline` 批量、上下文攜帶、LLM 失敗→MT 兜底、`degraded` 標記 |
| U-STRATEGY | 各 `CaptionStrategy.isApplicable` 判定邏輯 |
| U-RENDER | 依 `currentTime` 選段、provisional 原地更新、單/雙語切換 |
| U-CONFIG | `ConfigStore` 讀寫、`subscribe` 變更通知、默認值與檔位 |

### 4.2 集成測試（Vitest + jsdom）

| 用例組 | 覆蓋內容 |
|---|---|
| I-CHAIN | `CaptionStrategyChain` 逐級降級：native→lookahead→realtime |
| I-REGISTRY | `Registry` 依 `EngineConfig` 選中正確 Provider |
| I-ENGINE-FALLBACK | ASR/翻譯引擎失敗時的兜底切換路徑 |
| I-EVENTS | `PipelineEvent`（segments-ready/updated/degraded/metrics）正確發射 |

### 4.3 契約測試（鎖定外部易變接口）

> 針對架構文檔識別的**變化風險點**，用契約 fixture 固化「外部格式 → 內部結構」的轉換，改版時契約測試先紅，快速定位適配器。

| 用例組 | 契約對象 |
|---|---|
| C-YT-CAPTION | YouTube 字幕（timedtext XML/JSON）→ `SubtitleSegment[]` 解析契約 |
| C-YT-PLAYBACK | YouTube 播放器狀態讀取 → `PlaybackState` 契約 |
| C-ASR-API | 雲端 ASR 請求/響應 → `ASRResult` 契約 |
| C-LLM-API | 雲端 LLM 請求/響應 → `TranslationResult` 契約 |

### 4.4 E2E 測試（Playwright + 加載擴充）

- 以構建產物（`dist/`，`build:test` 產出）加載擴充，配合 Mock 站點驗證全鏈路。
- **擴充加載範式（實裝關鍵）**：Playwright 默認的 `chromium.launch()` + `newContext()` **不會注入擴充**，且默認注入 `--disable-extensions`。必須：
  1. 用 `chromium.launchPersistentContext('', {...})`（持久上下文才注入擴充）；
  2. `ignoreDefaultArgs: ['--disable-extensions']`（移除禁用擴充的默認參數）；
  3. `channel: 'chromium'`（headless 下默認走 headless_shell，不支持 `--load-extension`）；
  4. `--load-extension` / `--disable-extensions-except` 傳**絕對路徑**。
  以上封裝於 `test/e2e/fixtures.ts` 的自定義 `test` fixture（覆蓋 `context`），供各 spec 復用。
- `TEST_PROFILE=1` 構建向 dist manifest 追加 `http://localhost:8721/*` 的 content_scripts match 與 host_permissions，使 content-script 得以注入 Mock 頁。
- 用臨時 Chromium user-data-dir（測試後清理），持久化狀態隔離。

| 用例組 | 覆蓋場景 |
|---|---|
| E-NATIVE | 打開帶字幕頁面 → 覆蓋層出現譯文字幕 → 隨播放同步（TC-F01/02/03） |
| E-INJECT | content-script 注入 Mock 頁 → 覆蓋層掛載於播放器容器 → 暫停後仍掛載 |
| E-REALTIME | 打開無字幕頁面 → provisional 字幕先顯示 → 定稿修正（M2） |
| E-DEGRADE | 模擬預取失效 → 降級三級，字幕不中斷（M2/M3） |
| E-CONFIG | Options 切換引擎/目標語言/顯示模式 → 生效 |
| E-PRIVACY | 本地模式運行 → 斷言無外發網絡請求 |

---

## 5. 全閉環 CI 流水線（GitHub Actions）

### 5.1 階段劃分

```
build → unit → integration → contract → e2e → report → cleanup
```

- 任一階段失敗即中斷（fail-fast），並仍執行 `cleanup`（`if: always()`）。
- `e2e` 前置：啟動 Mock 站點服務、安裝 Chromium。

### 5.2 Workflow 草圖

```yaml
name: system-test
on: [push, pull_request]

jobs:
  system-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 20, cache: npm }

      - name: Install deps
        run: npm ci

      # 1) 構建擴充（測試組裝，注入 stub）
      - name: Build extension (test profile)
        run: npm run build:test        # 產出 dist/ 供 --load-extension

      # 2) 單元 + 集成 + 契約
      - name: Unit / Integration / Contract
        run: npm run test:ci           # Vitest，輸出 JUnit XML

      # 3) 啟動本地 Mock 站點（後台）
      - name: Start mock site
        run: npm run mock:serve &       # 固定端口

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      # 4) E2E（加載擴充 + Mock 站點 + stub 引擎）
      - name: E2E
        run: npm run test:e2e           # 輸出 JUnit XML + HTML + trace

      # 5) 匯總報告
      - name: Generate report
        if: always()
        run: npm run report:merge       # 合併各層 JUnit → 統一 HTML

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: test-report
          path: reports/

      # 6) 環境恢復（見 5.3）
      - name: Cleanup
        if: always()
        run: npm run test:cleanup
```

### 5.3 環境恢復（cleanup）

`cleanup` 必須在**任何情況下**執行（`if: always()`），恢復三層：

| 層 | 恢復動作 |
|---|---|
| 進程 | 關閉 Mock 站點服務、殘留 chromium 進程 |
| 文件 | 刪除臨時 Chromium user-data-dir、Playwright trace 中間物、構建臨時文件 |
| 工作區 | 校驗 `git status` 乾淨；本地運行時可選 `git clean -fdx`（測試產物目錄除外） |

> 本地一鍵入口：`npm run test:all`（build→test→e2e→report→cleanup 串聯），與 CI 行為一致，保證「本地可跑 = CI 可跑」。

---

## 6. 測試報告與門禁

### 6.1 報告格式

- **JUnit XML**：各層測試機器可讀輸出，供 CI 聚合與趨勢分析。
- **HTML 看板**：合併後的可讀報告（`reports/index.html`），含用例明細、通過率、耗時、E2E 截圖/trace 鏈接。
- **覆蓋率**：單元/集成覆蓋率報告（lcov + HTML）。
- **性能指標**：E2E 採集的字幕延遲 P50/P95、RTF、丟段率，輸出到報告。

### 6.2 門禁規則

| 門禁 | 閾值 |
|---|---|
| 用例通過率 | 100%（任一失敗即紅） |
| 單元+集成覆蓋率 | ≥ 目標線（如 80%，可按里程碑調整） |
| E2E 三級延遲 | P95 ≤ 5s（對應非功能需求） |
| 隱私斷言 | 本地模式外發請求數 = 0 |
| 工作區乾淨 | cleanup 後 `git status` 無殘留 |

---

## 7. 系統測試用例

> 每個用例綁定需求編號，實現需求可追蹤。步驟均在閉環環境（Mock 站點 + stub 引擎）執行。

### 7.1 功能測試用例

#### TC-F01 原生字幕翻譯（對應 F-01）
- 前置：打開 `with-native-captions.html`，配置 stub 翻譯引擎，目標語言 zh。
- 步驟：啟用擴充 → 等待字幕軌被抓取 → 觸發翻譯。
- 預期：覆蓋層顯示譯文；譯文與 fixture 對照表一致；`origin=native`。

#### TC-F02 覆蓋層渲染與雙語（對應 F-02）
- 前置：同上；顯示模式設為 bilingual。
- 步驟：播放至含字幕時間點。
- 預期：覆蓋層同時顯示原文與譯文；掛載於播放器容器；全屏切換後仍正確定位。

#### TC-F03 播放狀態同步（對應 F-03）
- 前置：帶字幕頁面。
- 步驟：暫停 / 快進 / 2x 倍速。
- 預期：字幕隨 `currentTime` 正確顯示/隱藏；倍速下時序不錯位；快進後跳到對應段。

#### TC-F04 翻譯引擎配置（對應 F-04）
- 前置：Options 頁面。
- 步驟：切換雲端 LLM ↔ 本地；填寫端點/密鑰（指向 stub）。
- 預期：配置持久化；`Registry` 選中對應 Provider；再次播放走新引擎。

#### TC-F05 目標語言選擇（對應 F-05）
- 步驟：切換目標語言（如 zh→ja）。
- 預期：後續翻譯請求 `targetLang` 更新；覆蓋層譯文語言隨之變化。

#### TC-F10 本地 LLM 服務兼容（對應 F-10）
- 前置：本地 OpenAI 兼容服務（或 stub）；配置 `type: 'local'`。
- 步驟 A（端點規範化）：填 Base URL `http://127.0.0.1:8000/v1` → 實際請求發往 `/v1/chat/completions`；填完整路徑 → 原樣保留；填裸 host → 補 `/v1/chat/completions`；空值 → 回落 OpenAI 默認。
- 步驟 B（reasoning 剝離）：stub 返回 `content` 含 `<think>...</think>` 思考塊 → 解析出的譯文行不含思考文本。
- 步驟 C（超時降級）：stub 響應延遲超過 `timeoutMs`（如 30ms）→ `AbortController` 中止請求、provider 拋錯、pipeline 降級 MT 兜底（`degraded=true`）。
- 預期：A 中請求 URL 正確（無 404）；B 中譯文不被思考塊污染；C 中字幕仍產出（降級），且無殘留定時器。

#### TC-F11 翻譯失敗診斷可見性（對應 F-11，已實裝）
- 前置：LLM 端點不可達或模型名不符（mock 宿主上無網/無 key，fetch 失敗或 404 觸發降級）。
- 步驟 A（持久化）：content-script 收到 `engine-degraded`/`pipeline-error` → 寫入 `chrome.storage.local['lastDiagnostic']`（`{ kind, timestamp, message }`）並 `console.warn('[AI_Trans] translation degraded: …')`；`pipeline-error.cause` 為 `Error` 時保留 `name: message`（模型 404 表現為 `LLM translation failed: HTTP 404`）。
- 步驟 B（Popup 顯示）：**常駐顯示**「最近失敗」行——有記錄顯示原因（警告色）；**無記錄顯示「最近失敗: 無」**（不整行隱藏，避免「看不到行」誤判為 bug）。本地模式翻譯狀態行顯示實際生效模型名（辨識保存未生效/載入舊版插件）。
- 步驟 C（§5.7 守護）：`chrome.storage.set` 拋錯時 `recordDiagnostic` 不崩潰、console 麵包屑仍輸出。
- 預期：E2E 中降級後 `lastDiagnostic` 被寫入（poll 可讀）；popup 有診斷行；策略級 `strategy-degraded` 不記錄（屬正常流轉）。
- 落點：集成 `test/integration/diagnostics.test.ts`（7）+ `test/integration/popup.test.ts`（4：含常駐「無」+ 測試連接按鈕）；單元 `test/unit/caption-strategy-chain.test.ts`（全鏈不適用→pipeline-error）+ `test/unit/native-caption-strategy.test.ts`（軌抓取軟失敗→診斷）；E2E `test/e2e/extension.spec.ts`（TC-F11 降級寫入）。

#### TC-F13 「全鏈不適用」不再靜默（對應 F-11，已實裝）
- 前置：mock 平台 `listCaptionTracks` 返回空或拋錯（模擬真實 YouTube 上字幕軌抓取失敗/無字幕）。
- 步驟：
  - A（軌為空）：`NativeCaptionStrategy.isApplicable` 返回 false，`ctx.diagnostics` 記錄 `native: no caption tracks found — <平台診斷>`（三態，見 TC-F14）。
  - B（軌拋錯）：返回 false，診斷記錄 `native: listCaptionTracks failed — <異常詳情>`（不再吞掉）。
  - C（全鏈不適用）：`CaptionStrategyChain` 全部策略 `isApplicable=false` → 發 `pipeline-error`（code `no-caption-strategy`，cause.message 含各策略診斷，` | ` 連接）。
  - D（無診斷時通用提示）：cause.message 為 `all caption strategies not applicable (no captions found)`。
  - E（策略 run 拋錯後續也不適用）：**run 失敗原因必須進 diagnostics**（`<origin>: run failed — <詳情>`）——回歸：此前 run 失敗的 cause 只進 errors 數組未進 diagnostics，popup 只剩後續佔位策略（M2/M3 not implemented）原因，真實根因被吞。
- 預期：字幕軌失敗不再靜默——診斷鏈路與「翻譯失敗」可區分；content-script `recordDiagnostic` 持久化 → popup「最近失敗」顯示真實原因（含策略 run 失敗的具體異常）。
- 落點：單元 `test/unit/caption-strategy-chain.test.ts`（3）+ `test/unit/native-caption-strategy.test.ts`（4）。

#### TC-F14 軌列表/解析失敗三態診斷（對應 F-11/M1-39，已實裝）
- 前置：mock 頁含/不含 `#ytInitialPlayerResponse` 具名腳本；或腳本內容非法 JSON。
- 步驟：
  - A（找不到數據源）：頁面無 `#ytInitialPlayerResponse` 且內聯掃描無 captionTracks → `fetchTrackList` 返回 `[]`，`getLastTrackDiagnostic()` = `player response JSON not found (ytInitialPlayerResponse missing/empty)`。
  - B（JSON 解析失敗）：腳本內容非法 JSON → 返回 `[]` 不拋錯，診斷 = `player response JSON parse failed: …`。
  - C（確實無字幕軌）：JSON 合法但結構無 `captionTracks` → 診斷 = `player response has no captionTracks …`。
  - D（有軌）：返回軌列表且診斷清空（`undefined`）。
- 預期：空結果三態可區分，不與「無字幕」誤判；`NativeCaptionStrategy` 空軌時把平台診斷帶入 `ctx.diagnostics`（`native: no caption tracks found — <平台診斷>`），全鏈失敗 cause 能解釋「為什麼抓不到」。
- 落點：集成 `test/integration/platform-adapter.test.ts`（+4 三態診斷）；單元 `test/unit/native-caption-strategy.test.ts`（+1 平台診斷帶入）。

#### TC-F15 M2/M3 佔位策略診斷（對應 F-11/M1-39，已實裝）
- 前置：真實佔位策略 `RealtimeASRStrategy`/`LookAheadASRStrategy`。
- 步驟：調用 `isApplicable`，斷言返回 `false` 且 `ctx.diagnostics` 記錄 `realtime-asr: not implemented (M2)` / `lookahead-asr: not implemented (M3)`；`diagnostics` 為 undefined 時不拋錯。
- 預期：佔位策略的「未實現」可與「真失敗」區分，全鏈失敗原因不再空白。
- 落點：單元 `test/unit/placeholder-strategies.test.ts`（3）。

#### TC-F16 timedtext 真實格式兼容（對應 F-01/M1-27，已實裝）
- 前置：真實 YouTube 的 `captionTracks[].baseUrl` 默認返回 **srv3 XML**（`<timedtext format="3"><body><p t d><s>`），非傳統 `<transcript><text>`；且可能返回 HTML 錯誤/登錄頁。
- 步驟：
  - A（強制 JSON）：`fetchTracks` 對 YouTube 域名的 timedtext URL 追加 `fmt=json3`（已有 fmt 參數則覆寫）；非 YouTube 域名（Mock 站點）不動。
  - B（srv3 兜底）：即使返回 srv3 XML，`parseXml` 識別 `<timedtext>` 根內含 `<p>` → `parseSrv3`（`t`/`d` 為毫秒，多 `<s>` 拼接文本）。
  - C（HTML 錯誤頁）：DOMParser 產生 `parsererror` → 拋「parse error (not valid XML…)」而非誤判「missing transcript root」。
  - D（HTML 實體）：`&#39;` `&amp;` 等解碼。
- 預期：真實 YouTube 字幕內容三種形態（json3 / srv3 XML / 傳統 transcript XML）均可解析；錯誤頁不再被誤判為「無字幕根」。
- 落點：契約 `test/contract/timedtext.test.ts`（+3：srv3/錯誤頁/實體）；集成 `test/integration/platform-adapter.test.ts`（+2：TC-F16 追加 fmt 與非 YouTube 不動）。

#### TC-F17 外部接口調用節點診斷證據化（對應 F-11/M1-41，已實裝）
- 前置：以「popup『最近失敗』/Options 必須能告訴用戶原因；開發者能從診斷/事件流定位到具體節點」為判斷標準。
- 步驟：
  - A（LLM 響應結構）：`res.json()` 拋錯（HTTP 200 但 body 非 JSON）→ 錯誤含「response is not valid JSON」；choices 缺失或 content 非字符串 → 拋錯走降級（不再 `?? ''` 靜默回退原文）。
  - B（timedtext 拉取證據化）：fetch 網絡失敗 / HTTP 非 2xx / body 讀取失敗 / parse 失敗四種情況均寫入 `lastTrackDiagnostic`，且信息含 HTTP status、content-type、body 片段（`snippet()`）；HTML 錯誤頁（jsdom 下不產 parsererror、走 missing-root 分支）→ missing-root 診斷附「實際根元素名 + 片段」；`new URL` 構造失敗 → 「URL construct failed」。
  - C（播放器節點）：content-script 播放器 15s 超時 → 發 `pipeline-error`（code `player-not-found`）；`observePlayback` video 缺失 → console.warn 麵包屑。
  - D（頁面級 storage）：popup/options 讀配置或密鑰失敗 → 顯示錯誤狀態（「配置讀取失敗/讀取密鑰失敗」+ 詳情），頁面仍可用；service-worker `config:get/set` 失敗 → `sendResponse({ok:false,error})`（調用方不懸掛）。
  - E（message-bus）：`publish` 無接收方（Receiving end does not exist，常態）靜默；其他錯誤 console.warn 留痕；`dispose()` 移除 listener。
- 預期：任一外部接口調用失敗都留下可查詢的診斷痕跡，用戶/開發者可定位到具體節點。
- 落點：契約 `test/contract/timedtext.test.ts`（+3：非法 JSON 片段/HTML 證據/snippet）；集成 `test/integration/platform-adapter.test.ts`（+6：HTTP 非 2xx/網絡失敗/HTML content-type/非法 JSON/URL 構造 + observePlayback 麵包屑）、`test/integration/popup.test.ts`（+3：配置讀取失敗/密鑰讀取失敗/重新載入反饋）、新增 `test/integration/options.test.ts`（3）；單元 `test/unit/llm-translation.test.ts`（+3：非 JSON/choices 缺失/choices 非字符串）、新增 `test/unit/chrome-message-bus.test.ts`（4）、新增 `test/unit/service-worker.test.ts`（4）。

#### TC-F18 pot token 攔截複用（對應 F-01/M1-42，已實裝）
- 前置：真實 YouTube 對 `/api/timedtext` 引入 `pot` 防護——無 pot 的 baseUrl fetch 一律 HTTP 200 + text/html + 空 body；播放器自身帶 pot 的請求（`&potc=1&pot=…&c=WEB&cver=…`）用 **XMLHttpRequest**（非 fetch）發出；pot 非靜態、綁定請求上下文。jsdom 環境（無法跑真實播放器）下，以 mock XHR / mock postMessage 驗證攔截器與消息橋行為。
- 步驟：
  - A（MAIN world 攔截器 hook）：`open` 匹配 `youtube.com/timedtext` 的 XHR 被打標記；`send` 後 `load` 事件（HTTP 200 + 非空 body）→ `postMessage` 發 `ai-trans:timedtext-capture`；空 body / 非 200 不轉發。hook 用 `apply(this)` 保留實例接收者（§5.1 brand check）；load 監聽器用完自除（§5.4）。
  - B（URL 絕對化）：`open` 收到相對 URL（Mock 站點）時以 `new URL(arg, location.href)` 解析後匹配（§5.2）。
  - C（消息橋注入/生命周期）：`inject()` 冪等（重複調用只注入一次）且以 `chrome.runtime.getURL('src/runtime/yt-timedtext-interceptor.js')` 創建 `<script data-ai-trans>`；`start()` 冪等（先 remove 再 add）註冊 `window.message` 監聽並以 `__aiTrans` 標記過濾外部消息（§5.7）；`getLatest()` 返回最新捕獲；**`stop()` 移除監聽 + 停輪詢但保留 latest（restart 熱重啟用，M1-43）**；`dispose()` 移除監聽 + 清緩存 + resolve 掛起 waiters（§5.4，重複 dispose 安全）。
  - D（捕獲複用/回退/等待窗口）：`FetchCaptionSource` 注入 `CaptionCaptureProvider` 後，`fetchTracks` **優先複用**捕獲響應（不發網絡請求；srv3/json3 自動識別）；無捕獲值 → **`waitForCapture(timeoutMs)` 等待捕獲窗口（默認 15,000ms，M1-43）**，捕獲到達直接解析、超時 → 直接 fetch（原有行為）；捕獲為空/解析失敗 → 記 `lastTrackDiagnostic`（§5.6 留痕）並回退 fetch；無 `waitForCapture` 的舊 provider → 直接 fetch。
- 預期：捕獲響應優先、無捕獲走等待窗口、超時回退不變、失敗留痕；攔截器/消息橋無洩漏（stop/dispose 後監聽器清零、超時 timer 清理）。
- 落點：集成 `test/integration/timedtext-bridge.test.ts`（11：inject/start 冪等 + getLatest + stop 保留 latest + dispose 清理 + 外部消息過濾 + dispose 後不接收 + waitForCapture 三分支：立即/捕獲到達/超時 + 輪詢器 interval）、`test/integration/yt-timedtext-interceptor.test.ts`（7：open/send hook + URL 匹配 + load 轉發 + 空響應不轉發 + **localhost 匹配 + fetch hook：timedtext 透傳+捕獲 / 非 timedtext 不攔截**）、`test/integration/platform-adapter.test.ts`（+8：捕獲複用不發 fetch / 無捕獲回退 fetch / srv3 捕獲 / 空捕獲走 fetch / 捕獲解析失敗回退 + 診斷 / **等待捕獲後複用不發 fetch / 超時回退 fetch / 無 waitForCapture 舊實現直接 fetch**）、`test/support/setup-dom.ts`（+`chrome.runtime.getURL` mock）。

#### TC-F19 捕獲鏈路 E2E（對應 F-01/M1-43，已實裝）
- 前置：E2E 測試構建（`npm run build:test`，`TEST_PROFILE=1`）向 dist manifest 的 `content_scripts`、`host_permissions`、**`web_accessible_resources.matches`** 追加 `http://localhost:8721/*`（M1-43 修復：WAR 未含 localhost 時 Chrome 拒絕載入 MAIN world 攔截器——"Resources must be listed in the web_accessible_resources manifest key"，捕獲鏈路在 E2E 從未真正運行過）。mock 頁 `with-native-captions.html` 的播放器 `app.js` 用 **XMLHttpRequest**（真實瀏覽器環境）請求 `/timedtext?lang=en&v=abc123`；服務端 `serve-mock.mjs` 提供計數端點 `/__mock-caption-request-count` 與 `/reset`。
- 步驟：
  - A：`page.goto('/with-native-captions.html')`；先 `/reset` 清零計數（避免前序測試累計）。
  - B：覆蓋層 `.ai-trans-overlay` attached 且非空（字幕經捕獲響應 → 解析 → 翻譯 → 渲染全鏈路成功）。
  - C：讀 `/__mock-caption-request-count` 斷言 `count === 1`——**恰好 1 次**（僅 mock 播放器 XHR）；若擴充自己 fetch `/timedtext`（未複用捕獲），計數會 ≥ 2。
- 預期：字幕顯示 + 計數 = 1（擴充零 fetch，捕獲複用成立，pot 繞過在真實瀏覽器環境首次被驗證）。
- 落點：`test/e2e/extension.spec.ts`（+1 捕獲鏈路用例）；配套 `scripts/serve-mock.mjs`（計數/重置端點）、`scripts/copy-static.mjs`（TEST_PROFILE WAR 追加）、`test/fixtures/mock-youtube/app.js`（`requestCaptions()` XHR，首次播放即觸發）。

#### TC-F20 LLM body 讀取失敗與非 JSON 區分（對應 F-11/M1-44，已實裝）
- 前置：真實環境中 `LLMTranslationProvider.translate` 的 `res.json()` 在 body 流讀取階段拋 `TypeError: Failed to fetch`（HTTP 200 頭已收到、body 傳輸被中止，常見於本地模型服務推理異常/超時後斷連），原誤報「response is not valid JSON」誤導用戶排查格式。
- 步驟：
  - A（連接中斷）：mock fetch 返回 `{ok:true, status:200}`，`res.json()` 拋 `TypeError('Failed to fetch')` → 錯誤含「response body read failed (connection lost)」，且**不含**「not valid JSON」。
  - B（真解析失敗）：`res.json()` 拋 `SyntaxError('Unexpected token <…')` → 錯誤仍含「response is not valid JSON」，且**不含**「connection lost」（兩種失敗互不誤報）。
- 預期：網絡層連接中斷與格式層解析失敗可區分，popup「最近失敗」能告訴用戶正確原因。
- 落點：單元 `test/unit/llm-translation.test.ts`（+2）。

#### TC-F21 SPA 換視頻後字幕重新出現（對應 F-01/M1-45，已實裝）
- 前置：E2E 測試構建（`TEST_PROFILE=1`）含 M1-45 manifest 新 content_scripts 條目（`world:"MAIN"`+`run_at:"document_start"` 注入攔截器）；mock 頁 `with-native-captions.html` 的 `app.js` 以 `v` 參數為當前視頻身份——`currentVideoId()` 讀 URL，`requestCaptions()` 請求 `/timedtext?lang=en&v=<當前 v>`，並以 200ms setInterval 偵測 URL `v` 變化後重置 `captionsRequested` 重發請求；`serve-mock.mjs` timedtext 響應 `videoId` 動態反映請求 `v` 參數。
- 步驟：
  - A（首次播放）：`page.goto('/with-native-captions.html?lang=en&v=abc123')` → 覆蓋層 `.ai-trans-overlay` 非空（字幕顯示）。
  - B（SPA 換視頻）：`page.evaluate(() => history.pushState({}, '', '/with-native-captions.html?lang=en&v=xyz789'))` 觸發 URL `v` 變化（不走頁面重載）→ content-script 偵測到 URL 變化（popstate/patch history）→ debounce 後熱重啟字幕管線。
  - C（新視頻字幕出現）：等待覆蓋層重新非空，且內容對應新視頻（mock 字幕為 v 依賴文本，斷言含 `xyz789` 特有標記）。
  - D（無舊字幕殘留）：新視頻字幕出現前不顯示舊視頻字幕（跨視頻捕獲失效校驗：stale 捕獲被跳過）。
- 預期：SPA 導航換視頻後字幕自動重新出現；跨視頻捕獲不誤用。
- 落點：E2E `test/e2e/extension.spec.ts`（+1）；配套 `test/fixtures/mock-youtube/app.js`（v 動態 + 換視頻重發）、`with-native-captions.html`（ytInitialPlayerResponse 動態注入，baseUrl 按當前 v）、`scripts/serve-mock.mjs`（videoId 動態）；集成 `test/integration/timedtext-bridge.test.ts`（+2：waitForCapture 期望 videoId 過濾 + 超時後 stop 仍 clearInterval）、`test/integration/platform-adapter.test.ts`（+2：stale 跳過+診斷原因鏈、同視頻正常複用）、`test/integration/yt-timedtext-interceptor.test.ts`（+2：videoId 提取、URL 無 v 為空串）。

#### TC-F22 攔截器重播修復捕獲早於監聽器註冊競態（對應 F-01/M1-46，已實裝）
- 前置：M1-45 把攔截器以 `document_start`（MAIN world）注入後，引入新競態——攔截器捕獲響應並 `postMessage`，但 `TimedTextBridge` 的 `message` 監聽器在 content-script（`document_idle`）才註冊；帶緩存二次加載時播放器 timedtext 請求在 document_idle 前發出，捕獲消息發在監聽器就位前永久丟失 → `waitForCapture(15s)` 超時 → pot 空響應失敗。修復：攔截器維護模塊級 `lastCapture`，`install()` 啟 1.5s 定時器周期重播，晚註冊的監聽器最遲 1.5s 內收到。
- 步驟（集成測試覆蓋）：
  - A（重播晚註冊監聽器收到）：`loadInterceptor` → 捕獲一次（XHR/fetch 命中 timedtext）→ 斷言即時 postMessage + 推進 fake timer 1.5s → 斷言第二次 postMessage 重播 payload 相同。
  - B（新捕獲覆蓋重播）：捕獲 `v=abc` 後捕獲 `v=xyz` → 推進 1.5s → 重播為 `v=xyz`（不發舊捕獲）。
  - C（空響應不重播）：捕獲非空響應後捕獲空響應（`emitCapture` return）→ 重播仍發非空捕獲、不發空。
  - D（放寬匹配）：`video.google.com/timedtext` URL 被 `isTimedText` 匹配並捕獲。
  - E（調試輔助）：捕獲後 `window.__aiTransTimedtextRequests` 計數遞增、`__aiTransTimedtextLastCapture` 更新為當前捕獲對象（含 `videoId`）。
  - F（bridge 晚註冊收到重播）：`TimedTextBridge` 在捕獲已發生後才 `start()`，重播消息送達 → `getLatest()` 就緒 → `waitForCapture` 立即命中。
- 預期：重播使晚註冊監聽器收到捕獲（消息丟失競態修復）；SPA 換視頻後新捕獲覆蓋重播（`matchesVideo` 過濾仍正確）；調試輔助供 M1-27 真實環境定位「hook 沒觸發」vs「捕獲到但解析/複用斷」。
- 落點：集成 `test/integration/yt-timedtext-interceptor.test.ts`（+6：重播晚註冊/新捕獲覆蓋/空響應不重播/video.google.com 匹配/調試計數+lastCapture）、`test/integration/timedtext-bridge.test.ts`（+1：晚註冊收到重播）。E2E 時序盲區：mock 播放器請求時機設計在 content-script 就緒後，「捕獲早於監聽器」競態在 E2E 不暴露，由確定性集成用例覆蓋（避免 mock 時序 flaky）。

#### TC-F23 消息通信 CustomEvent 修復 + 字幕模組驅動增強 + 翻譯失敗降級（對應 F-01/M1-47，已實裝）
- 前置：M1-46 修復了「捕獲早於監聽器註冊」的競態，但真實環境仍現「捕獲成功但字幕不顯示」——`__aiTransTimedtextLastCapture` 有值（捕獲成功）、`Capture count: 1`，但字幕不顯示，console 出現 `LLM translation response body read failed (connection lost): Failed to fetch`。三層根因與修復：**(1) 消息通信失敗**——content-script 的 `window.postMessage` 與 MAIN world 的 `globalThis.addEventListener('message')` 在 isolated world 與 MAIN world 之間通信失敗（`__aiTransTargetLang: undefined`），導致字幕模組驅動未觸發。修復：改用 `CustomEvent`——content-script 用 `document.dispatchEvent(new CustomEvent('ai-trans:set-target-lang', { detail: { targetLang } }))`，interceptor 用 `document.addEventListener('ai-trans:set-target-lang', ...)`，避免跨 world 通信問題。**(2) 字幕模組驅動重試不足**——`MAX_RETRIES=20`（20 秒）在 YouTube 播放器加載較慢時不足，且沒有立即觸發機制。修復：`MAX_RETRIES` 增至 60（60 秒）；`resetAndRedriveCaptionModule()` 立即嘗試一次 `ensureCaptionModuleLoaded()`；收到 `SET_TARGET_LANG_EVENT` 消息時立即調用 `resetAndRedriveCaptionModule()`。**(3) 翻譯失敗時字幕完全不顯示**——LLM 翻譯服務連接失敗時，錯誤冒泡到策略鏈但不顯示任何字幕。修復：`NativeCaptionStrategy.run()` 添加 try-catch 捕獲翻譯錯誤，失敗時顯示原文字幕（`translatedText` 設為 `sourceText`）並發送 `engine-degraded` 事件。
- 步驟（集成測試覆蓋）：
  - A（CustomEvent 消息通信）：interceptor 監聽 `ai-trans:set-target-lang` CustomEvent → 設置 `__aiTransTargetLang` → 斷言值正確設置（替代原 `postMessage` 測試）。
  - B（字幕模組驅動立即觸發）：收到 `SET_TARGET_LANG_EVENT` 消息 → 立即調用 `resetAndRedriveCaptionModule()` → 斷言 `ensureCaptionModuleLoaded()` 被調用。
  - C（MAX_RETRIES 增強）：`MAX_RETRIES` 從 20 增至 60 → 斷言重試窗口為 60 秒。
- 預期：isolated world 與 MAIN world 之間的消息通信通過 `CustomEvent` 正常傳遞（`__aiTransTargetLang` 正確設置）；字幕模組驅動有足夠的重試窗口（60 秒）和立即觸發機制；翻譯失敗時顯示原文字幕並發送 `engine-degraded` 事件（popup 顯示降級原因）。
- 落點：集成 `test/integration/yt-timedtext-interceptor.test.ts`（+1：`set-target-lang` 消息測試改用 `CustomEvent`）。

#### TC-F26 LLM 直接 fetch 架構（對應 F-04/M1-48，已實裝）
- 前置：MV3 service worker 掛起後 `chrome.runtime.sendMessage`/port 響應被延遲到 SW 喚醒（實測延遲 138s+），`alarms` keepalive + port 長連接無法根治。M1-48 改為 content script（ISOLATED world）以 `globalThis.fetch` 直接調用 `LLMTranslationProvider`（host_permissions 授予跨域、無需 CORS 預檢、不受 SW 掛起影響）;移除 SW `translation:fetch` 消息處理 / `alarms` keepalive / `onConnect` port proxy / manifest `alarms` 權限，SW 精簡為僅 `config:get`/`config:set`。
- 步驟：
  - A（content script 直接 fetch）：`LLMTranslationProvider.translate()` 經 `vi.stubGlobal('fetch', mockFetch)` 直接調用 `globalThis.fetch`，斷言不經任何 message-bus/SW 層;mock 返回 OpenAI 兼容響應 → 解析成功。
  - B（fetch 綁定接收者）：mock fetch 以裸函數斷言能成功調用（內部 `globalThis.fetch.bind(globalThis)`，§5.1）。
  - C（SW 僅配置管理）：`service-worker.test.ts` 斷言 SW 只處理 `config:get`/`config:set`，無 `translation:fetch`/port 監聽。
- 預期：翻譯請求不再依賴 SW 喚醒，實測延遲 23ms（原 138s+）;SW 職責收斂。
- 落點：單元 `test/unit/llm-translation.test.ts`（直接 fetch 契約）、集成 `test/integration/composition.test.ts`（組裝注入）、`test/support/setup-dom.ts`（`vi.stubGlobal('fetch')` 測試模式）。

#### TC-F27 interceptor arraybuffer 支援 + 渲染日誌降壓（對應 F-01/F-11/M1-50，已實裝）
- 前置：YouTube 可能將 timedtext XHR `responseType` 設為 `arraybuffer`（二進制傳輸），原 `readXhrResponseText()` 對非文本類型返回空串 → 字幕響應被丟棄（`emitCapture: empty response` → 解析 `root <html>`）。M1-50 新增 arraybuffer 分支（`TextDecoder('utf-8')` 解碼）+ onLoad 記錄 `xhr.status`/`xhr.responseType`;併 overlay-renderer 日誌降壓（`render()` 僅 cues 數量變化時記錄、`draw()` no-cue 5s 節流、active cue 僅切換時記錄）。
- 步驟：
  - A（arraybuffer 解碼，已測）：構造 `responseType='arraybuffer'`、`response` 為 `ArrayBuffer`、`responseText` 存取器拋 `InvalidStateError` 的 XHR 模擬 → `readXhrResponseText` 以 `TextDecoder('utf-8')` 正確解碼含中文的 UTF-8 文本，`postMessage` 捕獲成功。
  - B（status/responseType 診斷，門控日誌）：onLoad 經 `diagLog('interceptor', ...)` 記錄 `xhr.status` 與 `xhr.responseType`（麵包屑留痕，受 M1-51 調試門控，非功能斷言）。
  - C（渲染日誌降壓，門控日誌）：`render()` 僅 cues 數量變化時記錄、`draw()` no-cue 5s 節流、active cue 僅切換時記錄——純日誌行為，不改變渲染輸出。
- 預期：arraybuffer timedtext 響應不再被誤丟;控制台不再每幀洪水;「空響應」原因可區分（HTTP 錯誤/類型不支援/真實無字幕）。
- 落點：集成 `test/integration/yt-timedtext-interceptor.test.ts`（`[M1-50] responseType=arraybuffer` 用例，緊鄰既有 M1-47 json/blob 硬化用例）;B/C 為純日誌行為不改變功能輸出，無獨立功能斷言（受既有渲染測試與門控測試 TC-F24 間接覆蓋）。

#### TC-F24 調試日誌門控（對應 F-12/M1-51，已實裝）
- 前置：`src/infrastructure/debug-log.ts` 中央門控——八分類（overlay/llm/capture/pipeline/strategy/content/bridge/interceptor）布爾開關，預設全關（`DEBUG_LOG_OFF`）；`diagLog(category, ...)` 僅在對應分類開啟時輸出（前綴 `[AI_Trans:diag][category]`）；開關經 `EngineConfig.debugLog` 持久化並以 `CustomEvent('ai-trans:set-debug-flags')` 同步給 MAIN world 攔截器。**錯誤/降級（console.warn + recordDiagnostic）不受開關影響**。
- 步驟：
  - A（默認全關不輸出）：`setDebugFlags(undefined)` → `diagLog('llm', 'x')` 不輸出（spy console.log 計數 0）。
  - B（開啟分類帶前綴輸出）：`setDebugFlags({ llm: true })` → `diagLog('llm', 'x')` 輸出且含 `[AI_Trans:diag][llm]` 前綴。
  - C（分類隔離）：僅開 `llm` 時 `diagLog('overlay', 'y')` 不輸出。
  - D（getDebugFlags 返回獨立副本）：外部修改返回值不影響內部狀態。
  - E（setDebugFlags 部分旗標補全）：只傳 `{ llm: true }` → 其餘分類補全為 false。
  - F（setDebugFlags(undefined) 重置全關）。
  - G（八分類全覆蓋）：枚舉所有分類均有對應開關。
- 預期：調試日誌按分類可控開關，普通用戶零噪音；開發者按需開啟定位；錯誤/降級信息始終可見（§5.6 不靜默）。
- 落點：單元 `test/unit/debug-log.test.ts`（+7）；`test/unit/config.test.ts`（DEFAULT_CONFIG 含 `debugLog`）、`test/unit/config-store.test.ts`（merge 保留 debugLog）、`test/integration/options.test.ts`（HTML 模板含調試日誌分區）。

#### TC-F25 字幕翻譯分塊/快取/重試（對應 F-13/M1-52，已實裝；M1-53 兩階段超時）
- 前置：`LLMTranslationProvider` 機制——`CHUNK_SIZE=60` 分塊、`translateStream` 漸進 emit 累計全量、LRU 快取（key=`model|targetLang|djb2Hash(塊源文)`，上限 100）、瞬態失敗重試 ≤2 次（500ms→1500ms 退避）、**兩階段超時**（M1-53：headers `timeoutMs` 默認 30s + body `bodyTimeoutMs` 默認 `BODY_TIMEOUT_MS=300_000`，共用同一 `AbortController`）。模塊級快取跨測試共享，測試須 `beforeEach/afterEach` 調 `invalidateLlmCache()` 防命中污染。
- 步驟：
  - A（分塊邊界）：130 段 → `chunkSegments` 為 [60,60,10] 三塊；恰 60 段 → 一塊；空輸入 → `[[]]`。
  - B（漸進 emit）：130 段 `translateStream` → emit 序列長度遞增 [60,120,130]（每塊完成 emit 累計全量）。
  - C（首塊 ready / 後續 updated）：`NativeCaptionStrategy` 走 `translateStream` 時首個 emit 映射 `segments-ready`、後續映射 `segments-updated`；`stop()` 後不再 emit。
  - D（快取命中）：同 key 二次請求零 fetch（mock fetch 計數不增）；換模型/換目標語言 → miss。
  - E（LRU 逐出）：110 個不同 key 依序寫入 → 快取大小收斂至 100（最舊被淘汰）。
  - F（瞬態重試）：HTTP 500 / 超時 / body 非 JSON / body 讀取 `Failed to fetch` → fake timers 下 3 請求後回退原文（不拋錯）；HTTP 429 首敗後成功 → 2 請求取成功結果。
  - G（永久失敗 fail-fast）：HTTP 400（非 429）→ 立即拋 `LLMRequestError` 且僅 1 請求；choices 缺失/content 非字符串 → 拋錯走降級。
  - H（**M1-53 headers 超時**）：`fetch()` 永不 resolve（響應頭遲遲不到）→ `timeoutMs` abort → 瞬態重試 → 原文兜底。
  - H'（**M1-53 body 超時**）：headers 已回但 `res.text()` 掛死 → `bodyTimeoutMs`（測試注入短值）abort → 瞬態重試 → 原文兜底（保留 M1-52「覆蓋 body 掛死」能力）。
  - I（配置變更失效）：`ensureLlmCacheInvalidationHook` 註冊 once-guard；`invalidateLlmCache()` 全量清空（重播零請求→清空後重新請求）。
  - J（**M1-53 headers 快 + body 慢回歸**）：headers 立即返回 + body 延遲（<bodyTimeoutMs）生成 → **不被 headers 超時誤殺**，單次請求成功翻譯、`degraded=false`。此為本次修復核心回歸（本地 LLM 11ms 回 headers、body 生成 >30s 的場景）。
  - K（**M1-53 常數**）：`BODY_TIMEOUT_MS = 300_000`（5 分鐘長輸出窗口）。
- 預期：長視頻首塊秒級可見、後續增量替換；重播/切配置免重複請求；瞬態抖動自動恢復、單塊失敗原文兜底不阻塞；永久失敗立即降級可診斷；**本地 LLM 慢生成不再被 30s headers 超時誤殺**。
- 落點：單元 `test/unit/llm-translation.test.ts`（29 用例，含 M1-53 兩階段超時 H/H'/J/K）+ `test/unit/native-caption-strategy.test.ts`（+3 流式）。

#### TC-F12 Popup「測試連接」按鈕（對應 F-11，已實裝）
- 前置：`connection-test.ts`（`testConnection`）注入 mock fetch；配置為 local/cloud-llm 引擎。
- 步驟：
  - A（端點可達+模型存在）：mock fetch 返回 200 + `choices[].message.content` → 返回 `ok:true`，請求 URL 經 `normalizeEndpoint` 補全為 `<endpoint>/chat/completions`。
  - B（模型 404）：mock fetch 返回 404 + `{ error: { message: "Model 'x' not found" } }` → `ok:false` 且錯誤含 HTTP 狀態與伺服器原因。
  - C（網絡失敗）：mock fetch 拋 `TypeError('Failed to fetch')` → `ok:false` 標記「網絡失敗」。
  - D（前置校驗）：MT 引擎 / 缺端點 / 缺模型 → 快速失敗不發請求。
  - E（響應結構異常）：200 但無 `choices` → `ok:false`。
  - F（Popup 整合）：點擊 `#btn-test` → `#status-connection` 顯示結果（成功標綠 `.ok`）。
- 預期：`ok`/`error` 分支覆蓋以上六類；fetch 永遠以 `globalThis.fetch.bind(globalThis)`（§5.1），超時 AbortController + finally 清 timer（§5.4）。
- 落點：集成 `test/integration/connection-test.test.ts`（5）+ `test/integration/popup.test.ts`（1：點擊按鈕標綠）。

#### TC-F06 實時擷取 ASR（對應 F-06，M2 實裝）
- 前置：打開 `no-captions.html`，注入音頻 fixture 與 `StubASR`。
- 步驟：
  - A（tabCapture 授權）：Popup 點擊「啟用 ASR」→ tabCapture 授權對話框（測試中自動放行）→ `chrome.storage.local['tabCaptureAuthorized']` 寫入 `true` → content-script `storage.onChanged` 監聽 → `enableAsr = true`。
  - B（Offscreen 通信）：content-script → port → Offscreen 發 `{ type: 'start', tabId }` → Offscreen 啟動 tabCapture → AudioContext 解碼 → 推送 `AudioChunk`（`seq` 遞增、`pcm: Float32Array`）。
  - C（VAD 過濾）：`EnergyVAD` 計算 RMS 能量 → 靜音 chunk `isSpeech=false` → 跳過 ASR。
  - D（ASR 流式）：`ASRPipeline.transcribeStream` → `StubASR.transcribeStream` → emit provisional `ASRResult(isPartial=true)` → emit final `ASRResult(isPartial=false)`。
  - E（provisional 字幕）：provisional emit → `segments-updated` → `OverlayRenderer.updateProvisional` 原地更新 → final emit → `segments-ready` → 定稿修正。
- 預期：provisional 字幕先顯示（`revision` 遞增），隨後被最終結果修正；`origin=realtime-asr`；tabCapture 授權狀態持久化。
- 落點：單元 `test/unit/tab-capture-source.test.ts`（TabCaptureAudioSource mock MediaStream → AudioChunk）、`test/unit/energy-vad.test.ts`（RMS 能量計算 + 靜音切分）、`test/unit/offscreen-protocol.test.ts`（Offscreen 消息協議）；集成 `test/integration/realtime-asr-strategy.test.ts`（RealtimeASRStrategy mock AudioSource + ASR → emit 事件序列）；E2E `test/e2e/extension.spec.ts`（TC-F06 無字幕頁面 → provisional → 定稿）。

#### TC-F07 ASR 引擎配置（對應 F-07，M2 實裝）
- 步驟：
  - A（引擎切換）：Options 切換本地 Whisper ↔ 雲端 ASR → `Registry.asr` Map 選中對應 `ASRProvider`（`local-whisper` / `cloud-asr`）。
  - B（模型檔位）：切換 `asr.modelTier`（tiny/base/small）→ `LocalWhisperASR.warmup()` 加載對應模型。
  - C（自定義模型）：填寫 `asr.modelPath`（如 vibevoice 本地路徑）→ 從 IndexedDB 加載自定義模型。
  - D（雲端端點識別）：`asr.endpoint` 含 `deepgram` → WebSocket 流式；其他 → OpenAI 兼容 multipart。
  - E（模型下載）：Options「模型管理」區 → 點擊「下載 tiny」→ Offscreen 下載到 IndexedDB → 進度條更新。
- 預期：`Registry` 選中對應 `ASRProvider`；識別路徑切換正確；自定義模型可加載；雲端端點自動識別。
- 落點：單元 `test/unit/local-whisper.test.ts`（LocalWhisperASR mock pipeline → ASRResult）、`test/unit/cloud-asr.test.ts`（CloudASR mock fetch/WebSocket → ASRResult）；集成 `test/integration/composition.test.ts`（ASR provider 註冊 + 選擇）。

#### TC-M2-01 Offscreen Document 生命週期（對應 M2-09）
- 步驟：
  - A（創建）：`RealtimeASRStrategy.run()` 觸發 → `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'ASR audio processing' })`。
  - B（port 長連接）：content-script `chrome.runtime.connect({ name: 'offscreen-asr' })` → Offscreen `chrome.runtime.onConnect` 接收 → 雙向消息傳遞。
  - C（銷毀）：`RealtimeASRStrategy.stop()` → `chrome.offscreen.deleteDocument()`。
  - D（SW 掛起免疫）：port 消息不經 SW 代理（直接 content-script ↔ Offscreen），SW 掛起不影響音頻流。
- 預期：Offscreen 正確創建/銷毀；port 消息雙向通達；MV3 同時只允許一個 Offscreen（重複創建報錯被 catch）。
- 落點：單元 `test/unit/offscreen-lifecycle.test.ts`（創建/銷毀/冪等）；集成 `test/integration/offscreen-protocol.test.ts`（port 消息協議）。

#### TC-M2-02 TabCapture 授權流程（對應 M2-14）
- 步驟：
  - A（授權成功）：Popup 點擊「啟用 ASR」→ `chrome.tabCapture.getMediaStream({ audio: true })` → 用戶點擊允許 → `chrome.storage.local['tabCaptureAuthorized'] = true` → content-script `storage.onChanged` → `enableAsr = true`。
  - B（授權拒絕）：用戶點擊拒絕 → popup 顯示「ASR 授權失敗」→ `tabCaptureAuthorized` 保持 `false` → content-script `enableAsr = false` → 策略鏈跳過 RealtimeASRStrategy。
  - C（授權持久化）：刷新頁面 → `chrome.storage.local` 讀取 `tabCaptureAuthorized = true` → 自動啟用 ASR（不再彈授權對話框）。
- 預期：授權狀態正確持久化；content-script 響應授權變更；拒絕授權時降級到原生字幕。
- 落點：集成 `test/integration/tab-capture-auth.test.ts`（授權成功/拒絕/持久化）。

#### TC-M2-03 VAD 能量閾值（對應 M2-07）
- 步驟：
  - A（語音檢測）：`EnergyVAD.process(pcm)` → RMS 能量 > 閾值 → `isSpeech = true`。
  - B（靜音檢測）：RMS < 閾值 → `isSpeech = false`。
  - C（分段邊界）：靜音連續 > 2s → 觸發分段邊界（切分 AudioChunk 送 ASR）。
  - D（閾值配置）：`EngineConfig.asr.vadThreshold` 可調（默認 0.01）。
- 預期：靜音/語音正確區分；分段邊界觸發正常；閾值可配置。
- 落點：單元 `test/unit/energy-vad.test.ts`（RMS 計算 + 靜音切分 + 閾值配置）。

#### TC-M2-04 LocalWhisperASR 本地推理（對應 M2-05）
- 步驟：
  - A（warmup）：`LocalWhisperASR.warmup({ modelTier: 'tiny' })` → 加載 tiny 模型（首次從 HuggingFace Hub 下載到 IndexedDB）。
  - B（transcribe）：`transcribe({ chunk, hintLang: 'en' })` → PCM → Whisper pipeline → `ASRResult(segments, isPartial: false)`。
  - C（transcribeStream）：`transcribeStream(req, emit)` → 分段推理 → emit provisional → emit final。
  - D（自定義模型）：`warmup({ modelPath: '/path/to/vibevoice' })` → 從 IndexedDB/本地加載自定義模型。
  - E（RTF 觀測）：`ASRResult.rtf` = 推理耗時 / 音頻時長（應 < 1 表示實時）。
- 預期：模型正確加載；推理結果帶時間軸；流式 emit provisional → final；自定義模型可加載。
- 落點：單元 `test/unit/local-whisper.test.ts`（mock transformers.js pipeline → ASRResult）。

#### TC-M2-05 CloudASR 雲端推理（對應 M2-06）
- 步驟：
  - A（OpenAI Whisper API）：`CloudASR.transcribe({ endpoint: 'https://api.openai.com/v1' })` → `POST /v1/audio/transcriptions`（multipart/form-data，`file` 為 WAV blob）→ `ASRResult`。
  - B（Deepgram WebSocket）：`CloudASR.transcribeStream({ endpoint: 'wss://...deepgram...' })` → WebSocket `wss://api.deepgram.com/v1/listen` → emit provisional → emit final。
  - C（端點自動識別）：endpoint 含 `deepgram` → WebSocket；其他 → OpenAI 兼容。
  - D（錯誤處理）：HTTP 4xx/5xx → `ASRRequestError`；WebSocket 斷開 → 發 `engine-degraded` 事件。
- 預期：雙實現正確路由；流式 emit provisional → final；錯誤處理走降級機制。
- 落點：單元 `test/unit/cloud-asr.test.ts`（mock fetch/WebSocket → ASRResult）。

#### TC-M2-06 RealtimeASRStrategy 完整鏈路（對應 M2-08）
- 步驟：
  - A（isApplicable）：`config.asr.type !== 'none'` && `tabCaptureAuthorized` → `true`；否則 `false` + 寫診斷 `realtime-asr: tabCapture not authorized`。
  - B（run 鏈路）：`TabCaptureAudioSource.open()` → `onChunk()` → VAD 過濾 → `ASRPipeline.transcribeStream` → 翻譯 → emit `segments-updated`（provisional）→ emit `segments-ready`（final）。
  - C（stop 清理）：`stop()` → `AudioSourceHandle.stop()` + 清理所有訂閱（§5.4 R4）。
  - D（錯誤降級）：tabCapture 失敗 → 發 `pipeline-error`（code `tab-capture-failed`）→ 策略鏈降級。
- 預期：完整鏈路打通；provisional → final 正確 emit；stop 完全清理；錯誤走降級。
- 落點：集成 `test/integration/realtime-asr-strategy.test.ts`（mock AudioSource + ASR → emit 事件序列）。

#### TC-M2-07 provisional 字幕修正（對應 M2-11）
- 步驟：
  - A（segments-updated）：ASR emit provisional → `segments-updated` → content-script `onEvent` → `cues[i].provisional = true` → `OverlayRenderer.updateProvisional(cue)` 原地更新。
  - B（segments-ready）：ASR emit final → `segments-ready` → content-script `onEvent` → `cues[i].provisional = false` → `OverlayRenderer.render(cues, currentTime)` 定稿。
  - C（revision 遞增）：provisional 多次更新 → `cue.revision` 遞增（同一 id 原地替換，不新增 DOM 節點）。
- 預期：provisional 字幕先顯示 → final 修正；同一 id 原地更新不閃爍。
- 落點：單元 `test/unit/overlay-renderer.test.ts`（updateProvisional 原地替換）；集成 `test/integration/content-script.test.ts`（onEvent segments-updated/ready 處理）。

#### TC-M2-08 性能觀測（對應 M2-12）
- 步驟：
  - A（RTF 收集）：`ASRPipeline.emitMetric('asr', ms, seq, rtf)` → `PipelineEvent.metrics` → `PerfMetrics` 收集。
  - B（P50/P95 計算）：`PerfMetrics.summary()` → 計算各階段 P50/P95 延遲。
  - C（動態降檔）：RTF > 1 持續 30s → 自動降 tiny → 仍不達標 → 切雲端。
- 預期：性能指標正確收集；P50/P95 可查詢；動態降檔觸發正常。
- 落點：單元 `test/unit/perf-metrics.test.ts`（RTF 收集 + P50/P95 計算）。

#### TC-M2-09 ASR warmup 模塊解析 + 字幕攔截器 DOM 解析（對應 M2-17/M2-18）
- 步驟：
  - A（ASR warmup 模塊打包）：`@huggingface/transformers` 被 esbuild 完整打包進 content-script IIFE（移除 `external` 配置），bundle 無裸 `import("@huggingface/transformers")`；Vitest 的 `resolve.alias` 映射到 `test/support/mock-huggingface-transformers.ts`（測試環境不依賴真實包）。
  - B（DOM 解析兜底）：`player.getOption('captions', 'tracklist')` 返回空陣列時，`getCaptionTracksFromPlayerResponse()` 從 DOM `<script id="ytInitialPlayerResponse">` 解析 `ytInitialPlayerResponse`（支持 `var ytInitialPlayerResponse = {...};` JS 賦值形式），提取 `captionTracks` 作為首要來源。
- 預期：A 中 content-script bundle 可獨立解析 `@huggingface/transformers`（Chrome content script 無 node_modules）；B 中播放器 API 返回空時仍從 DOM 獲取字幕軌。
- 落點：集成 `test/integration/yt-timedtext-interceptor.test.ts`（M2-18 用例：getOption 返回空陣列時 DOM 解析兜底成功，斷言 `setOption('captions', 'track', { languageCode: 'zh-Hant' })` + `__aiTransCaptionTracks === 2`）。

#### TC-F08 預緩衝提前處理與降級（對應 F-08）
- 前置：可預取音頻的 mock 場景。
- 步驟 A：預取可用 → 走二級 look-ahead。
- 步驟 B：模擬預取失效（`changed-dom.html`）→ 觸發降級。
- 預期：A 中字幕領先播放頭；B 中發射 `strategy-degraded(lookahead→realtime)`，字幕不中斷、下游數據結構不變。

#### TC-F09 字幕樣式設置（對應 F-09，M1-49 已實裝）
- 前置：M1-49 默認樣式「白字 + 黑色環繞描邊（`text-shadow`）+ 灰黑半透明背景 `rgba(32,32,32,0.7)`」;Options 背景設置為「預設下拉（無背景/半透明灰黑推薦/半透明黑/自定義）+ 自定義區域（`<input type=color>` + 透明度滑桿）」。
- 步驟：
  - A（默認值）：`DEFAULT_CONFIG.subtitleStyle` 含白字 + 描邊 + 灰黑半透明背景。
  - B（背景預設 UI）：Options HTML 模板含背景預設下拉與自定義顏色/透明度控件;選「自定義」展開控件。
  - C（向後兼容）：舊配置 `background: transparent` → `matchPreset` 映射為「無背景」預設。
  - D（rgba 解析）：`parseRgba('rgba(32,32,32,0.7)')` 正確拆出顏色與透明度。
- 預期：極亮/極暗視頻字幕均清晰;預設覆蓋常見場景、自定義滿足特殊需求;舊用戶配置不破壞。
- 落點：單元 `test/unit/config.test.ts`（DEFAULT_CONFIG.subtitleStyle 默認值：白字 #ffffff + 描邊 + rgba(32,32,32,0.7)）、集成 `test/integration/options.test.ts`（背景預設下拉 HTML 模板含 none/gray/black/custom 選項；§5.6 配置讀取失敗可見）。`BG_PRESETS`/`parseRgba`/`matchPreset` 為 options.ts 模組私有函數，無直接單測——由 Options 讀取/保存集成測試間接覆蓋（標記：模組私有純函數如需單測可後續抽出）。E2E 樣式即時生效由 TC-E01 覆蓋層掛載鏈路兜底。

#### TC-DEGRADE 引擎兜底（對應架構第 10 章）
- 步驟：`StubLLM` 模擬超時/超額。
- 預期：自動切 `StubMT`；`TranslationResult.degraded=true`；發射 `engine-degraded`；字幕仍產出。

#### TC-E01 擴充注入與覆蓋層掛載（對應 F-01/F-02，已實裝）
- 前置：`build:test` 產出 dist；Playwright persistent context fixture 加載擴充；打開 `with-native-captions.html`。
- 步驟：等待 content-script 注入並掛載覆蓋層。
- 預期：`.ai-trans-overlay` 節點掛載於 `#mock-player` 容器（`toBeAttached`）；暫停後覆蓋層仍掛載（不隨播放狀態消失）。

#### TC-E02 覆蓋層含譯文字幕（對應 F-01/F-03，已實裝）
- 前置：同 TC-E01。
- 步驟：播放時鐘推進至字幕時間窗（0~2000ms）。
- 預期：`.ai-trans-overlay` 非空（`not.toBeEmpty`）；字幕隨 `currentTime` 顯示。驗證了「抓字幕（timedtext fetch）→ 翻譯 → observePlayback + rAF 渲染」全鏈路。

#### TC-E03 timedtext 端點與 Mock 宿主基線（已實裝）
- 步驟：請求 `/timedtext`；讀取 `__mockState` 播放時鐘；暫停/播放控制。
- 預期：timedtext 返回 4 行 events；時鐘推進/暫停/恢復符合預期（smoke + extension spec 共 5 個宿主基線用例）。

> 已實裝 E2E 共 15 個用例（`test/e2e/smoke.spec.ts` 5 + `test/e2e/extension.spec.ts` 10，含 TC-R3 覆蓋層不累積、TC-R8 storage.onChanged 熱重啟、TC-F11 降級診斷寫入、**TC-F19 捕獲鏈路**、**TC-F21 SPA 換視頻**），全綠。TC-E01/02 覆蓋擴充注入與渲染全鏈路，TC-E03 為宿主與端點基線。pot 攔截器（M1-42/43/45）的 manifest/web_accessible_resources 完整性由集成測試 `timedtext-bridge.test.ts`（`inject()` 用 `chrome.runtime.getURL` 解析路徑）+ **TC-F19 捕獲鏈路 E2E**（WAR 追加 localhost 後，MAIN world 攔截器在真實瀏覽器首次真正運行，請求計數 = 1）驗證；M1-45 的 `document_start` + `world:"MAIN"` manifest 注入與 SPA 換視頻熱重啟由 **TC-F21**（E2E 真實瀏覽器 + 集成）驗證；真實播放器攔截行為待真實 YouTube 登錄環境手動冒煙（M1-27）。

#### TC-R 可靠性紅線回歸（對應 AGENTS.md §5 / architecture §7.1，已實裝）

覆蓋 MV3 真實環境陷阱，jsdom 單測與 E2E 分工驗證：

| TC | 紅線 | 斷言 | 落點 |
|---|---|---|---|
| TC-R1a | R1 fetch 綁定 | LLM 默認 fetch 以 globalThis 為接收者調用不拋 Illegal invocation | `test/unit/llm-translation.test.ts` |
| TC-R1b | R1 fetch 綁定 | `FetchCaptionSource` 默認 fetch 綁定 globalThis | `test/integration/platform-adapter.test.ts` |
| TC-R2 | R2 URL 絕對化 | 相對 baseUrl 被解析為絕對 URL 傳入 fetch | `test/integration/platform-adapter.test.ts` |
| TC-R3 | R3 禁覆寫共享容器 | restart/暫停後 `.ai-trans-overlay` 恰好 1 個、仍 attached | `test/e2e/extension.spec.ts` |
| TC-R4a | R4 註冊必解除 | `observePlayback` 的 unsubscribe 解除全部事件監聽 | `test/integration/platform-adapter.test.ts` |
| TC-R4b | R4 不累積 | 多次 observe/unsubscribe 後 add 次數 == remove 次數 | `test/integration/platform-adapter.test.ts` |
| TC-R5 | R5 stream 降級 | `translateStream` 的 primary 流式拋錯時降級 fallback 並發 engine-degraded + pipeline-error | `test/unit/translation-pipeline.test.ts` |
| TC-R6 | R6 不掩蓋缺失 | 播放器缺失時 observePlayback 返回 noop 不拋錯 | `test/integration/platform-adapter.test.ts` |
| TC-R7a | R7 選擇器精確 | 具名 `#ytInitialPlayerResponse` 優先，忽略其他內聯腳本 | `test/integration/platform-adapter.test.ts` |
| TC-R7b | R7 JSON 容錯 | 非法 JSON / 首個內聯非字幕腳本時返回 `[]` 不拋 SyntaxError | `test/integration/platform-adapter.test.ts` |
| TC-R8 | R4 跨上下文熱重啟 | 經 service worker 寫 `chrome.storage.local`（等價 Options 保存）觸發 `storage.onChanged` → content-script `restart()`，覆蓋層仍恰好 1 個、仍 attached（不累積、不崩潰） | `test/e2e/extension.spec.ts` |

> 全部測試合計 182（單元 53 + 契約 11 + 集成 104 + E2E 15）。R 系列為 §5 紅線的專屬回歸，改動相關代碼須保持這些斷言不破。新增（F-11 診斷可見性）：集成 +11（`diagnostics.test.ts` 7：extract/record/read/format + §5.7 storage 拋錯守護；`popup.test.ts` 4：有診斷/常駐「無」/狀態行/測試連接按鈕；`connection-test.test.ts` 5：TC-F12 六類分支）、單元 +8（TC-F13：`caption-strategy-chain.test.ts` 全鏈診斷 2 + run 失敗診斷 1 + `native-caption-strategy.test.ts` 軌抓取診斷 4 + `placeholder-strategies.test.ts` 3）、E2E +1（TC-F11 降級後 `lastDiagnostic` 寫入）。新增（M1-39 不靜默失敗收口）：集成 +4（TC-F14 軌列表三態診斷）、單元 +4（TC-F15 佔位策略 3 + TC-F14 平台診斷帶入 1）。新增（TC-F16 timedtext 真實格式兼容）：契約 +3（srv3/HTML 錯誤頁/實體）、集成 +2（fmt=json3 追加/非 YouTube 不動）。新增（TC-F17 外部接口調用節點診斷證據化）：單元 +11（`llm-translation.test.ts` 3：非 JSON/choices 缺失/choices 非字符串；`chrome-message-bus.test.ts` 4：無接收方靜默/錯誤警告/dispose/消息分發；`service-worker.test.ts` 4：config:get/set 成功與失敗/未知 topic）、集成 +12（`platform-adapter.test.ts` 6：HTTP 非 2xx/網絡失敗/HTML content-type/非法 JSON/URL 構造 + observePlayback 麵包屑；`popup.test.ts` 3：配置讀取失敗/密鑰讀取失敗/重新載入反饋；`options.test.ts` 3：正常填充/配置失敗/密鑰失敗）、契約 +3（timedtext 非法 JSON 片段/HTML 證據/snippet）。新增（TC-F18 pot token 攔截複用）：集成 +14（`timedtext-bridge.test.ts` 5：inject 冪等 + getLatest + start/dispose 清理 + 外部消息過濾 + dispose 後不接收；`yt-timedtext-interceptor.test.ts` 4：open/send hook + URL 匹配 + load 轉發 + 空響應不轉發；`platform-adapter.test.ts` +5：捕獲複用不發 fetch / srv3 捕獲 / 無捕獲回退 / 空捕獲走 fetch / 捕獲解析失敗回退 + 診斷；`setup-dom.ts` 補 `chrome.runtime.getURL` mock）。新增（TC-F19 捕獲鏈路 + M1-43 捕獲時序修復）：集成 +11（`timedtext-bridge.test.ts` +6：stop 保留 latest + start 冪等 + inject 冪等 + dispose 後不接收 + waitForCapture 三分支：立即/捕獲到達/超時 + 輪詢器 interval；`yt-timedtext-interceptor.test.ts` +2：localhost 匹配 + fetch hook：timedtext 透傳+捕獲 / 非 timedtext 不攔截；`platform-adapter.test.ts` +3：等待捕獲後複用不發 fetch / 超時回退 fetch / 無 waitForCapture 舊實現直接 fetch）、E2E +1（TC-F19 捕獲鏈路：WAR 追加 localhost 後斷言 mock 播放器請求計數 = 1、擴充零 fetch）。新增（TC-F20 LLM body 讀取失敗與非 JSON 區分，M1-44）：單元 +2（`llm-translation.test.ts`：res.json() 拋 `TypeError('Failed to fetch')` → 「connection lost」且不含 not-valid-JSON；拋 `SyntaxError` → 仍報 not-valid-JSON 且不含 connection lost）。新增（TC-F21 SPA 換視頻 + M1-45 注入時序/跨視頻失效）：集成 +8（`timedtext-bridge.test.ts` +2：waitForCapture 期望 videoId 過濾兩分支 + 超時後 stop 仍 clearInterval；`yt-timedtext-interceptor.test.ts` +2：videoId 提取 + URL 無 v 空串；`platform-adapter.test.ts` +2：stale 跳過複用 + 診斷原因鏈、同視頻正常複用——另改 1 斷言：等待捕獲後複用 `toHaveBeenCalledWith(15_000, '')`，jsdom location 無 v 故期望空串）、E2E +1（TC-F21：SPA pushState 換視頻後字幕重新出現、無舊字幕殘留）。新增（TC-F22 攔截器重播修復捕獲早於監聽器註冊競態，M1-46）：集成 +7（`yt-timedtext-interceptor.test.ts` +6：重播晚註冊監聽器收到 / 新捕獲覆蓋重播 SPA 換視頻 / 空響應不重播 / video.google.com 放寬匹配 / 調試計數+lastCapture；`timedtext-bridge.test.ts` +1：晚註冊收到重播）。
>
> **E2E 配置污染防護（重要）**：E2E 經 persistent context 加載擴充，content-script 會真實請求配置中的端點。**禁止測試寫入指向真實本地服務的端點**（如 `127.0.0.1:8000`——開發機上的 omlx 等）——否則測試會真實打開發機服務、污染日誌與診斷（曾發生：omlx 出現大量 `qwen-mlx` 404 記錄，實為 TC-R8 舊版寫入真實 8000 端口所致）。統一改用不可達假端口 `127.0.0.1:59999`。

### 7.2 非功能測試用例

#### TC-NF-LATENCY 三級延遲（對應非功能：延遲）
- 步驟：E2E 注入已知時間軸音頻，測量字幕顯示滯後。
- 預期：P95 顯示延遲 ≤ 5s；provisional 首屏延遲顯著低於定稿延遲。

#### TC-NF-ACCURACY 翻譯/識別準確（對應非功能：準確率）
- 步驟：對 fixture 集比對輸出與期望。
- 預期：與對照表匹配（stub 確定性保證可斷言）。

#### TC-NF-STABILITY 改版穩定性（對應非功能：穩定性）
- 步驟：加載 `changed-dom.html`。
- 預期：不崩潰；契約測試定位到失效適配器；降級策略生效。

#### TC-NF-PRIVACY 本地模式隱私（對應非功能：隱私）
- 步驟：全本地引擎運行，攔截網絡層。
- 預期：無任何外發請求（外發計數 = 0）。

#### TC-NF-PERF 頁面性能（對應非功能：性能）
- 步驟：實時 ASR 運行期間監測主線程。
- 預期：重推理在 Offscreen，頁面主線程無明顯卡頓；丟段率在閾值內。

#### TC-NF-COMPAT 兼容性（對應非功能：兼容性）
- 步驟：在 Chromium（及可選 Edge）跑核心 E2E 子集。
- 預期：核心鏈路一致通過。

### 7.3 用例與需求追蹤矩陣

| 用例 | 需求 | 層級 |
|---|---|---|
| TC-F01 | F-01 | E2E/集成 |
| TC-F02 | F-02 | E2E |
| TC-F03 | F-03 | E2E |
| TC-F04 | F-04 | E2E/集成 |
| TC-F05 | F-05 | 集成 |
| TC-F10 | F-10 | 單元/集成/E2E（已實裝） |
| TC-F11 | F-11 | 集成/E2E（已實裝） |
| TC-F13 | F-11 | 單元（已實裝） |
| TC-F14 | F-11 | 集成/單元（已實裝） |
| TC-F15 | F-11 | 單元（已實裝） |
| TC-F16 | F-01 | 契約/集成（已實裝） |
| TC-F17 | F-11 | 單元/集成/契約（已實裝） |
| TC-F18 | F-01 | 集成（已實裝） |
| TC-F19 | F-01 | 集成/E2E（已實裝） |
| TC-F20 | F-11 | 單元（已實裝） |
| TC-F21 | F-01 | 集成/E2E（已實裝） |
| TC-F22 | F-01 | 集成（已實裝） |
| TC-F06 | F-06 | 單元/集成/E2E（M2 實裝） |
| TC-F07 | F-07 | 單元/集成（M2 實裝） |
| TC-M2-01 | M2-09 | 單元/集成 |
| TC-M2-02 | M2-14 | 集成 |
| TC-M2-03 | M2-07 | 單元 |
| TC-M2-04 | M2-05 | 單元 |
| TC-M2-05 | M2-06 | 單元 |
| TC-M2-06 | M2-08 | 集成 |
| TC-M2-07 | M2-11 | 單元/集成 |
| TC-M2-08 | M2-12 | 單元 |
| TC-M2-09 | M2-17/M2-18 | 集成（已實裝） |
| TC-F08 | F-08 | 集成/E2E |
| TC-F09 | F-09 | E2E |
| TC-DEGRADE | 架構§10 | 單元/集成 |
| TC-E01 | F-01/F-02 | E2E（已實裝） |
| TC-E02 | F-01/F-03 | E2E（已實裝） |
| TC-E03 | 宿主基線 | E2E（已實裝） |
| TC-R1~R8 | AGENTS.md §5 可靠性紅線 / architecture §7.1 | 單元/集成/E2E（已實裝） |
| TC-NF-LATENCY | 非功能·延遲 | E2E |
| TC-NF-ACCURACY | 非功能·準確率 | 單元 |
| TC-NF-STABILITY | 非功能·穩定性 | 契約/E2E |
| TC-NF-PRIVACY | 非功能·隱私 | E2E |
| TC-NF-PERF | 非功能·性能 | E2E |
| TC-NF-COMPAT | 非功能·兼容性 | E2E |

---

## 8. 測試風險與應對

| 風險 | 影響 | 應對 |
|---|---|---|
| E2E flaky（時序/等待） | 誤報影響閉環 | 原生等待（Playwright auto-wait）、固定時鐘、重試策略、trace 留存 |
| Mock 與真實 YouTube 偏差 | 測試通過但線上失效 | 契約測試 + 可選真實冒煙套件（手動觸發，見開放問題） |
| 環境未清理 | 下次運行污染 | `cleanup` 強制 `if: always()`；三層恢復；工作區乾淨性門禁 |
| stub 過度簡化 | 掩蓋真實缺陷 | stub 覆蓋失敗/超時/亂序等邊界；契約鎖定真實格式 |
| 性能斷言環境依賴 | CI 機器波動 | 用相對閾值 + 多次取中位；性能門禁與功能門禁分離 |

---

## 9. 開放問題

1. **真實冒煙套件**：是否增設「連真實 YouTube/雲端」的可選冒煙集（手動/定時觸發），與閉環主流程分離。
2. **音頻 fixture 形態**：實時 ASR 的音頻注入採用預錄 PCM 還是合成信號，需與 `StubASR` 契約對齊。
3. **tabCapture 在 CI 的可行性**：headless 下標籤頁音頻擷取的可測邊界，必要時以注入層旁路真實 capture。
4. **覆蓋率目標分層**：domain/application 與 adapters 是否採用不同覆蓋率門檻。
5. **性能門禁閾值標定**：CI runner 性能差異下 P95 閾值的穩定取值。
