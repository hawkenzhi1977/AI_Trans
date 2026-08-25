// package-release.mjs — 生成最終用戶可直接加載的發布件。
//
// 產出：
//   release/ai-trans-extension/            未打包擴充（可直接「加載已解壓的擴充程序」）
//   release/ai-trans-extension-v<版本>.zip  壓縮包（便於分發）
//
// 與 dist/ 的差別：發布件只含運行必需文件，剔除 sourcemap(.js.map) 與類型聲明(.d.ts)，
// 目錄結構與 manifest 引用路徑保持一致（src/runtime/...）。
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;

const RELEASE_DIR = 'release';
const EXT_DIR = join(RELEASE_DIR, 'ai-trans-extension');
const ZIP_NAME = `ai-trans-extension-v${version}.zip`;

// 1) 生產構建（typecheck + esbuild + copy-static，生成 dist/，不含 TEST_PROFILE）。
console.log('[release] building production bundle...');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCmd, ['run', 'build'], { stdio: 'inherit', shell: true });

// 2) 清空並重建發布目錄。
rmSync(EXT_DIR, { recursive: true, force: true });
mkdirSync(EXT_DIR, { recursive: true });

// 3) 從 dist/ 拷貝運行必需文件，剔除 .js.map 與 .d.ts。
function copyClean(srcDir, destDir) {
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyClean(src, dest);
    } else if (name.endsWith('.js.map') || name.endsWith('.d.ts')) {
      // 跳過：發布件不需要 sourcemap 與類型聲明。
      continue;
    } else {
      cpSync(src, dest, { force: true });
    }
  }
}
copyClean('dist', EXT_DIR);

// 4) 移除 sourcemap 引用註釋，避免瀏覽器控制台 404 警告。
function stripSourceMapRefs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      stripSourceMapRefs(p);
    } else if (name.endsWith('.js')) {
      const text = readFileSync(p, 'utf-8').replace(/\n\/\/# sourceMappingURL=.*$/m, '\n');
      writeFileSync(p, text);
    }
  }
}
stripSourceMapRefs(EXT_DIR);

// 5) 打包 zip（用系統 zip；跨平台由 README 說明備選）。
const zipPath = join(RELEASE_DIR, ZIP_NAME);
rmSync(zipPath, { force: true });
try {
  // 在 ai-trans-extension 目錄內壓縮其內容（zip 根即擴充根）。
  execFileSync('zip', ['-r', '-q', join('..', ZIP_NAME), '.'], {
    cwd: EXT_DIR,
    stdio: 'inherit',
  });
  console.log(`[release] created ${zipPath}`);
} catch {
  console.warn(
    '[release] "zip" 命令不可用，已跳過壓縮包生成；可直接使用未打包目錄 ' + EXT_DIR
  );
}

console.log(`[release] done. 未打包擴充：${EXT_DIR}`);
console.log('[release] 在 Chrome/Edge 打開 chrome://extensions → 開啟開發者模式 → 加載已解壓的擴充程序 → 選擇該目錄。');
