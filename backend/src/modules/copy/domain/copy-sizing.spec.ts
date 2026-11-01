import { Prisma } from '@prisma/client';

import {
  DEFAULT_COPY_INITIAL_CASH,
  evaluateEligibility,
  followStartCursor,
  isAfter,
  parseAllocationFraction,
  sizeCopyOrder,
} from './copy-sizing';

/**
 * MODULE 07 - the pure copy-trading rules, tested with no database and no
 * clock.
 *
 * These decide whether a follower's simulated balance moves and by how much, so
 * each rule is provoked on its own: the proportional scaling, each of the two
 * bounds, the price policy, the refusal vocabulary, and the pair comparison the
 * durable cursor depends on. Anything that fails here fails as a wrong balance
 * later, which is a far more expensive place to find it.
 */
describe('parseAllocationFraction', () => {
  it('accepts a proportion in (0, 1]', () => {
    expect(parseAllocationFraction('0.25')).toEqual({ ok: true, fraction: new Prisma.Decimal('0.25') });
    expect(parseAllocationFraction('1')).toEqual({ ok: true, fraction: new Prisma.Decimal('1') });
    expect(parseAllocationFraction('0.000000000000000001')).toEqual({
      ok: true,
      fraction: new Prisma.Decimal('0.000000000000000001'),
    });
  });

  it('trims surrounding whitespace but nothing else', () => {
    expect(parseAllocationFraction('  0.5  ')).toEqual({ ok: true, fraction: new Prisma.Decimal('0.5') });
  });

  it('refuses zero, because copying nothing should be expressed by unfollowing', () => {
    const result = parseAllocationFraction('0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/greater than zero/);
  });

  it('refuses anything above 1 - that would be leverage, not a copy', () => {
    for (const raw of ['1.0001', '2', '1.5']) {
      const result = parseAllocationFraction(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/cannot exceed 1/);
    }
  });

  it('refuses a quantity of digits that cannot be a proportion', () => {
    expect(parseAllocationFraction('100').ok).toBe(false);
  });

  it('refuses shapes that are not a plain decimal', () => {
    for (const raw of ['', 'abc', '-0.5', '0.25e-2', '1,5', '.5', '0.', 'NaN']) {
      expect(parseAllocationFraction(raw).ok).toBe(false);
    }
  });

  it('refuses more than the column scale of 18 decimal places', () => {
    expect(parseAllocationFraction('0.1234567890123456789').ok).toBe(false);
    expect(parseAllocationFraction('0.123456789012345678').ok).toBe(true);
  });
});

describe('evaluateEligibility', () => {
  const FOLLOWED_AT = new Date('2026-03-01T12:00:00.000Z');
  const ACTIVE_STRATEGY = { status: 'ACTIVE' as const, visibility: 'PUBLIC' as const };

  const evaluate = (overrides: Partial<Parameters<typeof evaluateEligibility>[0]> = {}) =>
    evaluateEligibility({
      followStatus: 'ACTIVE',
      followedAt: FOLLOWED_AT,
      fillFilledAt: new Date('2026-03-01T12:00:01.000Z'),
      strategy: ACTIVE_STRATEGY,
      ...overrides,
    });

  it('copies when the follow is active, the strategy is public and active, and the fill postdates the follow', () => {
    expect(evaluate()).toEqual({ eligible: true });
  });

  it('refuses an unfollowed follow with FOLLOW_NOT_ACTIVE', () => {
    expect(evaluate({ followStatus: 'UNFOLLOWED' })).toEqual({
      eligible: false,
      rejectReason: 'FOLLOW_NOT_ACTIVE',
    });
  });

  it('refuses a fill stamped before the follow began, even while the follow is ACTIVE', () => {
    // The cursor survives an unfollow/re-follow cycle on purpose, so the gap's
    // fills are still read - and must be recorded as refused, not copied.
    expect(evaluate({ fillFilledAt: new Date('2026-02-20T09:00:00.000Z') })).toEqual({
      eligible: false,
      rejectReason: 'FOLLOW_NOT_ACTIVE',
    });
  });

  it('accepts a fill stamped at the follow instant itself', () => {
    expect(evaluate({ fillFilledAt: FOLLOWED_AT })).toEqual({ eligible: true });
  });

  it('refuses an archived strategy with STRATEGY_ARCHIVED', () => {
    expect(evaluate({ strategy: { status: 'ARCHIVED', visibility: 'PUBLIC' } })).toEqual({
      eligible: false,
      rejectReason: 'STRATEGY_ARCHIVED',
    });
  });

  it('refuses a strategy that went private with STRATEGY_NOT_ELIGIBLE', () => {
    expect(evaluate({ strategy: { status: 'ACTIVE', visibility: 'PRIVATE' } })).toEqual({
      eligible: false,
      rejectReason: 'STRATEGY_NOT_ELIGIBLE',
    });
  });

  it('refuses a strategy row that cannot be found rather than crashing the pass', () => {
    expect(evaluate({ strategy: null })).toEqual({
      eligible: false,
      rejectReason: 'STRATEGY_NOT_ELIGIBLE',
    });
  });
});

describe('sizeCopyOrder', () => {
  const CASH = DEFAULT_COPY_INITIAL_CASH; // 100000
  const WALLET = new Prisma.Decimal('1000000');

  const size = (overrides: Partial<Parameters<typeof sizeCopyOrder>[0]> = {}) =>
    sizeCopyOrder({
      side: 'LONG',
      expertQuantity: new Prisma.Decimal('10'),
      allocationFraction: new Prisma.Decimal('0.25'),
      fillPrice: new Prisma.Decimal('100'),
      cash: CASH,
      walletUsdt: WALLET,
      ...overrides,
    });

  it('scales the expert quantity by the allocation and truncates toward zero', () => {
    const result = size({ expertQuantity: new Prisma.Decimal('10'), allocationFraction: new Prisma.Decimal('0.25') });
    expect(result).toEqual({
      executable: true,
      quantity: new Prisma.Decimal('2.5'),
      fillPrice: new Prisma.Decimal('100'),
      gross: new Prisma.Decimal('250'),
    });
  });

  it('mirrors the expert exactly at an allocation of 1', () => {
    const result = size({ allocationFraction: new Prisma.Decimal('1') });
    expect(result).toMatchObject({ quantity: new Prisma.Decimal('10'), gross: new Prisma.Decimal('1000') });
  });

  it('scales down without knowing anything about the expert account', () => {
    const result = size({ allocationFraction: new Prisma.Decimal('0.1') });
    expect(result).toMatchObject({ quantity: new Prisma.Decimal('1'), gross: new Prisma.Decimal('100') });
  });

  it('reports a scaled quantity of zero as ALLOCATION_ROUNDED_TO_ZERO', () => {
    const result = size({
      expertQuantity: new Prisma.Decimal('1'),
      allocationFraction: new Prisma.Decimal('0.000000001'),
    });
    expect(result).toEqual({ executable: false, rejectReason: 'ALLOCATION_ROUNDED_TO_ZERO' });
  });

  it('refuses a missing, zero or negative price rather than guessing one', () => {
    for (const fillPrice of [null, new Prisma.Decimal('0'), new Prisma.Decimal('-1')]) {
      expect(size({ fillPrice })).toEqual({ executable: false, rejectReason: 'PRICE_UNAVAILABLE' });
    }
  });

  describe('the LONG bound', () => {
    it('takes the smaller of the scaled quantity and what the copy cash can fund', () => {
      // Scaled intent is 10 at 100 each (1000) but only 500 of copy cash exists.
      const result = size({
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        cash: new Prisma.Decimal('500'),
      });
      expect(result).toMatchObject({ quantity: new Prisma.Decimal('5'), gross: new Prisma.Decimal('500') });
    });

    it('never spends more than the cash it has', () => {
      // 99.99 of cash buys 0.9999 units at 100 - truncated down, so the debit
      // cannot exceed the balance by a fraction of a cent.
      const result = size({
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        cash: new Prisma.Decimal('99.99'),
      });
      expect(result).toMatchObject({
        quantity: new Prisma.Decimal('0.9999'),
        gross: new Prisma.Decimal('99.99'),
      });
    });

    it('refuses when no positive quantity fits the cash', () => {
      const result = size({ cash: new Prisma.Decimal('0'), allocationFraction: new Prisma.Decimal('1') });
      expect(result).toEqual({ executable: false, rejectReason: 'INSUFFICIENT_COPY_CASH' });
    });

    it('refuses when the cash cannot fund even one 8-decimal unit at this price', () => {
      // 1e-8 of cash buys 1e-10 of an asset priced at 100, which truncates to
      // zero units. The fill is refused rather than taken at a quantity of 0 -
      // a refusal is a stored outcome, whereas a zero fill would be a lie.
      const result = size({
        cash: new Prisma.Decimal('0.00000001'),
        fillPrice: new Prisma.Decimal('100'),
        allocationFraction: new Prisma.Decimal('1'),
      });
      expect(result).toEqual({ executable: false, rejectReason: 'INSUFFICIENT_COPY_CASH' });
    });
  });

  describe('the SHORT bound', () => {
    const short = (overrides: Partial<Parameters<typeof sizeCopyOrder>[0]> = {}) =>
      size({ side: 'SHORT', ...overrides });

    it('takes the scaled quantity exactly, because a short is not bounded by the book', () => {
      const result = short({ allocationFraction: new Prisma.Decimal('1') });
      expect(result).toMatchObject({ quantity: new Prisma.Decimal('10'), gross: new Prisma.Decimal('1000') });
    });

    it('is never bounded by the copy cash, because a short brings the notional in', () => {
      const result = short({ allocationFraction: new Prisma.Decimal('1'), cash: new Prisma.Decimal('0') });
      expect(result).toMatchObject({ quantity: new Prisma.Decimal('10'), gross: new Prisma.Decimal('1000') });
    });

    it('refuses before the bound when the scaled quantity rounds to zero', () => {
      const result = short({
        expertQuantity: new Prisma.Decimal('1'),
        allocationFraction: new Prisma.Decimal('0.000000001'),
      });
      expect(result).toEqual({ executable: false, rejectReason: 'ALLOCATION_ROUNDED_TO_ZERO' });
    });
  });

  describe('INSUFFICIENT_WALLET_BALANCE', () => {
    it('refuses a copy the follower\'s real USDT balance cannot cover', () => {
      const result = size({
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        walletUsdt: new Prisma.Decimal('999'),
      });
      expect(result).toEqual({ executable: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' });
    });

    it('refuses a short too, because the notional still has to be covered', () => {
      const result = size({
        side: 'SHORT',
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        walletUsdt: new Prisma.Decimal('999'),
      });
      expect(result).toEqual({ executable: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' });
    });

    it('accepts a notional the balance covers exactly', () => {
      const result = size({
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        walletUsdt: new Prisma.Decimal('1000'),
      });
      expect(result).toMatchObject({ quantity: new Prisma.Decimal('10'), gross: new Prisma.Decimal('1000') });
    });

    it('checks the balance against the copy that would actually happen, not the intention', () => {
      // The cash bound trims the copy to 5 units (500), which the balance of 500
      // covers exactly - even though the unscaled intent was 1000.
      const result = size({
        allocationFraction: new Prisma.Decimal('1'),
        fillPrice: new Prisma.Decimal('100'),
        cash: new Prisma.Decimal('500'),
        walletUsdt: new Prisma.Decimal('500'),
      });
      expect(result).toMatchObject({ quantity: new Prisma.Decimal('5'), gross: new Prisma.Decimal('500') });
    });
  });
});

describe('isAfter', () => {
  const FILL = (filledAt: string, orderId: string) => ({ filledAt: new Date(filledAt), orderId });

  it('orders by timestamp first', () => {
    expect(isAfter(FILL('2026-03-02T00:00:00.000Z', 'a'), FILL('2026-03-01T00:00:00.000Z', 'z'))).toBe(true);
    expect(isAfter(FILL('2026-03-01T00:00:00.000Z', 'a'), FILL('2026-03-02T00:00:00.000Z', 'z'))).toBe(false);
  });

  it('breaks a tie on the order id, the same way the port does', () => {
    const at = '2026-03-01T00:00:00.000Z';
    expect(isAfter(FILL(at, 'bbbb'), FILL(at, 'aaaa'))).toBe(true);
    expect(isAfter(FILL(at, 'aaaa'), FILL(at, 'bbbb'))).toBe(false);
    expect(isAfter(FILL(at, 'aaaa'), FILL(at, 'aaaa'))).toBe(false);
  });

  it('treats an empty cursor as being behind everything', () => {
    expect(isAfter(FILL('2026-03-01T00:00:00.000Z', 'a'), null)).toBe(true);
    expect(isAfter(FILL('2026-03-01T00:00:00.000Z', 'a'), { filledAt: null, orderId: null })).toBe(true);
  });
});

describe('followStartCursor', () => {
  const NOW = new Date('2026-03-01T12:00:00.000Z');

  it('seeds the cursor at the follow instant with the nil order id', () => {
    expect(followStartCursor(NOW)).toEqual({
      filledAt: NOW,
      orderId: '00000000-0000-0000-0000-000000000000',
    });
  });

  it('makes a fill stamped at the same millisecond count as after the follow', () => {
    const cursor = followStartCursor(NOW);
    expect(isAfter({ filledAt: NOW, orderId: 'anything' }, cursor)).toBe(true);
    expect(
      isAfter({ filledAt: new Date(NOW.getTime() - 1), orderId: 'anything' }, cursor),
    ).toBe(false);
  });
});
