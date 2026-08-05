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

// 質量守衛：任一 suite tests=0 通常意味著該階段在收集/import 期崩潰（而非真的無用例），
// junit 會靜默寫出空報告，容易被 && 短路掩蓋。此處顯式 warn 以便 CI 日誌可見。
for (const f of files) {
  const content = readFileSync(join(reportsDir, f), 'utf-8');
  const m = content.match(/<testsuites[^>]*\btests="(\d+)"/);
  if (m && Number(m[1]) === 0) {
    console.warn(
      `merge-reports: ⚠ ${f} 報告 tests=0——該階段可能於收集/初始化期崩潰（非真正無用例），請檢查完整日誌`
    );
  }
}

const merged = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
${parts.join('\n')}
</testsuites>
`;

writeFileSync(join(outDir, 'junit-merged.xml'), merged);
console.log(`merge-reports: merged ${files.length} suites -> reports/junit-merged.xml`);
