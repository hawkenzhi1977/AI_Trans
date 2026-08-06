import type { CaptionTrack, SubtitleSegment } from '../../../domain/models/subtitle';

/**
 * YouTube timedtext 字幕解析——契約測試鎖定對象。
 * 輸入：timedtext 的字幕 XML/JSON 內容；輸出：內部 SubtitleSegment[]。
 * 適配器內部完成「外部格式 → 內部結構」，核心無感。
 */

export interface TimedTextEntry {
  start: number; // 秒
  dur: number; // 秒
  text: string;
}

export interface TimedTextDocument {
  entries: TimedTextEntry[];
  lang: string;
}

/** 解析 YouTube timedtext JSON/XML 為內部結構。時間換算為毫秒。 */
export function parseTimedText(raw: string, lang: string): SubtitleSegment[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return parseJson(trimmed, lang);
  }
  return parseXml(trimmed, lang);
}

function parseJson(raw: string, lang: string): SubtitleSegment[] {
  // YouTube timedtext 可能為 JSON 格式：{"events":[{"tStartMs":..,"dDurationMs":..,"segs":[{"utf8":..}]}]}
  // §5.6/R7：外部 JSON 必須 try/catch 兜底，且失敗信息帶「json 解析失敗」語義與片段證據，
  // 不讓 parse 錯誤冒泡成功能降級誤判，也不許無聲吞掉。
  let doc: {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
  };
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `timedtext JSON parse failed: ${err instanceof Error ? err.message : String(err)}` +
        ` — body snippet: ${snippet(raw, 80)}`
    );
  }
  if (!Array.isArray(doc.events)) {
    throw new Error('timedtext JSON: missing events array');
  }
  return doc.events
    .map((ev, i) => {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').trim();
      if (!text) return null;
      const start = Math.round(ev.tStartMs ?? 0);
      const dur = Math.round(ev.dDurationMs ?? 2000);
      return toSegment(String(i), start, start + dur, text, lang);
    })
    .filter((s): s is SubtitleSegment => s !== null);
}

function parseXml(raw: string, lang: string): SubtitleSegment[] {
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  // 解析錯誤（非法 XML / HTML 錯誤頁）：DOMParser 返回含 <parsererror> 的文檔。
  // §5.6：不用「猜測性」措辭（possibly login page），改附實際證據——
  // 頂層元素名 + body 前 N 字符片段，讓用戶/開發者確認是登錄頁/錯誤頁還是別的。
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error(
      `timedtext XML: parse error (not valid XML) — root <${
        doc.documentElement?.tagName ?? 'unknown'
      }>, body snippet: ${snippet(raw, 120)}`
    );
  }
  // srv3 格式：<timedtext format="3"><body><p t=".." d=".."><s>text</s></p></body></timedtext>
  // 真實 YouTube 默認返回此格式（我們已改為請求 fmt=json3，此處為兜底）。
  const timedtextRoot = doc.getElementsByTagName('timedtext')[0];
  if (timedtextRoot && timedtextRoot.getElementsByTagName('p').length > 0) {
    return parseSrv3(timedtextRoot, lang);
  }
  // 傳統格式：<transcript><text start=".." dur="..">text</text></transcript>
  const transcribe =
    doc.getElementsByTagName('transcript')[0] ??
    timedtextRoot;
  if (!transcribe) {
    // §5.6：HTML 錯誤/登錄頁在 jsdom 的 DOMParser 下可能不出 parsererror
    // （<html> 是「合法」XML 根）而是走到此處——必須附實際根元素名與片段證據，
    // 讓「HTML 錯誤頁」與「確實無字幕根」可區分，不許只有猜測性措辭。
    throw new Error(
      `timedtext XML: missing transcript root — actual root <${
        doc.documentElement?.tagName ?? 'none'
      }>, body snippet: ${snippet(raw, 120)}`
    );
  }
  const nodes = transcribe.children;
  const segments: SubtitleSegment[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.tagName !== 'text') continue;
    const text = decodeEntities((node.textContent ?? '').trim());
    if (!text) continue;
    const start = Number(node.getAttribute('start') ?? 0);
    const dur = Number(node.getAttribute('dur') ?? 2);
    segments.push(
      toSegment(String(i), Math.round(start * 1000), Math.round((start + dur) * 1000), text, lang)
    );
  }
  return segments;
}

/** 解析 srv3 XML（<p t d><s>...</s></p>，時間為毫秒）。 */
function parseSrv3(root: Element, lang: string): SubtitleSegment[] {
  const ps = root.getElementsByTagName('p');
  const segments: SubtitleSegment[] = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    // <p> 內文本可能直接在 p 或分佈於多個 <s> 子節點。
    const text = decodeEntities((p.textContent ?? '').trim());
    if (!text) continue;
    const start = Number(p.getAttribute('t') ?? 0); // 毫秒
    const dur = Number(p.getAttribute('d') ?? 2000); // 毫秒
    segments.push(
      toSegment(String(i), Math.round(start), Math.round(start + dur), text, lang)
    );
  }
  return segments;
}

/** 解碼常見 HTML 實體（YouTube 字幕文本可能含 &amp;#39; 等）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toSegment(
  id: string,
  start: number,
  end: number,
  text: string,
  lang: string
): SubtitleSegment {
  return {
    id,
    start,
    end,
    sourceText: text,
    sourceLang: lang,
    targetLang: undefined,
    origin: 'native',
    provisional: false,
    revision: 0,
  };
}

/** 由已解析的段構建 CaptionTrack 實現（靜態段，供測試/緩存用）。 */
export function createCaptionTrack(
  lang: string,
  isAutoGenerated: boolean,
  segments: SubtitleSegment[]
): CaptionTrack {
  return {
    lang,
    isAutoGenerated,
    fetch: async () => segments,
  };
}

/** 惰性構建 CaptionTrack：fetch 時才拉取並解析。 */
export function createLazyCaptionTrack(
  lang: string,
  isAutoGenerated: boolean,
  loader: () => Promise<SubtitleSegment[]>
): CaptionTrack {
  return {
    lang,
    isAutoGenerated,
    fetch: loader,
  };
}

/** 取響應體前 N 字符的乾淨單行片段作為診斷證據（去除控制字符/換行）。 */
export function snippet(raw: string, n: number): string {
  const clean = raw.replace(/[\t\r\n]+/g, ' ').slice(0, n).trim();
  return clean.length > 0 ? `"${clean}"` : '(empty body)';
}
