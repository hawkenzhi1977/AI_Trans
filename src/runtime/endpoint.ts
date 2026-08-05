// LLM 端點規範化——純函數，無外部依賴。
// 抽離自 composition.ts，讓 popup / connection-test 等輕量上下文可複用而不必
// 連帶引入整個 registry 組裝鏈（adapters/application）。
//
// 規則（僅服務 OpenAI 兼容結構）：
//  - 空 → 默認 OpenAI 雲端端點。
//  - 已是 /chat/completions 結尾 → 原樣保留（完整路徑填法）。
//  - 已含 /v{n} 版本段（如 /v1）→ 補 /chat/completions。
//  - 裸 host（無版本段）→ 補 /v1/chat/completions。
export function normalizeEndpoint(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'https://api.openai.com/v1/chat/completions';
  const base = trimmed.replace(/\/+$/, ''); // 去掉尾部斜杠
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}
