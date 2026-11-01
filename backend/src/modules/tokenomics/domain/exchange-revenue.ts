import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import type { ExchangeRevenueMode } from '../../../config/app.config';

/**
 * MODULE 08 x MODULE 11 — how much of a settled USDT order the burn/buyback
 * engine is sized against, and what (if anything) that says about revenue.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * A settled BUY moves exactly two things (see `UsdtService.place` and
 * `LiquidityAllocationService.allocateBuy`):
 *
 *   customer wallet   -inrAmount INR      +usdtAmount USDT
 *   LP wallets        +Σ sliceInr INR     -Σ sliceUsdt USDT
 *
 * and the LP credits are built to sum to the customer's debit *to the paisa* —
 * non-final slices floor at a paisa and the final slice absorbs the remainder.
 * The platform's own share of a BUY is therefore **zero**, and three separate
 * places in the codebase already say so out loud: `usdt_orders.savings` is
 * documented as "never cash, revenue or buyback funding", the pricing domain
 * repeats it, and the allocation DTO repeats it a third time. The quote even
 * carries `feesNote: 'fees not included'`.
 *
 * TWO BASES, KEPT APART ON PURPOSE
 * --------------------------------
 * The engine can be sized two ways, and the distinction is the whole content of
 * this file because the two make different claims about the platform's finances.
 *
 *   RETAINED_BPS — revenue basis.
 *     retained = customer INR − LP INR settled
 *     basis    = retained × bps / 10000        (floored to 2dp)
 *
 *   `retained` is a *measured residual*, not a configured number: what the
 *   settlement physically left in the platform after every counterparty was
 *   paid. While the exchange collects no fee it is zero, the basis is zero, and
 *   nothing is queued. The cap is the point — `bps` scales what was retained and
 *   can never exceed it, so customer principal and LP funds are unreachable from
 *   here by construction rather than by convention.
 *
 *   VOLUME_LINKED — turnover basis.
 *     basis    = the order's own INR value     (BUY and SELL alike)
 *     revenue  = 0, always
 *
 *   The traded rupees are a *measure of activity*, and the EMBER the policy
 *   destroys is a quantity derived from that measure at the configured reference
 *   price. Nothing is charged for the privilege: no fee is added to the order,
 *   the customer pays what the quote said, LPs are credited what they were always
 *   credited, and not one rupee changes wallet because of this decision. What
 *   does move is EMBER, out of the treasury's own inventory, under the same
 *   reserve floor as any other burn.
 *
 * So the two columns are never conflated. `revenue_inr` answers "how much did
 * Prometheus earn from this order" and stays zero under a volume policy;
 * `basis_inr` answers "how much was the engine sized against". Reading the
 * second as the first would turn turnover into income, which is the one claim
 * this table is not allowed to make — and a reader years from now can still tell
 * which basis produced a given burn, because both numbers are on the row.
 *
 * Everything in this file is pure: no database, no clock, no configuration
 * reads. A decision depends only on its inputs, so the same settlement always
 * produces the same basis figure however many times it is replayed.
 */

/** INR is a two-decimal currency; a fraction of a paisa is not an amount. */
const INR_SCALE = 2;

/**
 * The closed set of outcomes. Every event row carries exactly one, always,
 * including the ones that allocated nothing — a silent skip is indistinguishable
 * from a bug, and this table is the answer to "why is the number zero?".
 */
export const EXCHANGE_REVENUE_REASON = {
  /** A revenue basis was attributed and the tokenomics pipeline was queued. */
  ATTRIBUTED: 'ATTRIBUTED',
  /**
   * A volume basis was taken from the order and the pipeline was queued.
   * Records that the engine was sized against turnover, which is not the same
   * claim as `ATTRIBUTED` makes and never will be.
   */
  VOLUME_SIZED: 'VOLUME_SIZED',
  /** A SELL under a revenue basis. The BUY revenue rule does not extend to it. */
  SELL_OUT_OF_SCOPE: 'SELL_OUT_OF_SCOPE',
  /**
   * No liquidity providers existed, so the order settled on Module 08's legacy
   * path and the USDT was credited with no LP behind it. Under a *revenue* basis
   * the customer's INR is then unmatched rather than retained, and reading it as
   * income would mint burnable value out of an unbacked mint. A volume basis has
   * no such problem: it never claimed the rupees were the platform's.
   */
  LEGACY_NO_LP_BACKING: 'LEGACY_NO_LP_BACKING',
  /** `TOKENOMICS_EXCHANGE_REVENUE_MODE=NONE` — the shipped default. */
  POLICY_DISABLED: 'POLICY_DISABLED',
  /** `TOKENOMICS_EXCHANGE_REVENUE_BPS=0`. */
  POLICY_RATE_ZERO: 'POLICY_RATE_ZERO',
  /** The settlement left nothing behind. True for every order today. */
  NO_RETAINED_MARGIN: 'NO_RETAINED_MARGIN',
  /** A basis exists but is smaller than one paisa at the policy rate. */
  BELOW_INR_SCALE: 'BELOW_INR_SCALE',
  /** The pipeline completed: allocation, buyback, execution and both burns. */
  PIPELINE_COMPLETED: 'PIPELINE_COMPLETED',
  /** Module 12's reserve guard refused the burn. Retryable; never bypassed. */
  TREASURY_RESERVE_FLOOR: 'TREASURY_RESERVE_FLOOR',
  /** The treasury cannot cover the burn at all. Retryable; never bypassed. */
  TREASURY_INSUFFICIENT_BALANCE: 'TREASURY_INSUFFICIENT_BALANCE',
  /** A non-guardrail failure, waiting for its backoff to elapse. */
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  /** A non-guardrail failure outlived the event's retry budget. */
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  /**
   * The revenue policy itself threw. Recorded as ineligible rather than
   * propagated: a bug in this module must not be able to take the exchange
   * down, and the safe direction for an unexplained order is to burn nothing.
   */
  POLICY_ERROR: 'POLICY_ERROR',
} as const;

export type ExchangeRevenueReasonCode = (typeof EXCHANGE_REVENUE_REASON)[keyof typeof EXCHANGE_REVENUE_REASON];

export interface ExchangeRevenuePolicy {
  readonly mode: ExchangeRevenueMode;
  readonly bps: number;
}

/** What a settlement actually did, read from the rows it just wrote. */
export interface SettledExchangeOrder {
  readonly side: 'BUY' | 'SELL';
  readonly customerInr: Prisma.Decimal;
  readonly lpInrSettled: Prisma.Decimal;
  /** False when Module 09 had no providers and returned `legacy: true`. */
  readonly lpBacked: boolean;
}

export interface ExchangeRevenueDecision {
  readonly eligible: boolean;
  /**
   * INR this settlement made Prometheus, exact at 2dp. Zero whenever `eligible`
   * is false, and zero *always* under a volume basis — a traded amount is not
   * income no matter how large it is.
   */
  readonly revenueInr: Prisma.Decimal;
  /**
   * INR the engine is sized against, which is what the allocation's reference
   * amount is built from. Equal to `revenueInr` under `RETAINED_BPS`, equal to
   * the order's own INR value under `VOLUME_LINKED`, zero when nothing is queued.
   */
  readonly basisInr: Prisma.Decimal;
  /** What the settlement left after LP credits, floored at zero, exact at 2dp. */
  readonly retainedInr: Prisma.Decimal;
  readonly reasonCode: ExchangeRevenueReasonCode;
  readonly detail: string;
}

/**
 * The one decision this module makes.
 *
 * The mode is read before anything about the order, because the two bases ask
 * different questions of the same settlement: a revenue basis wants to know who
 * was paid and what was left, a volume basis only wants to know how much traded.
 * Within the revenue path the guards then run in order of "least surprising
 * reason" — what the order *was* is answered before what the configuration
 * *says*, because an operator turning a knob should not be able to rewrite the
 * explanation of an order that was never in scope.
 */
export function decideExchangeRevenue(
  policy: ExchangeRevenuePolicy,
  order: SettledExchangeOrder,
): ExchangeRevenueDecision {
  const retainedInr = retainedAfter(order);

  if (policy.mode === 'VOLUME_LINKED') {
    return decideVolumeLinked(order, retainedInr);
  }

  if (order.side !== 'BUY') {
    return skip('SELL_OUT_OF_SCOPE', 'A SELL order returns INR to the customer; no BUY revenue rule covers it.', retainedInr);
  }

  if (!order.lpBacked) {
    return skip(
      'LEGACY_NO_LP_BACKING',
      'The order settled with no liquidity providers, so its INR is unmatched rather than retained.',
      retainedInr,
    );
  }

  if (policy.mode === 'NONE') {
    return skip('POLICY_DISABLED', 'Exchange-to-tokenomics revenue is disabled by configuration.', retainedInr);
  }

  if (policy.bps <= 0) {
    return skip('POLICY_RATE_ZERO', 'The configured revenue rate is zero basis points.', retainedInr);
  }

  if (retainedInr.lte(zero)) {
    return skip(
      'NO_RETAINED_MARGIN',
      'The settlement credited the customer\'s entire INR to liquidity providers, so nothing was retained.',
      retainedInr,
    );
  }

  const revenue = retainedInr.times(policy.bps).div(10_000).toDecimalPlaces(INR_SCALE, Prisma.Decimal.ROUND_FLOOR);

  if (revenue.lte(zero)) {
    return skip(
      'BELOW_INR_SCALE',
      `The retained margin at ${policy.bps} bps is smaller than one paisa, so no allocation was recorded.`,
      retainedInr,
    );
  }

  return {
    eligible: true,
    revenueInr: revenue,
    basisInr: revenue,
    retainedInr,
    reasonCode: 'ATTRIBUTED',
    detail: `${policy.bps} bps of ${retainedInr.toFixed()} INR retained after LP credits.`,
  };
}

/**
 * Volume-linked sizing: the order's INR value is the basis, and the revenue
 * claim is zero.
 *
 * Both sides qualify, which the revenue path deliberately does not: a SELL is
 * just as much turnover as a BUY, and a metric of activity does not care which
 * direction it moved. Nor does this path ask whether LPs backed the order —
 * under a revenue basis an unbacked order's INR cannot be read as margin, but a
 * volume basis never read it as the platform's in the first place.
 */
function decideVolumeLinked(
  order: SettledExchangeOrder,
  retainedInr: Prisma.Decimal,
): ExchangeRevenueDecision {
  const basis = order.customerInr.toDecimalPlaces(INR_SCALE, Prisma.Decimal.ROUND_FLOOR);

  if (basis.lte(zero)) {
    return skip(
      'BELOW_INR_SCALE',
      'The order settled for less than one paisa of INR, so there is no volume to size against.',
      retainedInr,
    );
  }

  return {
    eligible: true,
    revenueInr: zero,
    basisInr: basis,
    retainedInr,
    reasonCode: 'VOLUME_SIZED',
    detail: `${order.side} of ${basis.toFixed()} INR sized the engine; no revenue claimed, the EMBER comes from the treasury.`,
  };
}

/**
 * What the settlement left after every counterparty was paid.
 *
 * Floored at zero: LP credits are built to sum to the customer's debit, and a
 * negative residual would mean the settlement over-paid the providers. That is
 * a bug in the other module, and it is not this one's business to propagate it
 * as negative revenue.
 *
 * An order with no LPs behind it has no residual either. Its `lp_inr_settled`
 * is zero because there was nobody to pay, not because the platform kept the
 * rupees, so the subtraction would report customer principal as retained margin
 * — the exact number a revenue basis then turns into a burn.
 */
function retainedAfter(order: SettledExchangeOrder): Prisma.Decimal {
  if (!order.lpBacked) return zero;

  const retained = order.customerInr.minus(order.lpInrSettled);

  return (retained.gt(zero) ? retained : zero).toDecimalPlaces(INR_SCALE, Prisma.Decimal.ROUND_FLOOR);
}

const zero = new Prisma.Decimal(0);

function skip(
  reasonCode: ExchangeRevenueReasonCode,
  detail: string,
  retainedInr: Prisma.Decimal,
): ExchangeRevenueDecision {
  return {
    eligible: false,
    revenueInr: zero,
    basisInr: zero,
    retainedInr,
    reasonCode,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Deterministic idempotency keys
// ---------------------------------------------------------------------------

/**
 * RFC 4122 v5 (SHA-1) name-based UUID.
 *
 * The tokenomics tables are all keyed on `(user_id, client_request_id)`, so a
 * key derived from the *order* rather than generated per attempt is what makes
 * the whole pipeline replay-safe: a worker that crashes after the allocation
 * committed and runs again sends the identical key, gets the identical row back,
 * and continues from there instead of proposing a second allocation.
 */
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export function deterministicUuid(name: string): string {
  const hash = createHash('sha1').update(Buffer.from(URL_NAMESPACE.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The four keys one order can ever produce. Namespaced by purpose because the
 * allocation, buyback and two burns each carry their own unique constraint, and
 * reusing one string across them would make two different records look like
 * replays of each other.
 */
export const exchangeRevenueKeys = {
  allocation: (orderId: string): string => deterministicUuid(`tokenomics/allocation/${orderId}`),
  buyback: (orderId: string): string => deterministicUuid(`tokenomics/buyback/${orderId}`),
  directBurn: (orderId: string): string => deterministicUuid(`tokenomics/burn/direct/${orderId}`),
  buybackBurn: (orderId: string): string => deterministicUuid(`tokenomics/burn/buyback/${orderId}`),
} as const;

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

/**
 * Backoff in milliseconds, indexed by attempts already made and clamped at the
 * last entry. A blocked burn is not an error — the treasury may be funded hours
 * later — so the tail is long and flat rather than a fast give-up.
 */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000] as const;

export function nextAttemptDelayMs(attemptsMade: number): number {
  const index = Math.max(0, attemptsMade - 1);
  return BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)]!;
}
