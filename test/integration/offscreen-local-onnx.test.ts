// 集成測試：offscreen local-onnx 模型載入彈性化（補充修復九）+ WebGPU 載入後端（M2-26）。
// 覆蓋：hasModelInCache 用 Cache API 判定的正確性、runInference lazy 載入恢復、
// checkModelStatus 不依賴內存 translationPipeline、推理失敗錯誤可讀化、
// WebGPU 設備選擇 / WASM 回退 / webgpuFailed 一次性記憶。
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

// 診斷 mock（委派真實實現——既有測試斷言 storage 寫入仍生效；同時提供 spy 供
// WebGPU 回退診斷調用斷言）。importOriginal 提供真實實現，spy 包裹後轉發。
vi.mock('../../src/infrastructure/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infrastructure/diagnostics')>();
  return {
    recordDiagnostic: vi.fn(async (e: Parameters<typeof actual.recordDiagnostic>[0]) =>
      actual.recordDiagnostic(e)
    ),
  };
});

import {
  resetLocalOnnxModuleForTest,
  _testExports,
} from '../../src/runtime/offscreen';
import { recordDiagnostic } from '../../src/infrastructure/diagnostics';

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

  it('checkModelStatus：模型已載入記憶體 → loaded true（M1-59）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);

    // 先下載（會載入 pipeline 到記憶體）。
    await _testExports.downloadModel();
    const res = await _testExports.checkModelStatus();

    expect(res.type).toBe('local-onnx:status');
    expect((res as { loaded?: boolean }).loaded).toBe(true);
    expect((res as { loading?: boolean }).loading).toBe(false);
    expect((res as { downloaded: boolean }).downloaded).toBe(true);
  });

  it('checkModelStatus：背景預熱進行中 → loading true（M1-59）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    // 掛起載入：模擬 check-status 觸發的背景預熱仍在進行。
    transformersMock.pipeline.mockImplementationOnce(() => new Promise(() => {}));

    const res = await _testExports.checkModelStatus();
    // 快取存在 → downloaded true；載入進行中 → loading true、loaded false。
    expect((res as { downloaded: boolean }).downloaded).toBe(true);
    expect((res as { loaded?: boolean }).loaded).toBe(false);
    expect((res as { loading?: boolean }).loading).toBe(true);
  });

  it('checkModelStatus：背景預熱完成 → 廣播 local-onnx:status loaded true（M1-59）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue(async () => []);

    await _testExports.checkModelStatus();
    // 等待背景預熱完成並廣播。
    await new Promise((r) => setTimeout(r, 20));

    const broadcastMsgs = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((m) => (m as { type?: string }).type === 'local-onnx:status');
    expect(broadcastMsgs.length).toBeGreaterThan(0);
    const last = broadcastMsgs[broadcastMsgs.length - 1] as {
      loaded?: boolean;
      loading?: boolean;
    };
    expect(last.loaded).toBe(true);
    expect(last.loading).toBe(false);
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

describe('offscreen 空閒關閉（M2-25）', () => {
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

  it('空閒關閉：dispose 翻譯 pipeline 並通知 SW 關閉 document', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    const disposeSpy = vi.fn(async () => {});
    transformersMock.pipeline.mockResolvedValue({ dispose: disposeSpy });

    // 先載入 pipeline（模擬運行中持有 WASM 模型記憶體）。
    await _testExports.downloadModel();
    expect(disposeSpy).not.toHaveBeenCalled();

    await _testExports.shutdownForIdle();

    // 釋放 wasm 記憶體（dispose pipeline）。
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 通知 SW 調用 chrome.offscreen.closeDocument。
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      topic: 'offscreen:idle-close',
    });
  });

  it('空閒關閉冪等：重複觸發不重複 dispose（idleCloseRequested 守衛）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    const disposeSpy = vi.fn(async () => {});
    transformersMock.pipeline.mockResolvedValue({ dispose: disposeSpy });

    await _testExports.downloadModel();
    await _testExports.shutdownForIdle();
    await _testExports.shutdownForIdle();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('無 pipeline 時空閒關閉仍安全（不拋錯）', async () => {
    await _testExports.shutdownForIdle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      topic: 'offscreen:idle-close',
    });
  });
});

// ============================================================
// M2-26：WebGPU 載入後端 + WASM 回退（popup 阻塞根因修復）
// ============================================================
describe('offscreen local-onnx WebGPU 載入後端（M2-26）', () => {
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

  it('無 navigator.gpu → preferWebGpu=false，載入走 device:wasm（零回歸）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue({});

    expect(_testExports.preferWebGpu()).toBe(false);
    await _testExports.ensurePipelineLoaded();

    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
    expect(transformersMock.pipeline.mock.calls[0][2]).toMatchObject({ device: 'wasm' });
    expect(recordDiagnostic).not.toHaveBeenCalled();
  });

  it('有 navigator.gpu → preferWebGpu=true，載入走 device:webgpu', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockResolvedValue({});
    // jsdom 默認 navigator 無 gpu；stub 出 WebGPU 可用環境。
    vi.stubGlobal('navigator', { gpu: {} });

    expect(_testExports.preferWebGpu()).toBe(true);
    await _testExports.ensurePipelineLoaded();

    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
    expect(transformersMock.pipeline.mock.calls[0][2]).toMatchObject({ device: 'webgpu' });
    expect(recordDiagnostic).not.toHaveBeenCalled();
  });

  it('webgpu 嘗試失敗 → 回退 wasm 成功 + local-onnx-webgpu-fallback 診斷 + webgpuFailed=true', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    // 第一次（webgpu）reject、第二次（wasm 回退）resolve。
    transformersMock.pipeline
      .mockRejectedValueOnce(new Error('WebGPU device creation failed'))
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { gpu: {} });

    await _testExports.ensurePipelineLoaded();

    // 共兩次 pipeline 調用：webgpu（失敗）→ wasm（成功）。
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(2);
    expect(transformersMock.pipeline.mock.calls[0][2]).toMatchObject({ device: 'webgpu' });
    expect(transformersMock.pipeline.mock.calls[1][2]).toMatchObject({ device: 'wasm' });
    expect(recordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pipeline-error',
        error: expect.objectContaining({ code: 'local-onnx-webgpu-fallback' }),
      })
    );
  });

  it('webgpuFailed=true 後 → preferWebGpu=false（後續載入不再嘗試 webgpu）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    // webgpu reject → wasm 成功（觸發 webgpuFailed=true）。
    transformersMock.pipeline
      .mockRejectedValueOnce(new Error('WebGPU device creation failed'))
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { gpu: {} });

    await _testExports.ensurePipelineLoaded();
    // 失敗記憶生效：preferWebGpu 翻轉為 false，後續載入將直接走 wasm。
    expect(_testExports.webgpuFailed).toBe(true);
    expect(_testExports.preferWebGpu()).toBe(false);
  });

  it('resetLocalOnnxModuleForTest → webgpuFailed 歸零（Document 重建重置）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline
      .mockRejectedValueOnce(new Error('WebGPU device creation failed'))
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { gpu: {} });

    await _testExports.ensurePipelineLoaded();
    expect(_testExports.webgpuFailed).toBe(true);

    resetLocalOnnxModuleForTest();
    expect(_testExports.webgpuFailed).toBe(false);
  });

  it('webgpu 與 wasm 皆失敗 → 拋原始錯誤（不吞）', async () => {
    installCaches([makeRequest(MODEL_ONNX_URL)]);
    transformersMock.pipeline.mockRejectedValue(new Error('all backends failed'));
    vi.stubGlobal('navigator', { gpu: {} });

    await expect(_testExports.ensurePipelineLoaded()).rejects.toThrow('all backends failed');
  });
});

// 進度聚合器測試——多檔案下載時計算整體百分比（避免進度條在文件切換時跳回 0%）。
describe('DownloadProgressAggregator — 多檔案下載進度聚合', () => {
  const { DownloadProgressAggregator } = _testExports;

  it('單檔案：loaded 從 0 到 total → progress 從 0 到 100', () => {
    const agg = new DownloadProgressAggregator();
    expect(agg.update('model.onnx', 0, 1000).progress).toBe(0);
    expect(agg.update('model.onnx', 500, 1000).progress).toBe(50);
    expect(agg.update('model.onnx', 1000, 1000).progress).toBe(100);
  });

  it('多檔案：整體百分比 = 所有檔案 loaded 之和 / total 之和', () => {
    const agg = new DownloadProgressAggregator();
    // 兩個檔案各 1000 bytes。
    agg.update('model.onnx', 0, 1000);
    agg.update('tokenizer.json', 0, 1000);
    // 第一個檔案下載 50%。
    expect(agg.update('model.onnx', 500, 1000).progress).toBe(25); // 500/2000 = 25%
    // 第一個完成，第二個還在 0。
    expect(agg.update('model.onnx', 1000, 1000).progress).toBe(50); // 1000/2000 = 50%
    // 第二個下載 50%。
    expect(agg.update('tokenizer.json', 500, 1000).progress).toBe(75); // 1500/2000 = 75%
    // 全部完成。
    expect(agg.update('tokenizer.json', 1000, 1000).progress).toBe(100);
  });

  it('reset() 清空所有檔案追蹤', () => {
    const agg = new DownloadProgressAggregator();
    agg.update('model.onnx', 500, 1000);
    agg.reset();
    // reset 後第一個檔案從 0 開始。
    expect(agg.update('model.onnx', 0, 1000).progress).toBe(0);
  });

  it('loaded/total 累計返回所有檔案的總和', () => {
    const agg = new DownloadProgressAggregator();
    agg.update('a.onnx', 100, 200);
    const result = agg.update('b.onnx', 50, 300);
    expect(result.loaded).toBe(150); // 100 + 50
    expect(result.total).toBe(500); // 200 + 300
  });
});