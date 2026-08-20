import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleTimeout } from '../../src/infrastructure/idle-timeout';

describe('IdleTimeout — 空閒計時器', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('超時後觸發 onTimeout 一次', () => {
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout });
    idle.start();
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // 觸發後不再重複觸發（一次性）。
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('reset 在超時前重置計時（活動延後空閒）', () => {
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout });
    idle.start();
    vi.advanceTimersByTime(900);
    idle.reset(); // 900ms 處活動 → 重新計時 1000ms。
    vi.advanceTimersByTime(500);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500); // 距上次活動 1000ms。
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stop 後不再觸發（§5.4 清理）', () => {
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout });
    idle.start();
    idle.stop();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    // stop 後 reset 無效。
    idle.reset();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('start 重複調用不重複註冊計時器（§5.4 不累積）', () => {
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout });
    idle.start();
    idle.start();
    idle.start();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('isIdle 反映空閒狀態（供外部守衛判斷）', () => {
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout });
    idle.start();
    expect(idle.isIdle()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(idle.isIdle()).toBe(true);
  });

  it('支持注入時間源（可移植測試）', () => {
    let now = 0;
    const onTimeout = vi.fn();
    const idle = new IdleTimeout({ timeoutMs: 1000, onTimeout, now: () => now });
    idle.start();
    now = 1500;
    expect(idle.isIdle()).toBe(true);
  });
});