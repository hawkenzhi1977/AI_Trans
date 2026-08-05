# AI_Trans — 發布件安裝說明 / Installation Guide

此目錄為可直接加載的 Chrome MV3 擴充發布件。
This directory is a ready-to-load Chrome MV3 extension release.

- `ai-trans-extension/` — 未打包擴充目錄（推薦用於「加載已解壓的擴充程序」）
  Unpacked extension folder (use "Load unpacked").
- `ai-trans-extension-v0.1.0.zip` — 壓縮包（便於分發，需先解壓）
  Zip archive (for distribution; unzip before loading).

---

## 中文：安裝步驟（Windows / macOS / Linux 通用）

Chrome 擴充的加載方式在三個平台完全相同（Chrome / Edge / Brave 等 Chromium 內核瀏覽器）。

1. 若使用 zip，先解壓得到 `ai-trans-extension/` 目錄。
2. 打開瀏覽器，地址欄輸入 `chrome://extensions`（Edge 為 `edge://extensions`）並回車。
3. 打開右上角的「開發者模式 / Developer mode」開關。
4. 點擊「加載已解壓的擴充程序 / Load unpacked」。
5. 選擇 `ai-trans-extension/` 目錄（含 `manifest.json` 的那一層）。
6. 打開任意 YouTube 視頻頁（`https://www.youtube.com/watch?v=...`）。
7. 點擊工具欄的 AI_Trans 圖標 → 「設定」配置翻譯引擎與目標語言。

> 各平台目錄選擇差異僅在文件對話框；擴充本身無平台差異。

## English: Install steps (Windows / macOS / Linux)

Loading is identical on all three OSes and any Chromium browser (Chrome / Edge / Brave).

1. If you have the zip, unzip it to get the `ai-trans-extension/` folder.
2. Open your browser and go to `chrome://extensions` (or `edge://extensions`).
3. Enable "Developer mode" (top-right toggle).
4. Click "Load unpacked".
5. Select the `ai-trans-extension/` folder (the one containing `manifest.json`).
6. Open any YouTube watch page (`https://www.youtube.com/watch?v=...`).
7. Click the AI_Trans toolbar icon → "設定/Settings" to configure the engine and target language.

---

完整功能說明、源碼構建見項目根目錄 `README.md`（English）與 `README.zh-Hant.md`（中文）。
For full features and building from source, see `README.md` / `README.zh-Hant.md` in the project root.
