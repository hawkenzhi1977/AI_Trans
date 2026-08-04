import type { AudioSourceHandle } from '../models/audio';
import type { PlaybackState } from '../models/playback';
import type { CaptionTrack } from '../models/subtitle';

/**
 * 平台適配器端口——隔離「平台頁面/接口改版」風險。
 * YouTube 等具體平台的變化，收斂在實現內部，核心無感。
 */
export interface PlatformAdapter {
  readonly platformId: string;
  matches(url: string): boolean;
  /** 監聽播放狀態，返回取消訂閱函數。 */
  observePlayback(cb: (state: PlaybackState) => void): () => void;
  /** 發現原生字幕軌。 */
  listCaptionTracks(): Promise<CaptionTrack[]>;
  /** 提供音頻源句柄（含 tabCapture / buffered）。 */
  getAudioSource(): Promise<AudioSourceHandle>;
  /** 覆蓋層字幕掛載容器。 */
  mountPoint(): HTMLElement;
}
