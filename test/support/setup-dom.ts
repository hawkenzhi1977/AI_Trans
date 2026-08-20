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
    getManifest: vi.fn(() => ({ version: '0.2.0' })),
    // M2-26：SW ensureOffscreenDocument 用；返空上下文 → 觸發 createDocument。
    getContexts: vi.fn(async () => [] as unknown[]),
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onConnect: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn(),
    connect: vi.fn(() => ({
      name: 'mock-port',
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn(),
    })),
    // M2-26：SW 生命週期事件（麵包屑測試用）；add 為 vi.fn() 供取出監聽器驅動。
    onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
    onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
    onSuspend: { addListener: vi.fn(), removeListener: vi.fn() },
    lastError: undefined,
  },
  offscreen: {
    createDocument: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    Reason: { USER_MEDIA: 'USER_MEDIA' },
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
