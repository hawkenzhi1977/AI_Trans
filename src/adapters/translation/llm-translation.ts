import type { TranslationRequest, TranslationResult } from '../../domain/models/translation';
import type { TranslationProvider } from '../../domain/ports/translation-provider';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { diagLog } from '../../infrastructure/debug-log';

/**
 * LLM 翻譯適配器（OpenAI 兼容 /chat/completions）。
 * 端點、模型、密鑰均來自配置；密鑰以 ref 指向本地存儲。
 *
 * M1-48：content script 直接 fetch（host_permissions），不再經 service worker 代理。
 * M1-52（字幕延遲優化，~10min → 首塊可見後秒級）：
 * - 超時覆蓋 fetch+body 讀取（原 clearTimeout 在收到響應頭後即取消，body 讀取掛死）。
 * - 分塊翻譯：長字幕（數百段）切片（~60 行/塊）逐塊請求，首塊譯完即漸進發出
 *   （translateStream → segments-ready/segments-updated），後續塊增量合併。
 * - LRU 快取：key=model|targetLang|hash(塊內所有源文)，上限 100 條
 *   （djb2 哈希，~120B/條 ≈ 12KB）——相同視頻/語言重播時免請求；
 *   chrome.storage.onChanged 偵測 EngineConfig 變更 → invalidateCache() 全量失效。
 * - 瞬態失敗重試：網絡中止/超時、HTTP 429/5xx、body 讀取與 JSON 解析錯誤重試 ≤2 次
 *   （500ms→1500ms 退避）；永久失敗（4xx 非 429、choices 缺失）不重試直接降級。
 */

/** LLM 適配層錯誤——攜帶 status/transient 旗標供重試與管線降級判斷。 */
export class LLMRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status（無 HTTP 響應時為 null：網絡層錯誤）。 */
    public readonly status: number | null,
    /** 是否瞬態（可重試）：網絡中止、429/5xx、body/parse 錯誤。 */
    public readonly transient: boolean
  ) {
    super(message);
    this.name = 'LLMRequestError';
  }
}

/** 分塊大小（段數）：431 段 ≈ 8 塊，單塊 LLM 輸出可控制在數十秒內。 */
export const CHUNK_SIZE = 60;

/** 瞬態失敗重試次數上限（首次 + 重試共 1+2 次）。 */
const MAX_RETRIES = 2;

/** 重試退避間隔（毫秒）：第 1 次重試前 500ms，第 2 次 1500ms。 */
const RETRY_DELAYS_MS = [500, 1500];

/** LRU 快取條目上限（~120B/條 ≈ 12KB 上限）。 */
const CACHE_MAX_ENTRIES = 100;

/** 塊文本的 djb2 哈希（32 位無符號整數的 16 進制字符串）。 */
export function djb2Hash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // (hash << 5) + hash = hash * 33；與 charCode 加總後截到 32 位。
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** LRU 快取——Map 迭代序即插入序；get 命中時刪除重插實現最近使用提序。 */
class LruCache {
  private readonly map = new Map<string, Map<string, string>>();

  get(key: string): Map<string, string> | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: Map<string, string>): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > CACHE_MAX_ENTRIES) {
      // 淘汰最舊（迭代序首位）。
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * 快取（模塊級單例）：跨 restart/provided instance 持久——同視頻換語言/切檔重播免請求。
 * Options 保存新配置 → content-script restart → composition 組裝時重註冊
 * storage.onChanged 監聽器（模塊級 once-guard 防重複註冊，§5.4 洩漏零容忍）。
 */
const llmCache = new LruCache();
let configWatcherInstalled = false;

/**
 * 註冊 chrome.storage.onChanged 監聽器使 LLM 快取失效（M1-52 方案 A：
 * targetLang/model/endpoint 變更 → 全量清空；端點/語言變更時鍵空間不同無法精確失效，
 * 全量清空最安全，清空後 miss 自動重建）。
 * 非擴充環境（jsdom 無 chrome.storage）try/catch 守護後無操作。
 */
export function ensureLlmCacheInvalidationHook(): void {
  if (configWatcherInstalled) return;
  configWatcherInstalled = true;
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && 'engineConfig' in changes) {
        invalidateLlmCache();
      }
    });
  } catch {
    // 無 chrome.storage 環境（測試/無 chrome API）：快取仍有效，失效靠重啟重建 provider。
  }
}

/** 全量失效快取（供測試與配置變更）。 */
export function invalidateLlmCache(): void {
  llmCache.clear();
}

/** 快取條目數（供測試）。 */
export function llmCacheSize(): number {
  return llmCache.size;
}

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

  /**
   * 非流式翻譯：分塊 → 逐塊（快取命中直取 / miss 走重試 fetch）→ 合併結果。
   * 塊級瞬態重試耗盡 → 該塊原文兜底並記 diagLog（不阻塞其餘塊）。
   */
  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const merged: SubtitleSegment[] = [];
    for (const chunk of chunkSegments(req.segments)) {
      const chunkResult = await this.translateChunkWithRetry(chunk, req);
      merged.push(...chunkResult);
    }
    return { segments: merged, engineId: this.opts.engineId, degraded: false };
  }

  /**
   * 流式（漸進）翻譯（M1-52）：分塊逐塊翻譯，每塊完成即 emit **累計全量**譯文——
   * pipeline/管線把 emit 依次作為 segments-ready → segments-updated，
   * 渲染層 5-10s 內先見首塊，後續塊增量替換（content-script onEvent 已支持兩者）。
   * 塊失敗（重試耗盡/永久失敗）→ 該塊原文兜底繼續，不中斷後續塊與 emit。
   */
  async translateStream(
    req: TranslationRequest,
    emit: (r: TranslationResult) => void
  ): Promise<void> {
    const accumulated: SubtitleSegment[] = [];
    for (const chunk of chunkSegments(req.segments)) {
      const chunkResult = await this.translateChunkWithRetry(chunk, req);
      accumulated.push(...chunkResult);
      emit({
        segments: [...accumulated],
        engineId: this.opts.engineId,
        degraded: false,
      });
    }
  }

  /** 塊翻譯 + 快取 + 重試。瞬態失敗（transient）重試，永久失敗直接拋。 */
  private async translateChunkWithRetry(
    chunk: SubtitleSegment[],
    req: TranslationRequest
  ): Promise<SubtitleSegment[]> {
    const cacheKey = this.cacheKey(chunk, req.targetLang);
    const cached = llmCache.get(cacheKey);
    if (cached) {
      diagLog('llm', 'cache hit, chunk size:', chunk.length, 'key:', cacheKey);
      return chunk.map((s, i) => ({
        ...s,
        translatedText: cached.get(String(i)) ?? s.sourceText,
        targetLang: req.targetLang,
      }));
    }

    let lastErr: LLMRequestError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const map = await this.translateChunkOnce(chunk, req);
        llmCache.set(cacheKey, map);
        return chunk.map((s, i) => ({
          ...s,
          translatedText: map.get(String(i)) ?? s.sourceText,
          targetLang: req.targetLang,
        }));
      } catch (err) {
        // 非 LLMRequestError（意外錯誤）視同瞬態處理——但永久失敗（4xx/choices 缺失）
        // 已在 translateChunkOnce 內拋非 transient LLMRequestError，此處只重試瞬態。
        if (err instanceof LLMRequestError && !err.transient) throw err;
        lastErr = err instanceof LLMRequestError ? err : new LLMRequestError(String(err), null, true);
      }
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 1500;
        diagLog('llm', `transient failure, retrying attempt ${attempt + 2}/${MAX_RETRIES + 1} after ${delay}ms`, String(lastErr));
        await sleep(delay);
      }
    }
    diagLog('llm', 'all retries exhausted, fallback to original text for chunk', String(lastErr));
    return chunk.map((s) => ({
      ...s,
      translatedText: s.sourceText,
      targetLang: req.targetLang,
    }));
  }

  /** 塊翻譯一輪：fetch + parse；失敗拋 LLMRequestError（瞬態/永久按語義標記）。 */
  private async translateChunkOnce(
    chunk: SubtitleSegment[],
    req: TranslationRequest
  ): Promise<Map<string, string>> {
    const lines: string[] = chunk.map((s, i) => `${i}\t${s.sourceText}`);

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

    const response = await this.fetchDirectly({
      endpoint: this.opts.endpoint,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    diagLog('llm', 'response status =', response.status, ', ok =', response.ok);
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      throw new LLMRequestError(`LLM translation failed: HTTP ${response.status}`, response.status, transient);
    }

    // §5.6：HTTP 200 但 body 非 JSON（本地服務返回 HTML 錯誤頁/代理返回純文本）時，
    // JSON.parse 的 SyntaxError 不含語義——必須 try/catch 並把「解析失敗」與響應片段
    // 寫進錯誤信息，否則用戶只看到 `SyntaxError: Unexpected token` 無法定位。
    // 解析失敗歸為瞬態（代理偶發返回垃圾頁的重試往往可恢復）。
    let data: {
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      data = JSON.parse(response.body) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      diagLog('llm', 'JSON parsed, choices count =', data.choices?.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AI_Trans:diag] LLM: JSON parse failed, body snippet =', response.body.substring(0, 200));
      throw new LLMRequestError(
        `LLM translation response is not valid JSON: ${msg}. Body snippet: ${response.body.substring(0, 200)}`,
        response.status,
        true
      );
    }
    const choice = data.choices?.[0];
    // §5.6：choices 缺失（如被限流返回 {error}、結構變更）時**不允許靜默回退原文**——
    // 那是翻譯靜默失效且 degraded=false 的最典型漏洞（字幕出來但是原文，用戶查不到原因）。
    // 必須拋錯走降級機制；choices 缺失視為永久失敗（結構性問題重試無用）。
    if (!choice || typeof choice.message?.content !== 'string') {
      console.error('[AI_Trans:diag] LLM: no valid choices[0].message.content, choice =', choice);
      throw new LLMRequestError(
        'LLM translation response has no valid choices[0].message.content (possibly rate-limited or schema changed)',
        response.status,
        false
      );
    }
    const content = stripReasoning(choice.message.content);
    diagLog('llm', 'content after stripReasoning =', content);

    // 解析 "ID<TAB>translation" 行。
    const map = new Map<string, string>();
    for (const line of content.split('\n')) {
      const m = /^(\d+)\t(.+)$/.exec(line.trim());
      if (m) map.set(m[1], m[2]);
    }
    diagLog('llm', 'parsed map size =', map.size, ', map =', Object.fromEntries(map));
    return map;
  }

  /** 生成快取 key：model|targetLang|hash(塊源文)。 */
  private cacheKey(chunk: SubtitleSegment[], targetLang: string): string {
    return `${this.opts.model}|${targetLang}|${djb2Hash(chunk.map((s) => s.sourceText).join('\n'))}`;
  }

  /**
   * 直接 fetch 翻譯端點。
   * content script 在 ISOLATED world 有 host_permissions（manifest.json），
   * 可以直接 fetch localhost，不受 CORS 限制。
   * M1-52：AbortController 覆蓋 fetch+body 讀取全程——原實現收到響應頭後即
   * clearTimeout，body 流掛死時超時永遠不觸發（M1-47 用戶反饋的 connection lost 場景）。
   */
  private async fetchDirectly(request: {
    endpoint: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    diagLog('llm', 'fetching directly to', request.endpoint);
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
      const elapsed = Date.now() - startTime;
      diagLog('llm', 'fetch completed in', elapsed, 'ms, status =', res.status);
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // body 讀取失敗（連接中斷）歸為瞬態錯誤供重試。
        throw new LLMRequestError(
          `response body read failed: ${err instanceof Error ? err.message : String(err)}`,
          res.status,
          true
        );
      }
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      if (err instanceof LLMRequestError) throw err;
      // AbortError：超時中斷（含 fetch 階段與 body 讀取階段）——瞬態（重試可能恢復）。
      const isAbort =
        err instanceof DOMException
          ? err.name === 'AbortError'
          : (err instanceof Error || typeof err === 'object') &&
            (err as { name?: unknown })?.name === 'AbortError';
      if (isAbort) throw new LLMRequestError('LLM request timed out (aborted)', null, true);
      // 其它網絡層錯誤（Failed to fetch / CORS / 斷網）同屬瞬態。
      throw new LLMRequestError(
        `LLM network error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true
      );
    } finally {
      // M1-52：定時器在整個 fetch+body 讀取完成（或拋錯）後的 finally 統一清理，
      // 不再像舊版在收到響應頭後取消——body 掛死時也能觸發中斷。
      clearTimeout(timer);
    }
  }
}

/** 把段列表切為 <=CHUNK_SIZE 的塊（保持順序）。 */
export function chunkSegments(segments: SubtitleSegment[]): SubtitleSegment[][] {
  const chunks: SubtitleSegment[][] = [];
  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    chunks.push(segments.slice(i, i + CHUNK_SIZE));
  }
  return chunks.length > 0 ? chunks : [[]];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 剝離 reasoning 模型可能混入 content 的思考塊——防禦性容錯。
 * OpenAI 兼容服務通常把思考分離到 reasoning_content（我們只讀 content 故不受影響），
 * 但部分 MLX/本地服務會把  <think>... </think> 直接塞進 content，需剝離避免污染字幕解析。
 * 移除成對  <think>..</think>，並清掉殘留的開/閉標籤與由此產生的前導空行。
 */
export function stripReasoning(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // 成對思考塊
    .replace(/<\/?think>/gi, '') // 殘留單邊標籤
    .replace(/^\s+/, ''); // 剝離後可能的前導空白
}
