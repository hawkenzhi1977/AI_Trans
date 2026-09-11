// PCM 跨 extension messaging 編碼/解碼（M2-59）。
// Chrome MV3 port.postMessage / runtime.sendMessage 對 Float32Array 的序列化行為不穩定：
// 接收端可能收到沒有 length 的 plain object，導致 VAD RMS=0、ASR 拿到空 PCM。
// 統一改用 base64 string 傳輸，接收端還原為 Float32Array。
// 代價：4096 samples × 4 bytes → ~5.5KB base64（每塊），可接受。

/** Float32Array → base64 string（little-endian，與 Float32Array 內存布局一致）。 */
export function encodePcmFloat32(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** base64 string → Float32Array。空/非法輸入返回空陣列（不拋錯，§5.7 容錯）。 */
export function decodePcmFloat32(encoded: string): Float32Array {
  if (typeof encoded !== 'string' || encoded.length === 0) return new Float32Array(0);
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // 長度非 4 的倍數時截斷到完整 float32（避免 RangeError）。
    const usable = bytes.length - (bytes.length % 4);
    if (usable === 0) return new Float32Array(0);
    const view = new DataView(bytes.buffer, 0, usable);
    const out = new Float32Array(usable / 4);
    for (let i = 0; i < out.length; i++) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  } catch {
    return new Float32Array(0);
  }
}
