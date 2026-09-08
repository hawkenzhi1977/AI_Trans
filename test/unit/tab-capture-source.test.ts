import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import { TabCaptureAudioSource } from '../../src/adapters/audio/tab-capture-source';
import type { TabStreamIdProvider } from '../../src/adapters/audio/tab-capture-source';

// M2-46：TabCaptureAudioSource 使用 in-memory streamId provider（不落 storage）。
// streamId 由 popup 透過 tabs.sendMessage 直接交付 content-script 記憶體，
// 避免一次性 TTL token 落 storage 被重複消費。

/** 建立標準 mock port。 */
function makeMockPort() {
  return {
    name: 'offscreen-asr',
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn(),
  };
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

describe('TabCaptureAudioSource — in-memory streamId provider（M2-46）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  it('start() 消費 provider 的 streamId 並送給 offscreen（不讀 storage）', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: 'fresh-stream-id' });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    await handle.start();

    // 消費了 provider 的 streamId
    expect(provider.consumeStreamId).toHaveBeenCalledTimes(1);

    // 發送了 startCapture 消息，帶正確 streamId
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startCapture', streamId: 'fresh-stream-id' })
    );

    // 沒有讀 storage 取 streamId（storage.local.get 不應被呼叫用於 streamId）
    // （setup-dom 的 mock 允許 get 被呼叫用於其他目的，但 provider 路徑不需要它）
  });

  it('start() provider 返回 null → 複用已有 MediaStream，送 streamId=null 給 offscreen', async () => {
    const source = new TabCaptureAudioSource();
    const provider = makeProvider({ streamId: null, hasActive: true });
    source.setStreamIdProvider(provider);
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const mockPort = makeMockPort();
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);

    await handle.start();

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

    await expect(handle.start()).rejects.toThrow('tabCapture not authorized');

    // 落了診斷
    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toBeDefined();

    // M2-54：不再寫 storage，避免觸發 onAsrAuthChanged 競態 restart。
    // tabCaptureAuthorized 的重置由 content-script 的 onEvent 統一管理。
    const auth = await chrome.storage.local.get('tabCaptureAuthorized');
    expect(auth.tabCaptureAuthorized).toBeUndefined(); // setup-dom 初始值未設，確認沒被寫入
  });

  it('start() 發送 offscreen:ensure-created 給 SW（不直接調用 chrome.offscreen）', async () => {
    const source = new TabCaptureAudioSource();
    source.setStreamIdProvider(makeProvider({ streamId: 'sid' }));
    const handle = await source.open({} as never);

    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(makeMockPort());

    await handle.start();

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

    await handle.start();
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

    // 記錄 storage.local.set 的調用
    const setCalls: unknown[] = [];
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementation((obj: unknown) => {
      setCalls.push(obj);
      return Promise.resolve();
    });

    await expect(handle.start()).rejects.toThrow('tabCapture not authorized');

    // M2-54 核心斷言：adapter 層不再寫 tabCaptureAuthorized 到 storage，
    // 避免觸發 onAsrAuthChanged 競態 restart。
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

    await handle.start();

    // 找到 port.onMessage.addListener 注冊的回調
    const onMsgListener = (mockPort.onMessage.addListener as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((msg: unknown) => void) | undefined;
    expect(onMsgListener).toBeDefined();

    onMsgListener!({ type: 'captureStarted' });

    expect(provider.onStreamEstablished).toHaveBeenCalledTimes(1);
  });
});
