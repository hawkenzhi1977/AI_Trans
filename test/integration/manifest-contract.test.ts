// 契約測試：源 manifest.json 的 web_accessible_resources 完整性。
// 防止回歸——content-script（LocalWhisperASR）在宿主頁面環境載入擴充資源需 WAR 白名單，
// 缺 `src/runtime/ort/*` 會導致 wasm 後端「Failed to fetch ... jsep.mjs」（補充修復十）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(__dirname, '../../manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
  web_accessible_resources?: Array<{ resources?: string[] }>;
};

function warResources(): string[] {
  return (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []);
}

describe('manifest web_accessible_resources 契約', () => {
  it('含 content-script 需要載入的 ONNX Runtime wasm 資源（src/runtime/ort/*）', () => {
    expect(warResources()).toContain('src/runtime/ort/*');
  });

  it('含 MAIN world 攔截器腳本', () => {
    expect(warResources()).toContain('src/runtime/yt-timedtext-interceptor.js');
  });

  it('ort 資源條目匹配 YouTube（content-script 宿主）', () => {
    const ortEntry = (manifest.web_accessible_resources ?? []).find(
      (w) => w.resources?.includes('src/runtime/ort/*')
    );
    expect(ortEntry).toBeDefined();
    expect(ortEntry?.matches).toContain('https://www.youtube.com/*');
  });
});