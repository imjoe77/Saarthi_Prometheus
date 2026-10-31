import { Prisma } from '@prisma/client';

import { replayCopyLedger, type CopyLedgerEvent } from './copy-performance';

/**
 * MODULE 07 - the copy ledger replay.
 *
 * THESE CASES PIN THE ARITHMETIC THE ENGINE WRITES, NOT A FORMULA THAT AGREES
 * WITH IT. Every expectation here is the number `CopyExecutionService` would
 * have stored in `copy_accounts.realized_pnl`, so a change to the replay that
 * would make a screen disagree with the database fails here first.
 */
describe('replayCopyLedger', () => {
  const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

  function event(overrides: Partial<CopyLedgerEvent> & { side: 'BUY' | 'SELL' }): CopyLedgerEvent {
    return {
      followerId: 'follower-1',
      strategyId: 'strategy-1',
      symbol: 'BTC/USD',
      quantity: dec('1'),
      fillPrice: dec('100'),
      gross: dec('100'),
      status: 'COPIED',
      expertFilledAt: new Date('2026-01-01T00:00:00.000Z'),
      expertOrderId: 'order-1',
      processedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('realises nothing on a buy', () => {
    const result = replayCopyLedger([event({ side: 'BUY' })]);

    expect(result.realizedPnl.toString()).toBe('0');
    expect(result.points[0]?.realizedPnl.toString()).toBe('0');
    expect(result.copiedCount).toBe(1);
  });

  it('realises the difference between the entry and the exit', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('2'), fillPrice: dec('100'), gross: dec('200') }),
      event({
        side: 'SELL',
        quantity: dec('2'),
        fillPrice: dec('110'),
        gross: dec('220'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);

    expect(result.realizedPnl.toString()).toBe('20');
    expect(result.points[1]?.cumulativePnl.toString()).toBe('20');
  });

  it('averages the entry price across two buys', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'BUY',
        quantity: dec('1'),
        fillPrice: dec('200'),
        gross: dec('200'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'SELL',
        quantity: dec('2'),
        fillPrice: dec('180'),
        gross: dec('360'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ]);

    // The average entry is 150, so selling 2 at 180 realises (180 - 150) * 2.
    expect(result.realizedPnl.toString()).toBe('60');
  });

  it('keeps the average entry when a position is partly sold', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('2'), fillPrice: dec('100'), gross: dec('200') }),
      event({
        side: 'SELL',
        quantity: dec('1'),
        fillPrice: dec('120'),
        gross: dec('120'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'SELL',
        quantity: dec('1'),
        fillPrice: dec('130'),
        gross: dec('130'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ]);

    // Both sells price against the original 100, not against a running average
    // of a shrinking position.
    expect(result.realizedPnl.toString()).toBe('50');
  });

  it('starts a fresh average after a position empties', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SELL',
        quantity: dec('1'),
        fillPrice: dec('150'),
        gross: dec('150'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'BUY',
        quantity: dec('1'),
        fillPrice: dec('300'),
        gross: dec('300'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      event({
        side: 'SELL',
        quantity: dec('1'),
        fillPrice: dec('320'),
        gross: dec('320'),
        expertOrderId: 'order-4',
        expertFilledAt: new Date('2026-01-04T00:00:00.000Z'),
      }),
    ]);

    // 150 - 100 = 50 on the first round, 320 - 300 = 20 on the second. A
    // replay that averaged across the closed lot would report 70 on the last
    // sell, which is a number the ledger does not hold.
    expect(result.realizedPnl.toString()).toBe('70');
  });

  it('ignores a refusal entirely', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SELL',
        quantity: null,
        fillPrice: null,
        gross: null,
        status: 'REJECTED',
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);

    expect(result.rejectedCount).toBe(1);
    expect(result.copiedCount).toBe(1);
    expect(result.realizedPnl.toString()).toBe('0');
    expect(result.points).toHaveLength(1);
  });

  it('books a sell with no position the way the engine books it', () => {
    const result = replayCopyLedger([
      event({ side: 'BUY', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SELL',
        strategyId: 'strategy-2',
        quantity: dec('1'),
        fillPrice: dec('900'),
        gross: dec('900'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);

    // The second follow never bought anything. The engine's SELL path reads a
    // missing position as a zero holding and a zero entry price, so it books
    // the full 900 - and the replay books the same 900, because the two must
    // agree on every row, not only on the reachable ones.
    expect(result.realizedPnl.toString()).toBe('900');
  });

  it('replays in the engine\'s order, not the order it was handed', () => {
    const result = replayCopyLedger([
      event({
        side: 'SELL',
        quantity: dec('1'),
        fillPrice: dec('150'),
        gross: dec('150'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({ side: 'BUY', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
    ]);

    expect(result.points[0]?.side).toBe('BUY');
    expect(result.points[1]?.side).toBe('SELL');
    expect(result.realizedPnl.toString()).toBe('50');
  });
});
