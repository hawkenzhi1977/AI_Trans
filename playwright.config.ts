import { defineConfig } from '@playwright/test';

/**
 * E2E 配置：擴充加載由 test/e2e/fixtures.ts 的 launchPersistentContext 自定義
 * context 接管（Playwright 默認 context 不注入擴充）。此處只保留基址與超時。
 * WebServer 自動拉起 mock:serve，測試完自動關閉。
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://localhost:8721',
  },
  webServer: {
    command: 'node scripts/serve-mock.mjs',
    port: 8721,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
