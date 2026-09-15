// M2-68：VAD 閾值默認值 + 邊界測試。
import { describe, it, expect } from 'vitest';
import { EnergyVAD, DEFAULT_VAD_CONFIG } from '../../src/infrastructure/vad';

describe('EnergyVAD — M2-68 閾值默認值', () => {
  it('DEFAULT_VAD_CONFIG.threshold = 0.005（M2-68 從 0.01 降低）', () => {
    expect(DEFAULT_VAD_CONFIG.threshold).toBe(0.005);
  });

  it('無參構造 → 使用默認閾值 0.005', () => {
    const vad = new EnergyVAD();
    expect(vad.getThreshold()).toBe(0.005);
  });

  it('rms = 0.006 → isSpeech = true（高於閾值 0.005）', () => {
    const vad = new EnergyVAD();
    const pcm = new Float32Array(160).fill(0.006);
    const result = vad.process(pcm, 16000, 0);
    expect(result.isSpeech).toBe(true);
    expect(result.rms).toBeCloseTo(0.006, 6);
  });

  it('rms = 0.004 → isSpeech = false（低於閾值 0.005）', () => {
    const vad = new EnergyVAD();
    const pcm = new Float32Array(160).fill(0.004);
    const result = vad.process(pcm, 16000, 0);
    expect(result.isSpeech).toBe(false);
    expect(result.rms).toBeCloseTo(0.004, 6);
  });

  it('rms = 0.01 → isSpeech = true（舊默認值現在遠高於新閾值）', () => {
    const vad = new EnergyVAD();
    const pcm = new Float32Array(160).fill(0.01);
    const result = vad.process(pcm, 16000, 0);
    expect(result.isSpeech).toBe(true);
  });

  it('setThreshold 動態調整後邊界跟隨', () => {
    const vad = new EnergyVAD();
    vad.setThreshold(0.01);
    const pcm = new Float32Array(160).fill(0.008);
    expect(vad.process(pcm, 16000, 0).isSpeech).toBe(false);
    vad.setThreshold(0.005);
    expect(vad.process(pcm, 16000, 1).isSpeech).toBe(true);
  });
});
