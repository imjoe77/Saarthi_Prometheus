import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';

/**
 * MODULE 03 — decimal handling for money.
 *
 * Every financial quantity in Prometheus is a PostgreSQL `NUMERIC(38,18)`,
 * surfaced by Prisma as `Prisma.Decimal`. JavaScript `number` is never accepted
 * here: binary floating point cannot represent 0.1 exactly, so `0.1 + 0.2` is
 * not `0.3`, and a balance built from floats drifts by fractions of a cent that
 * no later reconciliation can explain.
 *
 * Two operations live here, both pure and both unit-tested:
 *  - `normaliseAmount` validates and canonicalises an incoming mutation amount.
 *  - `formatDecimal` renders a stored value as the fixed-point string the API
 *    returns, at the asset's own display precision.
 */

/** The scale of the underlying column. No value may carry more than this. */
const MAX_DECIMALS = 18;

/** Anything the amount rule rejects, in one place so the wording stays uniform. */
function invalidAmount(detail: string): DomainException {
  return new DomainException(
    ERROR_CODES.VALIDATION_FAILED,
    `amount ${detail}.`,
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Validates a mutation amount and returns it as an exact Decimal.
 *
 * Rejected: a blank string, a number, a value that is not a finite decimal
 * (`NaN`, `Infinity`), zero or a negative value, and any value carrying more
 * decimal places than the asset allows. The last rule is what keeps reads
 * lossless: because a balance only ever moves by amounts at the asset's own
 * scale, formatting it back to that scale never rounds.
 *
 * Accepts a string or an already-parsed `Prisma.Decimal`. A `number` is
 * rejected at both the type level and at runtime, because by the time a float
 * reaches here the precision it would have lost is already gone.
 */
export function normaliseAmount(
  amount: string | Prisma.Decimal,
  asset: { symbol: string; decimals: number },
): Prisma.Decimal {
  let value: Prisma.Decimal;

  if (amount instanceof Prisma.Decimal) {
    value = amount;
  } else if (typeof amount === 'string') {
    const trimmed = amount.trim();

    if (trimmed.length === 0) {
      throw invalidAmount('must not be empty');
    }

    try {
      value = new Prisma.Decimal(trimmed);
    } catch {
      throw invalidAmount('must be a decimal number');
    }
  } else {
    // Unreachable through the typed API; a guard for JavaScript callers.
    throw invalidAmount('must be a decimal number');
  }

  if (value.isNaN() || !value.isFinite()) {
    throw invalidAmount('must be a finite decimal number');
  }

  if (value.lte(0)) {
    throw invalidAmount('must be greater than zero');
  }

  const scale = Math.min(asset.decimals, MAX_DECIMALS);

  if (value.decimalPlaces() > scale) {
    throw invalidAmount(
      `cannot carry more than ${scale} decimal places for ${asset.symbol}`,
    );
  }

  return value;
}

/**
 * Renders a stored value as a fixed-point string at the asset's display scale.
 *
 * `toFixed` rather than `toString`: Decimal prints very small or very large
 * magnitudes in exponential form ("1e-18"), which is valid JSON but not a
 * monetary string. Because mutations are validated to the same scale, this
 * never rounds - it only pads.
 */
export function formatDecimal(value: Prisma.Decimal, decimals: number): string {
  const places = Math.min(Math.max(decimals, 0), MAX_DECIMALS);
  return value.toFixed(places);
}
