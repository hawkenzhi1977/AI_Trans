// YouTube timedtext 契約樣本——鎖定外部格式，格式變動時測試先紅。

/** JSON 格式（events/segs）。 */
export const TIMEDTEXT_JSON = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'Second line' }] },
    { tStartMs: 3500, dDurationMs: 1000, segs: [{ utf8: '' }] }, // 空行，應被過濾
  ],
});

/** XML 格式（transcript/text）。 */
export const TIMEDTEXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<transcript>
  <text start="0" dur="1.5">Hello world</text>
  <text start="1.5" dur="2">Second line</text>
  <text start="3.5" dur="1"></text>
</transcript>`;

/** 期望解析結果（毫秒時間軸，空行已過濾）。 */
export const EXPECTED_SEGMENTS = [
  { start: 0, end: 1500, sourceText: 'Hello world' },
  { start: 1500, end: 3500, sourceText: 'Second line' },
];
