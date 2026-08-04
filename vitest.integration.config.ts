import { defineConfig } from 'vitest/config';

/** 集成測試：Orchestrator 端到端串接 stub 引擎與 mock 平臺。jsdom 環境。 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/integration/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['test/support/setup-dom.ts'],
    reporters: ['default', ['junit', { outputFile: 'reports/junit/integration.xml' }]],
  },
});
