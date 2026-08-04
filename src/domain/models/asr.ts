import type { AudioChunk } from './audio';
import type { SubtitleSegment } from './subtitle';

export interface ASRRequest {
  chunk: AudioChunk;
  /** 語言提示（可選）。 */
  hintLang?: string;
  /** 是否允許 provisional 部分結果。 */
  allowPartial: boolean;
}

export interface ASRResult {
  /** 對應 AudioChunk.seq，用於重排。 */
  seq: number;
  /** 帶時間軸的識別結果（origin=*-asr）。 */
  segments: SubtitleSegment[];
  /** 是否 provisional。 */
  isPartial: boolean;
  /** 實時因子（推理耗時 / 音頻時長），觀測用。 */
  rtf?: number;
}
