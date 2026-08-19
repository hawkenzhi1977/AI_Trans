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

/** 注入快取刪除所需環境（clearModelCache 的 IndexedDB + caches.delete）。 */
function installCacheDeletionEnv(): void {
  vi.stubGlobal('indexedDB', {
    databases: vi.fn(async () => [{ name: 'transformers-cache' }, { name: 'other-db' }]),
    deleteDatabase: vi.fn(),
  });
  vi.stubGlobal('caches', {
    keys: vi.fn(async () => ['transformers-cache', 'other-cache']),
    delete: vi.fn(async () => true),
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
    const { translatedLines, echoed, parsedCount } = _testExports.parseNumberedOutput(
      '1. 你好\n2. 世界',
      ['Hello', 'World']
    );
    expect(translatedLines).toEqual(['你好', '世界']);
    expect(echoed).toBe(false);
    expect(parsedCount).toBe(2);
  });

  it('parseNumberedOutput：缺行以原文兜底（parsedCount 只計解析到行）', () => {
    const { translatedLines, parsedCount } = _testExports.parseNumberedOutput('2. 世界', [
      'Hello',
      'World',
    ]);
    expect(translatedLines).toEqual(['Hello', '世界']);
    expect(parsedCount).toBe(1);
  });

  it('parseNumberedOutput：全部回顯原文標記 echo', () => {
    const { translatedLines, echoed, parsedCount } = _testExports.parseNumberedOutput(
      '1. Hello\n2. World',
      ['Hello', 'World']
    );
    expect(translatedLines).toEqual(['Hello', 'World']);
    expect(echoed).toBe(true);
    expect(parsedCount).toBe(2);
  });

  it('parseNumberedOutput：無行號輸出但包含中文 → 使用中文作為翻譯（F6 回退解析器）', () => {
    const { translatedLines, echoed, parsedCount } = _testExports.parseNumberedOutput(
      '你好\n世界',
      ['Hello', 'World']
    );
    // F6: 當沒有編號但輸出包含中文時，使用中文作為翻譯
    expect(translatedLines).toEqual(['你好', '世界']);
    expect(echoed).toBe(false);
    expect(parsedCount).toBe(0);
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
    expect((res as { echoed?: boolean }).echoed).toBe(false);
    expect(capturedInput).toContain('<|im_start|>system');
    expect(capturedInput).toContain('1. Hello\n2. World');
  });

  it('runInference：模型回顯原文 → 落 echo 診斷（含 raw 片段 + 解析統計）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => [
      { generated_text: '1. Hello\n2. World' },
    ]);

    const res = await _testExports.runInference('Hello\nWorld', 'zh-Hant', undefined);

    expect(res.ok).toBe(true);
    expect((res as { echoed?: boolean }).echoed).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalled();
    const stored = await chrome.storage.local.get('lastDiagnostic');
    // M2-24 補充修復十六：cause 內嵌 raw 生成文本片段 + parsed 統計，popup 可分辨真回顯 vs 解析誤判。
    expect(stored.lastDiagnostic.message).toContain('echoed input');
    expect(stored.lastDiagnostic.message).toContain('parsed 2/2 lines');
    expect(stored.lastDiagnostic.message).toContain('raw output:');
    expect(stored.lastDiagnostic.message).toContain('1. Hello\\n2. World');
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

describe('offscreen local-onnx 快取清除與重新下載彈性（補充修復十五）', () => {
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

  it('clearModelCache 後 downloadModel 啟動新鮮載入並帶進度回調（不複用陳舊 loadPromise）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);

    // ① check-status 觸發背景預熱 → 建立無進度回調的 loadPromise。
    await _testExports.checkModelStatus();
    // ② 清除快取 → 重置 loadPromise / 世代遞增（舊代碼漏此步）。
    installCacheDeletionEnv();
    await _testExports.clearModelCache();
    // ③ 下載 → 必須以新的 pipeline() 載入並帶進度回調。
    const res = await _testExports.downloadModel();

    expect(res.ok).toBe(true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(2);
    const secondCallOptions = transformersMock.pipeline.mock.calls[1][2] as {
      progress_callback?: unknown;
    };
    expect(typeof secondCallOptions.progress_callback).toBe('function');
  });

  it('清快取時在飛的陳舊載入完成後被 dispose 且不落地 translationPipeline（世代失效）', async () => {
    installCacheDeletionEnv();
    let resolveStale!: (v: unknown) => void;
    transformersMock.pipeline
      .mockImplementationOnce(() => new Promise((res) => (resolveStale = res)))
      .mockResolvedValue(async () => []);

    // ① 啟動無進度回調的載入（等價 check-status 預熱）→ loadPromise 在飛。
    const staleLoad = _testExports.ensurePipelineLoaded();
    await new Promise((r) => setTimeout(r, 0));
    expect(resolveStale).toBeTypeOf('function');

    // ② 清除快取 → 世代遞增。
    await _testExports.clearModelCache();
    // ③ 陳舊載入此刻才完成 → 結果必須被 dispose，且該載入以 ModelCacheClearedError 拒絕。
    const staleDispose = vi.fn(async () => {});
    resolveStale({ dispose: staleDispose });
    await expect(staleLoad).rejects.toThrow('model cache cleared during load');
    await new Promise((r) => setTimeout(r, 10));

    expect(staleDispose).toHaveBeenCalledTimes(1);
    // 陳舊載入不落地 → 後續下載仍以新鮮載入承接。
    const res = await _testExports.downloadModel();
    expect(res.ok).toBe(true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(2);
  });

  it('clearModelCache dispose 已載入的 pipeline（釋放 wasm 記憶體）', async () => {
    installCacheDeletionEnv();
    const disposeSpy = vi.fn(async () => {});
    transformersMock.pipeline.mockResolvedValue({ dispose: disposeSpy });

    await _testExports.downloadModel();
    expect(disposeSpy).not.toHaveBeenCalled();

    await _testExports.clearModelCache();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('連續兩輪「清快取 + 重新下載」均成功（世代計數不殘留）', async () => {
    installCacheDeletionEnv();
    transformersMock.pipeline.mockResolvedValue(async () => []);

    const res1 = await _testExports.downloadModel();
    await _testExports.clearModelCache();
    const res2 = await _testExports.downloadModel();
    await _testExports.clearModelCache();
    const res3 = await _testExports.downloadModel();

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res3.ok).toBe(true);
    // 三輪下載各自獨立載入。
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(3);
    // 無失敗診斷（§5.6）。
    const stored = await chrome.storage.local.get('lastDiagnostic');
    expect(stored.lastDiagnostic).toBeUndefined();
  });

  it('預熱失敗不拖垮後續下載（進度防護：新鮮載入承接而非複用失敗的陳舊 promise）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    // 第一次 pipeline()（預熱）失敗；第二次（下載）成功。
    transformersMock.pipeline
      .mockRejectedValueOnce(new Error('warmup failed'))
      .mockResolvedValueOnce(async () => []);

    await _testExports.checkModelStatus();
    await new Promise((r) => setTimeout(r, 10));

    const res = await _testExports.downloadModel();
    expect(res.ok).toBe(true);
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(2);
    const secondCallOptions = transformersMock.pipeline.mock.calls[1][2] as {
      progress_callback?: unknown;
    };
    expect(typeof secondCallOptions.progress_callback).toBe('function');
  });
});