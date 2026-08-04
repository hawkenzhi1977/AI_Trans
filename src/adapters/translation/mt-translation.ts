import type { SubtitleSegment } from '../../domain/models/subtitle';
import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { TranslationProvider } from '../../domain/ports/translation-provider';

/** 單詞級替換字典（測試/演示用）。實際 MT 引擎按同接口接入。 */
export interface MTDictionary {
  [word: string]: string;
}

/**
 * 傳統 MT 兜底適配器。
 * 默認實現為字典替換；真實 MT 服務（DeepL/Google 等）按同一接口實現即可。
 */
export class MTTranslationProvider implements TranslationProvider {
  readonly location = 'cloud' as const;
  readonly engineId = 'mt';

  constructor(private readonly dict: MTDictionary = {}) {}

  translate(req: TranslationRequest): Promise<TranslationResult> {
    const segments: SubtitleSegment[] = req.segments.map((s) => ({
      ...s,
      translatedText: this.replace(s.sourceText),
      targetLang: req.targetLang,
    }));
    return Promise.resolve({
      segments,
      engineId: this.engineId,
      degraded: false,
    });
  }

  private replace(text: string): string {
    // 按詞替換；保留標點。
    return text.replace(/[A-Za-z]+/g, (w) => this.dict[w.toLowerCase()] ?? w);
  }
}
