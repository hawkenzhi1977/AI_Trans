// 能量閾值 VAD（Voice Activity Detection）——基於 RMS 能量計算。
// 無外部依賴，簡單高效；用於過濾靜音片段，節省 ASR 算力。
import type { AudioChunk } from '../domain/models/audio';

/** VAD 配置。 */
export interface VADConfig {
  /** RMS 能量閾值（0-1），低於此值視為靜音。默認 0.01。 */
  threshold: number;
  /** 靜音持續時間（毫秒），超過則觸發分段邊界。默認 2000ms。 */
  silenceDurationMs: number;
}

/** 默認 VAD 配置。 */
export const DEFAULT_VAD_CONFIG: VADConfig = {
  threshold: 0.01,
  silenceDurationMs: 2000,
};

/** VAD 結果。 */
export interface VADResult {
  /** 是否含語音。 */
  isSpeech: boolean;
  /** RMS 能量值（0-1）。 */
  rms: number;
}

/**
 * 能量閾值 VAD——計算 PCM 數據的 RMS 能量，判斷是否含語音。
 * 用於過濾靜音片段，避免 ASR 處理無意義音頻。
 */
export class EnergyVAD {
  private readonly config: VADConfig;
  private silenceStartTime: number | null = null;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  /**
   * 處理音頻塊，返回 VAD 結果。
   * @param pcm 單聲道 PCM 數據（Float32Array，值域 -1 到 1）。
   * @param _sampleRate 採樣率（Hz，保留供未來擴展）。
   * @param timestamp 時間戳（毫秒，performance.now()）。
   */
  process(pcm: Float32Array, _sampleRate: number, timestamp: number): VADResult {
    // 計算 RMS 能量。
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      sum += pcm[i] * pcm[i];
    }
    const rms = Math.sqrt(sum / pcm.length);

    // 判斷是否含語音。
    const isSpeech = rms >= this.config.threshold;

    // 追蹤靜音持續時間（用於分段邊界檢測）。
    if (!isSpeech) {
      if (this.silenceStartTime === null) {
        this.silenceStartTime = timestamp;
      }
    } else {
      this.silenceStartTime = null;
    }

    return { isSpeech, rms };
  }

  /**
   * 檢測是否應觸發分段邊界（靜音持續超過閾值）。
   * @param timestamp 當前時間戳（毫秒）。
   * @returns 是否應切分音頻塊。
   */
  shouldSegment(timestamp: number): boolean {
    if (this.silenceStartTime === null) return false;
    const silenceDuration = timestamp - this.silenceStartTime;
    return silenceDuration >= this.config.silenceDurationMs;
  }

  /** 重置靜音計數器（新音頻流開始時調用）。 */
  reset(): void {
    this.silenceStartTime = null;
  }

  /**
   * 標記 AudioChunk 的 isSpeech 字段（批量處理）。
   * @param chunk 待標記的音頻塊。
   * @returns 標記後的音頻塊（原地修改）。
   */
  markChunk(chunk: AudioChunk): AudioChunk {
    const { isSpeech } = this.process(chunk.pcm, chunk.sampleRate, performance.now());
    chunk.isSpeech = isSpeech;
    return chunk;
  }
}
