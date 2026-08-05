import { defineConfig } from 'vitest/config';

/** 集成測試：Orchestrator 端到端串接 stub 引擎與 mock 平臺。jsdom 環境。 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'jsdom',
    // 明文守衛：收集不到任何用例即視為失敗（防範 jsdom 依賴不相容等收集期崩潰被靜默為 0 tests）。
    passWithNoTests: false,
    setupFiles: ['test/support/setup-dom.ts'],
    reporters: ['default', ['junit', { outputFile: 'reports/junit/integration.xml' }]],
  },
});
