import type { ASRConfig } from '../models/config';
import type { ASRRequest, ASRResult } from '../models/asr';

/**
 * ASR 引擎端口——本地/雲端一視同仁。
 * 新增供應商只需實現本接口並在 Registry 註冊。
 */
export interface ASRProvider {
  readonly engineId: string;
  readonly location: 'local' | 'cloud';
  /** 模型預熱/常駐，消除首次推理抖動。 */
  warmup(config: ASRConfig): Promise<void>;
  transcribe(req: ASRRequest): Promise<ASRResult>;
  /** 可選：流式部分結果，支持 provisional 字幕。 */
  transcribeStream?(
    req: ASRRequest,
    emit: (r: ASRResult) => void
  ): Promise<void>;
}
