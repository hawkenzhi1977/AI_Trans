/** 統一錯誤模型——全管線一致使用，供降級決策與觀測。 */
export interface PipelineError {
  port: 'platform' | 'audio' | 'asr' | 'translation' | 'render';
  code: string;
  recoverable: boolean;
  cause?: unknown;
}
