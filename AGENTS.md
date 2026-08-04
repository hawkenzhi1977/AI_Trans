# AI_Trans 開發守則（AGENTS.md）

本文件是每次會話必讀的工程約束。它確保代碼、測試、文檔三者一致。

## 1. 項目本質

- Chrome MV3 擴充：YouTube 實時翻譯字幕。
- 架構：Hexagonal（端口與適配器）。domain 穩定核心，adapters 可插拔邊緣。
- 依賴方向：`adapters → domain`；`application → domain`；`runtime` 組裝（DI）。
- 三級字幕策略：一級原生字幕 → 二級預緩衝 ASR（高風險）→ 三級實時 ASR。
- 落地順序：M1（原生字幕）→ M2（實時 ASR）→ M3（預緩衝）。

## 2. 文檔治理（最高優先級）

**任何代碼修改前後，都必須對齊並同步 `doc/project-progress.md`。**
新增特性/功能點時，**必須**同步刷新三份設計文檔：

| 文檔 | 什麼時候改 |
|---|---|
| `doc/requirements-design.md` | 新增功能/需求（新 F 編號）、里程碑範圍變化 |
| `doc/architecture-design.md` | 新增接口/數據結構/適配器/性能機制 |
| `doc/system-test-design.md` | 新增測試用例（新 TC 編號）、測試策略變化 |
| `doc/project-progress.md` | 每次代碼變更後（狀態/技術點/優先級） |

規則：
1. 代碼與進展文檔**一一對應**：每項技術點有落點，每段代碼有條目。
2. 標記 ✅ 前必須有測試覆蓋；部分實現標 🟡。
3. 任何新增特性，先同步設計文檔，再進展文檔，最後才寫代碼（或同一變更內完成）。

## 3. 工程命令

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint flat config
npm run test:all    # build → 31 tests → report merge → cleanup
npm run test:ci     # unit + integration + contract
npm run test:e2e    # Playwright E2E（需先 build 產出 dist/）
```

**任何變更後至少跑 `typecheck` + 相關測試。** 提交前跑完整 `test:all`。

## 4. 代碼風格

- TS strict；`verbatimModuleSyntax`（type-only import 用 `import type`）。
- 中文註釋說明意圖，代碼/標識符用英文。
- 適配器輸入輸出一律使用 domain 內部結構，外部格式轉換留在適配器內。
- 新增 Provider 用 `Map<string, ...>` 顯式標註類型。

## 5. 提交約定

- 只在用戶明確要求時 commit/push。
- commit message 簡潔、匹配 repo 風格（中文描述）。
- 提交前 `git status` + `git diff` 檢查，不提交生成物（dist/、reports/）。
