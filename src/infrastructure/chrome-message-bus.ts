import type { MessageBus } from '../domain/ports/message-bus';

/**
 * 跨組件消息總線——基於 chrome.runtime。
 * topic 編碼為消息類型，payload 為結構化數據。
 */
export class ChromeMessageBus implements MessageBus {
  private readonly listeners = new Map<string, Set<(p: unknown) => void>>();

  constructor() {
    chrome.runtime.onMessage.addListener((message) => {
      const { topic, payload } = message as { topic?: string; payload?: unknown };
      if (typeof topic !== 'string') return;
      const set = this.listeners.get(topic);
      if (set) for (const cb of set) cb(payload);
    });
  }

  publish<T>(topic: string, payload: T): void {
    // 本組件內直發 + 跨組件發送。
    const set = this.listeners.get(topic);
    if (set) for (const cb of set) cb(payload);
    void chrome.runtime.sendMessage({ topic, payload }).catch(() => {});
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
}
