import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { TranslationProvider } from '../../domain/ports/translation-provider';

/**
 * LLM 翻譯適配器（OpenAI 兼容 /chat/completions）。
 * 端點、模型、密鑰均來自配置；密鑰以 ref 指向本地存儲。
 * 新增供應商只需複製本模式並適配請求格式。
 */
export class LLMTranslationProvider implements TranslationProvider {
  readonly location = 'cloud' as const;

  constructor(
    private readonly opts: {
      engineId: string;
      endpoint: string;
      model: string;
      apiKey: string;
      fetchFn?: typeof fetch;
    }
  ) {}

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

    const res = await (this.opts.fetchFn ?? fetch)(this.opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`LLM translation failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';

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
