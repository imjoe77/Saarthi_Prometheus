import { Prisma } from '@prisma/client';

import { roundMoney, truncateQuantity } from '../../simulation/engine/simulation-engine';

/**
 * MODULE 07 - pure copy-trading rules. Nothing here touches the database.
 *
 * ALLOCATION IS A PROPORTION, AND ONLY A PROPORTION. A follow carries one
 * number, `allocationFraction`, in (0, 1]: the share of each expert order the
 * follower mirrors. The follower's quantity is
 *
 *     intended = truncate(expertQuantity x allocationFraction)
 *
 * which is the same relationship on both sides of the book, and that symmetry
 * is the whole reason a proportion was chosen over a fixed notional. A fixed
 * amount can size a LONG but says nothing about a SHORT - there is no way to
 * derive "how much do I sell" from "the expert sold, spend $500" - whereas a
 * proportion answers both, and needs no knowledge of the expert's account.
 *
 * Everything above 1 is refused rather than silently capped: 1.0 already means
 * "exactly the expert's size", so anything more would be leverage, and this
 * module never levers a simulated account.
 *
 * BOUNDS ARE RESOLVED, NOT IGNORED. After scaling:
 *  - a LONG is limited to what the follower's copy cash can fund (never a
 *    negative balance, never credit),
 *  - a SHORT is not limited by the book - the follower mirrors the expert's
 *    direction, so a short is a short, and it brings the notional in rather
 *    than spending it,
 *  - when the bound leaves nothing to execute, the result is a rejection with
 *    the reason that explains it - never a zero-quantity "fill".
 *
 * PRICE POLICY IS MIRROR-PRICE. The follower transacts at the expert's
 * committed fill price, so a copy event is deterministic, needs no market
 * feed, and can be explained by one number stored on the expert's own row.
 * A fill price that is missing or not strictly positive is a rejection
 * (`PRICE_UNAVAILABLE`) rather than a guess.
 *
 * THE WALLET GATES THE COPY. A follower with no USDT in the real wallet cannot
 * mirror anything, and the refusal is recorded with its own reason rather than
 * being folded into the cash rule - "your pot is empty" and "you have no
 * capital" are different problems with different fixes.
 */

/** Reason a committed expert fill was not copied. Mirrors the `CopyRejectReason` enum. */
export type CopyRejectReason =
  | 'FOLLOW_NOT_ACTIVE'
  | 'STRATEGY_ARCHIVED'
  | 'STRATEGY_NOT_ELIGIBLE'
  | 'ALLOCATION_ROUNDED_TO_ZERO'
  | 'INSUFFICIENT_COPY_CASH'
  | 'PRICE_UNAVAILABLE'
  | 'INSUFFICIENT_WALLET_BALANCE';

/** Starting cash of a follower's copy account. Deliberately its own constant: it
 *  is not the expert's paper balance and not the Module 03 wallet. */
export const DEFAULT_COPY_INITIAL_CASH = new Prisma.Decimal('100000');

/** Largest allocation a follower may configure: one-to-one with the expert. */
export const MAX_ALLOCATION_FRACTION = new Prisma.Decimal('1');

export type FollowStatus = 'ACTIVE' | 'UNFOLLOWED';
export type StrategyLifecycle = 'ACTIVE' | 'ARCHIVED';
export type StrategyVisibilityState = 'PRIVATE' | 'PUBLIC';

export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly rejectReason: CopyRejectReason };

/**
 * May this follow consume this fill?
 *
 * Eligibility is re-read inside the processing transaction rather than
 * remembered at follow time, because all of these can change while the cursor
 * is parked: the follower can unfollow, the owner can archive, and the owner
 * can unpublish. Each of those has its own reason so the history says which one
 * stopped the copying.
 *
 * TWO TIME WINDOWS, BOTH DATED. `followedAt` is when the *current* active
 * interval began, and a fill stamped before it belongs to a gap between two
 * follows - or to the expert's history before the follow existed. Such a fill
 * is refused as `FOLLOW_NOT_ACTIVE` even if the follow is ACTIVE again right
 * now, because a cursor that survived an unfollow would otherwise walk back
 * into the gap and copy trades the follower was not following for. The status
 * route asks the same question about "a fill arriving now", which is why
 * `fillFilledAt` is an input rather than an internal `new Date()`.
 *
 * A missing strategy row is treated as "not eligible" rather than as an error:
 * the follow row's foreign key makes it unreachable, and a copy engine must
 * fail open into a recorded rejection instead of crashing the pass.
 */
export function evaluateEligibility(input: {
  readonly followStatus: FollowStatus;
  readonly followedAt: Date;
  readonly fillFilledAt: Date;
  readonly strategy: { status: StrategyLifecycle; visibility: StrategyVisibilityState } | null;
}): EligibilityResult {
  if (input.followStatus !== 'ACTIVE') {
    return { eligible: false, rejectReason: 'FOLLOW_NOT_ACTIVE' };
  }

  if (input.fillFilledAt.getTime() < input.followedAt.getTime()) {
    return { eligible: false, rejectReason: 'FOLLOW_NOT_ACTIVE' };
  }

  if (input.strategy === null) {
    return { eligible: false, rejectReason: 'STRATEGY_NOT_ELIGIBLE' };
  }

  if (input.strategy.status === 'ARCHIVED') {
    return { eligible: false, rejectReason: 'STRATEGY_ARCHIVED' };
  }

  if (input.strategy.visibility !== 'PUBLIC') {
    return { eligible: false, rejectReason: 'STRATEGY_NOT_ELIGIBLE' };
  }

  return { eligible: true };
}

export type AllocationParse =
  | { readonly ok: true; readonly fraction: Prisma.Decimal }
  | { readonly ok: false; readonly error: string };

const ALLOCATION_PATTERN = /^\d{1,2}(?:\.\d{1,18})?$/;

/**
 * Validates a follower-supplied allocation string.
 *
 * The shape check lives here rather than in a DTO decorator because this is the
 * one place the rule is written down: digits with at most 18 decimal places (the
 * column's scale), then a value check of 0 < f <= 1. `0` is refused because
 * copying nothing should be expressed by unfollowing, not by a configuration
 * that silently drops every event while claiming to be active.
 */
export function parseAllocationFraction(raw: string): AllocationParse {
  const trimmed = raw.trim();

  if (trimmed.length === 0 || !ALLOCATION_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: 'allocationFraction must be a positive decimal with at most 18 decimal places.',
    };
  }

  const fraction = new Prisma.Decimal(trimmed);

  if (fraction.lte(0)) {
    return { ok: false, error: 'allocationFraction must be greater than zero.' };
  }

  if (fraction.gt(MAX_ALLOCATION_FRACTION)) {
    return {
      ok: false,
      error: 'allocationFraction cannot exceed 1 - a copy never mirrors more than the expert.',
    };
  }

  return { ok: true, fraction };
}

export interface SizeCopyInput {
  readonly side: 'LONG' | 'SHORT';
  readonly expertQuantity: Prisma.Decimal;
  readonly allocationFraction: Prisma.Decimal;
  /** The expert's committed fill price, or null when it is unusable. */
  readonly fillPrice: Prisma.Decimal | null;
  /** The follower's copy cash for this follow. */
  readonly cash: Prisma.Decimal;
  /** The follower's real USDT balance, which gates whether the copy may happen. */
  readonly walletUsdt: Prisma.Decimal;
}

export type SizedCopy =
  | {
      readonly executable: true;
      readonly quantity: Prisma.Decimal;
      readonly fillPrice: Prisma.Decimal;
      readonly gross: Prisma.Decimal;
    }
  | { readonly executable: false; readonly rejectReason: CopyRejectReason };

/**
 * Sizes one copy, or returns the reason nothing can be copied.
 *
 * Order of the checks is the order the reasons are reported in a history, and
 * it is deliberately "price, then scaling, then the bounds": a fill that cannot
 * be priced is refused before any arithmetic that would have used a price, and
 * a scaled quantity of zero is distinguished from an unaffordable one so the
 * follower can tell a rounding artefact from running out of cash.
 *
 * NOTE ON THE CASH BOUND. `affordable` is computed by dividing cash by price
 * and truncating *down* to the quantity precision, so quantity x price can never
 * exceed cash in exact arithmetic. The execution service still re-checks the
 * debit with a guarded update, because that check is also what serialises two
 * concurrent copies against the same balance - arithmetic alone is not a lock.
 *
 * NOTE ON THE WALLET BOUND. It is checked against the gross of the copy that
 * would actually happen - the quantity after the cash bound, not the
 * unscaled intention - because that is the notional the follower's capital has
 * to stand behind.
 */
export function sizeCopyOrder(input: SizeCopyInput): SizedCopy {
  const price = input.fillPrice;

  if (price === null || !price.isFinite() || price.lte(0)) {
    return { executable: false, rejectReason: 'PRICE_UNAVAILABLE' };
  }

  const intended = truncateQuantity(input.expertQuantity.times(input.allocationFraction));

  if (intended.lte(0)) {
    return { executable: false, rejectReason: 'ALLOCATION_ROUNDED_TO_ZERO' };
  }

  let quantity: Prisma.Decimal;

  if (input.side === 'LONG') {
    const affordable = truncateQuantity(input.cash.dividedBy(price));
    quantity = intended.lt(affordable) ? intended : affordable;

    if (quantity.lte(0)) {
      return { executable: false, rejectReason: 'INSUFFICIENT_COPY_CASH' };
    }
  } else {
    // A SHORT brings the notional in, so the copy pot cannot run dry on it.
    quantity = intended;
  }

  const gross = roundMoney(quantity.times(price));

  if (input.walletUsdt.lt(gross)) {
    return { executable: false, rejectReason: 'INSUFFICIENT_WALLET_BALANCE' };
  }

  return { executable: true, quantity, fillPrice: price, gross };
}

/**
 * Keyset position of a fill, for comparing cursors.
 *
 * The cursor is a pair, and ordering it is not "compare the timestamps": two
 * fills can share `filledAt` (the column is timestamptz(3)), which is exactly
 * why the port tie-breaks on `orderId`. Advancing the cursor therefore needs
 * the same rule, or a later pass could write a cursor that points *before* one
 * it has already consumed.
 *
 * Returns true when `a` is strictly after `b`.
 */
export function isAfter(
  a: { readonly filledAt: Date; readonly orderId: string },
  b: { readonly filledAt: Date | null; orderId: string | null } | null,
): boolean {
  if (b === null || b.filledAt === null || b.orderId === null) {
    return true;
  }

  const delta = a.filledAt.getTime() - b.filledAt.getTime();
  if (delta !== 0) return delta > 0;

  return a.orderId > b.orderId;
}

/**
 * The cursor a new (or re-)follow starts from: "copy from now on".
 *
 * Seeded at the follow instant rather than at the beginning of the expert's
 * history, because the follower was not there for those fills - copying them
 * would build a position out of trades nobody intended to mirror. The rule a
 * reader can rely on is `filled_at`: a fill stamped before the follow is never
 * copied, and the nil order id makes a fill stamped at the same millisecond
 * count as after it.
 */
export function followStartCursor(now: Date): { filledAt: Date; orderId: string } {
  return { filledAt: now, orderId: '00000000-0000-0000-0000-000000000000' };
}
