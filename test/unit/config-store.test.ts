import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChromeStorageConfigStore } from '../../src/infrastructure/chrome-config-store';
import { DEFAULT_CONFIG } from '../../src/domain/models/config';

// 內存版 chrome.storage.local mock。
const memory = new Map<string, unknown>();
const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async () => Object.fromEntries(memory)),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) memory.set(k, v);
      }),
    },
  },
};

beforeEach(() => {
  memory.clear();
  // @ts-expect-error 注入全局 chrome
  globalThis.chrome = chromeMock;
  vi.clearAllMocks();
});

describe('ChromeStorageConfigStore', () => {
  it('get() 返回合併默認值的完整配置', async () => {
    const store = new ChromeStorageConfigStore();
    const config = await store.get();
    expect(config).toMatchObject({
      targetLang: DEFAULT_CONFIG.targetLang,
      displayMode: DEFAULT_CONFIG.displayMode,
    });
  });

  it('set() 寫入 patch 並與既有值合併（嵌套 translation/asr）', async () => {
    const store = new ChromeStorageConfigStore();
    await store.set({ translation: { type: 'mt' } });
    await store.set({ targetLang: 'en' });
    const config = await store.get();
    expect(config.translation.type).toBe('mt');
    expect(config.targetLang).toBe('en');
    // 未覆蓋項保留默認
    expect(config.translation.fallbackType).toBe('mt');
    expect(config.asr.modelTier).toBe('base');
  });

  it('subscribe 在 set 後收到新配置', async () => {
    const store = new ChromeStorageConfigStore();
    const seen: Array<string> = [];
    const unsub = store.subscribe((c) => seen.push(c.targetLang));
    await store.set({ targetLang: 'ja' });
    expect(seen).toEqual(['ja']);
    unsub();
  });

  it('API 密鑰存於獨立 key，不混入 EngineConfig', async () => {
    const store = new ChromeStorageConfigStore();
    await store.setApiKey('llm', 'sk-test-123');
    const config = await store.get();
    // 密鑰不可見於配置對象
    expect(JSON.stringify(config)).not.toContain('sk-test-123');
    expect(await store.getApiKey('llm')).toBe('sk-test-123');
    expect(await store.getApiKey('asr')).toBeUndefined();
  });

  it('apiKeyRef 存儲後不影響配置默認合併', async () => {
    const store = new ChromeStorageConfigStore();
    await store.setApiKey('asr', 'key-asr');
    await store.set({ asr: { type: 'cloud', endpoint: 'https://asr.example.com' } });
    const config = await store.get();
    expect(config.asr.type).toBe('cloud');
    expect(config.asr.endpoint).toBe('https://asr.example.com');
    expect(await store.getApiKey('asr')).toBe('key-asr');
  });
});
