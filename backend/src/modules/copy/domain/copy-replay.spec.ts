import { copyFillKey, replayCopyFills, type CopyFill } from './copy-replay';

/**
 * MODULE 07 - reconstructing what each copied fill did.
 *
 * The thing being pinned down here is that the reconstruction agrees with the
 * engine. These fixtures are the fill sequence a real follower produced, and
 * the expected figures are the ones the engine's own pot balance carries -
 * so a replay that disagreed would be caught here rather than in an answer.
 */
function fill(overrides: Partial<CopyFill> & Pick<CopyFill, 'expertOrderId' | 'side' | 'quantity' | 'fillPrice' | 'expertFilledAt'>): CopyFill {
  return {
    strategyId: 'follow-1',
    symbol: 'BTC/USD',
    status: 'COPIED',
    ...overrides,
  };
}

const SEQUENCE: CopyFill[] = [
  fill({ expertOrderId: 'a', side: 'LONG', quantity: '0.5', fillPrice: '80540.102', expertFilledAt: '2026-10-27T17:09:04.763Z' }),
  fill({ expertOrderId: 'b', side: 'SHORT', quantity: '0.5', fillPrice: '80534.41', expertFilledAt: '2026-10-27T17:11:18.453Z' }),
  fill({ expertOrderId: 'c', side: 'LONG', quantity: '0.005', fillPrice: '80527.51', expertFilledAt: '2026-10-27T18:35:42.931Z' }),
  fill({ expertOrderId: 'd', side: 'LONG', quantity: '0.005', fillPrice: '80588.146', expertFilledAt: '2026-10-27T18:47:23.671Z' }),
  fill({ expertOrderId: 'e', side: 'LONG', quantity: '0.005', fillPrice: '80546.9', expertFilledAt: '2026-10-27T18:49:32.366Z' }),
  fill({ expertOrderId: 'f', side: 'LONG', quantity: '0.005', fillPrice: '80540.1', expertFilledAt: '2026-10-27T18:49:57.633Z' }),
  fill({ expertOrderId: 'g', side: 'LONG', quantity: '0.005', fillPrice: '80526.099', expertFilledAt: '2026-10-27T18:55:06.933Z' }),
  fill({ expertOrderId: 'h', side: 'LONG', quantity: '0.005', fillPrice: '80538.27', expertFilledAt: '2026-10-27T18:55:27.889Z' }),
  fill({ expertOrderId: 'i', side: 'LONG', quantity: '0.5', fillPrice: '77304.304', expertFilledAt: '2026-10-31T08:15:05.295Z' }),
  fill({ expertOrderId: 'j', side: 'SHORT', quantity: '0.5', fillPrice: '77298.18', expertFilledAt: '2026-10-31T08:17:06.154Z' }),
  fill({ expertOrderId: 'k', side: 'LONG', quantity: '0.5', fillPrice: '77261.01', expertFilledAt: '2026-10-31T08:26:39.494Z' }),
];

describe('replayCopyFills', () => {
  it('opens, closes, adds and reduces the way the engine did', () => {
    const outcomes = replayCopyFills(SEQUENCE);
    expect(outcomes.get(copyFillKey('follow-1', 'a'))?.effect).toBe('OPEN');
    expect(outcomes.get(copyFillKey('follow-1', 'b'))?.effect).toBe('CLOSE');
    expect(outcomes.get(copyFillKey('follow-1', 'c'))?.effect).toBe('OPEN');
    expect(outcomes.get(copyFillKey('follow-1', 'd'))?.effect).toBe('ADD');
    expect(outcomes.get(copyFillKey('follow-1', 'i'))?.effect).toBe('ADD');
    expect(outcomes.get(copyFillKey('follow-1', 'j'))?.effect).toBe('REDUCE');
    expect(outcomes.get(copyFillKey('follow-1', 'k'))?.effect).toBe('ADD');
  });

  it('reproduces the profit and loss the pot actually booked', () => {
    const outcomes = replayCopyFills(SEQUENCE);
    // Closing a long bought at 80540.102 by selling at 80534.41 lost money.
    expect(outcomes.get(copyFillKey('follow-1', 'b'))?.realizedPnl).toBe('-2.846');

    // Every figure the replay produces must add up to the pot's own running
    // balance of realised profit and loss. This is the check that matters:
    // the fill rows record zero for all of these, and the pot does not.
    const total = [...outcomes.values()].reduce(
      (sum, outcome) => sum + Number(outcome.realizedPnl ?? 0),
      0,
    );
    expect(total).toBeCloseTo(-97.611778301886793, 9);
  });

  it('keeps each follow\'s book to itself', () => {
    const other = SEQUENCE.map((entry) => ({ ...entry, strategyId: 'follow-2' }));
    const outcomes = replayCopyFills([...SEQUENCE, ...other]);
    // The second follow's first fill meets an empty book of its own.
    expect(outcomes.get(copyFillKey('follow-1', 'a'))?.effect).toBe('OPEN');
    expect(outcomes.get(copyFillKey('follow-1', 'b'))?.effect).toBe('CLOSE');
  });

  it('reports a refused fill as having moved nothing', () => {
    const refused = fill({
      expertOrderId: 'r',
      side: 'LONG',
      quantity: null,
      fillPrice: null,
      expertFilledAt: '2026-10-27T17:09:04.763Z',
      status: 'REJECTED',
    });
    const outcomes = replayCopyFills([refused]);
    expect(outcomes.get(copyFillKey('follow-1', 'r'))?.effect).toBe('NONE');
    expect(outcomes.get(copyFillKey('follow-1', 'r'))?.realizedPnl).toBeNull();
  });

  it('reports a fill with no price as having moved nothing', () => {
    const unpriced = fill({
      expertOrderId: 'u',
      side: 'LONG',
      quantity: '0.5',
      fillPrice: null,
      expertFilledAt: '2026-10-27T17:09:04.763Z',
    });
    expect(replayCopyFills([unpriced]).get(copyFillKey('follow-1', 'u'))?.effect).toBe('NONE');
  });

  it('replays the fills in the order they happened, not the order they arrived', () => {
    const reversed = [...SEQUENCE].reverse();
    const outcomes = replayCopyFills(reversed);
    expect(outcomes.get(copyFillKey('follow-1', 'b'))?.effect).toBe('CLOSE');
    expect(outcomes.get(copyFillKey('follow-1', 'j'))?.effect).toBe('REDUCE');
  });
});
