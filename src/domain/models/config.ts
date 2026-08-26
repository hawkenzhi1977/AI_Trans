/** 本地 ONNX 翻譯模型檔位。 */
export const LOCAL_TRANSLATION_MODELS = {
  /** 小型翻譯模型（MarianMT），專為翻譯設計，記憶體小、速度快。僅支援英→中。 */
  small: 'Xenova/opus-mt-en-zh',
  /** 大型通用 LLM 模型（Qwen2.5），高質量翻譯，但記憶體大、速度較慢。 */
  large: 'onnx-community/Qwen2.5-0.5B-Instruct',
} as const;

/** 本地 ONNX 翻譯模型檔位類型。 */
export type LocalModelTier = keyof typeof LOCAL_TRANSLATION_MODELS;

/** 本地 ONNX 翻譯兜底模型名稱（唯讀，預設為小型模型）。 */
export const DEFAULT_LOCAL_TRANSLATION_MODEL = LOCAL_TRANSLATION_MODELS.small;

/** 翻譯引擎配置。 */
export interface TranslationConfig {
  type: 'cloud-llm' | 'local' | 'mt' | 'local-onnx';
  model?: string;
  endpoint?: string;
  /** 指向本地安全存儲，不明文散播。 */
  apiKeyRef?: string;
  /** LLM 失敗時兜底引擎。 */
  fallbackType?: 'mt' | 'local-onnx' | 'none';
  /** 本地 ONNX 兜底模型名稱（唯讀，預設為小型翻譯模型）。 */
  localModelName?: string;
  /** 本地 ONNX 模型檔位（small/large）。small 適合低配置機器，large 適合高質量需求。 */
  localModelTier?: LocalModelTier;
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
  | 'interceptor' // MAIN world 攔截器（XHR/fetch hook/字幕模組驅動）
  | 'local-onnx' // 本地 ONNX 翻譯適配器（chunk 進度/echo 統計）
  | 'popup'; // Popup 生命週期診斷（init 時序/storage 阻塞/openOptionsPage 失敗）

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
  'local-onnx': false,
  popup: false,
};

/** 引擎整體配置（單一配置實體）。 */
export interface EngineConfig {
  /** 整體功能開關（false = 完全停用字幕翻譯，恢復 YouTube 原生字幕）。 */
  enabled: boolean;
  translation: TranslationConfig;
  asr: ASRConfig;
  targetLang: string;
  displayMode: 'mono' | 'bilingual';
  performanceProfile: 'streaming' | 'balanced' | 'quality';
  subtitleStyle?: Record<string, string>;
  /** 調試日誌分類開關（M1-51；缺省全關）。 */
  debugLog: DebugLogConfig;
  /** M2-36：虛假 seek 防護閾值（毫秒）。若 seekTime=0 但當前播放位置 > 此值，忽略此次 seek。預設 10000ms。 */
  falseSeekThresholdMs?: number;
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
  enabled: true,
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
  falseSeekThresholdMs: 10000,
};
