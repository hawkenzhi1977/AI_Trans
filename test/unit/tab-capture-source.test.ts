import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetChromeMock } from '../support/setup-dom';
import { TabCaptureAudioSource } from '../../src/adapters/audio/tab-capture-source';

// M2-45：TabCaptureAudioSource 透過 Service Worker 創建 Offscreen Document
// （chrome.offscreen API 僅在 SW 可用，content-script 必須透過消息路由）。

describe('TabCaptureAudioSource — offscreen 創建透過 SW（M2-45）', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  it('start() 發送 offscreen:ensure-created 消息給 SW（不直接調用 chrome.offscreen）', async () => {
    const source = new TabCaptureAudioSource();
    const handle = await source.open({} as never);
    
    // 模擬 tabCapture 已授權
    await chrome.storage.local.set({
      tabCaptureAuthorized: true,
      tabCaptureStreamId: 'test-stream-id',
    });
    
    // 模擬 SW 響應 offscreen:ensure-created
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { topic?: string }) => {
        if (msg.topic === 'offscreen:ensure-created') {
          return { ok: true };
        }
        return { ok: false, error: 'unknown topic' };
      }
    );
    
    // 模擬 port 連接
    const mockPort = {
      name: 'offscreen-asr',
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn(),
    };
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);
    
    await handle.start();
    
    // 驗證發送了 offscreen:ensure-created 消息
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'offscreen:ensure-created' })
    );
    
    // 驗證沒有直接調用 chrome.offscreen.createDocument
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    
    // 驗證建立了 port 連接
    expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: 'offscreen-asr' });
    
    // 驗證發送了 startCapture 消息
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startCapture', streamId: 'test-stream-id' })
    );
  });

  it('start() offscreen:ensure-created 失敗 → 落診斷並拋錯', async () => {
    const source = new TabCaptureAudioSource();
    const handle = await source.open({} as never);
    
    await chrome.storage.local.set({
      tabCaptureAuthorized: true,
      tabCaptureStreamId: 'test-stream-id',
    });
    
    // 模擬 SW 響應失敗
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'offscreen create failed',
    });
    
    await expect(handle.start()).rejects.toThrow('offscreen create failed');
    
    // 驗證落了診斷
    const stored = await chrome.storage.local.get('lastDiagnostic');
    const rec = stored.lastDiagnostic as { message?: string } | undefined;
    expect(rec?.message).toBeDefined();
  });

  it('stop() 發送 offscreen:idle-close 消息給 SW（不直接調用 chrome.offscreen.closeDocument）', async () => {
    const source = new TabCaptureAudioSource();
    const handle = await source.open({} as never);
    
    await chrome.storage.local.set({
      tabCaptureAuthorized: true,
      tabCaptureStreamId: 'test-stream-id',
    });
    
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (msg: { topic?: string }) => {
        if (msg.topic === 'offscreen:ensure-created' || msg.topic === 'offscreen:idle-close') {
          return { ok: true };
        }
        return { ok: false, error: 'unknown topic' };
      }
    );
    
    const mockPort = {
      name: 'offscreen-asr',
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn(),
    };
    (chrome.runtime.connect as ReturnType<typeof vi.fn>).mockReturnValue(mockPort);
    
    await handle.start();
    await handle.stop();
    
    // 驗證發送了 offscreen:idle-close 消息
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'offscreen:idle-close' })
    );
    
    // 驗證沒有直接調用 chrome.offscreen.closeDocument
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
    
    // 驗證 port 已斷開
    expect(mockPort.disconnect).toHaveBeenCalled();
  });
});
