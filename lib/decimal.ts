/**
 * MODULE 03 — decimal-safe string arithmetic for the wallet UI.
 *
 * The API returns every monetary value as a fixed-point string precisely so the
 * browser never has to hold it in a `number`. This is the only place the UI adds
 * two of them, and it keeps that promise: the values are scaled to a common
 * number of places and summed as `BigInt`, with no `parseFloat` anywhere.
 *
 * `BigInt(0)` rather than `0n` because the project targets ES2017, where the
 * literal syntax is unavailable.
 */

function countDecimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function parseScaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = digits.split(".");
  const combined = `${whole}${fraction.padEnd(scale, "0")}` || "0";
  const magnitude = BigInt(combined);

  return negative ? -magnitude : magnitude;
}

function formatScaled(value: bigint, scale: number): string {
  const zero = BigInt(0);
  const negative = value < zero;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const splitAt = digits.length - scale;
  const whole = digits.slice(0, splitAt) || "0";
  const fraction = scale > 0 ? digits.slice(splitAt) : "";

  return `${negative ? "-" : ""}${whole}${scale > 0 ? `.${fraction}` : ""}`;
}

/** Adds two non-negative or negative decimal strings, preserving scale. */
export function addDecimalStrings(left: string, right: string): string {
  const scale = Math.max(countDecimalPlaces(left), countDecimalPlaces(right));

  return formatScaled(parseScaled(left, scale) + parseScaled(right, scale), scale);
}

/**
 * Multiplies two decimal strings exactly.
 *
 * Used only for display valuation — turning a token balance and a quoted price
 * into an indicative INR figure. The product's scale is the sum of the inputs'
 * scales, so `600000 x 88.42` stays an exact string rather than a float that
 * happens to print correctly.
 */
export function multiplyDecimalStrings(left: string, right: string): string {
  const leftScale = countDecimalPlaces(left);
  const rightScale = countDecimalPlaces(right);

  return formatScaled(
    parseScaled(left, leftScale) * parseScaled(right, rightScale),
    leftScale + rightScale,
  );
}

/**
 * Compares two decimal strings exactly.
 *
 * Returns a negative number, zero or a positive number as `left` is less than,
 * equal to or greater than `right`. Exact, like every other helper here, so a
 * limit check never turns on a float's last bit.
 */
export function compareDecimalStrings(left: string, right: string): number {
  const scale = Math.max(countDecimalPlaces(left), countDecimalPlaces(right));
  const leftValue = parseScaled(left, scale);
  const rightValue = parseScaled(right, scale);

  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;

  return 0;
}

/**
 * Rounds a decimal string to `places` decimals, HALF_UP — the same rule the
 * backend applies to paise settlement.
 *
 * The input is scaled to one extra place so the digit being dropped decides the
 * rounding, and the `bigint` division truncates toward zero exactly as HALF_UP
 * needs once the tie has been resolved by adding half a unit.
 */
export function roundDecimalString(value: string, places: number): string {
  const scale = countDecimalPlaces(value);

  if (scale <= places) {
    return formatScaled(parseScaled(value, places), places);
  }

  const scaled = parseScaled(value, scale);
  const divisor = BigInt(10) ** BigInt(scale - places);
  const negative = scaled < BigInt(0);
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude + divisor / BigInt(2)) / divisor;

  return formatScaled(negative ? -rounded : rounded, places);
}
