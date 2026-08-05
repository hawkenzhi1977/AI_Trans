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
| `README.md` / `README.zh-Hant.md` | 功能特性（已實現/待實現）、安裝/構建步驟、命令、配置項變化；兩份必須同步（內容等價，僅語言不同） |
| `release/`（發布件） + `release/README.md` | 用戶可見行為/構建產物結構/加載步驟變化；發布件須用當前源碼重新生成（`npm run release`） |

規則：
1. 代碼與進展文檔**一一對應**：每項技術點有落點，每段代碼有條目。
2. 標記 ✅ 前必須有測試覆蓋；部分實現標 🟡。
3. 任何新增特性，先同步設計文檔，再進展文檔，最後才寫代碼（或同一變更內完成）。
4. **README 一致性**：`README.md`（英文）與 `README.zh-Hant.md`（中文）內容等價，任一改動必同步另一份；README 描述的功能「已實現/待實現」狀態必須與 `doc/project-progress.md` 的里程碑狀態一致（不得把待實現說成已實現）。
5. **發布件一致性**：改動影響用戶可見行為、manifest、runtime 產物或加載方式時，必須用當前源碼重新 `npm run release` 生成 `release/`，並核對 README 的安裝/構建步驟與命令仍準確；發布件不得落後於源碼版本（`package.json` 的 `version` 與 zip 名一致）。

## 3. 工程命令

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint flat config
npm run build       # 生產構建到 dist/（typecheck + esbuild 打包 + copy-static）
npm run release     # 生成用戶發布件 release/ai-trans-extension(+.zip)
npm run test:all    # build → 66 tests → report merge → cleanup
npm run test:ci     # unit + integration + contract
npm run test:e2e    # Playwright E2E（需先 build 產出 dist/）
```

**任何變更後至少跑 `typecheck` + 相關測試。** 提交前跑完整 `test:all`。

## 4. 代碼風格

- TS strict；`verbatimModuleSyntax`（type-only import 用 `import type`）。
- 中文註釋說明意圖，代碼/標識符用英文。
- 適配器輸入輸出一律使用 domain 內部結構，外部格式轉換留在適配器內。
- 新增 Provider 用 `Map<string, ...>` 顯式標註類型。

## 5. 代碼可靠性紅線（Content-Script / MV3 真實環境陷阱）

以下問題**在 jsdom 單元測試中不會暴露，只在真實瀏覽器（content script isolated world、連續媒體事件、SPA 導航、多次改配置）才崩潰**。這是本項目血淚教訓的沉澱，寫新代碼與 review 時**必須逐條自查**：

### 5.1 宿主方法必須綁定接收者（Illegal invocation）
- `window.fetch`、`postMessage`、`navigator.*`、`chrome.*` 等宿主方法**賦值給變量或作回調傳遞前，必須 `.bind(宿主對象)`**。
- content-script 中裸調用 `fetch(...)`／`const f = window.fetch; f(...)` 會拋 `TypeError: Illegal invocation`。
- **統一規範**：所有適配器內默認 fetch 一律 `globalThis.fetch.bind(globalThis)`，禁止裸 `fetch` 或 `?? fetch`。參見 `FetchCaptionSource`（platform-adapter.ts）。

### 5.2 URL 必須解析為絕對路徑
- 傳入 `fetch()` / `new URL()` 的字符串可能是相對路徑（尤其測試 Mock 站點），content-script 的 base 非預期。
- **統一規範**：`new URL(maybeRelative, globalThis.location?.href ?? maybeRelative).href`。

### 5.3 禁止對「掛載了他人子節點的容器」做全量覆寫
- 對播放器容器等共享節點使用 `.textContent =`／`.innerHTML =`／`.replaceChildren()` 會刪除覆蓋層等子節點。
- overlay/占位文本必須寫在**自己創建的獨立子節點**上，不碰宿主容器本身。

### 5.4 註冊必配解除（洩漏零容忍）
- `addEventListener` / `MutationObserver.observe` / `setInterval` / `requestAnimationFrame` / `store.subscribe` / `observePlayback` **每一處註冊都必須保存 handle 並在對應 stop/cleanup 中解除**。
- **重點**：任何會被多次調用的路徑（如 `restart()`）在重建前必須完整清理上一輪的全部訂閱，否則監聽器隨改配置線性累積 → 內存洩漏 + CPU 空轉。
- `observePlayback()` 等返回 unsubscribe 的方法，**返回值不得丟棄**。
- 等待型 `MutationObserver`（如等播放器出現）必須：存 handle、可被 stop 中斷、加超時避免 Promise 永久懸掛。

### 5.5 async 組裝與事件驅動
- 所有 async 初始化的 Promise 必須 `await` 或顯式 `void ...catch(...)`；不得留未捕獲的懸掛 Promise。
- 流式方法（`translateStream`）與非流式一樣要有 try/catch + fallback + 降級事件，不能只在 `translate()` 做降級。
- 測試 Mock 中驅動 `currentTime` 等媒體狀態，**必須 `dispatchEvent(new Event('timeupdate'))`**，直接賦值不觸發監聽（真實 <video> 由事件驅動）。

### 5.6 不用可選鏈掩蓋真實缺失
- `registry.platforms[0]?.foo()` 這類會把「本應存在卻缺失」變成靜默無錯（字幕不動卻無日誌）。缺失屬異常時應顯式判空並報錯/發降級事件。

### 5.7 外部 JSON / DOM 解析必須容錯
- 選擇器要精確（避免 `script:not([src])` 誤匹配任意內聯腳本）；`JSON.parse` 外部內容必須 try/catch 兜底，禁止讓 parse 錯誤冒泡成功能降級誤判。

### 5.8 innerHTML / cssText 注入
- 拼進 `innerHTML` 的文本必須 escape；優先用 `textContent` + `createElement`。
- 拼進 `cssText` 的樣式值優先用 `style.setProperty(k, v)`（瀏覽器會拒非法值）。

## 6. 測試與一致性強制要求（每次代碼修改都適用）

**任何代碼修改，都必須同時完成對應測試，並保障「設計 ↔ 代碼 ↔ 測試」三者一致。**

1. **改代碼必補/改測試**：
   - 新增/修改**純邏輯**（domain/application/adapter）→ 必須有對應**單元或集成測試**覆蓋新行為與邊界。
   - 修 bug → 必須先寫一個**能復現該 bug 的失敗測試**，再修，確保紅→綠（回歸測試）。
   - 涉及 content-script / DOM / 播放驅動 / 擴充注入的行為 → 必須有 **E2E（Playwright）** 覆蓋，因為第 5 節的陷阱只有 E2E 或瀏覽器環境才能捕獲。
2. **§5 紅線項的專屬測試**：涉及 fetch 綁定、訂閱解除、URL 解析、DOM 掛載等，需寫針對性測試（如：斷言 `observePlayback` 的 unsubscribe 被調用、restart 後監聽器數不增長）。
3. **一致性校驗**（提交/收尾前必做）：
   - 設計文檔（requirements/architecture）中的接口/行為 = 代碼實現 = 測試斷言，三者一一對應。
   - 每個進展文檔標 ✅ 的技術點都必須有對應測試；部分覆蓋只能標 🟡。
   - 新增測試必須在 `system-test-design.md` 有 TC 編號。
4. **驗證命令**：改完跑 `npm run typecheck` + `npm run lint` + 相關測試；提交前跑完整 `npm run test:all`（含 E2E）並全綠。

## 7. 提交約定

- 只在用戶明確要求時 commit/push。
- commit message 簡潔、匹配 repo 風格（中文描述）。
- 提交前 `git status` + `git diff` 檢查，不提交生成物（dist/、reports/）。
