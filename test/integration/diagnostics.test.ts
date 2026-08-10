import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DIAGNOSTIC_KEY,
  extractDiagnostic,
  formatDiagnostic,
  isUserActionable,
  recordDiagnostic,
  readLastDiagnostic,
} from '../../src/infrastructure/diagnostics';
import type { PipelineEvent } from '../../src/domain/models/events';
import { resetChromeMock } from '../support/setup-dom';

describe('diagnostics 診斷持久化', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
  });

  it('engine-degraded(translation) 提取為 degraded 診斷，並寫入 chrome.storage.local', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event: PipelineEvent = {
      type: 'engine-degraded',
      port: 'translation',
      reason: 'primary failed: TypeError: Failed to fetch',
    };

    await recordDiagnostic(event);

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    const rec = stored[DIAGNOSTIC_KEY] as { kind: string; message: string; timestamp: string };
    expect(rec.kind).toBe('degraded');
    expect(rec.message).toContain('TypeError: Failed to fetch');
    expect(rec.timestamp).toBeTruthy();
    // console 麵包屑：警告文本包含降級原因，方便 DevTools 排查。
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('primary failed: TypeError: Failed to fetch')
    );
  });

  it('pipeline-error 提取為 error 診斷（cause 為 Error 時保留 name: message）', async () => {
    const event: PipelineEvent = {
      type: 'pipeline-error',
      error: {
        port: 'translation',
        code: 'translation-failed',
        recoverable: true,
        cause: new TypeError('Failed to fetch'),
      },
    };

    await recordDiagnostic(event);

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    expect((stored[DIAGNOSTIC_KEY] as { kind: string }).kind).toBe('error');
    expect((stored[DIAGNOSTIC_KEY] as { message: string }).message).toBe('TypeError: Failed to fetch');
  });

  it('策略級降級（strategy-degraded）與非引擎事件不記錄', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordDiagnostic({ type: 'strategy-degraded', from: 'native', to: 'realtime-asr' });
    await recordDiagnostic({ type: 'segments-ready', segments: [] });

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    expect(stored[DIAGNOSTIC_KEY]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('chrome.storage 拋錯時 recordDiagnostic 不崩潰（§5.7 try/catch 守護）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 模擬擴充環境異常：storage.set 拒絕。
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage unavailable'));

    const event: PipelineEvent = {
      type: 'engine-degraded',
      port: 'translation',
      reason: 'boom',
    };
    await expect(recordDiagnostic(event)).resolves.toBeUndefined();
    // console 麵包屑仍舊輸出（觀測不受存儲失敗影響）。
    expect(warn).toHaveBeenCalled();
  });

  it('readLastDiagnostic 返回持久化記錄，無記錄/損壞記錄返回 undefined', async () => {
    await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: { kind: 'degraded', message: 'boom', timestamp: 't0' } });
    const rec = await readLastDiagnostic();
    expect(rec?.message).toBe('boom');

    // 損壞記錄（非對象/缺 message）→ undefined
    await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: 'garbage' });
    expect(await readLastDiagnostic()).toBeUndefined();

    // 無記錄 → undefined
    await chrome.storage.local.remove(DIAGNOSTIC_KEY);
    expect(await readLastDiagnostic()).toBeUndefined();
  });

  it('formatDiagnostic 生成 popup 顯示文本；無記錄返回 undefined', () => {
    expect(
      formatDiagnostic({ kind: 'degraded', message: 'primary failed: x', timestamp: '2026-08-05T00:00:00Z' })
    ).toBe('降級: primary failed: x (2026-08-05T00:00:00Z)');
    expect(
      formatDiagnostic({ kind: 'error', message: 'TypeError: Failed to fetch', timestamp: 't0' })
    ).toBe('錯誤: TypeError: Failed to fetch (t0)');
    expect(formatDiagnostic(undefined)).toBeUndefined();
  });

  it('extractDiagnostic 非 translation/asr 端口的降級不記錄（如 platform 端口）', () => {
    const diag = extractDiagnostic({ type: 'engine-degraded', port: 'platform', reason: 'no adapter' });
    expect(diag).toBeUndefined();
  });
});

describe('isUserActionable 白名單匹配（popup 過濾用）', () => {
  it('網絡錯誤匹配', () => {
    expect(isUserActionable('TypeError: Failed to fetch')).toBe(true);
    expect(isUserActionable('NetworkError when attempting to fetch resource')).toBe(true);
    expect(isUserActionable('CORS policy: No Access-Control-Allow-Origin')).toBe(true);
    expect(isUserActionable('Mixed Content: blocked upgrade')).toBe(true);
    expect(isUserActionable('net::ERR_CONNECTION_REFUSED')).toBe(true);
  });

  it('HTTP 狀態碼匹配', () => {
    expect(isUserActionable('HTTP 401 Unauthorized')).toBe(true);
    expect(isUserActionable('HTTP 403 Forbidden')).toBe(true);
    expect(isUserActionable('HTTP 404 Not Found')).toBe(true);
    expect(isUserActionable('HTTP 429 Too Many Requests')).toBe(true);
    expect(isUserActionable('HTTP 500 Internal Server Error')).toBe(true);
    expect(isUserActionable('HTTP 502 Bad Gateway')).toBe(true);
    expect(isUserActionable('HTTP 503 Service Unavailable')).toBe(true);
    expect(isUserActionable('HTTP 504 Gateway Timeout')).toBe(true);
  });

  it('權限類錯誤匹配', () => {
    expect(isUserActionable('tab-capture-not-authorized')).toBe(true);
    expect(isUserActionable('user not authorized')).toBe(true);
    expect(isUserActionable('permission denied')).toBe(true);
    expect(isUserActionable('access denied for resource')).toBe(true);
  });

  it('配置類錯誤匹配', () => {
    expect(isUserActionable('model gpt-4o-mini not found')).toBe(true);
    expect(isUserActionable('invalid endpoint URL')).toBe(true);
    expect(isUserActionable('API key missing or invalid')).toBe(true);
    expect(isUserActionable('resource not found')).toBe(true);
    expect(isUserActionable('invalid configuration')).toBe(true);
  });

  it('內部調測信息不匹配', () => {
    expect(isUserActionable('JSON parse failed: Unexpected token')).toBe(false);
    expect(isUserActionable('no caption tracks found')).toBe(false);
    expect(isUserActionable('player response videoId mismatch')).toBe(false);
    expect(isUserActionable('stale DOM data detected')).toBe(false);
    expect(isUserActionable('bridge captured tracks timeout')).toBe(false);
    expect(isUserActionable('interceptor videoId mismatch')).toBe(false);
  });
});

describe('recordDiagnostic actionable 標記', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
  });

  it('用戶可操作錯誤設置 actionable: true', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event: PipelineEvent = {
      type: 'engine-degraded',
      port: 'translation',
      reason: 'TypeError: Failed to fetch',
    };

    await recordDiagnostic(event);

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    const rec = stored[DIAGNOSTIC_KEY] as { actionable: boolean };
    expect(rec.actionable).toBe(true);
  });

  it('內部調測錯誤設置 actionable: false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event: PipelineEvent = {
      type: 'pipeline-error',
      error: {
        port: 'platform',
        code: 'parse-failed',
        recoverable: false,
        cause: new Error('JSON parse failed: Unexpected token'),
      },
    };

    await recordDiagnostic(event);

    const stored = (await chrome.storage.local.get(DIAGNOSTIC_KEY)) as Record<string, unknown>;
    const rec = stored[DIAGNOSTIC_KEY] as { actionable: boolean };
    expect(rec.actionable).toBe(false);
  });
});
