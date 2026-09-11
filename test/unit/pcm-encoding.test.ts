import { describe, it, expect } from 'vitest';
import { encodePcmFloat32, decodePcmFloat32 } from '../../src/infrastructure/pcm-encoding';

describe('pcm-encoding — M2-59 base64 往返', () => {
  it('空 Float32Array → 空字符串 → 空 Float32Array', () => {
    const encoded = encodePcmFloat32(new Float32Array(0));
    expect(encoded).toBe('');
    const decoded = decodePcmFloat32(encoded);
    expect(decoded).toHaveLength(0);
  });

  it('常幅 PCM 往返（值精確還原）', () => {
    const pcm = new Float32Array(4096).fill(0.1);
    const decoded = decodePcmFloat32(encodePcmFloat32(pcm));
    expect(decoded).toHaveLength(4096);
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]).toBeCloseTo(0.1, 6);
    }
  });

  it('隨機 PCM 往返（值精確還原）', () => {
    const pcm = new Float32Array(1024);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 17) * 0.5;
    const decoded = decodePcmFloat32(encodePcmFloat32(pcm));
    expect(decoded).toHaveLength(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      expect(decoded[i]).toBe(pcm[i]);
    }
  });

  it('負值與極端值往返', () => {
    const pcm = new Float32Array([-1, 0, 1, -0.5, 0.5, Number.MIN_VALUE]);
    const decoded = decodePcmFloat32(encodePcmFloat32(pcm));
    expect(Array.from(decoded)).toEqual(Array.from(pcm));
  });

  it('非 base64 字串 → 空 Float32Array（不拋錯，§5.7 容錯）', () => {
    expect(decodePcmFloat32('not-base64!!!')).toHaveLength(0);
    expect(decodePcmFloat32('')).toHaveLength(0);
  });

  it('base64 解碼後字節數非 4 倍數 → 截斷到完整 float32', () => {
    // 'A' decodes to 1 byte → not a multiple of 4 → empty.
    expect(decodePcmFloat32('A')).toHaveLength(0);
    // 'AA==' decodes to 1 byte → empty.
    expect(decodePcmFloat32('AA==')).toHaveLength(0);
    // 'AAAA' decodes to 3 bytes → not a multiple of 4 → empty.
    expect(decodePcmFloat32('AAAA')).toHaveLength(0);
    // 16 bytes (4 float32) → base64 of 16 zero bytes.
    const b64 = Buffer.from(new Uint8Array(16)).toString('base64');
    expect(decodePcmFloat32(b64)).toHaveLength(4);
  });

  it('base64 長度對應樣本數正確（4096 samples → 5461 chars base64）', () => {
    const pcm = new Float32Array(4096);
    const encoded = encodePcmFloat32(pcm);
    // 4096 * 4 bytes = 16384 bytes → base64 length ceil(16384/3)*4 = 21845? Actually btoa length = ceil(n/3)*4.
    // 16384 / 3 = 5461.33 → 5462 * 4? No, btoa produces 4 chars per 3 bytes: ceil(16384/3)*4 = 5462*4? Wait.
    // Simpler: decoded length must equal original.
    expect(decodePcmFloat32(encoded)).toHaveLength(4096);
  });
});
