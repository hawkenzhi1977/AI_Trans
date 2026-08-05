// CI 測試分段執行器——unit / integration / contract 三段獨立跑，任一段失敗不短路後續，
// 各自產出 junit（reports/junit/*.xml），末尾統一判定退出碼。
//
// 動機（實裝血淚，見 system-test-design §3.4）：原 `test:ci` 用 `a && b && c` 串聯，
// 某段在「收集/import 階段」崩潰（如 jsdom 依賴不相容 → junit tests=0、退出碼 1）會 && 短路，
// 令後續段完全不執行、報告缺失，排查時無法區分「單段崩潰」與「真實用例失敗」。
// 本腳本保證：每段都跑、每段都產報告、退出碼反映「是否有任一段失敗」。
import { spawnSync } from 'node:child_process';

/** @type {{ name: string; config: string }[]} */
const stages = [
  { name: 'unit', config: 'vitest.unit.config.ts' },
  { name: 'integration', config: 'vitest.integration.config.ts' },
  { name: 'contract', config: 'vitest.contract.config.ts' },
];

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** @type {{ name: string; code: number }[]} */
const results = [];

for (const stage of stages) {
  console.log(`\n[run-ci-tests] ▶ ${stage.name} (${stage.config})`);
  const proc = spawnSync(npx, ['vitest', 'run', '--config', stage.config], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  // spawnSync 執行本身失敗（如找不到 npx）時 status 為 null → 視為失敗。
  const code = proc.status ?? 1;
  results.push({ name: stage.name, code });
  console.log(`[run-ci-tests] ${code === 0 ? '✓' : '✗'} ${stage.name} exit=${code}`);
}

const failed = results.filter((r) => r.code !== 0);

console.log('\n[run-ci-tests] 匯總：');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.name} (exit ${r.code})`);
}

if (failed.length > 0) {
  console.error(`\n[run-ci-tests] ✗ ${failed.length} 段失敗：${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}

console.log('\n[run-ci-tests] ✓ 全部通過');
