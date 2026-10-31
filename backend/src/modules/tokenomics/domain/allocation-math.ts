import { Prisma } from '@prisma/client';

import { DomainException } from '../../../common/errors/domain.exception';
import { normaliseAmount } from '../../wallet/decimal.util';

/**
 * MODULE 11 — pure allocation arithmetic.
 *
 * Every figure Module 11 records is computed here, from decimal strings only.
 * The functions are pure and database-free so the rounding policy can be
 * unit-tested directly against worked examples.
 *
 * ROUNDING POLICY, stated once and tested in `allocation-math.spec.ts`:
 *
 *  1. INPUTS are validated, never rounded. A reference amount beyond INR's
 *     2dp, a zero or negative amount, or a zero/negative price is REFUSED
 *     (via Module 03's `normaliseAmount`) - the same posture as every other
 *     mutation in the codebase. What arrives is what is computed against.
 *
 *  2. THE INR SPLIT: the direct-burn portion is `amount x pct / 100` rounded
 *     HALF_UP to INR's 2dp (the money-rounding convention `usdt-pricing.ts`
 *     and the simulation engine already use), and the buyback portion is the
 *     EXACT remainder `amount - direct`. Taking the remainder rather than
 *     rounding twice is what makes the sum invariant exact: the two portions
 *     always add up to the reference amount to the paisa, with no drift.
 *
 *  3. EMBER QUANTITIES are `portion / price` floored (ROUND_DOWN) to 18dp -
 *     the quantity convention the simulation engine and copy sizing already
 *     follow. Flooring guarantees a quantity never exceeds what its portion
 *     funds at that price; the two floors are independent, so their sum is
 *     never larger than the floor of the combined amount.
 *
 *  4. DIVISION runs on a 60-significant-digit clone of the Decimal type.
 *     decimal.js defaults to 20 significant digits, which is fewer than an
 *     18dp quantity plus its integer digits needs: flooring a quotient that
 *     was already rounded at the 20th digit could claim a ten-quadrillionth
 *     more EMBER than the portion actually funds.
 *
 * No JavaScript `number` touches a monetary value at any point: percentages
 * are the only numbers here, and they are validated integers.
 */

/** INR display and storage scale for money. */
export const INR_DECIMALS = 2;

/** EMBER ledger scale: NUMERIC(38,18). */
export const EMBER_DECIMALS = 18;

/**
 * A Decimal constructor with division precision lifted to 60 significant
 * digits. Scoped via `clone` so the process-wide Decimal configuration every
 * other module relies on is untouched.
 */
const MathDecimal = Prisma.Decimal.clone({ precision: 60 });

/** The configured split plus one computed allocation, all as exact Decimals. */
export interface AllocationComputation {
  readonly referenceAmount: Prisma.Decimal;
  readonly emberPrice: Prisma.Decimal;
  readonly directBurnPct: number;
  readonly buybackPct: number;
  readonly directBurnInr: Prisma.Decimal;
  readonly buybackInr: Prisma.Decimal;
  readonly directBurnEmber: Prisma.Decimal;
  readonly buybackEmber: Prisma.Decimal;
}

/**
 * Validates a reference amount: positive, at most INR's 2dp, never a float.
 *
 * `symbol: 'INR'` makes `normaliseAmount` enforce the INR asset's scale, so
 * the refusal message a caller sees names the currency they sent.
 */
export function parseReferenceAmount(value: string | Prisma.Decimal): Prisma.Decimal {
  return normaliseAmount(value, { symbol: 'INR', decimals: INR_DECIMALS });
}

/**
 * Validates an illustrative EMBER price: positive, up to 18dp.
 *
 * A price is a ratio (INR per EMBER), not a rupee amount, so it is not
 * constrained to 2dp - a fraction of a paisa per token is a legitimate price
 * to model.
 */
export function parseEmberPrice(value: string | Prisma.Decimal): Prisma.Decimal {
  return normaliseAmount(value, { symbol: 'INR per EMBER', decimals: EMBER_DECIMALS });
}

/** Validates an EMBER amount at full ledger scale (positive, <= 18dp). */
export function parseEmberAmount(value: string | Prisma.Decimal): Prisma.Decimal {
  return normaliseAmount(value, { symbol: 'EMBER', decimals: EMBER_DECIMALS });
}

/**
 * Splits a reference amount across the allocation percentages.
 *
 * Refuses percentages that are not non-negative integers summing to 100 -
 * configuration already guarantees this (it is boot-validated), so a failure
 * here means a caller passed something the config layer never saw, and
 * silently losing or inventing part of the reference amount is not an option.
 */
export function splitReferenceAmount(
  referenceAmount: Prisma.Decimal,
  directBurnPct: number,
  buybackPct: number,
): { directBurnInr: Prisma.Decimal; buybackInr: Prisma.Decimal } {
  const valid = (pct: number): boolean => Number.isInteger(pct) && pct >= 0 && pct <= 100;
  if (!valid(directBurnPct) || !valid(buybackPct) || directBurnPct + buybackPct !== 100) {
    throw DomainException.badRequest(
      'Allocation percentages must be non-negative integers summing to 100.',
    );
  }

  const direct = new MathDecimal(referenceAmount.toString())
    .times(directBurnPct)
    .div(100)
    .toDecimalPlaces(INR_DECIMALS, Prisma.Decimal.ROUND_HALF_UP);
  const buyback = new MathDecimal(referenceAmount.toString()).minus(direct);

  return {
    directBurnInr: new Prisma.Decimal(direct.toFixed(INR_DECIMALS)),
    buybackInr: new Prisma.Decimal(buyback.toFixed(INR_DECIMALS)),
  };
}

/**
 * How much EMBER an INR portion buys at `emberPrice`, floored to 18dp.
 *
 * The floor is the policy from rule 3: a quantity is always affordable at
 * the stated price, never a rounding artefact of what it could not afford.
 */
export function emberQuantity(portionInr: Prisma.Decimal, emberPrice: Prisma.Decimal): Prisma.Decimal {
  const quotient = new MathDecimal(portionInr.toString()).div(
    new MathDecimal(emberPrice.toString()),
  );
  return new Prisma.Decimal(quotient.toFixed(EMBER_DECIMALS, Prisma.Decimal.ROUND_DOWN));
}

/**
 * Validates both inputs and computes a full allocation - the single path the
 * preview endpoint and `POST /tokenomics/allocations` share, so a preview can
 * never disagree with the record it would create.
 */
export function computeAllocation(
  referenceAmountRaw: string | Prisma.Decimal,
  emberPriceRaw: string | Prisma.Decimal,
  directBurnPct: number,
  buybackPct: number,
): AllocationComputation {
  const referenceAmount = parseReferenceAmount(referenceAmountRaw);
  const emberPrice = parseEmberPrice(emberPriceRaw);
  const split = splitReferenceAmount(referenceAmount, directBurnPct, buybackPct);

  return {
    referenceAmount,
    emberPrice,
    directBurnPct,
    buybackPct,
    directBurnInr: split.directBurnInr,
    buybackInr: split.buybackInr,
    directBurnEmber: emberQuantity(split.directBurnInr, emberPrice),
    buybackEmber: emberQuantity(split.buybackInr, emberPrice),
  };
}
