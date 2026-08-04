import type { AudioChunk, AudioSourceHandle } from '../models/audio';
import type { PlatformAdapter } from './platform-adapter';

/**
 * 音頻來源端口——隔離「二級預緩衝方案脆弱」風險。
 * TabCapture / Buffered 均輸出 AudioChunk，下游 ASR 管線無感。
 */
export interface AudioSourceProvider {
  readonly kind: 'tab-capture' | 'buffered';
  open(platform: PlatformAdapter): Promise<AudioSourceHandle>;
  /** 分塊音頻流（VAD 標記後推送）。 */
  onChunk(cb: (chunk: AudioChunk) => void): void;
}
