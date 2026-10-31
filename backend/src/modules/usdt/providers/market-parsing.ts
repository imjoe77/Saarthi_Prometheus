import { Prisma } from '@prisma/client';

import { UsdtProviderError } from './usdt-pricing.types';

/**
 * MODULE 08 extension — strict parsers for CoinDCX and CoinGecko payloads.
 *
 * Everything a provider response claims is converted here or rejected here:
 * prices must be finite positive decimals, timestamps must be epoch times in a
 * plausible range, and shapes must match what was verified live. A malformed
 * payload throws {@link UsdtProviderError} rather than degrading into a number
 * that would quietly price an order - stale or broken data must never look
 * live. All monetary values stay as canonical decimal strings until the
 * service layer, where Decimal arithmetic begins.
 */

const MAX_BOOK_LEVELS = 100;

/** Validates a positive, finite decimal field and returns its canonical string. */
export function toPositiveDecimalString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new UsdtProviderError(source, `${field} must be a decimal string or number`);
  }

  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(String(value));
  } catch {
    throw new UsdtProviderError(source, `${field} is not a valid decimal`);
  }

  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new UsdtProviderError(source, `${field} must be a positive finite price`);
  }

  return parsed.toString();
}

/** Validates an optional positive decimal, returning null when absent. */
export function toOptionalPositiveDecimalString(
  value: unknown,
  field: string,
  source: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  return toPositiveDecimalString(value, field, source);
}

/**
 * Converts a provider timestamp to epoch milliseconds.
 *
 * CoinDCX's order book reports milliseconds while its ticker reports seconds,
 * and CoinGecko reports Unix seconds or ISO strings depending on the endpoint
 * - so the unit is inferred from magnitude and every form is normalised to
 * milliseconds exactly once, here.
 */
export function toEpochMs(value: unknown, field: string, source: string): number {
  let millis: number;

  if (typeof value === 'number' && Number.isFinite(value)) {
    millis = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      millis = numeric < 1e12 ? numeric * 1000 : numeric;
    } else {
      const parsedDate = Date.parse(value);
      if (Number.isNaN(parsedDate)) {
        throw new UsdtProviderError(source, `${field} is not a valid timestamp`);
      }
      millis = parsedDate;
    }
  } else {
    throw new UsdtProviderError(source, `${field} is missing or not a timestamp`);
  }

  // A timestamp before 2001 or beyond a day in the future cannot describe the
  // market right now; letting either through would defeat the freshness rules.
  const minMs = Date.UTC(2001, 0, 1);
  const maxMs = Date.now() + 24 * 60 * 60 * 1000;
  if (millis < minMs || millis > maxMs) {
    throw new UsdtProviderError(source, `${field} is outside a plausible time range`);
  }

  return millis;
}

/** Converts an optional timestamp; null when absent or unparseable. */
export function toOptionalEpochMs(value: unknown, field: string, source: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return toEpochMs(value, field, source);
  } catch {
    return null;
  }
}

/** One side of a CoinDCX order book, as a sorted list of levels. */
export function parseCoindcxBookSide(
  raw: unknown,
  side: 'asks' | 'bids',
  source: string,
): Array<{ price: string; quantity: string }> {
  const levels: Array<{ price: string; quantity: string }> = [];

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [priceRaw, quantityRaw] of Object.entries(raw as Record<string, unknown>)) {
      levels.push({
        price: toPositiveDecimalString(priceRaw, `${side} price`, source),
        quantity: toPositiveDecimalString(quantityRaw, `${side} quantity`, source),
      });
    }
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      // Accept ["99.9", "10.5"] and { price, quantity } shapes.
      if (Array.isArray(entry) && entry.length >= 2) {
        levels.push({
          price: toPositiveDecimalString(entry[0], `${side} price`, source),
          quantity: toPositiveDecimalString(entry[1], `${side} quantity`, source),
        });
      } else if (entry !== null && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        levels.push({
          price: toPositiveDecimalString(record['price'], `${side} price`, source),
          quantity: toPositiveDecimalString(record['quantity'], `${side} quantity`, source),
        });
      } else {
        throw new UsdtProviderError(source, `${side} contains an unrecognised level shape`);
      }
    }
  } else {
    throw new UsdtProviderError(source, `${side} must be an object or an array`);
  }

  const sorted = levels.sort((a, b) =>
    side === 'asks'
      ? new Prisma.Decimal(a.price).cmp(new Prisma.Decimal(b.price))
      : new Prisma.Decimal(b.price).cmp(new Prisma.Decimal(a.price)),
  );

  return sorted.slice(0, MAX_BOOK_LEVELS);
}
