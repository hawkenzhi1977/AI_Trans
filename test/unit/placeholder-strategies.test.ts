import { describe, it, expect } from 'vitest';
import { LookAheadASRStrategy } from '../../src/application';
import type { StrategyContext } from '../../src/domain/ports/caption-strategy';

// M3 佔位策略：M1 中 isApplicable 恆 false，但必須寫診斷讓鏈能區分
// 「未實現（預期跳過）」與「真失敗」——見 §5.6 不靜默失敗規則。
describe('M3 佔位策略診斷（§5.6）', () => {
  it('LookAheadASRStrategy：isApplicable=false 且診斷記錄 not implemented (M3)', async () => {
    const diag: string[] = [];
    const s = new LookAheadASRStrategy();
    const ok = await s.isApplicable({ diagnostics: diag } as StrategyContext);
    expect(ok).toBe(false);
    expect(diag).toContain('lookahead-asr: not implemented (M3)');
  });

  it('diagnostics 為 undefined 時不拋錯（向後兼容不帶診斷的 ctx）', async () => {
    const s = new LookAheadASRStrategy();
    await expect(s.isApplicable({} as StrategyContext)).resolves.toBe(false);
  });
});
