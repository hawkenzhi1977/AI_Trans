/** 翻譯引擎配置。 */
export interface TranslationConfig {
  type: 'cloud-llm' | 'local' | 'mt';
  model?: string;
  endpoint?: string;
  /** 指向本地安全存儲，不明文散播。 */
  apiKeyRef?: string;
  /** LLM 失敗時兜底引擎。 */
  fallbackType?: 'mt' | 'none';
}

/** ASR 引擎配置。 */
export interface ASRConfig {
  type: 'local-whisper' | 'cloud';
  modelTier?: 'tiny' | 'base' | 'small';
  endpoint?: string;
  apiKeyRef?: string;
}

/** 引擎整體配置（單一配置實體）。 */
export interface EngineConfig {
  translation: TranslationConfig;
  asr: ASRConfig;
  targetLang: string;
  displayMode: 'mono' | 'bilingual';
  performanceProfile: 'streaming' | 'balanced' | 'quality';
  subtitleStyle?: Record<string, string>;
}

/** 預設配置檔位。 */
export const PROFILE_DEFAULTS: Record<
  EngineConfig['performanceProfile'],
  Pick<EngineConfig, 'asr' | 'displayMode'>
> = {
  streaming: {
    asr: { type: 'local-whisper', modelTier: 'tiny' },
    displayMode: 'mono',
  },
  balanced: {
    asr: { type: 'local-whisper', modelTier: 'base' },
    displayMode: 'bilingual',
  },
  quality: {
    asr: { type: 'local-whisper', modelTier: 'small' },
    displayMode: 'bilingual',
  },
};

/** 默認配置。 */
export const DEFAULT_CONFIG: EngineConfig = {
  translation: { type: 'cloud-llm', fallbackType: 'mt' },
  asr: { type: 'local-whisper', modelTier: 'base' },
  targetLang: 'zh-Hant',
  displayMode: 'bilingual',
  performanceProfile: 'balanced',
};
