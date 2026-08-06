import type { MessageBus } from '../domain/ports/message-bus';

/**
 * 跨組件消息總線——基於 chrome.runtime。
 * topic 編碼為消息類型，payload 為結構化數據。
 */
export class ChromeMessageBus implements MessageBus {
  private readonly listeners = new Map<string, Set<(p: unknown) => void>>();
  // R4：保存監聽器句柄，dispose 時 removeListener，避免多次 new 累積監聽器洩漏。
  private readonly onMessage: (message: unknown) => void;

  constructor() {
    this.onMessage = (message: unknown) => {
      const { topic, payload } = (message ?? {}) as { topic?: string; payload?: unknown };
      if (typeof topic !== 'string') return;
      const set = this.listeners.get(topic);
      if (set) for (const cb of set) cb(payload);
    };
    chrome.runtime.onMessage.addListener(this.onMessage);
  }

  publish<T>(topic: string, payload: T): void {
    // 本組件內直發 + 跨組件發送。
    const set = this.listeners.get(topic);
    if (set) for (const cb of set) cb(payload);
    // §5.6：跨組件無接收方（"Receiving end does not exist"）是常態，可容忍；
    // 但其他錯誤（序列化失敗/端口斷開）不許完全丟棄——留 console 麵包屑便於排查。
    void chrome.runtime.sendMessage({ topic, payload }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Receiving end does not exist|message port closed/i.test(msg)) return; // 正常無接收方
      console.warn(`[AI_Trans] message bus publish("${topic}") failed: ${msg}`);
    });
  }

  subscribe<T>(topic: string, cb: (payload: T) => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(cb as (p: unknown) => void);
    return () => {
      set!.delete(cb as (p: unknown) => void);
    };
  }

  /** R4：解除 runtime.onMessage 監聽並清空訂閱（頁面卸載/銷毀時調用）。 */
  dispose(): void {
    chrome.runtime.onMessage.removeListener(this.onMessage);
    this.listeners.clear();
  }
}
