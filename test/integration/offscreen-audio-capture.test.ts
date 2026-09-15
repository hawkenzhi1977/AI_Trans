// 集成測試：offscreen 音頻捕獲 M2-58 儀表化——防禦性 resume + state breadcrumb
// + onaudioprocess 首塊/5s 窗口統計（§5.6「captureStarted 但無 audioChunk」必須可判定）。
// jsdom 無 AudioContext / mediaDevices，以 mock 類驅動。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// offscreen.ts 模組頂層引用 chrome.runtime.onMessage——jsdom 無 chrome，需先 stub。
// 使用 vi.hoisted 確保在 import offscreen.ts 前執行（ES module hoisting）。
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { onMessage: { addListener: vi.fn() }, onConnect: { addListener: vi.fn() }, sendMessage: vi.fn(), getURL: vi.fn(() => ''), connect: vi.fn(() => ({ postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn() })) },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    offscreen: { createDocument: vi.fn(), closeDocument: vi.fn() },
  };
});

// transformers.js mock（與 offscreen-local-onnx 測試一致，避免真實載入）。
const transformersMock = vi.hoisted(() => {
  const pipeline = vi.fn();
  const env = { allowLocalModels: false, backends: { onnx: { wasm: {} } } };
  return { pipeline, env };
});
vi.mock('@huggingface/transformers', () => transformersMock);

import { _testExports, resetLocalOnnxModuleForTest } from '../../src/runtime/offscreen';
import { resetChromeMock } from '../support/setup-dom';
import { decodePcmFloat32 } from '../../src/infrastructure/pcm-encoding';

/** 建立的 AudioContext 實例（依建立順序：passthrough 先、16kHz ASR context 後）。 */
let createdContexts: MockAudioContext[] = [];
/** ScriptProcessorNode 實例（僅 16kHz context 建立）。 */
let scriptProcessors: MockScriptProcessor[] = [];
/** 依序消費的初始 state（模擬 autoplay policy suspend）。 */
let initialStateQueue: Array<'suspended' | 'running'> = [];

class MockScriptProcessor {
  onaudioprocess: ((e: { inputBuffer: { getChannelData: (ch: number) => Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  state: 'suspended' | 'running';
  sampleRate: number;
  destination = {};
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48000;
    this.state = initialStateQueue.shift() ?? 'running';
  }
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => {
    const node = new MockScriptProcessor();
    scriptProcessors.push(node);
    return node;
  });
}

function makeFakeStream() {
  const track = { onended: null as null | (() => void), stop: vi.fn() };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

function makeMockPort() {
  return {
    name: 'offscreen-asr',
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn(),
  };
}

describe('offscreen M2-58 音頻捕獲儀表化', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdContexts = [];
    scriptProcessors = [];
    initialStateQueue = [];
    // 追蹤建立的 context（包裹構造器）。
    const RealMock = MockAudioContext;
    class Tracking extends RealMock {
      constructor(opts?: { sampleRate?: number }) {
        super(opts);
        createdContexts.push(this);
      }
    }
    vi.stubGlobal('AudioContext', Tracking);
    // jsdom 無 mediaDevices——注入假 getUserMedia。
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => makeFakeStream()) },
      configurable: true,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    _testExports.resetCaptureModuleForTest();
    resetLocalOnnxModuleForTest();
    resetChromeMock();
  });

  it('startCapture：兩個 context 都調用防禦性 resume()（autoplay policy suspend 不再無聲）', async () => {
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);

    expect(createdContexts).toHaveLength(2);
    // 兩個 context（passthrough + 16kHz ASR）都必須 resume。
    for (const ctx of createdContexts) {
      expect(ctx.resume).toHaveBeenCalledTimes(1);
    }
    // captureStarted 正常發出。
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'captureStarted' });
  });

  it('startCapture：state breadcrumb——console.warn 記錄兩個 context 的 state（排障可直接判定 suspend）', async () => {
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);

    const stateLogs = warnSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((m) => m.includes('audioContext state='));
    expect(stateLogs).toHaveLength(1);
    expect(stateLogs[0]).toContain('passthroughContext state=');
  });

  it('startCapture：初始 suspended 的 context 經 resume() 後變 running（防禦性恢復生效）', async () => {
    initialStateQueue = ['suspended', 'suspended'];
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);
    // resume() 是 fire-and-forget——等 microtask flush。
    await new Promise((r) => setTimeout(r, 0));

    expect(createdContexts[0].state).toBe('running');
    expect(createdContexts[1].state).toBe('running');
  });

  it('onaudioprocess：port 收到 audioChunk（pcm 複製 + sampleRate 16000）+ 首塊 breadcrumb', async () => {
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);

    expect(scriptProcessors).toHaveLength(1);
    const input = new Float32Array(4096).fill(0.1);
    // M2-68：音頻累積至 ~3s 才發送（4096 samples × 12 = 49152 samples ≈ 3.07s @ 16kHz）。
    for (let i = 0; i < 12; i++) {
      scriptProcessors[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => input },
      });
    }

    const chunkMsg = port.postMessage.mock.calls
      .map((c) => c[0] as { type: string; pcm?: string; sampleRate?: number })
      .find((m) => m.type === 'audioChunk');
    expect(chunkMsg).toBeDefined();
    // M2-59：pcm 為 base64 string（修復 extension messaging 對 Float32Array 序列化損毀）。
    expect(typeof chunkMsg!.pcm).toBe('string');
    const decoded = decodePcmFloat32(chunkMsg!.pcm!);
    // 累積 12 × 4096 = 49152 samples
    expect(decoded).toHaveLength(49_152);
    // 值精確還原（非引用同一陣列——事件緩衝回收後仍有效）。
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]).toBeCloseTo(0.1, 6);
    }
    expect(chunkMsg!.sampleRate).toBe(16000);

    const firstChunkLogs = warnSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((m) => m.includes('first audioChunk sent'));
    expect(firstChunkLogs).toHaveLength(1);
  });

  it('M2-68：默認 accumulateTargetMs=3000 → ~12 chunks (3.07s) 觸發（非舊 5s）', async () => {
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);

    const input = new Float32Array(4096).fill(0.1);
    // 3000ms @ 16kHz = 48000 samples; 4096 × 12 = 49152 > 48000 → 第 12 塊觸發。
    // 先餵 11 塊（45056 samples < 48000）→ 不觸發。
    for (let i = 0; i < 11; i++) {
      scriptProcessors[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => input },
      });
    }
    let chunkMsg = port.postMessage.mock.calls
      .map((c) => c[0] as { type: string })
      .find((m) => m.type === 'audioChunk');
    expect(chunkMsg).toBeUndefined();

    // 第 12 塊觸發。
    scriptProcessors[0].onaudioprocess!({
      inputBuffer: { getChannelData: () => input },
    });
    chunkMsg = port.postMessage.mock.calls
      .map((c) => c[0] as { type: string; pcm?: string })
      .find((m) => m.type === 'audioChunk');
    expect(chunkMsg).toBeDefined();
  });

  it('onaudioprocess：5s 窗口統計 breadcrumb（maxRms 可判定「有 chunk 但內容靜音」）', async () => {
    const port = makeMockPort();
    await _testExports.startCapture('stream-1', port as never);

    // 偽造時間流逝：windowStart 在 startCapture 時記錄，直接驅動 performance.now 偏移。
    const nowSpy = vi.spyOn(performance, 'now');
    const base = performance.now();
    let offset = 0;
    nowSpy.mockImplementation(() => base + (offset += 5001));

    // 靜音塊（rms=0）——maxRms 統計仍輸出。
    scriptProcessors[0].onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(4096) },
    });

    const windowLogs = warnSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((m) => m.includes('audioChunk stats'));
    expect(windowLogs).toHaveLength(1);
    expect(windowLogs[0]).toContain('maxRms=0.00000');
    nowSpy.mockRestore();
  });
});
