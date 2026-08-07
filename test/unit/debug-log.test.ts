import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setDebugFlags, getDebugFlags, diagLog } from '../../src/infrastructure/debug-log';
import type { DebugLogConfig } from '../../src/domain/models/config';
import { DEBUG_LOG_OFF } from '../../src/domain/models/config';

/** M1-51：調試日誌中央門控——默認全關，開關開啟後才輸出。 */
describe('debug-log — 分類門控（M1-51）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setDebugFlags(DEBUG_LOG_OFF);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('默認全關（DEBUG_LOG_OFF）時 diagLog 不輸出', () => {
    diagLog('overlay', 'should not appear');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('開啟某分類後 diagLog 輸出且帶 [AI_Trans:diag][category] 前綴', () => {
    setDebugFlags({ ...DEBUG_LOG_OFF, llm: true });
    diagLog('llm', 'fetch ok', 42);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const args = logSpy.mock.calls[0] ?? [];
    expect(args[0]).toBe('[AI_Trans:diag][llm]');
    expect(args[1]).toBe('fetch ok');
    expect(args[2]).toBe(42);
  });

  it('開關僅影響對應分類，其他分類仍靜默', () => {
    setDebugFlags({ ...DEBUG_LOG_OFF, pipeline: true });
    diagLog('pipeline', 'on');
    diagLog('overlay', 'off');
    diagLog('interceptor', 'off');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('getDebugFlags 返回獨立副本（外部修改不影響內部狀態）', () => {
    setDebugFlags({ ...DEBUG_LOG_OFF, bridge: true });
    const flags = getDebugFlags();
    flags.bridge = false;
    expect(getDebugFlags().bridge).toBe(true);
  });

  it('setDebugFlags 接受部分旗標（缺省分類補全為 false）', () => {
    const partial: Partial<DebugLogConfig> = { capture: true };
    setDebugFlags(partial);
    expect(getDebugFlags().capture).toBe(true);
    expect(getDebugFlags().strategy).toBe(false);
  });

  it('setDebugFlags(undefined) 重置為全關', () => {
    setDebugFlags({ ...DEBUG_LOG_OFF, overlay: true });
    setDebugFlags(undefined);
    expect(getDebugFlags()).toEqual(DEBUG_LOG_OFF);
  });

  it('八個分類全部覆蓋（overlay/llm/capture/pipeline/strategy/content/bridge/interceptor）', () => {
    const all: DebugLogConfig = { ...DEBUG_LOG_OFF };
    for (const k of Object.keys(DEBUG_LOG_OFF) as Array<keyof DebugLogConfig>) all[k] = true;
    setDebugFlags(all);
    const categories = Object.keys(DEBUG_LOG_OFF) as Array<keyof DebugLogConfig>;
    for (const cat of categories) diagLog(cat, 'x');
    expect(logSpy).toHaveBeenCalledTimes(categories.length);
    expect(Object.keys(DEBUG_LOG_OFF).sort()).toEqual(
      ['bridge', 'capture', 'content', 'interceptor', 'llm', 'overlay', 'pipeline', 'strategy']
    );
  });
});
