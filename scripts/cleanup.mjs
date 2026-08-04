// 環境恢復——清理測試產物與臨時進程殘留，保證閉環無殘留。
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const targets = [
  'reports/junit',
  'reports/junit-merged.xml',
  'reports/coverage',
  'test-results', // Playwright 默認輸出
  'playwright-report',
  '.vitest',
];

let removed = 0;
for (const t of targets) {
  const p = join(process.cwd(), t);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    removed += 1;
    console.log(`cleanup: removed ${t}`);
  }
}

console.log(`cleanup: done (${removed} path(s) cleared)`);
