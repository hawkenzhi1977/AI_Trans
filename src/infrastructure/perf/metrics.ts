// 性能觀測——收集 metrics 事件，計算 P50/P95 延遲與 RTF 統計。
// 用於動態降檔決策（RTF > 1.0 持續 30s → 降檔模型檔位）。
import type { PerfSample } from '../../domain/models/events';

/** 性能統計摘要。 */
export interface PerfSummary {
  /** 樣本數量。 */
  count: number;
  /** P50 延遲（毫秒）。 */
  p50: number;
  /** P95 延遲（毫秒）。 */
  p95: number;
  /** 平均 RTF（實時因子）。 */
  avgRtf: number;
  /** 最大 RTF。 */
  maxRtf: number;
}

/**
 * 性能指標收集器——滑動窗口統計。
 * 用於監控 ASR/翻譯/渲染延遲，觸發動態降檔。
 */
export class PerfMetrics {
  /** 滑動窗口大小（樣本數）。 */
  private readonly windowSize: number;
  /** 樣本緩存（按 stage 分組）。 */
  private readonly samples: Map<string, PerfSample[]> = new Map();

  constructor(windowSize = 100) {
    this.windowSize = windowSize;
  }

  /** 添加性能樣本。 */
  add(sample: PerfSample): void {
    const stage = sample.stage;
    if (!this.samples.has(stage)) {
      this.samples.set(stage, []);
    }
    const list = this.samples.get(stage)!;
    list.push(sample);
    // 滑動窗口：超過 windowSize 時移除最舊樣本。
    if (list.length > this.windowSize) {
      list.shift();
    }
  }

  /** 獲取指定階段的統計摘要。 */
  summary(stage: string): PerfSummary | null {
    const list = this.samples.get(stage);
    if (!list || list.length === 0) return null;

    // 排序計算分位數。
    const sorted = [...list].sort((a, b) => a.ms - b.ms);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);

    // RTF 統計（僅對有 rtf 的樣本）。
    const rtfSamples = list.filter((s) => s.rtf !== undefined);
    const avgRtf =
      rtfSamples.length > 0
        ? rtfSamples.reduce((sum, s) => sum + (s.rtf ?? 0), 0) / rtfSamples.length
        : 0;
    const maxRtf = rtfSamples.length > 0 ? Math.max(...rtfSamples.map((s) => s.rtf ?? 0)) : 0;

    return {
      count: list.length,
      p50: sorted[p50Index].ms,
      p95: sorted[p95Index].ms,
      avgRtf,
      maxRtf,
    };
  }

  /** 獲取所有階段的統計摘要。 */
  allSummaries(): Map<string, PerfSummary> {
    const result = new Map<string, PerfSummary>();
    for (const stage of this.samples.keys()) {
      const summary = this.summary(stage);
      if (summary) result.set(stage, summary);
    }
    return result;
  }

  /** 重置所有統計。 */
  reset(): void {
    this.samples.clear();
  }

  /**
   * 檢測是否需要降檔（RTF > 1.0 持續超過閾值）。
   * @param thresholdMs 持續時間閾值（毫秒），默認 30000ms（30s）。
   * @returns 是否建議降檔。
   */
  shouldDowngrade(thresholdMs = 30000): boolean {
    const asrSummary = this.summary('asr');
    if (!asrSummary) return false;

    // 檢查最近樣本中 RTF > 1.0 的比例。
    const asrSamples = this.samples.get('asr') ?? [];
    const highRtfCount = asrSamples.filter((s) => (s.rtf ?? 0) > 1.0).length;
    const highRtfRatio = highRtfCount / asrSamples.length;

    // 若超過 50% 樣本 RTF > 1.0，且持續時間超過閾值，建議降檔。
    if (highRtfRatio > 0.5 && asrSamples.length >= 10) {
      // 估算持續時間：假設樣本間隔均勻，用樣本數 × 平均間隔估算。
      const avgInterval = asrSamples.length > 1 ? 
        (asrSamples[asrSamples.length - 1].seq! - asrSamples[0].seq!) / (asrSamples.length - 1) : 1;
      const estimatedDuration = asrSamples.length * avgInterval * 256; // 256ms per chunk
      return estimatedDuration >= thresholdMs;
    }

    return false;
  }
}
