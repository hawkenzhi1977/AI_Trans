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
| `doc/project-progress.md` | 進度狀態（✅/🟡/⬜）、優先級、開發順序 | 代碼已存在但進度表未更新 |

## 工作流（每個任務必做）

### Step 0 — 開始前：讀取進展文檔

在任何代碼任務前，先讀 `doc/project-progress.md`。確認：
- 本任務對應哪個里程碑（M1/M2/M3）與哪個技術點編號（如 M1-24）。
- 該技術點當前狀態（✅/🟡/⬜）。

### Step 1 — 修改代碼時

- 只做進展文檔中**標記的技術點**；若任務超出文檔範圍，視為**新增特性**，走 Step 3 同步流程。
- 保持依賴方向：domain 不 import adapters/infrastructure；適配層只 import domain。

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

### Step 4 — 校驗

- 改完後重新跑 `npm run typecheck`、`npm run lint`、`npm run test:all`。
- 確認進展文檔所有 ✅ 項都有對應代碼與測試，所有代碼都有對應條目。
- 如果某項標記 ✅ 但實際是部分實現（如測試只有 3/5 用例），不要標 ✅，保持 🟡。

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

**場景 C：新增性能優化**（如 WebGPU 加速）
1. architecture-design.md §11.5 已是設計內容 → 在進展文檔 X-02 標記進度即可。
2. 若優化引入新機制 → 補進 architecture-design.md §11，並在進展文檔加條目。
