import { Prisma } from '@prisma/client';

import { roundMoney } from '../../simulation/engine/simulation-engine';

/**
 * MODULE 07 - the copy ledger, replayed.
 *
 * WHY A REPLAY EXISTS. The engine stores realized P&L as a running total on
 * `copy_accounts` (`realized_pnl`), which is the authoritative figure but says
 * nothing about *when* it was made. A follower asking "what is my profit and
 * loss" needs two answers: the total, and the path to it. The total is already
 * stored; the path is not, and cannot be - a copy account keeps no history of
 * its own balance, because the event table is the history.
 *
 * SO THE EVENT TABLE IS REPLAYED. Every copy event is a COPIED or REJECTED row
 * carrying the exact quantity and price the follower executed, and the
 * engine's accounting is deterministic: average-cost, one position per
 * (follow, symbol), a position deleted the moment it empties. Replaying the
 * events in the order the engine consumed them therefore reproduces the
 * engine's own arithmetic.
 *
 * THE REPLAY MIRRORS THE ENGINE LINE FOR LINE, ON PURPOSE. `CopyExecutionService`
 * writes the position on a BUY as `roundMoney(qty + q) x roundMoney((q*avg +
 * qty*price) / (q + qty))` and, on a SELL, realises `roundMoney(qty*price -
 * qty*avg)` before reducing the quantity. This module does the same
 * arithmetic, in the same order, with the same rounding - not an equivalent
 * formula, the same one. A second implementation that merely agreed "on
 * average" could disagree with the ledger on a single fill, and the screen
 * would then show a profit and loss the database does not hold.
 *
 * THE RECONCILIATION IS THE POINT. `copy_accounts.realized_pnl` is written by
 * the engine as the sum of exactly these per-SELL realisations. The replayed
 * total must equal the stored total, and the service that reads both logs a
 * warning when they do not, because a divergence is a bug in one of the two -
 * never something to paper over with a rounding tolerance.
 *
 * ORDER IS THE ENGINE'S ORDER. Fills are consumed ascending by
 * `(expertFilledAt, expertOrderId)`, so the replay sorts by the same key. The
 * engine's state is per (follow, symbol), so events of different follows
 * interleaving in the global list cannot affect one another's arithmetic.
 */

const ZERO = new Prisma.Decimal(0);

/** One consumed fill, as the replay needs to see it. */
export interface CopyLedgerEvent {
  readonly followerId: string;
  readonly strategyId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  /** The quantity the follower executed. Null for a refusal. */
  readonly quantity: Prisma.Decimal | null;
  /** The price the follower executed at. Null for a refusal. */
  readonly fillPrice: Prisma.Decimal | null;
  /** quantity x fillPrice. Null for a refusal. */
  readonly gross: Prisma.Decimal | null;
  readonly status: 'COPIED' | 'REJECTED';
  /** When the expert's fill committed. */
  readonly expertFilledAt: Date;
  /** The expert order this event mirrors - the engine's own tie-break. */
  readonly expertOrderId: string;
  /** When the engine consumed this event. */
  readonly processedAt: Date;
}

/** One point of the profit-and-loss path. */
export interface PerformancePoint {
  readonly strategyId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: Prisma.Decimal;
  readonly fillPrice: Prisma.Decimal;
  readonly gross: Prisma.Decimal;
  /**
   * The P&L this single fill realised. Zero for a BUY - a BUY moves cash into
   * a position and realises nothing - and zero for a refusal.
   */
  readonly realizedPnl: Prisma.Decimal;
  /** The running total across every fill, in consumption order. */
  readonly cumulativePnl: Prisma.Decimal;
  readonly processedAt: Date;
}

/** The replayed ledger: a point per executed fill, and the total it reaches. */
export interface CopyPerformance {
  readonly points: PerformancePoint[];
  readonly realizedPnl: Prisma.Decimal;
  readonly copiedCount: number;
  readonly rejectedCount: number;
}

/** The engine's own position state for one (follow, symbol). */
interface PositionState {
  quantity: Prisma.Decimal;
  averageEntryPrice: Prisma.Decimal;
}

/**
 * The order the engine consumed the fills in: ascending by the expert's fill
 * stamp, with the order id as the tie-break - the same key the port pages by
 * and the same key `isAfter` compares.
 */
export function compareLedgerEvents(left: CopyLedgerEvent, right: CopyLedgerEvent): number {
  const byFill = left.expertFilledAt.getTime() - right.expertFilledAt.getTime();
  if (byFill !== 0) return byFill;
  return left.expertOrderId < right.expertOrderId ? -1 : left.expertOrderId > right.expertOrderId ? 1 : 0;
}

/**
 * Replays the copy ledger into the profit-and-loss path.
 *
 * A refusal contributes nothing: it is a record of a fill the engine saw and
 * did not copy, so it has no quantity, no price and no effect on any balance.
 */
export function replayCopyLedger(events: readonly CopyLedgerEvent[]): CopyPerformance {
  const ordered = [...events].sort(compareLedgerEvents);
  const positions = new Map<string, PositionState>();
  const points: PerformancePoint[] = [];

  let cumulative = ZERO;
  let copiedCount = 0;
  let rejectedCount = 0;

  for (const event of ordered) {
    if (event.status === 'REJECTED') {
      rejectedCount += 1;
      continue;
    }

    const quantity = event.quantity;
    const fillPrice = event.fillPrice;

    // A COPIED row always carries both. A row that somehow does not is
    // skipped rather than guessed at: inventing a quantity would invent
    // money, and the replay's only job is to reproduce the ledger.
    if (quantity === null || fillPrice === null || quantity.lte(0) || fillPrice.lte(0)) {
      continue;
    }

    copiedCount += 1;

    const key = `${event.followerId}|${event.strategyId}|${event.symbol}`;
    const position = positions.get(key);
    let realized = ZERO;

    if (event.side === 'BUY') {
      if (position === undefined) {
        // The engine creates the position with the raw fill price, not a
        // recomputed average - there is no history to average against.
        positions.set(key, { quantity, averageEntryPrice: fillPrice });
      } else {
        const newQuantity = position.quantity.plus(quantity);
        const newAverage = position.quantity
          .times(position.averageEntryPrice)
          .plus(quantity.times(fillPrice))
          .dividedBy(newQuantity);

        positions.set(key, {
          quantity: roundMoney(newQuantity),
          averageEntryPrice: roundMoney(newAverage),
        });
      }
    } else {
      // The engine's SELL path reads the position defensively: a missing
      // position means a zero holding and a zero entry price. That branch is
      // unreachable - the sizing rule caps a SELL at the quantity held and
      // refuses it outright when nothing is held - but the replay mirrors it
      // anyway, because a replay that disagreed with the engine in even an
      // unreachable branch would be a replay that could disagree in a
      // reachable one.
      const held = position?.quantity ?? ZERO;
      const entryPrice = position?.averageEntryPrice ?? ZERO;

      realized = roundMoney(quantity.times(fillPrice).minus(quantity.times(entryPrice)));

      const remainder = held.minus(quantity);
      if (remainder.lte(0)) {
        // An emptied position is deleted by the engine, so the next BUY starts
        // a fresh average rather than averaging against a closed lot.
        positions.delete(key);
      } else if (position !== undefined) {
        positions.set(key, { quantity: roundMoney(remainder), averageEntryPrice: position.averageEntryPrice });
      }
    }

    cumulative = cumulative.plus(realized);

    points.push({
      strategyId: event.strategyId,
      symbol: event.symbol,
      side: event.side,
      quantity,
      fillPrice,
      gross: event.gross ?? roundMoney(quantity.times(fillPrice)),
      realizedPnl: realized,
      cumulativePnl: cumulative,
      processedAt: event.processedAt,
    });
  }

  return { points, realizedPnl: cumulative, copiedCount, rejectedCount };
}
