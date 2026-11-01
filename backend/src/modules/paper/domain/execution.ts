import { Prisma } from '@prisma/client';

import type { MarketInstrument } from '../../live-data/instruments/instrument-catalogue';
import { isMarketOpen, type MarketState } from '../../live-data/market-state';
import type { LiveQuote } from '../../live-data/providers/market-data-provider.port';
import { planOrder, type BookPlan, type BookPosition } from '../../trading/domain/position-book';

/**
 * MODULE 06c - pure paper execution domain helpers.
 *
 * NOTHING IN HERE HITS THE DATABASE. These are the arithmetic rules that turn
 * one quote, one order request and one book into a fill or a rejection. The
 * service calls these with Decimal numbers and Prisma transaction state; they
 * call nothing.
 *
 * THE RULES ARE EXPLICITLY CONSERVATIVE. A LONG uses the ask (or last if only
 * one exists); a SHORT uses the bid (or last). If neither side exists at all,
 * the result is `MARKET_DATA_UNAVAILABLE`. If the quote is older than the
 * instrument's threshold, the result is `STALE_MARKET_DATA`. If equities are
 * outside the regular US session, `MARKET_CLOSED`. If the trader's real USDT
 * wallet cannot cover the order's notional, `INSUFFICIENT_WALLET_BALANCE`. If
 * the simulated cash cannot fund it, `INSUFFICIENT_PAPER_CASH`. These are
 * rejections that are *persisted as rows*, not exceptions that are thrown away.
 *
 * TWO LEDGERS, TWO CHECKS. The wallet check is about whether the trader is
 * allowed to trade at all: a trader with no USDT cannot open a position, and
 * the order is recorded as refused rather than quietly dropped. The paper cash
 * check is about the simulated pot: the seeded 100,000 USD that is not real
 * money and can run dry long before the wallet does. They are checked in that
 * order, because the wallet gate is the one that says "you may not trade" and
 * the cash gate is the one that says "this pot cannot fund it".
 *
 * IDIOMATICALLY LONG OR SHORT, MARKET ORDERS ONLY. No cancel, no modify, full
 * fills. Prices are never supplied by the client - the engine selects them from
 * the quote - so a replay is byte-identical.
 */

export const DEFAULT_PAPER_INITIAL_CASH = new Prisma.Decimal('100000');

export type PaperOrderSide = 'LONG' | 'SHORT';

export type PaperRejectReason =
  | 'MARKET_DATA_UNAVAILABLE'
  | 'STALE_MARKET_DATA'
  | 'MARKET_CLOSED'
  | 'INSUFFICIENT_PAPER_CASH'
  | 'INSUFFICIENT_WALLET_BALANCE';

export interface FilledExecution {
  readonly filled: true;
  readonly fillPrice: Prisma.Decimal;
  readonly gross: Prisma.Decimal;
  /** What the order does to the simulated book. */
  readonly plan: BookPlan;
}

export interface RejectedExecution {
  readonly filled: false;
  readonly rejectReason: PaperRejectReason;
}

export type ExecutionResult = FilledExecution | RejectedExecution;

export interface ExecutionInput {
  readonly side: PaperOrderSide;
  readonly quantity: Prisma.Decimal;
  /** The simulated paper cash on hand. */
  readonly cash: Prisma.Decimal;
  /** The position this order faces, if the book is not flat. */
  readonly position: BookPosition | null;
  /** The trader's real USDT balance, which gates whether they may trade. */
  readonly walletUsdt: Prisma.Decimal;
  readonly instrument: MarketInstrument;
  readonly quote: LiveQuote;
  readonly asOf: Date;
}

function isStale(quote: LiveQuote, instrument: MarketInstrument, asOf: Date): boolean {
  const ms = Date.parse(quote.asOf);
  if (Number.isNaN(ms)) {
    return true;
  }
  return asOf.getTime() - ms > instrument.staleAfterMs;
}

/**
 * The price the order executes at: a LONG pays the ask, a SHORT receives the
 * bid. The spread is the market's, not the platform's - the paper ledger never
 * charges a fee and never invents a mid.
 */
function executionPrice(side: PaperOrderSide, quote: LiveQuote): Prisma.Decimal | null {
  if (side === 'LONG') {
    if (quote.ask) return new Prisma.Decimal(quote.ask);
    if (quote.bid) return new Prisma.Decimal(quote.bid);
    return null;
  }
  if (side === 'SHORT') {
    if (quote.bid) return new Prisma.Decimal(quote.bid);
    if (quote.ask) return new Prisma.Decimal(quote.ask);
    return null;
  }
  return null;
}

export function evaluatePaperExecution(input: ExecutionInput): ExecutionResult {
  const marketState: MarketState = isMarketOpen(input.instrument.kind, input.asOf);

  if (marketState === 'CLOSED') {
    return { filled: false, rejectReason: 'MARKET_CLOSED' };
  }

  if (isStale(input.quote, input.instrument, input.asOf)) {
    return { filled: false, rejectReason: 'STALE_MARKET_DATA' };
  }

  const price = executionPrice(input.side, input.quote);
  if (price === null) {
    return { filled: false, rejectReason: 'MARKET_DATA_UNAVAILABLE' };
  }

  const gross = input.quantity.times(price);

  if (input.walletUsdt.lt(gross)) {
    return { filled: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' };
  }

  const plan = planOrder({
    side: input.side,
    quantity: input.quantity,
    fillPrice: price,
    position: input.position,
  });

  if (plan.cashDelta.lt(0) && input.cash.plus(plan.cashDelta).lt(0)) {
    return { filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' };
  }

  return { filled: true, fillPrice: price, gross, plan };
}
