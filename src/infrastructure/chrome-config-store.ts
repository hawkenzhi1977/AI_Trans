import type { EngineConfig } from '../domain/models/config';
import { DEFAULT_CONFIG } from '../domain/models/config';
import type { ConfigStore } from '../domain/ports/config-store';

/**
 * Chrome storage 配置存儲——持久化於 chrome.storage.local。
 * 非擴充環境（測試）提供內存實現見 test/harness。
 */
export class ChromeStorageConfigStore implements ConfigStore {
  private static readonly KEY = 'engineConfig';

  async get(): Promise<EngineConfig> {
    const stored = await chrome.storage.local.get(ChromeStorageConfigStore.KEY);
    const raw = stored[ChromeStorageConfigStore.KEY] as Partial<EngineConfig> | undefined;
    return this.merge(DEFAULT_CONFIG, raw ?? {});
  }

  async set(patch: Partial<EngineConfig>): Promise<void> {
    const current = await this.get();
    const next = this.merge(current, patch);
    await chrome.storage.local.set({ [ChromeStorageConfigStore.KEY]: next });
    for (const cb of this.subscribers) cb(next);
  }

  subscribe(cb: (config: EngineConfig) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private readonly subscribers = new Set<(c: EngineConfig) => void>();

  private merge(base: EngineConfig, patch: Partial<EngineConfig>): EngineConfig {
    return {
      ...base,
      ...patch,
      translation: { ...base.translation, ...(patch.translation ?? {}) },
      asr: { ...base.asr, ...(patch.asr ?? {}) },
    };
  }
}
