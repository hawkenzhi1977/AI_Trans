import { describe, it, expect } from 'vitest';
import { parseTimedText } from '../../src/adapters/platform/youtube/timedtext';
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
});

describe('timedtext 契約：格式識別', () => {
  it('以 { 開頭識別為 JSON，否則 XML', () => {
    expect(parseTimedText(TIMEDTEXT_JSON, 'en')).toHaveLength(2);
    expect(parseTimedText(TIMEDTEXT_XML, 'en')).toHaveLength(2);
  });
});
