import { Prisma } from '@prisma/client';

import { decimalString } from '../../market-data/domain/decimal-string';
import { planOrder, type BookPosition } from '../../trading/domain/position-book';

/**
 * MODULE 07 - working out what each copied fill did to the holding.
 *
 * WHY THIS EXISTS. The ledger records every fill a follower consumed - its
 * side, size, price and time - but not whether that fill opened a holding or
 * closed one. The `realized_pnl` column used to be that signal, and it is not
 * one: rows written before the net-book migration recorded a zero for every
 * fill, because the column was `NOT NULL DEFAULT 0` back then. The pot's own
 * running figure always carried the truth - it was incremented with the real
 * result - so a book can hold a pot balance of -97.61 USDT while every one of
 * its fill rows says zero. Reading those rows as "this fill closed nothing"
 * would be a confident wrong answer.
 *
 * SO THE BOOK IS REPLAYED. The fills are put back through the same net-book
 * kernel the copy engine itself uses, in the order they happened, and each one
 * is asked what it did to the holding it met. The replay is exact for the same
 * reason the engine is: it reads the same fills, applies the same rules and
 * ends at the same position.
 *
 * PER FOLLOW, NOT PER ACCOUNT. Each follow holds its own book, so a LONG in
 * one follow and a SHORT in another are two positions, not one position and
 * its opposite. The replay therefore keeps a book per (follow, market).
 *
 * PURE BY DESIGN. No database, no clock, no model - so the reconstruction can
 * be pinned down by tests, and so an answer that changes when no fill changed
 * would be a bug rather than a hallucination.
 */

/** What one fill did to the holding it met. */
export type CopyFillEffect = 'OPEN' | 'ADD' | 'REDUCE' | 'CLOSE' | 'FLIP' | 'NONE';

/** One consumed expert fill, as the ledger holds it. */
export interface CopyFill {
  expertOrderId: string;
  strategyId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** What the follower took. Null for a refused fill. */
  quantity: string | null;
  /** The price the follower transacted at. Null when the fill carried none. */
  fillPrice: string | null;
  expertFilledAt: string;
  status: 'COPIED' | 'REJECTED';
}

/** What the replay worked out about one fill. */
export interface CopyFillOutcome {
  effect: CopyFillEffect;
  /**
   * What the fill realised against the holding it reduced. Null when it
   * reduced nothing, and null when the fill realised exactly nothing - a
   * break-even close is not a result.
   */
  realizedPnl: string | null;
}

/**
 * The key one fill is filed under.
 *
 * The same expert order can be copied through more than one follow, and the
 * ledger's key is (follower, strategy, expert order), so the follow has to be
 * part of the key here too: two copies of one expert order are two different
 * fills on two different books.
 */
export function copyFillKey(strategyId: string, expertOrderId: string): string {
  return `${strategyId}|${expertOrderId}`;
}

/**
 * Replays the fills and works out what each one did.
 *
 * The result is keyed by {@link copyFillKey}. A refused fill, a fill with no
 * price and a fill of no size all come back as `NONE`: none of them moved the
 * book, so there is nothing to say about them.
 */
export function replayCopyFills(fills: CopyFill[]): Map<string, CopyFillOutcome> {
  const outcomes = new Map<string, CopyFillOutcome>();
  const books = new Map<string, BookPosition | null>();

  const ordered = [...fills].sort((left, right) => {
    const at = left.expertFilledAt.localeCompare(right.expertFilledAt);
    return at !== 0 ? at : left.expertOrderId.localeCompare(right.expertOrderId);
  });

  for (const fill of ordered) {
    const nothing = { effect: 'NONE' as const, realizedPnl: null };

    if (fill.status !== 'COPIED' || fill.quantity === null || fill.fillPrice === null) {
      outcomes.set(copyFillKey(fill.strategyId, fill.expertOrderId), nothing);
      continue;
    }

    const quantity = new Prisma.Decimal(fill.quantity);
    const fillPrice = new Prisma.Decimal(fill.fillPrice);
    if (quantity.lte(0) || fillPrice.lte(0)) {
      outcomes.set(copyFillKey(fill.strategyId, fill.expertOrderId), nothing);
      continue;
    }

    const key = `${fill.strategyId}|${fill.symbol}`;
    const book = books.get(key) ?? null;

    const plan = planOrder({ side: fill.side, quantity, fillPrice, position: book });

    let effect: CopyFillEffect;
    if (book === null) {
      effect = 'OPEN';
    } else if (book.direction === fill.side) {
      effect = 'ADD';
    } else if (plan.position === null) {
      effect = 'CLOSE';
    } else if (plan.position.direction !== book.direction) {
      effect = 'FLIP';
    } else {
      effect = 'REDUCE';
    }

    books.set(key, plan.position);

    outcomes.set(copyFillKey(fill.strategyId, fill.expertOrderId), {
      effect,
      realizedPnl: plan.realizedPnl.isZero() ? null : decimalString(plan.realizedPnl),
    });
  }

  return outcomes;
}

/** Whether an effect is one that opened or added to a holding. */
export function isOpeningEffect(effect: CopyFillEffect | null): boolean {
  return effect === 'OPEN' || effect === 'ADD';
}

/** Whether an effect is one that closed part of a holding against it. */
export function isClosingEffect(effect: CopyFillEffect | null): boolean {
  return effect === 'REDUCE' || effect === 'CLOSE' || effect === 'FLIP';
}
