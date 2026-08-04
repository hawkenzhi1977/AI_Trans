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
