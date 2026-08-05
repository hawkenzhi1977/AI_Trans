import { defineConfig } from 'vitest/config';

/** 契約測試：鎖定外部易變接口的格式轉換（timedtext 解析、引擎調用契約）。jsdom 提供 DOMParser。 */
export default defineConfig({
  test: {
    name: 'contract',
    include: ['test/contract/**/*.test.ts'],
    environment: 'jsdom',
    // 明文守衛：收集不到任何用例即視為失敗（防範收集期崩潰被靜默為 0 tests 通過）。
    passWithNoTests: false,
    reporters: ['default', ['junit', { outputFile: 'reports/junit/contract.xml' }]],
  },
});
