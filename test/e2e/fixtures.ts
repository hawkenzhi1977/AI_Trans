// E2E 自定義 fixture：以 launchPersistentContext 加載擴充。
//
// 背景：Playwright 默認的 chromium.launch()+newContext() 不會注入擴充；
// 必須用 launchPersistentContext。且 headless 模式下默認走 headless_shell
// （不支持 --load-extension），需 channel:'chromium' 強制用完整 Chromium 內核。
// 同時必須 ignoreDefaultArgs:['--disable-extensions']，否則 Playwright 會注入
// --disable-extensions 導致擴充永不加載。
import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 擴充構建產物位於 <repo>/dist。用絕對路徑避免 persistent context 的 cwd 差異。
const EXT_PATH = path.resolve(__dirname, '../../dist');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 720 },
      // 移除 Playwright 默認注入的 --disable-extensions，否則擴充永不載入。
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },
});

export { expect } from '@playwright/test';
