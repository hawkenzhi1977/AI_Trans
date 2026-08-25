import type { EngineConfig } from '../domain/models/config';
import { DEFAULT_CONFIG } from '../domain/models/config';
import type { ConfigStore, ApiKeyStore } from '../domain/ports/config-store';

/**
 * Chrome storage 配置存儲——持久化於 chrome.storage.local。
 * EngineConfig 存於主 key；API 密鑰存於獨立 key（apiKeyRef 指向），不明文混入配置。
 * 非擴充環境（測試）提供內存實現見 test/harness。
 */
export class ChromeStorageConfigStore implements ConfigStore, ApiKeyStore {
  private static readonly KEY = 'engineConfig';
  private static readonly KEYS_KEY = 'engineConfigKeys';

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

  /** 讀取某引擎的 API 密鑰（獨立安全 key）。 */
  async getApiKey(slot: 'llm' | 'asr'): Promise<string | undefined> {
    const stored = await chrome.storage.local.get(ChromeStorageConfigStore.KEYS_KEY);
    const keys = (stored[ChromeStorageConfigStore.KEYS_KEY] ?? {}) as Record<string, string>;
    return keys[slot];
  }

  /** 寫入某引擎的 API 密鑰。 */
  async setApiKey(slot: 'llm' | 'asr', value: string): Promise<void> {
    const stored = await chrome.storage.local.get(ChromeStorageConfigStore.KEYS_KEY);
    const keys = (stored[ChromeStorageConfigStore.KEYS_KEY] ?? {}) as Record<string, string>;
    keys[slot] = value;
    await chrome.storage.local.set({ [ChromeStorageConfigStore.KEYS_KEY]: keys });
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
      // M2-34：debugLog 深合併——使用 base.debugLog 而非 DEFAULT_CONFIG.debugLog，
      // 避免部分 patch（如 Popup 切換 enabled）覆蓋已保存的調試設置。
      debugLog: { ...base.debugLog, ...(patch.debugLog ?? {}) },
    };
  }
}
