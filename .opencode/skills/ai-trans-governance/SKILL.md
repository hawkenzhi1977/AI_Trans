---
name: ai-trans-governance
description: AI_Trans 項目文檔治理與進度同步。使用時機：任何代碼修改、新增功能、設計變更、測試調整前後，需對齊 doc/project-progress.md 並同步刷新 doc/requirements-design.md、doc/architecture-design.md、doc/system-test-design.md。當用戶提到「對齊進展文檔」「同步設計文檔」「刷新進度」「進展記錄」「設計變更」時觸發。
---

# AI_Trans 文檔治理（Doc-Sync Governance）

本技能確保**代碼與四份核心文檔永遠一致**。所有工作必須對齊 `doc/project-progress.md`；任何新增特性/技術點都要回寫三份設計文檔與進展文檔。

## 四份核心文檔與職責

| 文檔 | 職責 | 失配時如何判別 |
|---|---|---|
| `doc/requirements-design.md` | 需求、功能（F-01~F-09）、里程碑 M1~M4 | 新功能沒有 F 編號或里程碑條目 |
| `doc/architecture-design.md` | 端口/適配器/數據結構/實時性/里程碑映射 | 新增代碼結構沒有對應章節落點 |
| `doc/system-test-design.md` | 測試策略、分層、用例 TC-*、CI 閉環 | 新增測試沒有對應用例編號 |
| `doc/diagnostics-design.md` | 診斷信息、錯誤消息、降級邏輯、診斷碼 | 新增/修改診斷點沒有對應文檔條目 |
| `doc/project-progress.md` | 進度狀態（✅/🟡/⬜）、優先級、開發順序 | 代碼已存在但進度表未更新 |
| `README.md` / `README.zh-Hant.md` | 功能特性（已實現/待實現）、安裝/構建步驟、命令、配置項 | README 描述與實際代碼/里程碑狀態不符 |
| `release/`（發布件）+ `release/README.md` | 用戶可加載的擴充產物與快速安裝說明 | 發布件與源碼版本不一致 |

### README 一致性規則

- `README.md`（英文）與 `README.zh-Hant.md`（中文）內容等價，任一改動必同步另一份。
- README 的「已實現」功能必須在 `doc/project-progress.md` 中標 ✅；「待實現」對應 🟡/⬜；不得超前聲稱。
- 安裝/構建步驟中的命令（`npm run build`、`npm run release` 等）必須與 `package.json` scripts 一致。

### 發布件一致性規則

- 改動影響用戶可見行為（字幕邏輯、配置頁、popup）、manifest、runtime 產物或加載方式時，必須重新 `npm run release` 生成 `release/`，並提交更新的發布件。
- 發布件版本（zip 名中的版本號）必須與 `package.json` 的 `version` 字段一致。
- `release/README.md` 的加載步驟若有變化（目錄結構、manifest 路徑），需同步更新。

## 工作流（每個任務必做）

### Step 0 — 開始前：讀取進展文檔

在任何代碼任務前，先讀 `doc/project-progress.md`。確認：
- 本任務對應哪個里程碑（M1/M2/M3）與哪個技術點編號（如 M1-24）。
- 該技術點當前狀態（✅/🟡/⬜）。

### Step 1 — 修改代碼時

- 只做進展文檔中**標記的技術點**；若任務超出文檔範圍，視為**新增特性**，走 Step 3 同步流程。
- 保持依賴方向：domain 不 import adapters/infrastructure；適配層只 import domain。
- **同步寫測試**：改純邏輯（domain/application/adapter）必補單元/集成測試；修 bug 先寫能復現的失敗測試（紅→綠）；改 content-script/DOM/播放驅動/注入行為必補 E2E。
- **逐條自查 §可靠性紅線**（見下方「代碼可靠性紅線自查清單」），這些陷阱 jsdom 單測不暴露，只在真實瀏覽器崩潰。

### Step 1.5 — 代碼可靠性紅線自查清單（改 runtime/adapters 必查）

| # | 紅線 | 自查點 | 對應專屬測試 |
|---|---|---|---|
| R1 | 宿主方法綁定接收者 | `fetch`/`postMessage`/`navigator.*`/`chrome.*` 賦值或作回調前有無 `.bind()`？默認 fetch 一律 `globalThis.fetch.bind(globalThis)`，禁裸 `fetch`/`?? fetch` | 斷言傳入 mock fetchFn 被以正確 this 調用 |
| R2 | URL 絕對化 | 傳 `fetch()`/`new URL()` 的字符串是否 `new URL(x, location.href)` 解析 | 斷言相對 baseUrl 被解析為絕對 URL |
| R3 | 禁全量覆寫共享容器 | overlay/文本是否寫在自建子節點，未對播放器容器 `.textContent=`/`.innerHTML=`/`.replaceChildren()` | E2E：暫停/改配置後覆蓋層節點仍 attached |
| R4 | 註冊必配解除 | 每處 `addEventListener`/`observe`/`setInterval`/`rAF`/`subscribe`/`observePlayback` 有無存 handle 並在 stop/cleanup 解除？restart 前是否完整清上一輪？unsubscribe 返回值有無丟棄？ | 斷言 stop 後 unsubscribe 被調用；restart×N 後監聽器數不增長 |
| R5 | async 組裝/事件驅動 | Promise 有無 await 或 `void ...catch`？`translateStream` 有無 try/catch+fallback+降級事件？等待型 Observer 有無超時避免懸掛？ | 斷言 stream 失敗走 fallback 並發降級事件 |
| R6 | 不用可選鏈掩蓋缺失 | `platforms[0]?.foo()` 這類是否把「本應存在卻缺失」變靜默無錯？異常應顯式判空報錯/發降級 | 斷言缺失時發 degraded 事件而非靜默 |
| R7 | 外部 JSON/DOM 容錯 | 選擇器精確（避免 `script:not([src])` 誤匹配）？`JSON.parse` 外部內容有無 try/catch 兜底？ | 斷言非法 JSON/多內聯腳本時不誤判降級 |
| R8 | innerHTML/cssText 注入 | 拼 innerHTML 文本有 escape？拼 cssText 用 `style.setProperty(k,v)`？ | 斷言注入字符被轉義 |

### Step 2 — 修改後：更新進展文檔

任務完成後，同步 `doc/project-progress.md`：
- 完成 → 狀態改 ✅，若該項屬里程碑末項則里程碑狀態也更新。
- 部分完成 → 保持 🟡，補充說明。
- 新增技術點 → 加到對應里程碑小節（含優先級、順序、狀態、落點）。

### Step 3 — 新增特性/功能點：同步三份設計文檔

當新增的功能、接口、適配器、數據結構、測試、風險不在現有設計文檔中時，**必須**回寫：

| 文檔 | 在哪加 |
|---|---|
| requirements-design.md | §2 功能需求表（新 F 編號）、§3 流程、§6 模塊、§8 里程碑 |
| architecture-design.md | §5 目錄結構、§6 數據結構、§7 接口、§12 里程碑映射、§13 開放問題 |
| system-test-design.md | §7 測試用例表（新 TC 編號）、§5 測試分層 |
| diagnostics-design.md | 對應業務流程章節（新診斷碼、錯誤消息、降級邏輯） |

### Step 4 — 校驗

- 改完後重新跑 `npm run typecheck`、`npm run lint`、`npm run test:all`。
- 確認進展文檔所有 ✅ 項都有對應代碼與測試，所有代碼都有對應條目。
- 如果某項標記 ✅ 但實際是部分實現（如測試只有 3/5 用例），不要標 ✅，保持 🟡。
- **三者一致性最終核對**：設計文檔的接口/行為 = 代碼實現 = 測試斷言，一一對應；新增測試在 system-test-design.md 有 TC 編號；§可靠性紅線涉及項有專屬回歸測試。
- **README 與發布件核對**：若改動涉及用戶可見行為/命令/manifest → 同步 `README.md` + `README.zh-Hant.md`（兩份等價），重跑 `npm run release` 更新 `release/`，確認發布件版本與 `package.json` 一致、README 步驟仍可行。

## 狀態語義

- ✅ 已完成：功能交付 + 有測試覆蓋 + 進展文檔標記
- 🟡 進行中：有代碼骨架/部分實現，或測試基礎設施搭建中
- ⬜ 待完成：尚未開始

## 常見場景

**場景 A：新增一個適配器**（如 CloudASR）
1. 在 `src/adapters/asr/cloud-asr.ts` 實現 `ASRProvider` 端口。
2. 進展文檔 M2-06 改為 ✅/🟡。
3. architecture-design.md §7.4 若無此適配器則補一行，§5 目錄樹補文件。
4. system-test-design.md 若新增測試則給 TC 編號。
5. 跑測試驗證。

**場景 B：修改現有功能**（如翻譯管線降級邏輯）
1. 若只是修 bug，不新增功能 → 只更新進展文檔的技術點說明。
2. 若改變了接口或行為 → 更新 architecture-design.md §7/§10 對應章節。
3. **修 bug 必先寫失敗測試**（紅→綠回歸）；若屬 §可靠性紅線（洩漏/綁定/覆寫）則補專屬回歸測試 + 必要時 E2E。

**場景 D：修可靠性紅線問題**（如 restart 訂閱洩漏、fetch 未綁定）
1. 先寫能復現的失敗測試（如斷言 restart 後 unsubscribe 被調用、監聽器數不增長）。
2. 修代碼；跑測試確認紅→綠。
3. architecture-design.md §7.1「content-script 運行時約束」補記該陷阱與規範。
4. system-test-design.md 給新 TC 編號；project-progress.md 加技術點條目（含落點）。
5. AGENTS.md §5 可靠性紅線若出現新類型，補一條。

**場景 E：改動用戶可見行為 / 發布相關**（如新增配置項、改 manifest、改 popup）
1. 更新代碼 + 對應測試。
2. 同步 `README.md` 與 `README.zh-Hant.md`（功能特性、配置說明、命令；兩份等價）。
3. 重跑 `npm run release` 生成最新 `release/`，核對版本號與 `release/README.md` 步驟。
4. 若屬新特性 → 同步四份設計/進展文檔（走場景 A 流程）。

**場景 C：新增性能優化**（如 WebGPU 加速）
1. architecture-design.md §11.5 已是設計內容 → 在進展文檔 X-02 標記進度即可。
2. 若優化引入新機制 → 補進 architecture-design.md §11，並在進展文檔加條目。
