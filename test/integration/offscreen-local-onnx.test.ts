// 集成測試：offscreen local-onnx 模型載入彈性化（補充修復九）。
// 覆蓋：hasModelInCache 用 Cache API 判定的正確性、runInference lazy 載入恢復、
// checkModelStatus 不依賴內存 translationPipeline、推理失敗錯誤可讀化。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// transformers.js mock（優先於 vitest.config 的 alias mock）。
const transformersMock = vi.hoisted(() => {
  const pipeline = vi.fn();
  const env = {
    allowLocalModels: false,
    backends: { onnx: { wasm: {} } },
  };
  return { pipeline, env };
});
vi.mock('@huggingface/transformers', () => transformersMock);

import {
  resetLocalOnnxModuleForTest,
  _testExports,
} from '../../src/runtime/offscreen';

/** 構造假 Request（僅測試 url 欄位）。 */
function makeRequest(url: string): Request {
  return { url } as Request;
}

/** 注入假 Cache API：有/無 transformers-cache 及對應 entries。 */
function installCaches(entries: Request[]): void {
  const cache = { keys: vi.fn(async () => entries) };
  const cachesApi = {
    keys: vi.fn(async () => (entries.length > 0 ? ['transformers-cache'] : [])),
    open: vi.fn(async () => cache),
  };
  vi.stubGlobal('caches', cachesApi);
}

/** 注入假 Cache API：無 transformers-cache。 */
function installEmptyCaches(): void {
  vi.stubGlobal('caches', {
    keys: vi.fn(async () => []),
    open: vi.fn(),
  });
}

const MODEL_ONNX_URL =
  'https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/onnx/model_q4.onnx';

describe('offscreen local-onnx 模型載入彈性化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLocalOnnxModuleForTest();
  });

  afterEach(async () => {
    // flush 進行中的預熱/載入 promise，避免跨測試污染。
    await new Promise((r) => setTimeout(r, 10));
    resetLocalOnnxModuleForTest();
    vi.unstubAllGlobals();
  });

  it('hasModelInCache：Cache API 有 transformers-cache 且含 .onnx → true', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    expect(await _testExports.hasModelInCache()).toBe(true);
  });

  it('hasModelInCache：無 transformers-cache → false', async () => {
    installEmptyCaches();
    expect(await _testExports.hasModelInCache()).toBe(false);
  });

  it('hasModelInCache：有 cache 但無 .onnx → false', async () => {
    installCaches([makeRequest('https://huggingface.co/x/config.json')]);
    expect(await _testExports.hasModelInCache()).toBe(false);
  });

  it('hasModelInCache：globalThis.caches 不可用 → false', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await _testExports.hasModelInCache()).toBe(false);
  });

  it('runInference：pipeline 未載入但快取存在 → lazy 載入並成功翻譯', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    // pipeline() 返回可調用的推理函數；生成文本 = prompt + 翻譯結果。
    transformersMock.pipeline.mockResolvedValue(async (input: string) => [
      { generated_text: `${input}你好` },
    ]);

    const res = await _testExports.runInference('hello world', 'zh-Hant', undefined);

    expect(res.type).toBe('local-onnx:translate-result');
    expect(res.ok).toBe(true);
    expect((res as { translatedText?: string }).translatedText).toBe('你好');
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
    // 每次載入必須重新配置 wasmPaths（指向擴充內 ort/）。
    expect(transformersMock.env.backends.onnx.wasm.wasmPaths).toBe(
      'chrome-extension://fake/src/runtime/ort/'
    );
  });

  it('runInference：pipeline 未載入且無快取 → notDownloaded（不觸發載入）', async () => {
    installEmptyCaches();
    const res = await _testExports.runInference('hello', 'zh-Hant', undefined);
    expect(res.ok).toBe(false);
    expect((res as { notDownloaded?: boolean }).notDownloaded).toBe(true);
    expect(transformersMock.pipeline).not.toHaveBeenCalled();
  });

  it('runInference：推理失敗（ORT 數字錯誤碼）→ ok:false 且錯誤可讀', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => {
      // ORT/transformers 在 wasm trap 時可能直接 throw 數字（如 1835858576）。
      throw 1835858576;
    });

    const res = await _testExports.runInference('hello', 'zh-Hant', undefined);

    expect(res.ok).toBe(false);
    const errMsg = (res as { error?: string }).error ?? '';
    expect(errMsg).toContain('1835858576');
    expect(errMsg).toContain('non-Error');
  });

  it('runInference：推理失敗（帶 code 的 Error）→ 錯誤含 code 與 stack', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => {
      const e = new Error('session run failed');
      (e as { code?: number }).code = 1835858576;
      throw e;
    });

    const res = await _testExports.runInference('hello', 'zh-Hant', undefined);

    expect(res.ok).toBe(false);
    const errMsg = (res as { error?: string }).error ?? '';
    expect(errMsg).toContain('session run failed');
    expect(errMsg).toContain('code=1835858576');
  });

  it('checkModelStatus：無內存 pipeline 但有快取 → downloaded true', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);

    const res = await _testExports.checkModelStatus();

    expect(res.type).toBe('local-onnx:status');
    expect((res as { downloaded: boolean }).downloaded).toBe(true);
  });

  it('checkModelStatus：無快取 → downloaded false（不誤報）', async () => {
    installEmptyCaches();
    const res = await _testExports.checkModelStatus();
    expect((res as { downloaded: boolean }).downloaded).toBe(false);
  });
});