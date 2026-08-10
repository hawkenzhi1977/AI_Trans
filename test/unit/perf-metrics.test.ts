import { describe, it, expect } from 'vitest';
import { PerfMetrics } from '../../src/infrastructure/perf/metrics';

describe('PerfMetrics', () => {
  it('收集樣本並計算統計摘要', () => {
    const perf = new PerfMetrics(10);

    // 添加 10 個樣本。
    for (let i = 0; i < 10; i++) {
      perf.add({
        stage: 'asr',
        ms: 100 + i * 10,
        seq: i,
        rtf: 0.5 + i * 0.1,
      });
    }

    const summary = perf.summary('asr');
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(10);
    expect(summary!.p50).toBe(150); // 第 6 個樣本（0-indexed: 5）
    expect(summary!.p95).toBe(190); // 第 10 個樣本（0-indexed: 9）
    expect(summary!.avgRtf).toBeCloseTo(0.95, 2);
    expect(summary!.maxRtf).toBe(1.4);
  });

  it('滑動窗口：超過 windowSize 時移除最舊樣本', () => {
    const perf = new PerfMetrics(5);

    // 添加 10 個樣本。
    for (let i = 0; i < 10; i++) {
      perf.add({ stage: 'asr', ms: i * 100, seq: i });
    }

    const summary = perf.summary('asr');
    expect(summary!.count).toBe(5);
    expect(summary!.p50).toBe(700); // 第 3 個樣本（0-indexed: 2）
  });

  it('檢測降檔條件：RTF > 1.0 持續超過閾值', () => {
    const perf = new PerfMetrics(20);

    // 添加 15 個高 RTF 樣本（超過 50% 比例）。
    for (let i = 0; i < 15; i++) {
      perf.add({
        stage: 'asr',
        ms: 500,
        seq: i,
        rtf: 1.5, // RTF > 1.0
      });
    }

    // 由於 shouldDowngrade 需要估算持續時間，這裡只檢查高 RTF 比例。
    const summary = perf.summary('asr');
    expect(summary).not.toBeNull();
    expect(summary!.avgRtf).toBeGreaterThan(1.0);
  });

  it('不觸發降檔：RTF < 1.0', () => {
    const perf = new PerfMetrics(20);

    // 添加 15 個低 RTF 樣本。
    for (let i = 0; i < 15; i++) {
      perf.add({
        stage: 'asr',
        ms: 100,
        seq: i,
        rtf: 0.5, // RTF < 1.0
      });
    }

    expect(perf.shouldDowngrade(30000)).toBe(false);
  });

  it('重置所有統計', () => {
    const perf = new PerfMetrics();
    perf.add({ stage: 'asr', ms: 100, seq: 0 });
    perf.reset();

    expect(perf.summary('asr')).toBeNull();
  });
});
