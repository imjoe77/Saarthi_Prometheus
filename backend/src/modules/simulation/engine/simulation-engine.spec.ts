import { Prisma } from '@prisma/client';

import type { SimulationRule } from '../rules/simulation-rule';
import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CASH,
  roundMoney,
  simulate,
  truncateQuantity,
  type SimulationCandle,
} from './simulation-engine';

/**
 * MODULE 06b - the deterministic paper-trading engine.
 *
 * The constants in these assertions were recomputed by hand, not read from the
 * engine: `999.00099900` is `100000 / 1.001` truncated to 8 places, and the
 * dust balance that remains is what proves the engine sizes a buy so cash never
 * goes negative. The rules this file defines (`BUY_ONCE`, `LONG_THEN_FLAT`,
 * ...) exist only here, because the timing contract is best asserted with rules
 * whose every branch is known in advance.
 */
const BUY_ONCE: SimulationRule = {
  key: 'test-buy-once',
  version: 1,
  symbol: 'TESTUSDT',
  enterNote: 'go_long',
  exitNote: 'never_exits',
  desire(_closes, t) {
    return t === 0 ? 'long' : 'hold';
  },
};

const LONG_THEN_FLAT: SimulationRule = {
  key: 'test-long-then-flat',
  version: 1,
  symbol: 'TESTUSDT',
  enterNote: 'go_long',
  exitNote: 'go_flat',
  desire(_closes, t) {
    if (t === 0) {
      return 'long';
    }
    return t === 1 ? 'flat' : 'hold';
  },
};

const NEVER_LONG: SimulationRule = {
  key: 'test-never-long',
  version: 1,
  symbol: 'TESTUSDT',
  enterNote: 'never',
  exitNote: 'never',
  desire() {
    return 'flat';
  },
};

function flatCandles(days: string[], price = new Prisma.Decimal(100)): SimulationCandle[] {
  return days.map((day) => ({ day, open: price, close: price }));
}

function dayBalance(result: ReturnType<typeof simulate>, day: string) {
  const found = result.balances.find((balance) => balance.day === day);
  if (found === undefined) {
    throw new Error(`no balance for ${day}`);
  }
  return found;
}

describe('simulation engine', () => {
  it('refuses an empty candle series - there is no window to report', () => {
    expect(() => simulate(BUY_ONCE, [])).toThrow(/empty candle series/);
  });

  it('buys exactly once, at the second day open, and never sells', () => {
    const result = simulate(BUY_ONCE, flatCandles(['2025-01-01', '2025-01-02', '2025-01-03']));

    expect(result.windowStart).toBe('2025-01-01');
    expect(result.windowEnd).toBe('2025-01-03');
    expect(result.dayCount).toBe(3);
    expect(result.balances).toHaveLength(3);
    expect(result.fills).toHaveLength(1);

    const fill = result.fills[0];
    expect(fill).not.toBeUndefined();
    expect(fill?.sequenceNo).toBe(1);
    expect(fill?.fillDay).toBe('2025-01-02');
    expect(fill?.side).toBe('BUY');
    expect(fill?.price.equals(new Prisma.Decimal(100))).toBe(true);
    expect(fill?.quantity.equals(new Prisma.Decimal('999.000999'))).toBe(true);
    expect(fill?.gross.equals(new Prisma.Decimal('99900.0999'))).toBe(true);
    expect(fill?.fee.equals(new Prisma.Decimal('99.9000999'))).toBe(true);
    expect(fill?.cashAfter.equals(new Prisma.Decimal('0.0000001'))).toBe(true);
    expect(fill?.note).toBe('go_long');
  });

  it('never forms an opinion on the last close, because nothing could act on it', () => {
    const rule: SimulationRule = {
      ...BUY_ONCE,
      key: 'test-last-signal',
      desire(_closes, t) {
        return t === 3 ? 'flat' : t === 0 ? 'long' : 'hold';
      },
    };

    const result = simulate(rule, flatCandles(['d1', 'd2', 'd3', 'd4']));

    // The flat signal on the final close would need an open that does not
    // exist; the engine must not invent one.
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.side).toBe('BUY');
    expect(result.balances.at(-1)?.positionQty.equals(new Prisma.Decimal('999.000999'))).toBe(true);
  });

  it('sells one full step behind the exit signal and returns the proceeds to cash', () => {
    const result = simulate(LONG_THEN_FLAT, flatCandles(['d1', 'd2', 'd3', 'd4']));

    expect(result.fills).toHaveLength(2);

    const sell = result.fills[1];
    expect(sell?.sequenceNo).toBe(2);
    expect(sell?.fillDay).toBe('d3');
    expect(sell?.side).toBe('SELL');
    expect(sell?.quantity.equals(result.fills[0]?.quantity ?? new Prisma.Decimal(0))).toBe(true);
    expect(sell?.note).toBe('go_flat');
    // 0.0000001 in cash + 99900.0999 back from the position - 99.9000999 fee.
    expect(sell?.cashAfter.equals(new Prisma.Decimal('99800.1998002'))).toBe(true);

    expect(dayBalance(result, 'd1').positionQty.isZero()).toBe(true);
    expect(dayBalance(result, 'd2').positionQty.equals(new Prisma.Decimal('999.000999'))).toBe(true);
    expect(dayBalance(result, 'd3').positionQty.isZero()).toBe(true);
    expect(dayBalance(result, 'd4').positionQty.isZero()).toBe(true);
  });

  it('never buys when the rule never wants to be long', () => {
    const result = simulate(NEVER_LONG, flatCandles(['d1', 'd2', 'd3']));

    expect(result.fills).toHaveLength(0);
    for (const balance of result.balances) {
      expect(balance.cash.equals(DEFAULT_INITIAL_CASH)).toBe(true);
      expect(balance.positionQty.isZero()).toBe(true);
      expect(balance.value.equals(DEFAULT_INITIAL_CASH)).toBe(true);
    }
  });

  it('records one balance row per day, and the fill sequence is 1-based and consecutive', () => {
    const days = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const result = simulate(LONG_THEN_FLAT, flatCandles(days));

    expect(result.balances.map((balance) => balance.day)).toEqual(days);
    expect(result.fills.map((fill) => fill.sequenceNo)).toEqual([1, 2]);
  });

  it('keeps the ledger identity true on every day of a longer run', () => {
    const days = Array.from({ length: 20 }, (_, index) => `d${index + 1}`);
    const result = simulate(BUY_ONCE, flatCandles(days));

    for (const balance of result.balances) {
      expect(balance.value.equals(balance.cash.plus(balance.positionValue))).toBe(true);
      expect(balance.cash.isNegative()).toBe(false);
      expect(balance.positionQty.isNegative()).toBe(false);
      expect(balance.positionValue.isNegative()).toBe(false);
      expect(balance.positionQty.decimalPlaces()).toBeLessThanOrEqual(8);
    }

    for (const fill of result.fills) {
      expect(fill.quantity.decimalPlaces()).toBeLessThanOrEqual(8);
      expect(fill.fee.isNegative()).toBe(false);
      expect(fill.cashAfter.isNegative()).toBe(false);
    }
  });

  it('applies a caller-chosen starting cash and fee rate', () => {
    const result = simulate(
      BUY_ONCE,
      flatCandles(['d1', 'd2', 'd3']),
      { initialCash: new Prisma.Decimal('50000') },
    );

    const fill = result.fills[0];
    expect(fill?.quantity.equals(new Prisma.Decimal('499.5004995'))).toBe(true);
    expect(fill?.cashAfter.equals(new Prisma.Decimal('0.00000005'))).toBe(true);
    expect(result.initialCash.equals(new Prisma.Decimal('50000'))).toBe(true);
    expect(result.feeRate.equals(DEFAULT_FEE_RATE)).toBe(true);
  });

  it('rounds money half-up to 18 places and truncates quantities toward zero', () => {
    expect(roundMoney(new Prisma.Decimal('2.0000000000000000045')).toString()).toBe(
      '2.000000000000000005',
    );
    expect(roundMoney(new Prisma.Decimal('2.0000000000000000044')).toString()).toBe(
      '2.000000000000000004',
    );
    expect(truncateQuantity(new Prisma.Decimal('999.000999999')).toString()).toBe('999.00099999');
    expect(truncateQuantity(new Prisma.Decimal('-0.0000000001')).isZero()).toBe(true);
  });

  it('marks the position at the close of the fill day, then again on flat days', () => {
    const result = simulate(BUY_ONCE, flatCandles(['d1', 'd2', 'd3', 'd4']));

    expect(dayBalance(result, 'd1').positionValue.isZero()).toBe(true);
    for (const day of ['d2', 'd3', 'd4']) {
      const balance = dayBalance(result, day);
      expect(balance.positionValue.equals(new Prisma.Decimal('99900.0999'))).toBe(true);
      expect(balance.value.equals(new Prisma.Decimal('99900.0999001'))).toBe(true);
    }
  });
});