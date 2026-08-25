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
  /** 獲取視頻音頻語言（BCP-47 格式，如 "en"、"zh-Hant"）；無法獲取返回 undefined。 */
  getAudioLanguage(): string | undefined;
  /** 上次字幕軌抓取的診斷信息（可選）：供策略鏈區分「無數據源/無字幕/解析失敗」，避免靜默（§5.6）。 */
  getLastTrackDiagnostic?(): string | undefined;
  /** 提供音頻源句柄（含 tabCapture / buffered）。 */
  getAudioSource(): Promise<AudioSourceHandle>;
  /** 覆蓋層字幕掛載容器。 */
  mountPoint(): HTMLElement;
}
