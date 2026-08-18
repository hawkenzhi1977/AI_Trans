// build.mjs — MV3 擴充打包：esbuild 把各入口 bundle 為單文件。
// Chrome MV3 的 content script 不支持 import 語句（非 module 上下文），故打包為 IIFE；
// SW 聲明為 module 型（manifest "type": "module"）可用 ESM；options/popup 為普通 <script>，用 IIFE。
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';

const outdir = 'dist';

// 清掉舊 tsc 直編產物（esbuild 只輸出 runtime 入口；殘留的 adapters/domain 等舊物不再需要）。
for (const stale of [
  'dist/src/adapters',
  'dist/src/application',
  'dist/src/domain',
  'dist/src/infrastructure',
  'dist/src/runtime/composition.js',
  'dist/src/runtime/composition.d.ts',
  'dist/src/runtime/composition.js.map',
]) {
  rmSync(stale, { recursive: true, force: true });
}

// 入口 → [輸出路徑, 格式]
const ENTRY_POINTS = [
  ['src/runtime/content-script.ts', 'src/runtime/content-script.js', 'iife'],
  ['src/runtime/service-worker.ts', 'src/runtime/service-worker.js', 'esm'],
  ['src/runtime/options/options.ts', 'src/runtime/options/options.js', 'iife'],
  ['src/runtime/popup/popup.ts', 'src/runtime/popup/popup.js', 'iife'],
  // MAIN world 攔截腳本：獨立打包（被 content-script 以 <script src> 注入頁面，
  // 不能與 content-script 共用 bundle，也必須是 IIFE 以在非 module 上下文執行）。
  ['src/runtime/yt-timedtext-interceptor.ts', 'src/runtime/yt-timedtext-interceptor.js', 'iife'],
  // Offscreen Document（M2-09）：offscreen.html 以普通 <script> 引用（非 module），
  // 故為 IIFE；打包 transformers.js（M2-18 已驗證可完整打入 IIFE，content-script 即此模式）。
  ['src/runtime/offscreen.ts', 'src/runtime/offscreen.js', 'iife'],
];

mkdirSync(outdir, { recursive: true });

for (const [entry, outfile, format] of ENTRY_POINTS) {
  await build({
    entryPoints: [entry],
    outfile: `${outdir}/${outfile}`,
    bundle: true,
    format,
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
    logLevel: 'warning',
  });
  console.log(`[build] bundled ${entry} -> ${outfile} (${format})`);
}

console.log('[build] esbuild bundling done');
