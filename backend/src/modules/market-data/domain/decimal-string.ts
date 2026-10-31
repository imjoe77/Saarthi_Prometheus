import type { Prisma } from '@prisma/client';

/**
 * MODULE 06b - render a `Decimal` as the shortest string that is exactly it.
 *
 * WHY NOT `toString()`. `Decimal` prints very small and very large magnitudes
 * in exponential form (`1e-9`), which is a valid decimal but not what anybody
 * expects to read in a JSON payload, and the moment a fee rate or a dust balance
 * drifts below the exponential threshold the API's shape would silently change.
 *
 * WHY NOT `toFixed(18)`. It never goes exponential, but it pads every value to
 * the column's scale, so a price of `94591.78` would arrive as
 * `94591.780000000000000000` - eighteen places of noise that a reader has to
 * learn to ignore, repeated on every row of every page.
 *
 * `toFixed(decimalPlaces())` is both: `decimalPlaces()` reports the places the
 * *value* actually has (trailing zeros are not part of it), and `toFixed` always
 * renders fixed-point. The result is lossless - it carries every digit that
 * exists and no digit that does not - and stable, because it depends only on the
 * value and never on its magnitude.
 */
export function decimalString(value: Prisma.Decimal): string {
  return value.toFixed(value.decimalPlaces());
}
