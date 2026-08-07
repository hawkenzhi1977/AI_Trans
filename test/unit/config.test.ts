import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  PROFILE_DEFAULTS,
} from '../../src/domain/models/config';

describe('config defaults', () => {
  it('DEFAULT_CONFIG 為 balanced 檔位、雲端 LLM 主 + MT 兜底', () => {
    expect(DEFAULT_CONFIG.performanceProfile).toBe('balanced');
    expect(DEFAULT_CONFIG.translation.type).toBe('cloud-llm');
    expect(DEFAULT_CONFIG.translation.fallbackType).toBe('mt');
    expect(DEFAULT_CONFIG.targetLang).toBe('zh-Hant');
  });

  it('DEFAULT_CONFIG 包含字幕樣式默認值（白字 + 灰黑半透明背景）', () => {
    expect(DEFAULT_CONFIG.subtitleStyle).toBeDefined();
    expect(DEFAULT_CONFIG.subtitleStyle?.['font-size']).toBe('24px');
    expect(DEFAULT_CONFIG.subtitleStyle?.color).toBe('#ffffff');
    expect(DEFAULT_CONFIG.subtitleStyle?.['background-color']).toBe('rgba(32, 32, 32, 0.7)');
  });

  it('PROFILE_DEFAULTS 覆蓋三檔且 ASR 模型層級遞增', () => {
    expect(PROFILE_DEFAULTS.streaming.asr.modelTier).toBe('tiny');
    expect(PROFILE_DEFAULTS.balanced.asr.modelTier).toBe('base');
    expect(PROFILE_DEFAULTS.quality.asr.modelTier).toBe('small');
  });

  it('streaming 檔位默認單語顯示以降延遲', () => {
    expect(PROFILE_DEFAULTS.streaming.displayMode).toBe('mono');
    expect(PROFILE_DEFAULTS.quality.displayMode).toBe('bilingual');
  });
});
