// Mock YouTube 宿主注入的全局 API 類型聲明（E2E 用）。
export {};

interface TimedTextDoc {
  events: Array<{
    tStartMs: number;
    dDurationMs: number;
    segs: Array<{ utf8: string }>;
  }>;
  lang: string;
  videoId: string;
}

declare global {
  interface Window {
    fetchTimedText(id: string, lang: string): TimedTextDoc;
    __mockState(): { playing: boolean; t: number };
  }
}
