import type { Millis } from './subtitle';

export interface BufferedRange {
  start: Millis;
  end: Millis;
}

export interface PlaybackState {
  currentTime: Millis;
  playing: boolean;
  /** 播放倍速。 */
  rate: number;
  duration: Millis;
  /** 供二級判斷可預取範圍。 */
  buffered: BufferedRange[];
}
