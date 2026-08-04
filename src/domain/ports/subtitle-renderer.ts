import type { Millis } from '../models/subtitle';

/** 渲染器可消費的字幕提示（譯文為主）。 */
export interface RenderableCue {
  id: string;
  sourceText?: string;
  translatedText: string;
  provisional: boolean;
  /** 當前是否在時間窗內（按播放時間選段）。 */
  active?: boolean;
  start: Millis;
  end: Millis;
}

/** 字幕渲染端口——覆蓋層/樣式變化可替換實現。 */
export interface SubtitleRenderer {
  mount(container: HTMLElement, style?: Record<string, string>): void;
  /** 按當前播放時間渲染。 */
  render(cues: RenderableCue[], currentTime: Millis): void;
  /** 臨時字幕原地更新。 */
  updateProvisional(cue: RenderableCue): void;
  unmount(): void;
}
