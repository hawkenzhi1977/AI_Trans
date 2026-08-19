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
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
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
    transformersMock.pipeline.mockResolvedValue(async () => [
      { generated_text: '1. 你好' },
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

describe('offscreen local-onnx Prompt 與輸出解析（補充修復十一）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    resetLocalOnnxModuleForTest();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    resetLocalOnnxModuleForTest();
    vi.unstubAllGlobals();
  });

  it('buildPrompt：ChatML 格式 + 行號標記 + 目標語言 few-shot', () => {
    const prompt = _testExports.buildPrompt('Hello\nWorld', 'zh-Hant');
    expect(prompt).toContain('<|im_start|>system');
    expect(prompt).toContain('Traditional Chinese');
    expect(prompt).toContain('1. Hello\n2. World');
    expect(prompt).toContain('Examples:');
    expect(prompt).toContain('<|im_start|>assistant');
  });

  it('buildPrompt：未覆蓋語言無 few-shot 但保留行號指令', () => {
    const prompt = _testExports.buildPrompt('Hi', 'xh');
    expect(prompt).not.toContain('Examples:');
    expect(prompt).toContain('1. Hi');
  });

  it('parseNumberedOutput：行號對齊還原譯文', () => {
    const { translatedLines, echoed } = _testExports.parseNumberedOutput(
      '1. 你好\n2. 世界',
      ['Hello', 'World']
    );
    expect(translatedLines).toEqual(['你好', '世界']);
    expect(echoed).toBe(false);
  });

  it('parseNumberedOutput：缺行以原文兜底', () => {
    const { translatedLines } = _testExports.parseNumberedOutput('2. 世界', ['Hello', 'World']);
    expect(translatedLines).toEqual(['Hello', '世界']);
  });

  it('parseNumberedOutput：全部回顯原文標記 echo', () => {
    const { translatedLines, echoed } = _testExports.parseNumberedOutput(
      '1. Hello\n2. World',
      ['Hello', 'World']
    );
    expect(translatedLines).toEqual(['Hello', 'World']);
    expect(echoed).toBe(true);
  });

  it('runInference：mock 返回行號譯文 → 按行序回傳，prompt 含 ChatML/行號', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    let capturedInput = '';
    transformersMock.pipeline.mockResolvedValue(async (input: string) => {
      capturedInput = input;
      return [{ generated_text: '1. 你好\n2. 世界' }];
    });

    const res = await _testExports.runInference('Hello\nWorld', 'zh-Hant', undefined);

    expect(res.ok).toBe(true);
    expect((res as { translatedText?: string }).translatedText).toBe('你好\n世界');
    expect(capturedInput).toContain('<|im_start|>system');
    expect(capturedInput).toContain('1. Hello\n2. World');
  });

  it('runInference：模型回顯原文 → 落 echo 診斷（storage.local 寫入）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => [
      { generated_text: '1. Hello\n2. World' },
    ]);

    const res = await _testExports.runInference('Hello\nWorld', 'zh-Hant', undefined);

    expect(res.ok).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalled();
    const stored = await chrome.storage.local.get('lastDiagnostic');
    expect(stored.lastDiagnostic.message).toContain('echoed input');
  });

  it('runInference：無回顯（正常翻譯）不寫 echo 診斷', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => [
      { generated_text: '1. 你好\n2. 世界' },
    ]);

    const res = await _testExports.runInference('Hello\nWorld', 'zh-Hant', undefined);

    expect(res.ok).toBe(true);
    const stored = await chrome.storage.local.get('lastDiagnostic');
    expect(stored.lastDiagnostic).toBeUndefined();
  });

  it('clearModelCache：刪除 transformers 相關 Cache API 與 IndexedDB 快取', async () => {
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => ['transformers-cache', 'other-cache']),
      delete: deleteCache,
      open: vi.fn(),
    });
    vi.stubGlobal('indexedDB', {
      databases: vi.fn(async () => [{ name: 'transformers-cache' }, { name: 'other-db' }]),
      deleteDatabase: vi.fn(),
    });

    const res = await _testExports.clearModelCache();

    expect(res.ok).toBe(true);
    expect(deleteCache).toHaveBeenCalledWith('transformers-cache');
    expect(deleteCache).not.toHaveBeenCalledWith('other-cache');
    // 無失敗診斷寫入。
    const stored = await chrome.storage.local.get('lastDiagnostic');
    expect(stored.lastDiagnostic).toBeUndefined();
  });
});

describe('offscreen local-onnx warmup 預加載（補充修復十三）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    resetLocalOnnxModuleForTest();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
    resetLocalOnnxModuleForTest();
    vi.unstubAllGlobals();
  });

  it('warmupModel：pipeline 未載入但快取存在 → 載入完成並返回 ok', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);

    const res = await _testExports.warmupModel();

    expect(res.type).toBe('local-onnx:warmup-complete');
    expect(res.ok).toBe(true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
  });

  it('warmupModel：pipeline 已載入 → 直接返回 ok 不重複載入', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);
    // 先透過 runInference 觸發載入。
    await _testExports.runInference('hi', 'zh-Hant', undefined);

    const res = await _testExports.warmupModel();

    expect(res.ok).toBe(true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
  });

  it('warmupModel：無快取 → 返回 ok:false 且不觸發載入（提示先下載）', async () => {
    installEmptyCaches();
    const res = await _testExports.warmupModel();
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('not downloaded');
    expect(transformersMock.pipeline).not.toHaveBeenCalled();
  });

  it('warmupModel：載入失敗 → 返回 ok:false 且落診斷（§5.6 不靜默）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockRejectedValue(new Error('wasm init failed'));

    const res = await _testExports.warmupModel();

    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('wasm init failed');
    // 診斷 message = "Error: wasm init failed"（formatCause）；console.warn 麵包屑含代碼名。
    const stored = await chrome.storage.local.get('lastDiagnostic');
    expect(stored.lastDiagnostic?.message).toContain('wasm init failed');
  });
});