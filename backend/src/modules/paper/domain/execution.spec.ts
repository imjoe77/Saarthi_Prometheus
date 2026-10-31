import { Prisma } from '@prisma/client';

import type { MarketInstrument } from '../../live-data/instruments/instrument-catalogue';
import { DEFAULT_PAPER_INITIAL_CASH, evaluatePaperExecution } from './execution';

/**
 * MODULE 06c - the pure fill/reject rules.
 *
 * No database, no provider, no clock of its own: every input is handed in, so
 * each of the five reject reasons and both fill paths can be provoked exactly
 * once and asserted on. These are the rules that decide whether real paper
 * money moves, which is why they are tested here in isolation rather than only
 * through the service that surrounds them.
 */
describe('evaluatePaperExecution', () => {
  /** Monday 2026-01-05 15:00 UTC = 10:00 New York, squarely inside the session. */
  const DURING_SESSION = new Date('2026-01-05T15:00:00.000Z');
  /** Saturday - equities closed, crypto still trading. */
  const WEEKEND = new Date('2026-01-10T15:00:00.000Z');

  const SOL: MarketInstrument = {
    symbol: 'SOL/USD',
    kind: 'CRYPTO',
    name: 'Solana',
    venue: 'crypto',
    quoteCurrency: 'USD',
    quantityPrecision: 8,
    staleAfterMs: 30_000,
  };

  const AAPL: MarketInstrument = {
    symbol: 'AAPL',
    kind: 'STOCK',
    name: 'Apple Inc.',
    venue: 'NASDAQ',
    quoteCurrency: 'USD',
    quantityPrecision: 4,
    staleAfterMs: 60_000,
  };

  const CASH = DEFAULT_PAPER_INITIAL_CASH; // 100000
  const ZERO = new Prisma.Decimal(0);

  interface Overrides {
    side?: 'BUY' | 'SELL';
    quantity?: string;
    cash?: Prisma.Decimal;
    positionQuantity?: string;
    instrument?: MarketInstrument;
    bid?: string | undefined;
    ask?: string | undefined;
    asOf?: string;
    at?: Date;
  }

  /**
   * Builds one execution input.
   *
   * `at` is resolved first and `asOf` defaults to *it*, so a case that moves
   * the clock does not silently inherit a quote stamped five days earlier and
   * fail as stale. `bid` and `ask` are read with an `in` check rather than a
   * destructuring default, because a default would fire for an explicit
   * `undefined` - and "this quote has no ask" is exactly what several cases
   * need to say.
   */
  function evaluate(overrides: Overrides = {}) {
    const at = overrides.at ?? DURING_SESSION;
    const instrument = overrides.instrument ?? SOL;

    return evaluatePaperExecution({
      side: overrides.side ?? 'BUY',
      quantity: new Prisma.Decimal(overrides.quantity ?? '1'),
      cash: overrides.cash ?? CASH,
      positionQuantity: new Prisma.Decimal(overrides.positionQuantity ?? '0'),
      instrument,
      quote: {
        symbol: instrument.symbol,
        bid: 'bid' in overrides ? overrides.bid : '99.5',
        ask: 'ask' in overrides ? overrides.ask : '100.5',
        asOf: overrides.asOf ?? at.toISOString(),
      },
      asOf: at,
    });
  }

  describe('fills', () => {
    it('fills a BUY at the ask, never at the bid', () => {
      const result = evaluate({ side: 'BUY', ask: '100.5', bid: '99.5' });

      expect(result).toEqual({
        filled: true,
        fillPrice: new Prisma.Decimal('100.5'),
        gross: new Prisma.Decimal('100.5'),
      });
    });

    it('fills a SELL at the bid, never at the ask', () => {
      const result = evaluate({
        side: 'SELL',
        quantity: '2',
        positionQuantity: '2',
        bid: '99.5',
        ask: '100.5',
      });

      expect(result).toEqual({
        filled: true,
        fillPrice: new Prisma.Decimal('99.5'),
        gross: new Prisma.Decimal('199'),
      });
    });

    it('sizes the gross as quantity times price, at full precision', () => {
      const result = evaluate({ side: 'BUY', quantity: '0.12345678', ask: '100' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(result.gross.toFixed(8)).toBe('12.34567800');
      }
    });

    it('fills a BUY that costs exactly the remaining cash, because the check is inclusive', () => {
      const result = evaluate({ side: 'BUY', quantity: '2', cash: new Prisma.Decimal('201'), ask: '100.5' });

      expect(result.filled).toBe(true);
    });

    it('fills a SELL of exactly the held position, because the check is inclusive', () => {
      const result = evaluate({ side: 'SELL', quantity: '2', positionQuantity: '2' });

      expect(result.filled).toBe(true);
    });

    it('falls back to the bid when an ask is missing on a BUY', () => {
      const result = evaluate({ side: 'BUY', ask: undefined, bid: '42' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(result.fillPrice).toEqual(new Prisma.Decimal('42'));
      }
    });

    it('falls back to the ask when a bid is missing on a SELL', () => {
      const result = evaluate({ side: 'SELL', quantity: '1', positionQuantity: '1', bid: undefined, ask: '43' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(result.fillPrice).toEqual(new Prisma.Decimal('43'));
      }
    });
  });

  describe('MARKET_CLOSED', () => {
    it('rejects an equities order outside the US cash session', () => {
      // 21:00 UTC in January is 16:00 New York - the close.
      const result = evaluate({
        instrument: AAPL,
        at: new Date('2026-01-05T21:00:00.000Z'),
      });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_CLOSED' });
    });

    it('rejects an equities order at the weekend', () => {
      const result = evaluate({ instrument: AAPL, at: WEEKEND });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_CLOSED' });
    });

    it('rejects an equities order before the open, even with a perfect quote', () => {
      const result = evaluate({
        instrument: AAPL,
        at: new Date('2026-01-05T14:29:00.000Z'),
        bid: '231.9',
        ask: '232.1',
      });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_CLOSED' });
    });

    it('accepts an equities order during the session', () => {
      const result = evaluate({ instrument: AAPL, at: DURING_SESSION, ask: '232.1' });

      expect(result.filled).toBe(true);
    });

    it('never rejects a crypto order as closed, because crypto has no session', () => {
      for (const at of [WEEKEND, new Date('2026-01-05T21:00:00.000Z'), new Date('2026-01-05T03:00:00.000Z')]) {
        const result = evaluate({ instrument: SOL, at });
        expect(result.filled).toBe(true);
      }
    });
  });

  describe('STALE_MARKET_DATA', () => {
    it('rejects a quote older than the instrument threshold', () => {
      const at = DURING_SESSION;
      const asOf = new Date(at.getTime() - 30_001).toISOString();

      const result = evaluate({ instrument: SOL, at, asOf });

      expect(result).toEqual({ filled: false, rejectReason: 'STALE_MARKET_DATA' });
    });

    it('accepts a quote exactly on the threshold, because the check is strict', () => {
      const at = DURING_SESSION;
      const asOf = new Date(at.getTime() - 30_000).toISOString();

      expect(evaluate({ instrument: SOL, at, asOf }).filled).toBe(true);
    });

    it('applies each instrument own threshold', () => {
      const at = DURING_SESSION;
      const asOf = new Date(at.getTime() - 45_000).toISOString();

      // 45s is stale for crypto (30s) but live for equities (60s).
      expect(evaluate({ instrument: SOL, at, asOf })).toEqual({
        filled: false,
        rejectReason: 'STALE_MARKET_DATA',
      });
      expect(evaluate({ instrument: AAPL, at, asOf }).filled).toBe(true);
    });

    it('treats an unparseable timestamp as stale rather than as fresh', () => {
      const result = evaluate({ asOf: 'not-a-timestamp' });

      expect(result).toEqual({ filled: false, rejectReason: 'STALE_MARKET_DATA' });
    });

    it('checks the session before freshness, so a closed market wins', () => {
      const result = evaluate({
        instrument: AAPL,
        at: WEEKEND,
        asOf: new Date(WEEKEND.getTime() - 600_000).toISOString(),
      });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_CLOSED' });
    });
  });

  describe('MARKET_DATA_UNAVAILABLE', () => {
    it('rejects when the quote carries neither bid nor ask', () => {
      const result = evaluate({ bid: undefined, ask: undefined });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_DATA_UNAVAILABLE' });
    });

    it('checks freshness before price, so a stale empty quote reports as stale', () => {
      const at = DURING_SESSION;
      const result = evaluate({
        at,
        asOf: new Date(at.getTime() - 60_000).toISOString(),
        bid: undefined,
        ask: undefined,
      });

      expect(result).toEqual({ filled: false, rejectReason: 'STALE_MARKET_DATA' });
    });
  });

  describe('INSUFFICIENT_PAPER_CASH', () => {
    it('rejects a BUY that costs more than the cash on hand', () => {
      const result = evaluate({ side: 'BUY', quantity: '2', cash: new Prisma.Decimal('200'), ask: '100.5' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' });
    });

    it('never applies to a SELL, which only spends a position', () => {
      const result = evaluate({
        side: 'SELL',
        quantity: '1',
        positionQuantity: '1',
        cash: ZERO,
        bid: '99.5',
      });

      expect(result.filled).toBe(true);
    });
  });

  describe('INSUFFICIENT_POSITION', () => {
    it('rejects a SELL larger than the position', () => {
      const result = evaluate({ side: 'SELL', quantity: '3', positionQuantity: '2' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_POSITION' });
    });

    it('rejects a SELL with no position at all', () => {
      const result = evaluate({ side: 'SELL', quantity: '1', positionQuantity: '0' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_POSITION' });
    });

    it('never applies to a BUY, which only spends cash', () => {
      const result = evaluate({ side: 'BUY', quantity: '5', positionQuantity: '0' });

      expect(result.filled).toBe(true);
    });
  });

  describe('precedence', () => {
    it('prefers MARKET_CLOSED over every later reason', () => {
      const at = WEEKEND;
      const result = evaluate({
        instrument: AAPL,
        at,
        asOf: new Date(at.getTime() - 600_000).toISOString(),
        bid: undefined,
        ask: undefined,
      });

      expect(result).toEqual({ filled: false, rejectReason: 'MARKET_CLOSED' });
    });

    it('prefers STALE_MARKET_DATA over an unavailable price', () => {
      const at = DURING_SESSION;
      const result = evaluate({
        at,
        asOf: new Date(at.getTime() - 60_000).toISOString(),
        bid: undefined,
        ask: undefined,
      });

      expect(result).toEqual({ filled: false, rejectReason: 'STALE_MARKET_DATA' });
    });

    it('reports insufficient cash over an otherwise valid quote', () => {
      const result = evaluate({ side: 'BUY', quantity: '1000', cash: new Prisma.Decimal('1'), ask: '100.5' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' });
    });
  });

  describe('the opening balance', () => {
    it('starts every paper account at 100000 USD', () => {
      expect(DEFAULT_PAPER_INITIAL_CASH.toString()).toBe('100000');
    });
  });
});
