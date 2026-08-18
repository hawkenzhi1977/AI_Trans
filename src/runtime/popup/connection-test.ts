// 連接測試——Popup「測試連接」按鈕的後端邏輯（純邏輯，可單測）。
// 直接向配置的端點發一個最小 /chat/completions 請求，驗證三件事：
//   1. 端點可達（fetch 不拋網絡錯誤）——排除 mixed-content / 端口 / CORS。
//   2. 模型名存在（HTTP 200 vs 404 Model not found）。
//   3. 響應可解析且符合預期結構。
// 與真實翻譯路徑共用 normalizeEndpoint，保證「測試的就是實際會發的請求」。
import { normalizeEndpoint } from '../endpoint';
import type { EngineConfig } from '../../domain/models/config';

export type ConnectionStatus =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/**
 * 用當前配置測試 LLM 端點連通性。
 * @param config 當前引擎配置
 * @param apiKey 從 ApiKeyStore 解析的密鑰（可能為空）
 * @returns ok=true 表示端點可達、模型存在、響應有效；否則返回人類可讀錯誤。
 */
export async function testConnection(
  config: EngineConfig,
  apiKey: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = 10_000
): Promise<ConnectionStatus> {
  const tc = config.translation;
  // 僅支持需要網絡的引擎。
  if (tc.type !== 'cloud-llm' && tc.type !== 'local') {
    return { ok: false, error: '當前引擎類型不需網絡連線（MT 字典 / 本地 ONNX）。請選雲端 LLM 或本地模型。' };
  }
  if (!tc.endpoint) {
    return { ok: false, error: '未填寫端點（Endpoint）。' };
  }

  const endpoint = normalizeEndpoint(tc.endpoint);
  const model = tc.model ?? (tc.type === 'cloud-llm' ? 'gpt-4o-mini' : '');
  if (!model) {
    return { ok: false, error: '未填寫模型 ID。' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'user', content: 'ping' },
        ],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 伺服器有回應但拒絕——最常見是模型名 404。嘗試解析錯誤體取具體原因。
      let serverMsg = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        serverMsg = body.error?.message ?? '';
      } catch {
        // 非 JSON 錯誤體，忽略。
      }
      return {
        ok: false,
        error: `HTTP ${res.status}${serverMsg ? ` — ${serverMsg}` : ''}`,
      };
    }

    // 響應結構驗證：OpenAI 兼容成功響應含 choices[0].message.content。
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      return { ok: false, error: '響應結構異常：無 choices 數組。' };
    }
    return { ok: true, detail: `端點可達，模型 ${model} 回應正常。` };
  } catch (err) {
    // 網絡層失敗（連接拒絕 / mixed-content / CORS / 超時）。
    const reason = err instanceof Error ? err.message : String(err);
    const timeoutHit = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      error: timeoutHit
        ? `請求超時（${timeoutMs / 1000}s）。檢查端點與服務狀態。`
        : `網絡失敗: ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
