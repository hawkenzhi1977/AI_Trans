import { defineConfig } from 'vitest/config';

/** 契約測試：鎖定外部易變接口的格式轉換（timedtext 解析、引擎調用契約）。jsdom 提供 DOMParser。 */
export default defineConfig({
  test: {
    name: 'contract',
    include: ['test/contract/**/*.test.ts'],
    environment: 'jsdom',
    reporters: ['default', ['junit', { outputFile: 'reports/junit/contract.xml' }]],
  },
});
