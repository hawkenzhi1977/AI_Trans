// copy-static.mjs — 構建後拷貝 manifest.json 等到 dist/。
// 測試模式（TEST_PROFILE=1）：向 content_scripts 追加 localhost mock 站點 match，
// 使 E2E 能在無真實 YouTube 環境下加載擴充；生產 manifest 保持乾淨。
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json', { force: true });

// 拷貝擴充頁面的 HTML（tsc 已編譯同目錄 .js，HTML 需手動拷貝）。
for (const html of [
  'src/runtime/options/options.html',
  'src/runtime/popup/popup.html',
]) {
  const dest = `dist/${html}`;
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
  cpSync(html, dest, { force: true });
  console.log(`[build] copied ${html}`);
}

const TEST_MATCH = 'http://localhost:8721/*';

if (process.env.TEST_PROFILE === '1') {
  const manifestPath = 'dist/manifest.json';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // 向每個 content_script 追加 mock 站點匹配。
  for (const cs of manifest.content_scripts ?? []) {
    cs.matches = [...new Set([...(cs.matches ?? []), TEST_MATCH])];
  }

  // 測試模式注入後，覆蓋層需要在 mock 頁面出現——保持 host_permissions 一致。
  manifest.host_permissions = [
    ...new Set([...(manifest.host_permissions ?? []), TEST_MATCH]),
  ];

  // M1-43：MAIN world 攔截器腳本（web_accessible_resources）在 mock 頁面
  // 也需可加載，否則 E2E 中 content-script 注入 <script> 被 Chrome 拒絕
  // （"Resources must be listed in the web_accessible_resources manifest key"），
  // 捕獲鏈路在 E2E 從未真正工作過（測試盲區）。向每個 WAR 條目的 matches 追加 mock 匹配。
  for (const war of manifest.web_accessible_resources ?? []) {
    war.matches = [...new Set([...(war.matches ?? []), TEST_MATCH])];
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('[build] TEST_PROFILE=1: injected localhost mock match into dist/manifest.json');
}

console.log('[build] copied static assets to dist/');
