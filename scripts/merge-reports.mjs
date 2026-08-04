// 測試報告合併——將 JUnit XML 合併為單一報告文件，供 CI 讀取。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const reportsDir = join(process.cwd(), 'reports/junit');
const outDir = join(process.cwd(), 'reports');
mkdirSync(outDir, { recursive: true });

const files = existsSync(reportsDir)
  ? readdirSync(reportsDir).filter((f) => f.endsWith('.xml'))
  : [];

if (files.length === 0) {
  console.warn('merge-reports: no junit xml found, skipping');
  process.exit(0);
}

const parts = files.map((f) =>
  readFileSync(join(reportsDir, f), 'utf-8').replace(/<\?xml[^>]*\?>/g, '')
);

const merged = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
${parts.join('\n')}
</testsuites>
`;

writeFileSync(join(outDir, 'junit-merged.xml'), merged);
console.log(`merge-reports: merged ${files.length} suites -> reports/junit-merged.xml`);
