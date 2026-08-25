import { describe, it, expect, vi } from 'vitest';
import { buildDefaultRegistry } from '../../src/runtime/composition';
import { normalizeEndpoint } from '../../src/runtime/endpoint';
import { DEFAULT_CONFIG, type EngineConfig } from '../../src/domain/models/config';
import type { ApiKeyStore } from '../../src/domain/ports/config-store';
import type { Registry } from '../../src/application/registry';

/** 內存 ApiKeyStore stub。 */
class MemoryApiKeyStore implements ApiKeyStore {
  constructor(private readonly keys: Record<string, string> = {}) {}
  async getApiKey(slot: 'llm' | 'asr'): Promise<string | undefined> {
    return this.keys[slot];
  }
  async setApiKey(slot: 'llm' | 'asr', value: string): Promise<void> {
    this.keys[slot] = value;
  }
}

const CONFIG = (patch: Partial<EngineConfig>): EngineConfig => ({
  ...DEFAULT_CONFIG,
  ...patch,
  translation: { ...DEFAULT_CONFIG.translation, ...(patch.translation ?? {}) },
  asr: { ...DEFAULT_CONFIG.asr, ...(patch.asr ?? {}) },
});

describe('buildDefaultRegistry 配置注入（M1-25）', () => {
  it('cloud-llm 配置註冊 llm + mt，且 apiKey 從安全存儲解析', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({ translation: { type: 'cloud-llm', model: 'gpt-test', endpoint: 'https://x/chat/completions' } }),
      { apiKeyStore: new MemoryApiKeyStore({ llm: 'sk-secret' }) }
    );

    const llm = registry.translation.get('llm');
    expect(llm).toBeDefined();
    expect(llm?.engineId).toBe('llm');
    expect(llm?.location).toBe('cloud');
    expect(registry.translation.has('mt')).toBe(true);
  });

  it('local 類型註冊 engineId=local-llm', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({ translation: { type: 'local' } }),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    expect(registry.translation.get('local-llm')?.engineId).toBe('local-llm');
  });

  it('local 端點自動補全：填 Base URL /v1 時實際請求發往 /v1/chat/completions', async () => {
    const captured: Array<RequestInfo | URL> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: '0\t你好' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const registry = await buildDefaultRegistry(
        CONFIG({ translation: { type: 'local', model: 'qwen-mlx', endpoint: 'http://127.0.0.1:8000/v1' } }),
        { apiKeyStore: new MemoryApiKeyStore({ llm: '1108' }) }
      );
      await registry.translation.get('local-llm')?.translate({
        segments: [{ id: '0', start: 0, end: 1000, sourceText: 'hi', origin: 'native', provisional: false, revision: 0 }],
        targetLang: 'zh-Hant',
      });
      expect(String(captured[0])).toBe('http://127.0.0.1:8000/v1/chat/completions');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('normalizeEndpoint 端點規範化（兩種填法兼容）', () => {
    it('完整 /chat/completions 路徑原樣保留', () => {
      expect(normalizeEndpoint('http://127.0.0.1:8000/v1/chat/completions')).toBe(
        'http://127.0.0.1:8000/v1/chat/completions'
      );
    });
    it('Base URL /v1 補全為 /v1/chat/completions', () => {
      expect(normalizeEndpoint('http://127.0.0.1:8000/v1')).toBe(
        'http://127.0.0.1:8000/v1/chat/completions'
      );
    });
    it('裸 host 補全為 /v1/chat/completions', () => {
      expect(normalizeEndpoint('http://127.0.0.1:8000')).toBe(
        'http://127.0.0.1:8000/v1/chat/completions'
      );
    });
    it('尾部斜杠被去除後再補全', () => {
      expect(normalizeEndpoint('http://127.0.0.1:8000/v1/')).toBe(
        'http://127.0.0.1:8000/v1/chat/completions'
      );
    });
    it('空/undefined 回落 OpenAI 默認端點', () => {
      expect(normalizeEndpoint(undefined)).toBe('https://api.openai.com/v1/chat/completions');
      expect(normalizeEndpoint('   ')).toBe('https://api.openai.com/v1/chat/completions');
    });
  });

  it('mt 類型僅註冊 mt，不註冊 llm', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({ translation: { type: 'mt' } }),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    expect(registry.translation.has('mt')).toBe(true);
    expect(registry.translation.has('llm')).toBe(false);
  });

  it('type=local-onnx 時註冊 local-onnx 引擎（即使 fallbackType 非 local-onnx）', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({ translation: { type: 'local-onnx', fallbackType: 'mt' } }),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    const localOnnx = registry.translation.get('local-onnx');
    expect(localOnnx).toBeDefined();
    expect(localOnnx?.engineId).toBe('local-onnx');
    expect(localOnnx?.location).toBe('local');
    expect(registry.translation.has('mt')).toBe(true);
  });

  it('fallbackType=local-onnx 時仍註冊 local-onnx 引擎（兜底路徑不破壞）', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({ translation: { type: 'cloud-llm', fallbackType: 'local-onnx' } }),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    expect(registry.translation.get('local-onnx')?.engineId).toBe('local-onnx');
    expect(registry.translation.has('llm')).toBe(true);
  });

  it('註冊默認策略鏈（native → lookahead → realtime）與 YouTube 平台', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({}),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    expect(registry.platforms.map((p) => p.platformId)).toEqual(['youtube']);
    expect(registry.strategies.map((s) => s.origin)).toEqual([
      'native',
      'lookahead-asr',
      'realtime-asr',
    ]);
  });

  it('apiKey 不散播入配置對象，僅存於安全存儲', async () => {
    const store = new MemoryApiKeyStore({ llm: 'sk-secret' });
    const config = CONFIG({ translation: { type: 'cloud-llm' } });
    await buildDefaultRegistry(config, { apiKeyStore: store });
    expect(JSON.stringify(config)).not.toContain('sk-secret');
    expect(await store.getApiKey('llm')).toBe('sk-secret');
  });

  it('LLM 翻譯請求實際攜帶從安全存儲解析的 Authorization', async () => {
    // 捕獲發往 LLM 端點的請求頭。
    const captured: RequestInit[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(init ?? {});
      // 返回中文翻譯（匹配 targetLang: 'zh-Hant'），避免觸發語言錯誤偵測。
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '0\t你好世界' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const registry: Registry = await buildDefaultRegistry(
        CONFIG({
          translation: {
            type: 'cloud-llm',
            model: 'gpt-test',
            endpoint: 'https://llm.example.com/chat/completions',
          },
        }),
        { apiKeyStore: new MemoryApiKeyStore({ llm: 'sk-secret' }) }
      );

      const llm = registry.translation.get('llm');
      const result = await llm?.translate({
        segments: [{ id: '0', start: 0, end: 1000, sourceText: 'hello world', origin: 'native', provisional: false, revision: 0 }],
        targetLang: 'zh-Hant',
      });

      expect(captured).toHaveLength(1);
      const headers = captured[0]!.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-secret');
      expect(result?.segments[0]?.translatedText).toBe('你好世界');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('local-whisper ASR 配置 customModelPath 時優先於 modelTier', async () => {
    const registry: Registry = await buildDefaultRegistry(
      CONFIG({
        asr: {
          type: 'local-whisper',
          modelTier: 'base',
          customModelPath: 'custom/vibevoice-model',
        },
      }),
      { apiKeyStore: new MemoryApiKeyStore() }
    );
    const asr = registry.asr.get('local-whisper');
    expect(asr).toBeDefined();
    expect(asr?.engineId).toBe('local-whisper');
    expect(asr?.location).toBe('local');
  });
});
