import type { CaptionTrack, SubtitleSegment } from '../../../domain/models/subtitle';
import { diagLog } from '../../../infrastructure/debug-log';

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
  // 診斷：記錄原始響應的格式特徵與前綴片段，用於區分 json3 / srv3 / 傳統格式
  // （真實環境播放器捕獲的響應可能為任意格式，時間戳單位也可能不同——見 §4.8.1 根因排查）。
  const isJson = trimmed.startsWith('{');
  diagLog(
    'capture',
    'parseTimedText: lang:', lang,
    'format:', isJson ? 'json' : 'xml',
    'length:', raw.length,
    'prefix:', snippet(raw, 120)
  );
  if (isJson) {
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
  // 診斷：原始事件首個含 tStartMs 的值，用於確認 json3 時間戳單位（應為毫秒）。
  const firstEv = doc.events.find((e) => typeof e.tStartMs === 'number');
  diagLog(
    'capture',
    'parseJson: events:', doc.events.length,
    'first tStartMs:', firstEv?.tStartMs, 'first dDurationMs:', firstEv?.dDurationMs
  );
  const segments = doc.events
    .map((ev, i) => {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').trim();
      if (!text) return null;
      const start = Math.round(ev.tStartMs ?? 0);
      const dur = Math.round(ev.dDurationMs ?? 2000);
      return toSegment(String(i), start, start + dur, text, lang);
    })
    .filter((s): s is SubtitleSegment => s !== null);
  logSegmentTimespan('parseJson', segments);
  return segments;
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
    diagLog('capture', 'parseXml: detected srv3 format (timedtext>p, t/d 為毫秒)');
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
  diagLog(
    'capture',
    'parseXml: legacy format (transcript/text, start/dur 為秒→×1000), root:',
    doc.documentElement?.tagName,
    'nodes:', nodes.length
  );
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
  logSegmentTimespan('parseXml(legacy)', segments);
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
  logSegmentTimespan('parseXml(srv3)', segments);
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

/**
 * 診斷輔助：輸出解析結果的時間戳範圍與時長分佈，用於判斷時間戳單位是否異常。
 * - 若 maxStart 很小（如 < 10_000）而段數多，可能單位是「秒」被當成毫秒（×1000 缺失）。
 * - 若中位時長 < 50ms，說明 dur 單位/解析可能異常（正常字幕段時長應為秒級）。
 */
function logSegmentTimespan(source: string, segments: SubtitleSegment[]): void {
  if (segments.length === 0) {
    diagLog('capture', `${source}: 0 segments parsed`);
    return;
  }
  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);
  const durations = segments.map((s) => s.end - s.start);
  const minStart = Math.min(...starts);
  const maxStart = Math.max(...starts);
  const maxEnd = Math.max(...ends);
  const sortedDur = [...durations].sort((a, b) => a - b);
  const medianDur = sortedDur[Math.floor(sortedDur.length / 2)];
  // 診斷：時間戳範圍與中位時長。maxStart < 10s 但段數多 → 單位可能為秒被當毫秒（×1000 缺失）。
  const unitSuspicion =
    segments.length >= 50 && maxStart < 10_000
      ? ' — SUSPECT: timestamps may be seconds treated as ms (missing ×1000)'
      : '';
  diagLog(
    'capture',
    `${source}: segments:`, segments.length,
    'start range:', minStart, '-', maxStart,
    'max end:', maxEnd,
    'median dur:', medianDur, 'ms',
    unitSuspicion
  );
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
