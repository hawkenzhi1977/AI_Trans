// jsdom 環境補全：MV3 chrome API 與 fetch 的最小 mock，供集成測試使用。
import { vi } from 'vitest';

// 內存版 chrome.storage.local
const memory = new Map<string, unknown>();

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
        if (keys == null) return Object.fromEntries(memory);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out: Record<string, unknown> = {};
        for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) memory.set(k, v);
      }),
      remove: vi.fn(async (key: string) => {
        memory.delete(key);
      }),
      clear: vi.fn(async () => {
        memory.clear();
      }),
    },
  },
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://fake/${path}`),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn(),
    lastError: undefined,
  },
  tabs: {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(),
    reload: vi.fn(async () => {}),
  },
};

// @ts-expect-error 注入全局 chrome
globalThis.chrome = chromeMock;

export function resetChromeMock(): void {
  memory.clear();
  vi.clearAllMocks();
}
