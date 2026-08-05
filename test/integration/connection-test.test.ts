import { describe, it, expect } from 'vitest';
import { testConnection } from '../../src/runtime/popup/connection-test';
import type { EngineConfig } from '../../src/domain/models/config';

// 構造最小 local 引擎配置。
function localConfig(endpoint: string, model: string): EngineConfig {
  return {
    translation: { type: 'local', model, endpoint, fallbackType: 'mt' },
    asr: { type: 'local-whisper', modelTier: 'base' },
    targetLang: 'zh-Hant',
    displayMode: 'bilingual',
    performanceProfile: 'balanced',
  };
}

// 最小 OpenAI 兼容成功響應。
const okResponse = (): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'ping' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('testConnection 連接測試', () => {
  it('端點可達 + 模型存在 → ok=true', async () => {
    const fetchMock = async (url: string): Promise<Response> => {
      expect(url).toBe('http://127.0.0.1:59999/v1/chat/completions'); // normalizeEndpoint 補全
      return okResponse();
    };
    const r = await testConnection(localConfig('http://127.0.0.1:59999/v1', 'm'), '', fetchMock);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.detail).toContain('m');
  });

  it('模型 404（如 Model not found）→ ok=false 且含 HTTP 狀態與伺服器原因', async () => {
    const fetchMock = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { message: "Model 'x' not found" } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    const r = await testConnection(localConfig('http://127.0.0.1:59999/v1', 'x'), '', fetchMock);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('404');
      expect(r.error).toContain("Model 'x' not found");
    }
  });

  it('網絡失敗（連接拒絕）→ ok=false 且標記網絡失敗', async () => {
    const fetchMock = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    const r = await testConnection(localConfig('http://127.0.0.1:59999/v1', 'm'), '', fetchMock);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('網絡失敗');
  });

  it('MT 引擎 / 缺端點 / 缺模型 → 快速失敗不回網絡', async () => {
    const r1 = await testConnection(
      { ...localConfig('', ''), translation: { type: 'mt' } } as EngineConfig,
      '',
      async () => okResponse()
    );
    expect(r1.ok).toBe(false);

    const r2 = await testConnection(
      { ...localConfig('', 'm'), translation: { type: 'local', model: 'm', endpoint: '' } } as EngineConfig,
      '',
      async () => okResponse()
    );
    expect(r2.ok).toBe(false);

    const r3 = await testConnection(
      { ...localConfig('http://x/v1', ''), translation: { type: 'local', model: '', endpoint: 'http://x/v1' } } as EngineConfig,
      '',
      async () => okResponse()
    );
    expect(r3.ok).toBe(false);
  });

  it('響應結構異常（無 choices）→ ok=false', async () => {
    const fetchMock = async (): Promise<Response> =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const r = await testConnection(localConfig('http://127.0.0.1:59999/v1', 'm'), '', fetchMock);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('choices');
  });
});
