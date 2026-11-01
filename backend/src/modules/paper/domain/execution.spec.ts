import { Prisma } from '@prisma/client';

import type { MarketInstrument } from '../../live-data/instruments/instrument-catalogue';
import type { BookPosition } from '../../trading/domain/position-book';
import { DEFAULT_PAPER_INITIAL_CASH, evaluatePaperExecution } from './execution';

/**
 * MODULE 06c - the pure fill/reject rules.
 *
 * No database, no provider, no clock of its own: every input is handed in, so
 * each of the five reject reasons and both fill paths can be provoked exactly
 * once and asserted on. These are the rules that decide whether real paper
 * money moves, which is why they are tested here in isolation rather than only
 * through the service that surrounds them.
 *
 * THE BOOK IS NET. A position is a direction plus a strictly positive
 * quantity, so an order is not "buy" or "sell" against a holding - it is a
 * LONG or a SHORT, and what it does to the book depends on what the book
 * already holds. A SHORT against a flat book opens a short; a LONG against a
 * short closes it.
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
  const WALLET = new Prisma.Decimal('1000000');

  interface Overrides {
    side?: 'LONG' | 'SHORT';
    quantity?: string;
    cash?: Prisma.Decimal;
    position?: BookPosition | null;
    walletUsdt?: Prisma.Decimal;
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
      side: overrides.side ?? 'LONG',
      quantity: new Prisma.Decimal(overrides.quantity ?? '1'),
      cash: overrides.cash ?? CASH,
      position: overrides.position ?? null,
      walletUsdt: overrides.walletUsdt ?? WALLET,
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

  /**
   * Reads a Decimal as a plain string.
   *
   * The plan rounds to the ledger's 18 places, so `100.5` and
   * `100.500000000000000000` are the same number with different internals -
   * and Jest's structural equality can tell them apart. The value is what the
   * test is about, so it is compared as a value.
   */
  const asText = (value: Prisma.Decimal | null | undefined): string | null =>
    value === null || value === undefined ? null : value.toString();

  describe('fills', () => {
    it('fills a LONG at the ask, never at the bid', () => {
      const result = evaluate({ side: 'LONG', ask: '100.5', bid: '99.5' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.fillPrice)).toBe('100.5');
        expect(asText(result.gross)).toBe('100.5');
      }
    });

    it('fills a SHORT at the bid, never at the ask', () => {
      const result = evaluate({ side: 'SHORT', quantity: '2', bid: '99.5', ask: '100.5' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.fillPrice)).toBe('99.5');
        expect(asText(result.gross)).toBe('199');
      }
    });

    it('sizes the gross as quantity times price, at full precision', () => {
      const result = evaluate({ side: 'LONG', quantity: '0.12345678', ask: '100' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(result.gross.toFixed(8)).toBe('12.34567800');
      }
    });

    it('fills a LONG that costs exactly the remaining cash, because the check is inclusive', () => {
      const result = evaluate({ side: 'LONG', quantity: '2', cash: new Prisma.Decimal('201'), ask: '100.5' });

      expect(result.filled).toBe(true);
    });

    it('falls back to the bid when an ask is missing on a LONG', () => {
      const result = evaluate({ side: 'LONG', ask: undefined, bid: '42' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.fillPrice)).toBe('42');
      }
    });

    it('falls back to the ask when a bid is missing on a SHORT', () => {
      const result = evaluate({ side: 'SHORT', quantity: '1', bid: undefined, ask: '43' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.fillPrice)).toBe('43');
      }
    });
  });

  describe('the net book', () => {
    it('opens a long against a flat book, spending the notional', () => {
      const result = evaluate({ side: 'LONG', quantity: '2', ask: '100.5' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.cashDelta)).toBe('-201');
        expect(asText(result.plan.realizedPnl)).toBe('0');
        expect(result.plan.position?.direction).toBe('LONG');
        expect(asText(result.plan.position?.quantity)).toBe('2');
        expect(asText(result.plan.position?.averageEntryPrice)).toBe('100.5');
      }
    });

    it('opens a short against a flat book, bringing the notional in', () => {
      const result = evaluate({ side: 'SHORT', quantity: '2', bid: '99.5' });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.cashDelta)).toBe('199');
        expect(asText(result.plan.realizedPnl)).toBe('0');
        expect(result.plan.position?.direction).toBe('SHORT');
        expect(asText(result.plan.position?.quantity)).toBe('2');
      }
    });

    it('averages the entry price when a long is added to a long', () => {
      const result = evaluate({
        side: 'LONG',
        quantity: '1',
        ask: '100',
        position: { direction: 'LONG', quantity: new Prisma.Decimal('1'), averageEntryPrice: new Prisma.Decimal('200') },
      });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.position?.quantity)).toBe('2');
        expect(asText(result.plan.position?.averageEntryPrice)).toBe('150');
        expect(asText(result.plan.realizedPnl)).toBe('0');
      }
    });

    it('closes a long and realises the loss when a SHORT faces it', () => {
      const result = evaluate({
        side: 'SHORT',
        quantity: '2',
        bid: '90',
        position: { direction: 'LONG', quantity: new Prisma.Decimal('2'), averageEntryPrice: new Prisma.Decimal('100') },
      });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.realizedPnl)).toBe('-20');
        expect(result.plan.closedPosition).toBe(true);
        expect(result.plan.position).toBeNull();
      }
    });

    it('closes a short and realises the gain when a LONG faces it', () => {
      const result = evaluate({
        side: 'LONG',
        quantity: '2',
        ask: '90',
        position: { direction: 'SHORT', quantity: new Prisma.Decimal('2'), averageEntryPrice: new Prisma.Decimal('100') },
      });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.realizedPnl)).toBe('20');
        expect(result.plan.closedPosition).toBe(true);
        expect(result.plan.position).toBeNull();
      }
    });

    it('flips the book when the order is larger than the position it faces', () => {
      const result = evaluate({
        side: 'SHORT',
        quantity: '3',
        bid: '100',
        position: { direction: 'LONG', quantity: new Prisma.Decimal('1'), averageEntryPrice: new Prisma.Decimal('100') },
      });

      expect(result.filled).toBe(true);
      if (result.filled) {
        expect(asText(result.plan.realizedPnl)).toBe('0');
        expect(result.plan.closedPosition).toBe(true);
        expect(result.plan.position?.direction).toBe('SHORT');
        expect(asText(result.plan.position?.quantity)).toBe('2');
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

  describe('INSUFFICIENT_WALLET_BALANCE', () => {
    it('rejects a LONG whose notional the real wallet cannot cover', () => {
      const result = evaluate({
        side: 'LONG',
        quantity: '2',
        walletUsdt: new Prisma.Decimal('200'),
        ask: '100.5',
      });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' });
    });

    it('rejects a SHORT whose notional the real wallet cannot cover', () => {
      const result = evaluate({
        side: 'SHORT',
        quantity: '2',
        walletUsdt: new Prisma.Decimal('100'),
        bid: '99.5',
      });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' });
    });

    it('accepts a notional the wallet covers exactly', () => {
      const result = evaluate({
        side: 'LONG',
        quantity: '2',
        walletUsdt: new Prisma.Decimal('201'),
        ask: '100.5',
      });

      expect(result.filled).toBe(true);
    });

    it('is checked before the paper cash, because it is the stronger statement', () => {
      const result = evaluate({
        side: 'LONG',
        quantity: '2',
        cash: new Prisma.Decimal('1'),
        walletUsdt: new Prisma.Decimal('1'),
        ask: '100.5',
      });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' });
    });
  });

  describe('INSUFFICIENT_PAPER_CASH', () => {
    it('rejects a LONG that costs more than the cash on hand', () => {
      const result = evaluate({ side: 'LONG', quantity: '2', cash: new Prisma.Decimal('200'), ask: '100.5' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' });
    });

    it('never applies to a SHORT, which brings the notional in rather than spending it', () => {
      const result = evaluate({
        side: 'SHORT',
        quantity: '1',
        cash: ZERO,
        bid: '99.5',
      });

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
      const result = evaluate({ side: 'LONG', quantity: '1000', cash: new Prisma.Decimal('1'), ask: '100.5' });

      expect(result).toEqual({ filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' });
    });
  });

  describe('the opening balance', () => {
    it('starts every paper account at 100000 USD', () => {
      expect(DEFAULT_PAPER_INITIAL_CASH.toString()).toBe('100000');
    });
  });
});
