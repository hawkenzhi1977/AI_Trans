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
 * 創建通過 Service Worker 代理的 fetch 函數。
 * Popup/Content-script 受 CORS 限制無法直接 fetch Ollama 等本地 LLM，
 * 由 SW 代理 POST 請求（SW 有 host_permissions 即可跨域 fetch）。
 */
export function createSwProxyFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await chrome.runtime.sendMessage({
      topic: 'sw:proxy-fetch-llm',
      payload: {
        url,
        method: init?.method ?? 'POST',
        headers: init?.headers as Record<string, string> | undefined,
        body: init?.body as string | undefined,
      },
    });
    const res = response as { ok: boolean; status?: number; body?: string; error?: string };
    if (res.error && !res.status) {
      throw new Error(res.error);
    }
    return new Response(res.body ?? '', {
      status: res.status ?? 200,
      statusText: res.ok ? 'OK' : 'Error',
    });
  };
}

/**
 * 用當前配置測試 LLM 端點連通性。
 * @param config 當前引擎配置
 * @param apiKey 從 ApiKeyStore 解析的密鑰（可能為空）
 * @returns ok=true 表示端點可達、模型存在、響應有效；否則返回人類可讀錯誤。
 */
export async function testConnection(
  config: EngineConfig,
  apiKey: string,
  fetchFn: typeof fetch = createSwProxyFetch(),
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
      let hasErrorBody = false;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        serverMsg = body.error?.message ?? '';
        hasErrorBody = true;
      } catch {
        // 非 JSON 錯誤體，忽略。
      }
      
      // 403 空 body 特殊處理：常見於本地 LLM 服務的 Origin 檢查
      if (res.status === 403 && !hasErrorBody) {
        return {
          ok: false,
          error: 'HTTP 403 — 服務端拒絕請求且未返回錯誤詳情（常見於本地 LLM 服務的 Origin 檢查，請參考文檔配置允許的來源）',
        };
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
