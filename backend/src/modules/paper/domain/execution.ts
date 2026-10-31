/**
 * MODULE 06c - pure paper execution domain helpers.
 *
 * NOTHING IN HERE HITS THE DATABASE. These are the arithmetic rules that turn
 * one quote and one order request into a fill or a rejection. The service calls
 * these with Decimal numbers and Prisma transaction state; they call nothing.
 *
 * THE RULES ARE EXPLICITLY CONSERVATIVE. A BUY uses the ask (or last if only
 * one exists); a SELL uses the bid (or last). If neither side exists at all,
 * the result is `MARKET_DATA_UNAVAILABLE`. If the quote is older than the
 * instrument's threshold, the result is `STALE_MARKET_DATA`. If equities are
 * outside the regular US session, `MARKET_CLOSED`. If a BUY cannot be funded by
 * paper cash, `INSUFFICIENT_PAPER_CASH`. If a SELL exceeds the paper position,
 * `INSUFFICIENT_POSITION`. These are rejections that are *persisted as rows*,
 * not exceptions that are thrown away.
 *
 * IDIOMATICALLY LONG-ONLY, MARKET ORDERS ONLY. No cancel, no modify, full fills.
 * Prices are never supplied by the client - the engine selects them from the
 * quote - so a replay is byte-identical.
 */
import { Prisma } from '@prisma/client';

import type { MarketInstrument } from '../../live-data/instruments/instrument-catalogue';
import { isMarketOpen, type MarketState } from '../../live-data/market-state';
import type { LiveQuote } from '../../live-data/providers/market-data-provider.port';

export const DEFAULT_PAPER_INITIAL_CASH = new Prisma.Decimal('100000');

export type PaperOrderSide = 'BUY' | 'SELL';

export type PaperRejectReason =
  | 'MARKET_DATA_UNAVAILABLE'
  | 'STALE_MARKET_DATA'
  | 'MARKET_CLOSED'
  | 'INSUFFICIENT_PAPER_CASH'
  | 'INSUFFICIENT_POSITION';

export interface FilledExecution {
  readonly filled: true;
  readonly fillPrice: Prisma.Decimal;
  readonly gross: Prisma.Decimal;
}

export interface RejectedExecution {
  readonly filled: false;
  readonly rejectReason: PaperRejectReason;
}

export type ExecutionResult = FilledExecution | RejectedExecution;

export interface ExecutionInput {
  readonly side: PaperOrderSide;
  readonly quantity: Prisma.Decimal;
  readonly cash: Prisma.Decimal;
  readonly positionQuantity: Prisma.Decimal;
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

function executionPrice(side: PaperOrderSide, quote: LiveQuote): Prisma.Decimal | null {
  if (side === 'BUY') {
    if (quote.ask) return new Prisma.Decimal(quote.ask);
    if (quote.bid) return new Prisma.Decimal(quote.bid);
    return null;
  }
  if (side === 'SELL') {
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

  if (input.side === 'BUY') {
    if (gross.gt(input.cash)) {
      return { filled: false, rejectReason: 'INSUFFICIENT_PAPER_CASH' };
    }
    return { filled: true, fillPrice: price, gross };
  }

  if (input.side === 'SELL') {
    if (input.quantity.gt(input.positionQuantity)) {
      return { filled: false, rejectReason: 'INSUFFICIENT_POSITION' };
    }
    return { filled: true, fillPrice: price, gross };
  }

  return { filled: false, rejectReason: 'MARKET_DATA_UNAVAILABLE' };
}