import type { Millis } from './subtitle';

/** 內部標準音頻分塊——所有音頻來源的統一輸出。 */
export interface AudioChunk {
  /** 單調遞增序號，用於亂序重排。 */
  seq: number;
  /** 對應視頻時間軸的起點。 */
  startTime: Millis;
  duration: Millis;
  sampleRate: number;
  /** 通常單聲道為 1。 */
  channels: number;
  /** 解碼後 PCM（留在 Offscreen，避免跨組件拷貝）。 */
  pcm: Float32Array;
  /** VAD 結果：是否含語音。 */
  isSpeech: boolean;
}

/** 音頻源句柄：控制音頻流生命週期。 */
export interface AudioSourceHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly kind: 'tab-capture' | 'buffered';
}
