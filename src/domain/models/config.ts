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
  type: 'local-whisper' | 'cloud' | 'none';
  modelTier?: 'tiny' | 'base' | 'small';
  endpoint?: string;
  apiKeyRef?: string;
  /** VAD 能量閾值（0-1），低於此值視為靜音。默認 0.01。 */
  vadThreshold?: number;
  /** 自定義模型路徑（用於 vibevoice 等本地模型，優先於 modelTier）。 */
  customModelPath?: string;
}

/**
 * 調試日誌分類開關（M1-51）。
 * 全預設 false——非必要的流程診斷日誌默認關閉，避免控制台洪水；
 * 錯誤/降級診斷（recordDiagnostic/console.warn）不受此開關影響（§5.6 紅線不靜默）。
 */
export type DebugLogCategory =
  | 'overlay' // 覆蓋層渲染器（render/draw/cue 切換）
  | 'llm' // LLM 翻譯適配器（fetch/解析/快取）
  | 'capture' // timedtext 捕獲鏈路（bridge 等待/複用）與平台抓軌
  | 'pipeline' // 翻譯管線（primary/fallback 流轉）
  | 'strategy' // 字幕策略鏈（native-strategy 抓軌/翻譯/推送）
  | 'content' // content-script 總控（掛載/事件/熱重啟）
  | 'bridge' // timedtext 消息橋（waitForCapture/輪詢）
  | 'interceptor'; // MAIN world 攔截器（XHR/fetch hook/字幕模組驅動）

/** 調試日誌開關配置（每類一個布爾開關）。 */
export type DebugLogConfig = Record<DebugLogCategory, boolean>;

/** 全關的調試旗標（預設值）。 */
export const DEBUG_LOG_OFF: DebugLogConfig = {
  overlay: false,
  llm: false,
  capture: false,
  pipeline: false,
  strategy: false,
  content: false,
  bridge: false,
  interceptor: false,
};

/** 引擎整體配置（單一配置實體）。 */
export interface EngineConfig {
  translation: TranslationConfig;
  asr: ASRConfig;
  targetLang: string;
  displayMode: 'mono' | 'bilingual';
  performanceProfile: 'streaming' | 'balanced' | 'quality';
  subtitleStyle?: Record<string, string>;
  /** 調試日誌分類開關（M1-51；缺省全關）。 */
  debugLog: DebugLogConfig;
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
  subtitleStyle: {
    'font-size': '24px',
    color: '#ffffff',
    'background-color': 'rgba(32, 32, 32, 0.7)',
  },
  debugLog: DEBUG_LOG_OFF,
};
