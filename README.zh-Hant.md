# AI_Trans

**為 YouTube 提供實時翻譯字幕的 Chrome MV3 擴充。**

AI_Trans 會抓取視頻的字幕（未來也支持識別音頻），用可配置的引擎（雲端 LLM 或本地模型）翻譯，並以覆蓋層的形式渲染在播放器上——無需離開頁面。

English version: [README.md](./README.md).

---

## 功能特性

### 已實現（里程碑 M1）

- **原生字幕翻譯**——檢測並抓取 YouTube 原生字幕軌，翻譯後覆蓋顯示在播放器上。
- **覆蓋層字幕渲染**——支持單語或雙語（原文＋譯文），渲染於獨立覆蓋層並對齊播放時間。
- **播放狀態同步**——字幕隨當前時間、暫停、快進同步（媒體事件 + `requestAnimationFrame` 對齊）。
- **可配置翻譯引擎**——雲端 LLM（OpenAI 兼容 `/chat/completions`）為主、傳統 MT 兜底；端點、模型、API Key 由用戶配置。API Key 與配置對象分離存儲。
- **目標語言與字幕樣式**——可選目標語言、顯示模式（單語/雙語）、字號、顏色、背景。
- **Options 與 Popup 配置界面**——完整設定頁 + 快捷彈出頁（狀態顯示 + 重新載入）。
- **可靠性加固的內容腳本**——宿主方法綁定（避免 "Illegal invocation"）、配置熱重載時無訂閱洩漏、外部 JSON 容錯解析（詳見 `AGENTS.md` §5）。

### 待實現（後續里程碑）

- **M2 — 實時 ASR**（`F-06`、`F-07`）：對無字幕視頻擷取標籤頁音頻，做流式 ASR + 翻譯。本地 Whisper（WASM/WebGPU）與雲端 ASR，均可配置。
- **M3 — 預緩衝提前處理**（`F-08`）：對「無字幕但可預取音頻」的視頻，提前對已緩衝音頻做 ASR（較高風險 / 屬優化）。
- **更多平台**（YouTube 之外）。

> 目前僅 M1（原生字幕路徑）達到可用狀態。三級字幕策略（原生 → 預緩衝 ASR → 實時 ASR）已完整設計，見 `doc/`。

---

## 方式一：直接使用發布件（無需構建）

預構建的發布件位於 [`release/`](./release/)：

- `release/ai-trans-extension/` — 未打包擴充目錄（推薦）。
- `release/ai-trans-extension-v0.1.0.zip` — 壓縮包。

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

- **翻譯引擎**：雲端 LLM / 本地 / MT，模型、端點、API Key、兜底引擎。
- **ASR 引擎**（供未來 M2）：本地 Whisper / 雲端，模型檔位，端點。
- **目標語言**、**顯示模式**（單語/雙語）、**性能檔位**。
- **字幕樣式**：字號、顏色、背景。

API Key 寫入獨立安全存儲槽，絕不嵌入明文配置對象。

---

## 架構（簡述）

六邊形架構（端口與適配器）：穩定的 `domain` 核心、可插拔的 `adapters`、`application` 調度器，以及負責組裝（DI）的 `runtime`。依賴方向恆為 `adapters/application → domain`。

完整設計見 [`doc/`](./doc/)：

- `doc/requirements-design.md` — 需求、功能（F-01…F-09）、里程碑。
- `doc/architecture-design.md` — 端口、適配器、數據結構、實時性分析。
- `doc/system-test-design.md` — 測試策略、分層用例（TC-*）。
- `doc/project-progress.md` — 實時進度表。

工程守則（含內容腳本可靠性紅線）見 [`AGENTS.md`](./AGENTS.md)。

---

## 授權

MIT。
