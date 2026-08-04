// 領域層統一導出——穩定核心，無外部依賴。
export * from './models/audio';
export * from './models/asr';
export * from './models/config';
export * from './models/events';
export * from './models/pipeline-error';
export * from './models/playback';
export * from './models/subtitle';
export * from './models/translation';

export * from './ports/asr-provider';
export * from './ports/audio-source';
export * from './ports/caption-strategy';
export * from './ports/config-store';
export * from './ports/message-bus';
export * from './ports/platform-adapter';
export * from './ports/subtitle-renderer';
export * from './ports/translation-provider';
