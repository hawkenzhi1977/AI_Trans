import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { TranslationProvider } from '../../domain/ports/translation-provider';

/**
 * LLM 翻譯適配器（OpenAI 兼容 /chat/completions）。
 * 端點、模型、密鑰均來自配置；密鑰以 ref 指向本地存儲。
 * 新增供應商只需複製本模式並適配請求格式。
 *
 * M1-48：content script 無法直接 fetch localhost（CORS 限制），
 * 翻譯請求通過 service worker 代理（chrome.runtime.sendMessage）。
 */
export class LLMTranslationProvider implements TranslationProvider {
  readonly location = 'cloud' as const;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      engineId: string;
      endpoint: string;
      model: string;
      apiKey: string;
      /** 請求超時（毫秒）。reasoning 模型可能長時間思考，超時後降級 fallback 避免字幕卡死。 */
      timeoutMs?: number;
    }
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get engineId(): string {
    return this.opts.engineId;
  }

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const lines: string[] = req.segments.map((s, i) => `${i}\t${s.sourceText}`);

    const body = {
      model: this.opts.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a subtitle translator. Translate each line to ' +
            `${req.targetLang}. Keep the segment IDs as prefixes. Reply as "${req.targetLang}" text lines with the same IDs. ` +
            'Output one translated line per input line, format: "ID<TAB>translation".',
        },
        ...(req.context?.length
          ? [{ role: 'user', content: `Context: ${req.context.join('\n')}` }]
          : []),
        { role: 'user', content: lines.join('\n') },
      ],
    };

    // M1-48：直接 fetch（content script 在 ISOLATED world 有 host_permissions）
    const response = await this.fetchDirectly({
      endpoint: this.opts.endpoint,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    console.log('[AI_Trans:diag] LLM: response status =', response.status, ', ok =', response.ok);
    if (!response.ok) {
      throw new Error(`LLM translation failed: HTTP ${response.status}`);
    }

    // §5.6：HTTP 200 但 body 非 JSON（本地服務返回 HTML 錯誤頁/代理返回純文本）時，
    // JSON.parse 的 SyntaxError 不含語義——必須 try/catch 並把「解析失敗」與響應片段
    // 寫進錯誤信息，否則用戶只看到 `SyntaxError: Unexpected token` 無法定位。
    let data: {
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      data = JSON.parse(response.body) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      console.log('[AI_Trans:diag] LLM: JSON parsed, choices count =', data.choices?.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AI_Trans:diag] LLM: JSON parse failed, body snippet =', response.body.substring(0, 200));
      throw new Error(
        `LLM translation response is not valid JSON: ${msg}. Body snippet: ${response.body.substring(0, 200)}`
      );
    }
    const choice = data.choices?.[0];
    // §5.6：choices 缺失（如被限流返回 {error}、結構變更）時**不允許靜默回退原文**——
    // 那是翻譯靜默失效且 degraded=false 的最典型漏洞（字幕出來但是原文，用戶查不到原因）。
    // 必須拋錯走降級機制（fallback / engine-degraded + pipeline-error）。
    if (!choice || typeof choice.message?.content !== 'string') {
      console.error('[AI_Trans:diag] LLM: no valid choices[0].message.content, choice =', choice);
      throw new Error(
        `LLM translation response has no valid choices[0].message.content (possibly rate-limited or schema changed)`
      );
    }
    const content = stripReasoning(choice.message.content);
    console.log('[AI_Trans:diag] LLM: content after stripReasoning =', content);

    // 解析 "ID<TAB>translation" 行。
    const map = new Map<string, string>();
    for (const line of content.split('\n')) {
      const m = /^(\d+)\t(.+)$/.exec(line.trim());
      if (m) map.set(m[1], m[2]);
    }
    console.log('[AI_Trans:diag] LLM: parsed map size =', map.size, ', map =', Object.fromEntries(map));

    const translated = req.segments.map((s, i) => ({
      ...s,
      translatedText: map.get(String(i)) ?? s.sourceText,
      targetLang: req.targetLang,
    }));
    console.log('[AI_Trans:diag] LLM: translated segments =', translated.map(s => ({ id: s.id, translated: s.translatedText })));

    return { segments: translated, engineId: this.opts.engineId, degraded: false };
  }

  /**
   * 直接 fetch 翻譯端點。
   * content script 在 ISOLATED world 有 host_permissions（manifest.json），
   * 可以直接 fetch localhost，不受 CORS 限制。
   */
  private async fetchDirectly(request: {
    endpoint: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    console.log('[AI_Trans:diag] LLM: fetching directly to', request.endpoint);
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await globalThis.fetch(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const elapsed = Date.now() - startTime;
      console.log('[AI_Trans:diag] LLM: fetch completed in', elapsed, 'ms, status =', res.status);
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

/**
 * 剝離 reasoning 模型可能混入 content 的思考塊——防禦性容錯。
 * OpenAI 兼容服務通常把思考分離到 reasoning_content（我們只讀 content 故不受影響），
 * 但部分 MLX/本地服務會把 <think>...</think> 直接塞進 content，需剝離避免污染字幕解析。
 * 移除成對 <think>..</think>，並清掉殘留的開/閉標籤與由此產生的前導空行。
 */
export function stripReasoning(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // 成對思考塊
    .replace(/<\/?think>/gi, '') // 殘留單邊標籤
    .replace(/^\s+/, ''); // 剝離後可能的前導空白
}
