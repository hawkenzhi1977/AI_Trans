import type { EngineConfig } from '../models/config';

/** 配置存儲端口——讀寫與變更訂閱。 */
export interface ConfigStore {
  get(): Promise<EngineConfig>;
  set(patch: Partial<EngineConfig>): Promise<void>;
  /** 訂閱配置變更，返回取消訂閱函數。 */
  subscribe(cb: (config: EngineConfig) => void): () => void;
}
