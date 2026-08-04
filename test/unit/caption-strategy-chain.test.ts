import { describe, it, expect } from 'vitest';
import { CaptionStrategyChain } from '../../src/application/caption-strategy-chain';
import type { CaptionStrategy, StrategyContext } from '../../src/domain/ports/caption-strategy';
import type { PipelineEvent } from '../../src/domain/models/events';
import type { CaptionOrigin } from '../../src/domain/models/subtitle';

interface FakeOpts {
  origin: CaptionOrigin;
  applicable: boolean;
  throwOnRun?: boolean;
}

class FakeStrategy implements CaptionStrategy {
  readonly origin: CaptionOrigin;
  ran = false;
  stopped = false;
  constructor(private readonly opts: FakeOpts) {
    this.origin = opts.origin;
  }
  async isApplicable(): Promise<boolean> {
    return this.opts.applicable;
  }
  async run(_ctx: StrategyContext, emit: (e: PipelineEvent) => void): Promise<void> {
    this.ran = true;
    if (this.opts.throwOnRun) throw new Error(`${this.origin} run failed`);
    emit({ type: 'segments-ready', segments: [] });
  }
  stop(): void {
    this.stopped = true;
  }
}

const ctx = {} as StrategyContext;

describe('CaptionStrategyChain', () => {
  it('第一策略適用時直接接管，不觸及後續', async () => {
    const s1 = new FakeStrategy({ origin: 'native', applicable: true });
    const s2 = new FakeStrategy({ origin: 'realtime-asr', applicable: true });
    const chain = new CaptionStrategyChain([s1, s2]);

    const { origin } = await chain.runWithFallback(ctx);
    expect(origin).toBe('native');
    expect(s1.ran).toBe(true);
    expect(s2.ran).toBe(false);
  });

  it('第一策略不適用時降級到下一策略', async () => {
    const s1 = new FakeStrategy({ origin: 'native', applicable: false });
    const s2 = new FakeStrategy({ origin: 'realtime-asr', applicable: true });
    const chain = new CaptionStrategyChain([s1, s2]);

    const { origin, errors } = await chain.runWithFallback(ctx);
    expect(origin).toBe('realtime-asr');
    expect(s2.ran).toBe(true);
    expect(errors.some((e) => e.code === 'strategy-not-applicable')).toBe(true);
  });

  it('策略 run 拋錯時發 strategy-degraded 並降級', async () => {
    const s1 = new FakeStrategy({ origin: 'native', applicable: true, throwOnRun: true });
    const s2 = new FakeStrategy({ origin: 'realtime-asr', applicable: true });
    const events: PipelineEvent[] = [];
    const chain = new CaptionStrategyChain([s1, s2], (e) => events.push(e));

    const { origin } = await chain.runWithFallback(ctx);
    expect(origin).toBe('realtime-asr');
    expect(
      events.some(
        (e) => e.type === 'strategy-degraded' && e.from === 'native' && e.to === 'realtime-asr'
      )
    ).toBe(true);
  });

  it('全部策略失敗時 origin 為 undefined', async () => {
    const s1 = new FakeStrategy({ origin: 'native', applicable: false });
    const s2 = new FakeStrategy({ origin: 'realtime-asr', applicable: false });
    const chain = new CaptionStrategyChain([s1, s2]);

    const { origin, errors } = await chain.runWithFallback(ctx);
    expect(origin).toBeUndefined();
    expect(errors).toHaveLength(2);
  });

  it('stopAll 停止所有策略', async () => {
    const s1 = new FakeStrategy({ origin: 'native', applicable: true });
    const s2 = new FakeStrategy({ origin: 'realtime-asr', applicable: true });
    const chain = new CaptionStrategyChain([s1, s2]);
    chain.stopAll();
    expect(s1.stopped).toBe(true);
    expect(s2.stopped).toBe(true);
  });
});
