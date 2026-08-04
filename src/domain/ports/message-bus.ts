/** 跨組件消息總線端口（SW / Content Script / Offscreen）。 */
export interface MessageBus {
  publish<T>(topic: string, payload: T): void;
  /** 訂閱，返回取消訂閱函數。 */
  subscribe<T>(topic: string, cb: (payload: T) => void): () => void;
}
