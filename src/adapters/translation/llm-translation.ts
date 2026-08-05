import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { TranslationProvider } from '../../domain/ports/translation-provider';

/**
 * LLM 翻譯適配器（OpenAI 兼容 /chat/completions）。
 * 端點、模型、密鑰均來自配置；密鑰以 ref 指向本地存儲。
 * 新增供應商只需複製本模式並適配請求格式。
 */
export class LLMTranslationProvider implements TranslationProvider {
  readonly location = 'cloud' as const;
  // R1：默認 fetch 必須綁定 globalThis，content-script 中裸 fetch 會拋 Illegal invocation。
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      engineId: string;
      endpoint: string;
      model: string;
      apiKey: string;
      fetchFn?: typeof fetch;
      /** 請求超時（毫秒）。reasoning 模型可能長時間思考，超時後降級 fallback 避免字幕卡死。 */
      timeoutMs?: number;
    }
  ) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
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

    // R4 配套：AbortController 超時。reasoning 模型單次可能 30~40s，超時拋錯 → pipeline 降級 fallback。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError 或網絡錯誤：統一拋出供上層降級。
      throw new Error(
        `LLM translation request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`LLM translation failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = stripReasoning(data.choices?.[0]?.message?.content ?? '');

    // 解析 "ID<TAB>translation" 行。
    const map = new Map<string, string>();
    for (const line of content.split('\n')) {
      const m = /^(\d+)\t(.+)$/.exec(line.trim());
      if (m) map.set(m[1], m[2]);
    }

    const translated = req.segments.map((s, i) => ({
      ...s,
      translatedText: map.get(String(i)) ?? s.sourceText,
      targetLang: req.targetLang,
    }));

    return { segments: translated, engineId: this.opts.engineId, degraded: false };
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
