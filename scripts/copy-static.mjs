// copy-static.mjs — 構建後拷貝 manifest.json 等到 dist/。
// 測試模式（TEST_PROFILE=1）：向 content_scripts 追加 localhost mock 站點 match，
// 使 E2E 能在無真實 YouTube 環境下加載擴充；生產 manifest 保持乾淨。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json', { force: true });

// 拷貝擴充頁面的 HTML（tsc 已編譯同目錄 .js，HTML 需手動拷貝）。
for (const html of [
  'src/runtime/options/options.html',
  'src/runtime/popup/popup.html',
  'src/runtime/offscreen.html', // M2-09：Offscreen Document 入口。
]) {
  const dest = `dist/${html}`;
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
  cpSync(html, dest, { force: true });
  console.log(`[build] copied ${html}`);
}

// M2-24：本地化 ONNX Runtime WASM——transformers.js v3 默認從 jsdelivr CDN 載入 wasm，
// 網絡不可達會導致模型下載 100% 後 InferenceSession 初始化失敗（"下載失敗"）。
// 把 onnxruntime-web 的 wasm + worker 腳本拷進擴充，wasmPaths 指向本地。
// 注意：onnxruntime-web v1.22 初始化 wasm backend 時 dynamic import 的是 **jsep** 變體
// （ort-wasm-simd-threaded.jsep.mjs/.wasm）——缺 jsep 文件即報 "no available backend found /
// Failed to fetch dynamically imported module"，因此 jsep 與非 jsep 一併打包。
// v1.23 新增 asyncify 變體（用於某些特殊算子），一併打包以備後端選擇。
const ORT_WASM_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
];
for (const file of ORT_WASM_FILES) {
  const src = `node_modules/onnxruntime-web/dist/${file}`;
  const dest = `dist/src/runtime/ort/${file}`;
  if (!existsSync(src)) {
    console.log(`[build] skip (not in onnxruntime-web): ${file}`);
    continue;
  }
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
  cpSync(src, dest, { force: true });
  console.log(`[build] copied ${dest} (${file})`);
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
