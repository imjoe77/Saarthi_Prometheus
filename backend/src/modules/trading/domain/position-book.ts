import { Prisma } from '@prisma/client';

import { roundMoney } from '../../simulation/engine/simulation-engine';

/**
 * THE SIMULATED BOOK, AS PURE ARITHMETIC.
 *
 * TWO LEDGERS, ONE BOOK. Module 06c (the expert's paper account) and Module 07
 * (a follower's copy pot) are separate balances in separate tables, but the
 * question "what does this order do to the position and the cash?" has exactly
 * one answer, and it is written down here once. Both engines call it, and the
 * copy ledger's replay calls it too - which is why a replay can disagree with
 * its own engine about a rounding rule: there is only one rounding rule.
 *
 * THE BOOK IS NET, NOT LONG-ONLY. A position points one way and holds a
 * magnitude, and an order either adds to the position it faces or moves
 * against it:
 *
 *   flat  + LONG   -> long q at the fill price, cash falls by q x price
 *   flat  + SHORT  -> short q at the fill price, cash rises by q x price
 *   long  + LONG   -> a bigger long, weighted-average entry, cash falls
 *   long  + SHORT  -> reduces, closes or flips the long; profit if the price rose
 *   short + SHORT  -> a bigger short, weighted-average entry, cash rises
 *   short + LONG   -> reduces, closes or flips the short; profit if the price fell
 *
 * A FLIP IS ALLOWED, AND IS THE POINT OF HAVING TWO DIRECTIONS. An order
 * larger than the position it faces closes it and opens one in the order's own
 * direction with the leftover - because a "short" that could only ever mean
 * "sell what you hold" would not be a short at all, and the expert's LONG/SHORT
 * button would be a rename of a long-only sell.
 *
 * THE CASH IDENTITY IS THE PROOF. Over any sequence of orders,
 *
 *     cash + position market value == opening cash + realized P&L
 *
 * holds exactly, because an order moves cash by +/- its own notional and
 * realizes P&L only against a position it reduces. A reader who checks the
 * account against that identity is checking the arithmetic, not a convention.
 *
 * NO MONEY MOVES HERE. This module computes; the engines that own the ledgers
 * apply the result, and the engines that own the real wallets decide whether a
 * trader may trade at all.
 */

/** Which way a position points. */
export type Direction = 'LONG' | 'SHORT';

/** One open position: a direction and the magnitude held in it. */
export interface BookPosition {
  readonly direction: Direction;
  /** Always strictly greater than zero. */
  readonly quantity: Prisma.Decimal;
  readonly averageEntryPrice: Prisma.Decimal;
}

/**
 * What one order does to the book.
 *
 * `position` is null when the order leaves the book flat - a closed position is
 * a *deleted row*, never a zero-quantity one, so "held nothing" and "missing
 * data" cannot be confused.
 */
export interface BookPlan {
  /** The position after the order, or null when the order leaves the book flat. */
  readonly position: BookPosition | null;
  /** Change to the cash balance. Negative spends cash, positive brings it in. */
  readonly cashDelta: Prisma.Decimal;
  /** Profit or loss realised by this order, against the position it reduced. */
  readonly realizedPnl: Prisma.Decimal;
  /** True when the order closed the position it acted against. */
  readonly closedPosition: boolean;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Plans one order against one position.
 *
 * THE CASH MOVEMENT IS THE ORDER'S OWN NOTIONAL, ALWAYS. A LONG order costs
 * `quantity x price` whatever the book looks like - buying back a short costs
 * cash exactly as opening a long does - and a SHORT order brings in exactly
 * that much. That symmetry is what makes the cash identity above hold, and it
 * is why the engine's affordability check is a single comparison rather than a
 * per-branch one.
 *
 * THE REALIZED P&L IS SIGNED BY DIRECTION. Closing a long profits when the
 * price rose (sold above the entry); closing a short profits when the price
 * fell (bought back below the entry). Both are `closed x (exit - entry)` with
 * the direction deciding which end is which.
 *
 * THE ENTRY PRICE OF A REDUCED POSITION DOES NOT MOVE. Averaging is a property
 * of *adding*, so reducing a position leaves its average entry alone - which is
 * what makes the profit on the closed part computable from the row itself.
 */
export function planOrder(input: {
  readonly side: Direction;
  readonly quantity: Prisma.Decimal;
  readonly fillPrice: Prisma.Decimal;
  readonly position: BookPosition | null;
}): BookPlan {
  const quantity = input.quantity;
  const price = input.fillPrice;
  const notional = quantity.times(price);
  const cashDelta = input.side === 'LONG' ? notional.negated() : notional;

  const position = input.position;

  if (position === null) {
    return {
      position: { direction: input.side, quantity, averageEntryPrice: price },
      cashDelta,
      realizedPnl: ZERO,
      closedPosition: false,
    };
  }

  if (position.direction === input.side) {
    const newQuantity = position.quantity.plus(quantity);
    const newAverage = position.quantity
      .times(position.averageEntryPrice)
      .plus(quantity.times(price))
      .dividedBy(newQuantity);

    return {
      position: {
        direction: position.direction,
        quantity: roundMoney(newQuantity),
        averageEntryPrice: roundMoney(newAverage),
      },
      cashDelta,
      realizedPnl: ZERO,
      closedPosition: false,
    };
  }

  const closed = quantity.lte(position.quantity) ? quantity : position.quantity;
  const realized =
    position.direction === 'LONG'
      ? closed.times(price).minus(closed.times(position.averageEntryPrice))
      : closed.times(position.averageEntryPrice).minus(closed.times(price));

  const leftover = quantity.minus(closed);

  if (leftover.lte(0)) {
    const remaining = position.quantity.minus(closed);
    const emptied = remaining.lte(0);

    return {
      position: emptied
        ? null
        : {
            direction: position.direction,
            quantity: roundMoney(remaining),
            averageEntryPrice: position.averageEntryPrice,
          },
      cashDelta,
      realizedPnl: roundMoney(realized),
      closedPosition: emptied,
    };
  }

  // The order was larger than the position it faced: it closed that position
  // and opened one in its own direction with the leftover, at the fill price.
  return {
    position: { direction: input.side, quantity: roundMoney(leftover), averageEntryPrice: price },
    cashDelta,
    realizedPnl: roundMoney(realized),
    closedPosition: true,
  };
}

/**
 * The unrealised result of holding a position at a given price.
 *
 * `marketValue` is SIGNED: a short position is a liability, so its value is
 * negative. That is what keeps the cash identity exact - cash plus a signed
 * market value is the account's real worth, and a short that is not marked as
 * a liability would overstate it.
 */
export function markPosition(
  position: BookPosition,
  markPrice: Prisma.Decimal,
): {
  readonly marketValue: Prisma.Decimal;
  readonly unrealizedPnl: Prisma.Decimal;
} {
  const value = position.quantity.times(markPrice);

  if (position.direction === 'LONG') {
    return {
      marketValue: value,
      unrealizedPnl: position.quantity.times(markPrice.minus(position.averageEntryPrice)),
    };
  }

  return {
    marketValue: value.negated(),
    unrealizedPnl: position.quantity.times(position.averageEntryPrice.minus(markPrice)),
  };
}
