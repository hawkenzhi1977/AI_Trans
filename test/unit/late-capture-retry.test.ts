import { describe, it, expect } from 'vitest';
import { LateCaptureRetry } from '../../src/application/late-capture-retry';

// 晚捕獲重試狀態機（M2-24 補充修復十四）單元測試。
// 覆蓋守衛：未置位 / 視頻不匹配 / 重試上限 / 冷卻 / segments-ready 解除。

describe('LateCaptureRetry — 晚捕獲重試狀態機', () => {
  it('未置位（arm 前）時捕獲到達不觸發重試', () => {
    const retry = new LateCaptureRetry();
    expect(retry.onCapture({ videoId: 'abc' })).toBeNull();
    expect(retry.isAwaiting).toBe(false);
  });

  it('arm 後同一視頻的捕獲觸發重試，返回 1-based 序號', () => {
    const retry = new LateCaptureRetry();
    retry.arm('abc');
    expect(retry.isAwaiting).toBe(true);
    expect(retry.onCapture({ videoId: 'abc' })).toBe(1);
    expect(retry.retryCount).toBe(1);
  });

  it('arm 後不同視頻的捕獲不觸發重試（videoId 守衛）', () => {
    const retry = new LateCaptureRetry();
    retry.arm('abc');
    expect(retry.onCapture({ videoId: 'xyz' })).toBeNull();
    expect(retry.retryCount).toBe(0);
  });

  it('捕獲無 videoId 時保守接受（無法判別不誤拒）', () => {
    const retry = new LateCaptureRetry();
    retry.arm('abc');
    expect(retry.onCapture({})).toBe(1);
  });

  it('arm(null) 時任何捕獲都接受（無期望視頻）', () => {
    const retry = new LateCaptureRetry();
    retry.arm(null);
    expect(retry.onCapture({ videoId: 'xyz' })).toBe(1);
  });

  it('達到 maxRetries 後不再觸發重試', () => {
    const retry = new LateCaptureRetry({ maxRetries: 2, cooldownMs: 0 });
    retry.arm('abc');
    expect(retry.onCapture({ videoId: 'abc' })).toBe(1);
    expect(retry.onCapture({ videoId: 'abc' })).toBe(2);
    expect(retry.onCapture({ videoId: 'abc' })).toBeNull();
    expect(retry.retryCount).toBe(2);
  });

  it('冷卻內捕獲到達不觸發重試（cooldownMs 守衛）', () => {
    let now = 0;
    const retry = new LateCaptureRetry({ cooldownMs: 5000, now: () => now });
    retry.arm('abc');
    now = 1000;
    expect(retry.onCapture({ videoId: 'abc' })).toBe(1); // 首次允許
    now = 2000; // 距上次 1000ms < 5000ms
    expect(retry.onCapture({ videoId: 'abc' })).toBeNull();
    now = 7000; // 距上次 5000ms，冷卻結束
    expect(retry.onCapture({ videoId: 'abc' })).toBe(2);
  });

  it('disarm 重置等待狀態與計數（segments-ready / stop 解除）', () => {
    const retry = new LateCaptureRetry({ cooldownMs: 0 });
    retry.arm('abc');
    retry.onCapture({ videoId: 'abc' });
    expect(retry.retryCount).toBe(1);
    retry.disarm();
    expect(retry.isAwaiting).toBe(false);
    expect(retry.retryCount).toBe(0);
    // disarm 後捕獲到達不再觸發
    expect(retry.onCapture({ videoId: 'abc' })).toBeNull();
  });

  it('重新 arm 後計數重新開始（換視頻/重啟場景）', () => {
    const retry = new LateCaptureRetry({ maxRetries: 2, cooldownMs: 0 });
    retry.arm('abc');
    retry.onCapture({ videoId: 'abc' });
    retry.onCapture({ videoId: 'abc' });
    expect(retry.onCapture({ videoId: 'abc' })).toBeNull(); // 達上限
    retry.disarm();
    retry.arm('abc');
    expect(retry.onCapture({ videoId: 'abc' })).toBe(1); // 重新開始
  });

  it('latencyMs 反映 arm 到查詢時刻的延遲；未 arm 為 0', () => {
    let now = 0;
    const retry = new LateCaptureRetry({ now: () => now });
    expect(retry.latencyMs).toBe(0);
    retry.arm('abc');
    now = 12345;
    expect(retry.latencyMs).toBe(12345);
    retry.disarm();
    expect(retry.latencyMs).toBe(0);
  });
});