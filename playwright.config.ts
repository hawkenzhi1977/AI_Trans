import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 配置：以 --load-extension 加載擴充，指向本地 Mock YouTube 站點。
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
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium-extension',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--load-extension=dist',
            '--disable-extensions-except=dist',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'node scripts/serve-mock.mjs',
    port: 8721,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
