import { Prisma } from '@prisma/client';

import { USDT_DECIMALS } from '../usdt/domain/usdt-pricing';

/**
 * MODULE 12 - the approved treasury guardrail policy as pure functions.
 *
 * RESERVE RULE (owner-approved): the protected floor is 30% of the cumulative
 * qualifying EMBER funding credited to the platform treasury. Qualifying
 * funding is counted from authoritative ledger records - `DEPOSIT` legs on
 * the treasury wallet - never from balances, never hardcoded, and never from
 * internal transfers: `TRANSFER_IN`/`ADJUSTMENT` carry no qualifying
 * classification (Module 03 documents them as distinct from deposit/
 * withdrawal), so they are excluded. Burns destroy EMBER but never reduce
 * the historical funding basis. Simulated buybacks and allocations record
 * nothing that could count as funding.
 *
 * A zero or missing basis is handled safely, not fabricated: 30% of zero is
 * zero, so an unfunded treasury has a zero floor and its own emptiness is
 * what refuses burns (`INSUFFICIENT_BALANCE`, evaluated first - see the
 * guard).
 *
 * PRECISION: decimal.js (and therefore `Prisma.Decimal`) rounds at 20
 * significant digits, fewer than an 18dp ledger quantity plus its integer
 * digits needs. All policy arithmetic runs on a 60-significant-digit clone,
 * the same technique Module 11's `allocation-math.ts` uses, and results are
 * wrapped back into `Prisma.Decimal` only where exact - no JavaScript
 * `number` ever touches a monetary value here.
 *
 * CAPACITY CONVERSION (owner-approved, display-only): the demo monthly
 * capacity is configured in INR (`TREASURY_MONTHLY_CAPACITY_INR`, default
 * ₹30 crore) and converted to USDT for display at the already-configured
 * `USDT_FALLBACK_PRICE_INR` - an existing, centrally configured, explicitly
 * display-approved rate. No rate is ever invented: when the configured rate
 * is missing, the conversion reports unavailable instead of guessing.
 * Capacity tracking stays reporting-only; nothing here blocks spending.
 */

/** The approved protected-floor percentage (master plan, Module 12). */
export const RESERVE_FLOOR_PERCENT = 30;

/** The owner-approved floor base, reported verbatim by the summary API. */
export const RESERVE_FLOOR_BASE = 'QUALIFYING_TREASURY_FUNDING';

/** Honest, user-facing statement of the approved policy. */
export const RESERVE_NOTE =
  'Prototype/demo policy: the protected floor is 30% of cumulative qualifying EMBER funding credited to the platform treasury (DEPOSIT ledger legs). Module 11 rejects a burn, inside its transaction, when it would take available EMBER below the floor; funding is never blocked.';

/** Honest, user-facing statement of the capacity contract. */
export const CAPACITY_NOTE =
  'Prototype/demo monthly capacity (approved at ₹30 crore), reported for visibility only: no treasury USDT spending operation exists that enforces it, and this API never blocks an operation.';

/** Reserve health, relative to the computed floor. */
export type TreasuryReserveStatus = 'UNPROVISIONED' | 'OK' | 'AT_FLOOR' | 'BELOW_FLOOR';

/** USDT capacity state for the tracked month. */
export type TreasuryCapacityExhaustion = 'AVAILABLE' | 'EXHAUSTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

/** Where the INR->USDT display conversion got its rate, or why it could not. */
export interface CapacityConversion {
  source: 'USDT_FALLBACK_PRICE_INR';
  priceInr: string | null;
  reason: 'CONVERSION_RATE_UNAVAILABLE' | null;
}

/**
 * A Decimal constructor with arithmetic precision lifted to 60 significant
 * digits. Scoped via `clone` so the process-wide Decimal configuration every
 * other module relies on is untouched (allocation-math's pattern).
 */
const PolicyDecimal = Prisma.Decimal.clone({ precision: 60 });

/** Re-wraps an exact policy computation as a `Prisma.Decimal`. */
function exact(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/**
 * The protected floor: 30% of the cumulative qualifying funding basis.
 *
 * Exact within ledger scale: the product and the division by 100 terminate,
 * so the 60-digit clone never rounds a real `NUMERIC(38,18)` input.
 */
export function reserveFloor(fundingBasis: Prisma.Decimal): Prisma.Decimal {
  return exact(new PolicyDecimal(fundingBasis.toString()).times(RESERVE_FLOOR_PERCENT).div(100));
}

/** `available - amount`, exact within ledger scale (60-digit subtraction). */
export function projectedBalance(available: Prisma.Decimal, amount: Prisma.Decimal): Prisma.Decimal {
  return exact(new PolicyDecimal(available.toString()).minus(amount.toString()));
}

/** Balance above the floor, clamped at zero - what a discretionary burn may use. */
export function discretionaryCapacity(
  available: Prisma.Decimal,
  floor: Prisma.Decimal,
): Prisma.Decimal {
  const above = new PolicyDecimal(available.toString()).minus(floor.toString());
  return above.isNegative() ? new Prisma.Decimal(0) : exact(above);
}

/** Reserve health from exact Decimals: strictly above, exactly at, or below. */
export function reserveStatus(available: Prisma.Decimal, floor: Prisma.Decimal): TreasuryReserveStatus {
  if (available.gt(floor)) return 'OK';
  if (available.eq(floor)) return 'AT_FLOOR';
  return 'BELOW_FLOOR';
}

/**
 * Converts the approved INR capacity to a USDT display figure at the
 * configured display rate, floored to USDT's 6dp - a capacity ceiling is
 * never rounded up into extra headroom. A missing (or non-positive, which
 * configuration forbids) rate yields an unavailable conversion, never an
 * invented one.
 */
export function convertCapacityInrToUsdt(
  capacityInr: Prisma.Decimal,
  priceInr: string | null,
): { capacityUsdt: string | null; conversion: CapacityConversion } {
  const conversion: CapacityConversion = {
    source: 'USDT_FALLBACK_PRICE_INR',
    priceInr,
    reason: null,
  };

  if (priceInr === null || new PolicyDecimal(priceInr).lte(0)) {
    conversion.reason = 'CONVERSION_RATE_UNAVAILABLE';
    return { capacityUsdt: null, conversion };
  }

  const usdt = new PolicyDecimal(capacityInr.toString()).div(new PolicyDecimal(priceInr));
  return {
    capacityUsdt: usdt.toDecimalPlaces(USDT_DECIMALS, Prisma.Decimal.ROUND_FLOOR).toString(),
    conversion,
  };
}

/** Remaining capacity (clamped at zero) and exhaustion, in USDT units. */
export function monthCapacityLeft(
  capacityUsdt: string,
  utilization: string,
): { remaining: string; exhaustion: 'AVAILABLE' | 'EXHAUSTED' } {
  const cap = new PolicyDecimal(capacityUsdt);
  const used = new PolicyDecimal(utilization);
  const left = cap.minus(used);
  return {
    remaining: (left.isNegative() ? new PolicyDecimal(0) : left).toString(),
    exhaustion: used.gte(cap) ? 'EXHAUSTED' : 'AVAILABLE',
  };
}
