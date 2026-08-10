import { defineConfig } from 'vitest/config';

/** 單元測試：domain 模型與 application 管線純邏輯。Node 環境。 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // 明文守衛：收集不到任何用例即視為失敗（防範收集期崩潰被靜默為 0 tests 通過）。
    passWithNoTests: false,
    reporters: ['default', ['junit', { outputFile: 'reports/junit/unit.xml' }]],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'reports/coverage/unit',
      reporter: ['text-summary', 'lcov'],
      include: ['src/domain/**', 'src/application/**'],
    },
  },
  resolve: {
    alias: {
      // @huggingface/transformers 為可選依賴，測試中 mock 為空模塊。
      '@huggingface/transformers': new URL('./test/support/mock-huggingface-transformers.ts', import.meta.url).pathname,
    },
  },
});
