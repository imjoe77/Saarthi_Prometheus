import { Prisma } from '@prisma/client';

/**
 * MODULE 14 - the whole financial comparison Sentinel exists for, as a pure
 * function.
 *
 * EXACT DECIMALS, NEVER FLOATS. Prices arrive as Prisma.Decimal or the
 * canonical decimal strings the API and the market data carry; floats are not
 * accepted, because binary floating point cannot represent decimal currency
 * and `0.1 + 0.2 !== 0.3` would make threshold equality unpredictable. The
 * comparison is `Decimal.gte` / `Decimal.lte`, so a target of `85.20` is met
 * by an observed `85.2` exactly as it is met by `85.20`.
 *
 * THE THRESHOLD IS AN ALERT RULE, NOT AN EXECUTION PRICE. Returning `true`
 * says only "the target condition held for this observed value"; what Sentinel
 * does next is decided by the caller (trigger row, call job, or nothing).
 */
export type TriggerCondition = 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';

/**
 * Whether `observedPrice` satisfies `condition` against `targetPrice`.
 *
 * Both prices must be `Prisma.Decimal` values or canonical decimal strings;
 * anything else is a caller bug and throws rather than silently comparing.
 */
export function evaluateThreshold(
  condition: TriggerCondition,
  targetPrice: Prisma.Decimal | string,
  observedPrice: Prisma.Decimal | string,
): boolean {
  const target = new Prisma.Decimal(targetPrice as Prisma.Decimal.Value);
  const observed = new Prisma.Decimal(observedPrice as Prisma.Decimal.Value);

  if (condition === 'GREATER_THAN_OR_EQUAL') {
    return observed.greaterThanOrEqualTo(target);
  }

  return observed.lessThanOrEqualTo(target);
}
