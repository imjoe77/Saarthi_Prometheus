import { Prisma } from '@prisma/client';

import type { EmberLiquiditySlab } from '../../../config/app.config';

/**
 * EMBER-locking slab resolution (Module 09).
 *
 * The rule is a FLAT CLIFF: a commitment at or above a slab's `minUsdt` (and
 * below the next slab's threshold) requires exactly that slab's `requiredEmber`.
 * Slabs arrive from validated configuration in ascending order - the config
 * parser refuses anything else - and an EMPTY list means "no approved slabs
 * configured yet", which disables commitment mutations rather than guessing.
 *
 * Pure arithmetic over strings and Decimals: no wallet, no database, no clock.
 * That is what makes the central business rule unit-testable against approved
 * thresholds the moment they are signed off.
 */

/** True when approved slabs exist and commitment endpoints may run. */
export function slabsConfigured(slabs: readonly EmberLiquiditySlab[]): boolean {
  return slabs.length > 0;
}

/**
 * Required EMBER lock for a USDT commitment, or null when the commitment sits
 * below the lowest configured slab (no slab covers it, so it cannot qualify).
 *
 * Callers must check {@link slabsConfigured} first: an empty list yielding
 * null here would otherwise read as "below the lowest slab" instead of the
 * configuration error it is.
 */
export function requiredEmberLock(
  slabs: readonly EmberLiquiditySlab[],
  committedUsdt: Prisma.Decimal,
): Prisma.Decimal | null {
  let match: EmberLiquiditySlab | null = null;

  for (const slab of slabs) {
    if (committedUsdt.gte(slab.minUsdt)) {
      match = slab;
    } else {
      break;
    }
  }

  return match ? new Prisma.Decimal(match.requiredEmber) : null;
}

/** What a commitment change does to the EMBER lock. */
export type EmberLockDelta =
  | { readonly direction: 'lock'; readonly amount: Prisma.Decimal }
  | { readonly direction: 'unlock'; readonly amount: Prisma.Decimal }
  | { readonly direction: 'none'; readonly amount: Prisma.Decimal };

/**
 * Difference between the newly required lock and what is already locked.
 *
 * Positive (required grew): lock the difference. Negative (required fell,
 * e.g. after an approved reduction): unlock only the surplus - never more than
 * this commitment actually holds.
 */
export function emberLockDelta(currentlyLocked: Prisma.Decimal, required: Prisma.Decimal): EmberLockDelta {
  const delta = required.sub(currentlyLocked);

  if (delta.isZero()) {
    return { direction: 'none', amount: new Prisma.Decimal(0) };
  }
  if (delta.isPositive()) {
    return { direction: 'lock', amount: delta };
  }
  return { direction: 'unlock', amount: delta.abs() };
}
