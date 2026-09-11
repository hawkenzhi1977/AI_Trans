import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import { TabCaptureAudioSource } from '../../src/adapters/audio/tab-capture-source';
import type { TabStreamIdProvider, StreamIdAcquirer } from '../../src/adapters/audio/tab-capture-source';
import { setDebugFlags } from '../../src/infrastructure/debug-log';
import { encodePcmFloat32 } from '../../src/infrastructure/pcm-encoding';

// M2-46：TabCaptureAudioSource 使用 in-memory streamId provider（不落 storage）。
// streamId 由 popup 透過 tabs.sendMessage 直接交付 content-script 記憶體，
// 避免一次性 TTL token 落 storage 被重複消費。

/** 建立標準 mock port（獨立 addListener，不共享 setup-dom 的 onMessageListeners）。 */
function makeMockPort() {
  return {
    name: 'offscreen-asr',
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn(),
  };
}

/** 從 mock port 提取已註冊的 onMessage / onDisconnect 回調。 */
function getPortListeners(port: ReturnType<typeof makeMockPort>) {
  const msgCalls = (port.onMessage.addListener as ReturnType<typeof vi.fn>).mock.calls;
  const discCalls = (port.onDisconnect.addListener as ReturnType<typeof vi.fn>).mock.calls;
  return {
    onMessage: msgCalls[msgCalls.length - 1]?.[0] as ((m: unknown) => void) | undefined,
    onDisconnect: discCalls[discCalls.length - 1]?.[0] as (() => void) | undefined,
  };
}

/** 觸發 port onMessage（須在 start() 進入 await 後調用，確保 listener 已註冊）。 */
function triggerPortMessage(port: ReturnType<typeof makeMockPort>, msg: unknown): void {
  const listener = getPortListeners(port).onMessage;
  expect(listener).toBeDefined();
  listener!(msg);
}


/** 觸發 port onDisconnect（模擬 offscreen 文件被關閉）。 */
function triggerPortDisconnect(port: ReturnType<typeof makeMockPort>): void {
  const listener = getPortListeners(port).onDisconnect;
  expect(listener).toBeDefined();
  listener!();
}

/** 建立 mock TabStreamIdProvider。 */
function makeProvider(opts: {
  streamId?: string | null;
  hasActive?: boolean;
}): TabStreamIdProvider {
  return {
    consumeStreamId: vi.fn(() => {
      if (opts.streamId !== undefined) return opts.streamId;
      return undefined;
    }),
    hasActiveStream: vi.fn(() => opts.hasActive ?? false),
    onStreamEstablished: vi.fn(),
    onStreamReleased: vi.fn(),
  };
}

/** 建立 mock StreamIdAcquirer。 */
function makeAcquirer(streamId: string | null = 'reacquired-id'): StreamIdAcquirer {
  return {
    acquire: vi.fn(() => Promise.resolve(streamId)),
  };
}

describe('TabCaptureAudioSource — in-memory streamId provider（M2-46）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  it('start() provider 返回 fresh streamId → 送給 offscreen，等待 captureStarted', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: 'fresh-stream-id' });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    expect(provider.consumeStreamId).toHaveBeenCalledTimes(1);
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startCapture', streamId: 'fresh-stream-id' })
    );
  });

  it('start() provider 返回 null → 複用已有 MediaStream，送 streamId=null 給 offscreen', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: null, hasActive: true });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startCapture', streamId: null })
    );
  });

  it('start() provider undefined → 樂觀探測 startCapture(null)，offscreen 無活串流 → need-stream-id', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: undefined, hasActive: false });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'error', message: 'no streamId and no active stream', code: 'need-stream-id' });
    const expectP = expect(startPromise).rejects.toThrow('tabCapture re-authorization needed');
    await new Promise((r) => setTimeout(r, 20));
    await expectP;

    // 樂觀探測：送 streamId=null
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startCapture', streamId: null })
    );
  });

  it('M2-54 回歸：start() provider 返回 undefined → 未授權，落診斷、拋錯，不寫 storage（避免競態 restart）', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: undefined, hasActive: false });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'error', message: 'no streamId and no active stream', code: 'need-stream-id' });
    const expectP = expect(startPromise).rejects.toThrow('tabCapture re-authorization needed');
    await new Promise((r) => setTimeout(r, 20));
    await expectP;

    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toBeDefined();

    const auth = await chrome.storage.local.get('tabCaptureAuthorized');
    expect(auth.tabCaptureAuthorized).toBeUndefined();
  });

  it('M2-55：provider undefined + offscreen need-stream-id + acquirer 成功 → 自動重取並重送 startCapture', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: undefined, hasActive: false });
    const acquirer = makeAcquirer('fresh-reacquired-id');
    source.setStreamIdProvider(provider);
    source.setStreamIdAcquirer(acquirer);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'error', message: 'no streamId and no active stream', code: 'need-stream-id' });
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    expect(acquirer.acquire).toHaveBeenCalledTimes(1);
    expect(mockPort.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'startCapture', streamId: null })
    );
    expect(mockPort.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'startCapture', streamId: 'fresh-reacquired-id' })
    );
  });

  it('M2-55：provider undefined + offscreen need-stream-id + acquirer 失敗 → 落 reauth 診斷並拋錯', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: undefined, hasActive: false });
    const acquirer = makeAcquirer(null);
    source.setStreamIdProvider(provider);
    source.setStreamIdAcquirer(acquirer);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'error', message: 'no streamId and no active stream', code: 'need-stream-id' });
    // 先掛 handler（acquirer 為 async，reject 在其 resolve 之後才觸發）。
    const expectP = expect(startPromise).rejects.toThrow('tabCapture re-authorization needed');
    await new Promise((r) => setTimeout(r, 20));
    await expectP;

    expect(acquirer.acquire).toHaveBeenCalledTimes(1);
    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toContain('re-authorization');
  });

  it('start() 發送 offscreen:ensure-created 給 SW（不直接調用 chrome.offscreen）', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'offscreen:ensure-created' })
    );
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('start() offscreen:ensure-created 失敗 → 落診斷並拋錯', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'offscreen create failed',
    });

    await expect(handle.start()).rejects.toThrow('offscreen create failed');

    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toBeDefined();
  });

  it('stop() 發送 stopCapture 給 offscreen 並斷開 port（不發 offscreen:idle-close）', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;
    await handle.stop();

    // 發了軟停止（stopCapture）給 offscreen
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stopCapture' })
    );
    // port 斷開（允許 offscreen 進入空閒計時）
    expect(mockPort.disconnect).toHaveBeenCalled();

    // 沒有發 offscreen:idle-close（空閒完整釋放由 offscreen 自管）
    const sendMsgCalls = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const idleClose = sendMsgCalls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>).topic === 'offscreen:idle-close'
    );
    expect(idleClose).toHaveLength(0);
  });

  it('M2-54 回歸：start() provider 返回 undefined 後，storage 不被寫入 tabCaptureAuthorized（消除競態觸發源）', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: undefined, hasActive: false });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const setCalls: unknown[] = [];
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation((obj: unknown) => {
      setCalls.push(obj);
      return Promise.resolve();
    });

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'error', message: 'no streamId and no active stream', code: 'need-stream-id' });
    const expectP = expect(startPromise).rejects.toThrow('tabCapture re-authorization needed');
    await new Promise((r) => setTimeout(r, 20));
    await expectP;

    const hasTabCaptureWrite = setCalls.some(
      (obj) =>
        typeof obj === 'object' &&
        obj !== null &&
        'tabCaptureAuthorized' in (obj as Record<string, unknown>)
    );
    expect(hasTabCaptureWrite).toBe(false);
  });

  it('captureStarted 消息 → 通知 provider.onStreamEstablished()', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: 'sid' });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    expect(provider.onStreamEstablished).toHaveBeenCalledTimes(1);
  });

  it('M2-55：中途 stream-ended → 清除複用旗標 + 自動重取恢復（無 unhandled rejection）', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: 'sid' });
    const acquirer = makeAcquirer('recovered-id');
    source.setStreamIdProvider(provider);
    source.setStreamIdAcquirer(acquirer);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;

    // 捕括建立後，offscreen 回報 stream-ended（無待決握手 → handleMidCaptureError 路徑）。
    triggerPortMessage(mockPort, { type: 'error', message: 'stream ended unexpectedly', code: 'stream-ended' });
    await new Promise((r) => setTimeout(r, 10));

    // acquirer 被調用一次（自動重取恢復）
    expect(acquirer.acquire).toHaveBeenCalledTimes(1);
    // 複用旗標已清除（死串流丟棄）
    expect(provider.onStreamReleased).toHaveBeenCalledTimes(1);
  });

  it('§5.4：port.onDisconnect 觸發時解除 onMessage 監聽（防監聽器洩漏）', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    // 模擬 offscreen 文件被關閉 → port 斷開。
    triggerPortDisconnect(mockPort);
    const expectP = expect(startPromise).rejects.toThrow('offscreen port disconnected');
    await new Promise((r) => setTimeout(r, 20));
    await expectP;

    // §5.4 核心斷言：斷開後解除 onMessage 監聽，listener 不隨 start/stop 循環累積。
    expect(mockPort.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('§5.4：start→stop→start 循環不累積 port 監聽器（restart 路徑零洩漏）', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const ports: Array<ReturnType<typeof makeMockPort>> = [];
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const p = makeMockPort();
      ports.push(p);
      return p;
    });

    // 第一次 start→stop。
    let startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(ports[0], { type: 'captureStarted' });
    await startPromise;
    await handle.stop();

    // 第二次 start→stop（restart 路徑）。
    startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(ports[1], { type: 'captureStarted' });
    await startPromise;
    await handle.stop();

    // §5.4 核心斷言：同一 port 重複 start 不重複註冊監聽器（connectPort 冪等，
    // 且 handler 對重複調用安全——避免 offscreen 消息在 stop→start 間隙被舊監聽器誤處理）。
    expect(ports[0].onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(ports[1].onMessage.addListener).toHaveBeenCalledTimes(1);
  });
});

// M2-58：audioChunk 接收 breadcrumb（§5.6——「chunk 到沒到 content-script」必須可觀測）。
describe('TabCaptureAudioSource — M2-58 audioChunk 接收 breadcrumb', () => {
  let source: TabCaptureAudioSource;
  let handle: Awaited<ReturnType<TabCaptureAudioSource['open']>>;
  let mockPort: ReturnType<typeof makeMockPort>;

  beforeEach(async () => {
    resetChromeMock();
    setDebugFlags({ audio: false });
    source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    const startPromise = handle.start();
    await new Promise((r) => setTimeout(r, 0));
    triggerPortMessage(mockPort, { type: 'captureStarted' });
    await startPromise;
  });

  afterEach(() => {
    setDebugFlags({ audio: false });
  });

  it('audioChunk 消息 → chunkCallback 收到 AudioChunk（seq 遞增、duration 由樣本數計算）', async () => {
    const chunks: Array<{ seq: number; duration: number; sampleRate: number; pcm: Float32Array }> = [];
    source.onChunk((c) => chunks.push(c));

    triggerPortMessage(mockPort, { type: 'audioChunk', pcm: encodePcmFloat32(new Float32Array(4096)), sampleRate: 16_000, timestamp: 123 });
    triggerPortMessage(mockPort, { type: 'audioChunk', pcm: encodePcmFloat32(new Float32Array(4096)), sampleRate: 16_000, timestamp: 234 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[1].seq).toBe(1);
    // 4096 samples @ 16kHz = 256ms。
    expect(chunks[0].duration).toBeCloseTo(256);
    expect(chunks[0].sampleRate).toBe(16_000);
    expect(chunks[0].pcm).toHaveLength(4096);
  });

  it('§5.6：chunkCallback 未註冊時仍計數並留 breadcrumb（首塊 diagLog 可見，不再無聲丟棄）', async () => {
    setDebugFlags({ audio: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 不調用 source.onChunk（chunkCallback = null）。
    triggerPortMessage(mockPort, { type: 'audioChunk', pcm: encodePcmFloat32(new Float32Array(4096)), sampleRate: 16_000, timestamp: 1 });

    const firstChunkLogs = logSpy.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('first audioChunk received')
    );
    expect(firstChunkLogs).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('stop() 重置接收統計（新會話重新出現首塊 breadcrumb，計數不跨會話累積）', async () => {
    setDebugFlags({ audio: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    triggerPortMessage(mockPort, { type: 'audioChunk', pcm: encodePcmFloat32(new Float32Array(4096)), sampleRate: 16_000, timestamp: 1 });
    await handle.stop();

    // stop 後再收 chunk（mock port 未觸發 onDisconnect，listener 仍在）→ 計數已重置 → 再見「首塊」。
    triggerPortMessage(mockPort, { type: 'audioChunk', pcm: encodePcmFloat32(new Float32Array(4096)), sampleRate: 16_000, timestamp: 2 });

    const firstChunkLogs = logSpy.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('first audioChunk received')
    );
    expect(firstChunkLogs).toHaveLength(2);
    logSpy.mockRestore();
  });
});
