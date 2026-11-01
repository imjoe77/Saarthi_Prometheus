import { Prisma } from '@prisma/client';

import { replayCopyLedger, type CopyLedgerEvent } from './copy-performance';

/**
 * MODULE 07 - the copy ledger replay.
 *
 * THESE CASES PIN THE ARITHMETIC THE ENGINE WRITES, NOT A FORMULA THAT AGREES
 * WITH IT. Every expectation here is the number `CopyExecutionService` would
 * have stored in `copy_accounts.realized_pnl`, so a change to the replay that
 * would make a screen disagree with the database fails here first.
 *
 * THE BOOK IS NET, AND THE REPLAY CALLS THE ENGINE'S OWN KERNEL. A LONG or a
 * SHORT is applied to whatever the book already holds, so a SHORT against a
 * flat book opens a short and realises nothing, while a LONG against a short
 * closes it and realises the difference.
 */
describe('replayCopyLedger', () => {
  const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

  function event(overrides: Partial<CopyLedgerEvent> & { side: 'LONG' | 'SHORT' }): CopyLedgerEvent {
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

  it('realises nothing on a long', () => {
    const result = replayCopyLedger([event({ side: 'LONG' })]);

    expect(result.realizedPnl.toString()).toBe('0');
    expect(result.points[0]?.realizedPnl.toString()).toBe('0');
    expect(result.copiedCount).toBe(1);
  });

  it('realises the difference between the entry and the exit', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('2'), fillPrice: dec('100'), gross: dec('200') }),
      event({
        side: 'SHORT',
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

  it('averages the entry price across two longs', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'LONG',
        quantity: dec('1'),
        fillPrice: dec('200'),
        gross: dec('200'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'SHORT',
        quantity: dec('2'),
        fillPrice: dec('180'),
        gross: dec('360'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ]);

    // The average entry is 150, so closing 2 at 180 realises (180 - 150) * 2.
    expect(result.realizedPnl.toString()).toBe('60');
  });

  it('keeps the average entry when a position is partly closed', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('2'), fillPrice: dec('100'), gross: dec('200') }),
      event({
        side: 'SHORT',
        quantity: dec('1'),
        fillPrice: dec('120'),
        gross: dec('120'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'SHORT',
        quantity: dec('1'),
        fillPrice: dec('130'),
        gross: dec('130'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ]);

    // Both closes price against the original 100, not against a running
    // average of a shrinking position.
    expect(result.realizedPnl.toString()).toBe('50');
  });

  it('starts a fresh average after a position empties', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SHORT',
        quantity: dec('1'),
        fillPrice: dec('150'),
        gross: dec('150'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({
        side: 'LONG',
        quantity: dec('1'),
        fillPrice: dec('300'),
        gross: dec('300'),
        expertOrderId: 'order-3',
        expertFilledAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      event({
        side: 'SHORT',
        quantity: dec('1'),
        fillPrice: dec('320'),
        gross: dec('320'),
        expertOrderId: 'order-4',
        expertFilledAt: new Date('2026-01-04T00:00:00.000Z'),
      }),
    ]);

    // 150 - 100 = 50 on the first round, 320 - 300 = 20 on the second. A
    // replay that averaged across the closed lot would report 70 on the last
    // close, which is a number the ledger does not hold.
    expect(result.realizedPnl.toString()).toBe('70');
  });

  it('ignores a refusal entirely', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SHORT',
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

  it('books a short against a flat book the way the engine books it', () => {
    const result = replayCopyLedger([
      event({ side: 'LONG', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'SHORT',
        strategyId: 'strategy-2',
        quantity: dec('1'),
        fillPrice: dec('900'),
        gross: dec('900'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);

    // The second follow never bought anything, so its short opens against a
    // flat book and realises nothing. The engine books the same zero, because
    // the two must agree on every row, not only on the reachable ones.
    expect(result.realizedPnl.toString()).toBe('0');
  });

  it('realises the gain when a long closes a short', () => {
    const result = replayCopyLedger([
      event({ side: 'SHORT', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
      event({
        side: 'LONG',
        quantity: dec('1'),
        fillPrice: dec('90'),
        gross: dec('90'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ]);

    // Closing a short at 90 against an entry of 100 realises 100 - 90.
    expect(result.realizedPnl.toString()).toBe('10');
  });

  it('replays in the engine\'s order, not the order it was handed', () => {
    const result = replayCopyLedger([
      event({
        side: 'SHORT',
        quantity: dec('1'),
        fillPrice: dec('150'),
        gross: dec('150'),
        expertOrderId: 'order-2',
        expertFilledAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      event({ side: 'LONG', quantity: dec('1'), fillPrice: dec('100'), gross: dec('100') }),
    ]);

    expect(result.points[0]?.side).toBe('LONG');
    expect(result.points[1]?.side).toBe('SHORT');
    expect(result.realizedPnl.toString()).toBe('50');
  });
});
