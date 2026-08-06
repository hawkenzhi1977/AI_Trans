import { describe, it, expect } from 'vitest';
import { parseTimedText, snippet } from '../../src/adapters/platform/youtube/timedtext';
import {
  TIMEDTEXT_JSON,
  TIMEDTEXT_XML,
  EXPECTED_SEGMENTS,
} from '../support/fixtures/timedtext';

describe('timedtext 契約：JSON 格式', () => {
  it('解析 events/segs 為內部段，時間轉毫秒，空行過濾', () => {
    const segs = parseTimedText(TIMEDTEXT_JSON, 'en');
    expect(segs).toHaveLength(2);
    segs.forEach((s, i) => {
      expect(s.start).toBe(EXPECTED_SEGMENTS[i].start);
      expect(s.end).toBe(EXPECTED_SEGMENTS[i].end);
      expect(s.sourceText).toBe(EXPECTED_SEGMENTS[i].sourceText);
      expect(s.sourceLang).toBe('en');
      expect(s.origin).toBe('native');
      expect(s.provisional).toBe(false);
    });
  });

  it('缺 events 數組時拋錯', () => {
    expect(() => parseTimedText('{"foo":1}', 'en')).toThrow('missing events');
  });
});

describe('timedtext 契約：XML 格式', () => {
  it('解析 transcript/text 為內部段，空行過濾', () => {
    const segs = parseTimedText(TIMEDTEXT_XML, 'en');
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(1500);
    expect(segs[1].sourceText).toBe('Second line');
  });

  it('缺 transcript 根時拋錯', () => {
    expect(() => parseTimedText('<foo/>', 'en')).toThrow('missing transcript');
  });

  it('srv3 格式（timedtext>body>p>s）解析為內部段（毫秒時間軸）', () => {
    const srv3 = `<?xml version="1.0" encoding="utf-8"?><timedtext format="3"><body><p t="0" d="1500"><s>Hello</s> <s>world</s></p><p t="1500" d="2000"><s>Second</s></p></body></timedtext>`;
    const segs = parseTimedText(srv3, 'en');
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(1500);
    expect(segs[0].sourceText).toBe('Hello world');
    expect(segs[1].sourceText).toBe('Second');
  });

  it('HTML 錯誤/登錄頁（非法 XML）拋解析錯誤而非 missing root', () => {
    // DOMParser 對 HTML 片段會產生 parsererror——應報「非合法 XML」而非誤判「無字幕根」。
    const html = `<!DOCTYPE html><html><head><title>Sign in</title></head><body>...</body></html>`;
    expect(() => parseTimedText(html, 'en')).toThrow(/parse error|missing transcript/);
  });

  it('HTML 實體解碼（&#39; &amp;）', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><transcript><text start="0" dur="1">It&#39;s &amp; fine</text></transcript>`;
    const segs = parseTimedText(xml, 'en');
    expect(segs[0].sourceText).toBe("It's & fine");
  });
});

describe('timedtext 契約：格式識別', () => {
  it('以 { 開頭識別為 JSON，否則 XML', () => {
    expect(parseTimedText(TIMEDTEXT_JSON, 'en')).toHaveLength(2);
    expect(parseTimedText(TIMEDTEXT_XML, 'en')).toHaveLength(2);
  });
});

describe('timedtext 契約：§5.6 解析失敗證據化', () => {
  it('非法 JSON → 拋「json parse failed」並附 body 片段證據', () => {
    expect(() => parseTimedText('{ "events": [{"tStartMs":', 'en')).toThrow(/timedtext JSON parse failed/);
    expect(() => parseTimedText('{ "events": [{"tStartMs":', 'en')).toThrow(/body snippet/);
  });

  it('HTML 錯誤/登錄頁 → 錯誤含根元素名與片段證據（不再只是猜測性措辭）', () => {
    // jsdom DOMParser 對完整 HTML（<!DOCTYPE>）不產 parsererror，而是根 <html>；
    // 無論走 parsererror 還是 missing root 分支，錯誤都必須附證據而非猜測。
    const html = `<!DOCTYPE html><html><head><title>Sign in</title></head><body>Please sign in to continue</body></html>`;
    expect(() => parseTimedText(html, 'en')).toThrow(/body snippet/);
    expect(() => parseTimedText(html, 'en')).toThrow(/actual root <html>/);
    // 真 malformed XML（無 <html> 根）→ parsererror 分支，同樣帶證據。
    const bad = '<timedtext><body><p t="1">';
    expect(() => parseTimedText(bad, 'en')).toThrow(/parse error/);
    expect(() => parseTimedText(bad, 'en')).toThrow(/body snippet/);
  });

  it('snippet 去除控制字符並截斷', () => {
    expect(snippet('hello\nworld\t\nagain', 100)).toBe('"hello world again"');
    expect(snippet('', 100)).toBe('(empty body)');
    expect(snippet('abcdefghij', 4)).toBe('"abcd"');
  });
});
