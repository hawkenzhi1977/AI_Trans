import { defineConfig } from 'vitest/config';

/** 單元測試：domain 模型與 application 管線純邏輯。Node 環境。 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', ['junit', { outputFile: 'reports/junit/unit.xml' }]],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'reports/coverage/unit',
      reporter: ['text-summary', 'lcov'],
      include: ['src/domain/**', 'src/application/**'],
    },
  },
});
