# AI_Trans 系統測試設計文檔

> 版本：v0.1（草案）
> 狀態：系統測試設計 — 全閉環自動化測試、測試用例
> 關聯文檔：`doc/requirements-design.md`、`doc/architecture-design.md`
> 最後更新：2026-08-05（新增 TC-R 可靠性紅線回歸系列）

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

**紅線**：任何依賴變更（尤其 `jsdom`）後，必須本地 `npm install` 更新 lockfile 並跑 `test:ci` 確認**集成用例數不為 0**；`npm warn EBADENGINE` 不可忽視。`test:ci` 現為 `&&` 串聯，單段收集期崩潰會短路掩蓋後續 contract/E2E 報告——排查時須以完整 CI 日誌（非僅 junit）確認真實錯誤。

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
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
        uses: actions/upload-artifact@v4
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

#### TC-F06 實時擷取 ASR（對應 F-06）
- 前置：打開 `no-captions.html`，注入音頻 fixture 與 `StubASR`。
- 步驟：啟用擴充 → 授權音頻擷取（測試中自動放行）。
- 預期：provisional 字幕先顯示（`revision` 遞增），隨後被最終結果修正；`origin=realtime-asr`。

#### TC-F07 ASR 引擎配置（對應 F-07）
- 步驟：切換本地 Whisper ↔ 雲端 ASR（均為 stub）。
- 預期：`Registry` 選中對應 `ASRProvider`；識別路徑切換正確。

#### TC-F08 預緩衝提前處理與降級（對應 F-08）
- 前置：可預取音頻的 mock 場景。
- 步驟 A：預取可用 → 走二級 look-ahead。
- 步驟 B：模擬預取失效（`changed-dom.html`）→ 觸發降級。
- 預期：A 中字幕領先播放頭；B 中發射 `strategy-degraded(lookahead→realtime)`，字幕不中斷、下游數據結構不變。

#### TC-F09 字幕樣式設置（對應 F-09）
- 步驟：修改字號/顏色/位置/背景透明度。
- 預期：覆蓋層樣式即時生效；配置持久化。

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

> 已實裝 E2E 共 11 個用例（`test/e2e/smoke.spec.ts` 5 + `test/e2e/extension.spec.ts` 6，含 TC-R3 覆蓋層不累積），全綠。TC-E01/02 覆蓋擴充注入與渲染全鏈路，TC-E03 為宿主與端點基線。

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

> 全部測試合計 66（單元 25 + 契約 5 + 集成 25 + E2E 11）。R 系列為 §5 紅線的專屬回歸，改動相關代碼須保持這些斷言不破。

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
| TC-F06 | F-06 | E2E |
| TC-F07 | F-07 | 集成 |
| TC-F08 | F-08 | 集成/E2E |
| TC-F09 | F-09 | E2E |
| TC-DEGRADE | 架構§10 | 單元/集成 |
| TC-E01 | F-01/F-02 | E2E（已實裝） |
| TC-E02 | F-01/F-03 | E2E（已實裝） |
| TC-E03 | 宿主基線 | E2E（已實裝） |
| TC-R1~R7 | AGENTS.md §5 可靠性紅線 / architecture §7.1 | 單元/集成/E2E（已實裝） |
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
