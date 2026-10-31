import { Prisma } from '@prisma/client';

import { fatalIssue, warningIssue, type ValidationIssue } from './validation';

/**
 * MODULE 06b - one Binance Spot `1d` kline row, parsed and checked.
 *
 * THE FORMAT IS FROZEN BY THE DATA, NOT BY A DOCUMENT. `data/market/raw` holds
 * 81 CSVs with no header and twelve comma-separated fields; the importer reads
 * them exactly as the source emits them, and every assumption made here was
 * verified against the whole dataset before this parser was written:
 *
 *   [0]  open time, Unix microseconds, 16 digits, always UTC midnight
 *   [1]  open        [2] high       [3] low        [4] close
 *   [5]  base volume
 *   [6]  close time, microseconds, always open + 86,399,999,999
 *   [7]  quote volume
 *   [8]  trade count
 *   [9]  taker-buy base volume   [10] taker-buy quote volume
 *   [11] always `0`
 *
 * WHY MICROSECONDS AND NOT MILLISECONDS. Binance changed the unit in 2021 and
 * emits 16-digit microsecond values in current archives. Parsing them as
 * milliseconds would land in 1970; parsing them as BigInt and dividing is the
 * only conversion that cannot lose the sub-millisecond remainder silently. The
 * `% 1000n === 0n` check is therefore not pedantry: it is what proves the
 * remainder really is zero rather than hoping it is.
 *
 * FATAL vs WARNING, stated as a rule. A finding is fatal when it changes what
 * would be stored - a row that cannot be attributed to a day, an OHLC that is
 * internally impossible, a price that is not a number. It is a warning when the
 * value is stored as parsed and only the source's bookkeeping is off: a
 * surprising close-time stamp, a nonzero ignore field, more decimal places than
 * the eight the engine truncates to. The dataset produces zero findings of
 * either kind; the checks exist so that a *different* dataset says so instead of
 * quietly importing.
 */
const FIELD_COUNT = 12;
const MICROSECONDS_PER_MILLISECOND = 1000n;
const MICROSECONDS_PER_DAY = 86_400_000_000n;
const EXPECTED_CLOSE_TIME_DELTA = 86_399_999_999n;
const DISPLAY_DECIMAL_PLACES = 8;
const SIXTEEN_DIGITS = /^\d{16}$/;
const UNSIGNED_INTEGER = /^\d+$/;
const DECIMAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

export interface KlineCandle {
  /** UTC calendar day derived from the open timestamp. */
  readonly day: string;
  readonly open: Prisma.Decimal;
  readonly high: Prisma.Decimal;
  readonly low: Prisma.Decimal;
  readonly close: Prisma.Decimal;
  readonly volume: Prisma.Decimal;
  readonly quoteVolume: Prisma.Decimal;
}

export type KlineParseResult =
  | { readonly ok: true; readonly candle: KlineCandle; readonly warnings: readonly ValidationIssue[] }
  | { readonly ok: false; readonly issue: ValidationIssue };

function parseNumber(raw: string): Prisma.Decimal | null {
  if (!DECIMAL.test(raw)) {
    return null;
  }
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(raw);
  } catch {
    return null;
  }
  return value.isFinite() ? value : null;
}

function hasMoreThanEightPlaces(raw: string): boolean {
  const dot = raw.indexOf('.');
  return dot >= 0 && raw.length - dot - 1 > DISPLAY_DECIMAL_PLACES;
}

function parseOpenTimestamp(
  raw: string,
  source: string,
  line: number,
): { readonly day: string } | { readonly issue: ValidationIssue } {
  if (!SIXTEEN_DIGITS.test(raw)) {
    return {
      issue: fatalIssue(
        'KLINE_OPEN_TIME_FORMAT',
        source,
        line,
        `field 0 must be a 16-digit Unix microsecond timestamp, got '${raw}'`,
      ),
    };
  }

  const microseconds = BigInt(raw);
  if (microseconds % MICROSECONDS_PER_MILLISECOND !== 0n) {
    return {
      issue: fatalIssue(
        'KLINE_OPEN_TIME_NOT_MILLISECOND',
        source,
        line,
        `field 0 (${raw}) is not a whole number of milliseconds`,
      ),
    };
  }

  const milliseconds = microseconds / MICROSECONDS_PER_MILLISECOND;
  const asNumber = Number(milliseconds);
  if (!Number.isSafeInteger(asNumber)) {
    return {
      issue: fatalIssue(
        'KLINE_OPEN_TIME_OUT_OF_RANGE',
        source,
        line,
        `field 0 (${raw}) is outside the range JavaScript can represent as a date`,
      ),
    };
  }

  if (microseconds % MICROSECONDS_PER_DAY !== 0n) {
    return {
      issue: fatalIssue(
        'KLINE_OPEN_TIME_NOT_MIDNIGHT',
        source,
        line,
        `field 0 (${raw}) does not land on UTC midnight, so it names a partial day that ` +
          'this module has no column to store',
      ),
    };
  }

  let day: string;
  try {
    day = new Date(asNumber).toISOString().slice(0, 10);
  } catch {
    return {
      issue: fatalIssue(
        'KLINE_OPEN_TIME_OUT_OF_RANGE',
        source,
        line,
        `field 0 (${raw}) is not a valid instant`,
      ),
    };
  }

  return { day };
}

/**
 * Parse one CSV line into a candle, or into the single fatal finding that stops
 * it.
 *
 * Only the first fatal is returned: a row that has already failed one structural
 * rule will fail the ones after it for the same reason, and a report that says
 * six things about one line says less than one that says the thing that matters.
 * Warnings accumulate because they are independent observations about a row that
 * *is* going to be stored.
 */
export function parseKlineLine(
  line: string,
  source: string,
  lineNumber: number,
): KlineParseResult {
  const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  const fields = text.split(',');

  if (fields.length !== FIELD_COUNT) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_FIELD_COUNT',
        source,
        lineNumber,
        `expected ${FIELD_COUNT} comma-separated fields, got ${fields.length}`,
      ),
    };
  }

  const openTimeField = fields[0] ?? '';
  const timestamp = parseOpenTimestamp(openTimeField, source, lineNumber);
  if ('issue' in timestamp) {
    return { ok: false, issue: timestamp.issue };
  }

  const priceFields = [
    { index: 1, name: 'open' },
    { index: 2, name: 'high' },
    { index: 3, name: 'low' },
    { index: 4, name: 'close' },
  ] as const;

  const prices: Record<'open' | 'high' | 'low' | 'close', Prisma.Decimal> = {
    open: new Prisma.Decimal(0),
    high: new Prisma.Decimal(0),
    low: new Prisma.Decimal(0),
    close: new Prisma.Decimal(0),
  };

  for (const { index, name } of priceFields) {
    const raw = fields[index] ?? '';
    const parsed = parseNumber(raw);
    if (parsed === null) {
      return {
        ok: false,
        issue: fatalIssue(
          'KLINE_PRICE_FORMAT',
          source,
          lineNumber,
          `field ${index} (${name}) must be a decimal number, got '${raw}'`,
        ),
      };
    }
    if (parsed.lte(0)) {
      return {
        ok: false,
        issue: fatalIssue(
          'KLINE_PRICE_NOT_POSITIVE',
          source,
          lineNumber,
          `field ${index} (${name}) must be greater than zero, got '${raw}'`,
        ),
      };
    }
    prices[name] = parsed;
  }

  const open = prices.open;
  const high = prices.high;
  const low = prices.low;
  const close = prices.close;
  const maxOfBody = Prisma.Decimal.max(open, close);
  const minOfBody = Prisma.Decimal.min(open, close);

  if (high.lt(maxOfBody)) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_OHLC_ORDER',
        source,
        lineNumber,
        `high (${high.toString()}) is below the open/close range ${minOfBody.toString()}..${maxOfBody.toString()}`,
      ),
    };
  }
  if (low.gt(minOfBody)) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_OHLC_ORDER',
        source,
        lineNumber,
        `low (${low.toString()}) is above the open/close range ${minOfBody.toString()}..${maxOfBody.toString()}`,
      ),
    };
  }

  const volumeField = fields[5] ?? '';
  const volume = parseNumber(volumeField);
  if (volume === null) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_VOLUME_FORMAT',
        source,
        lineNumber,
        `field 5 (volume) must be a decimal number, got '${volumeField}'`,
      ),
    };
  }
  if (volume.isNegative()) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_VOLUME_NEGATIVE',
        source,
        lineNumber,
        `field 5 (volume) must not be negative, got '${volumeField}'`,
      ),
    };
  }

  const quoteVolumeField = fields[7] ?? '';
  const quoteVolume = parseNumber(quoteVolumeField);
  if (quoteVolume === null) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_VOLUME_FORMAT',
        source,
        lineNumber,
        `field 7 (quote volume) must be a decimal number, got '${quoteVolumeField}'`,
      ),
    };
  }
  if (quoteVolume.isNegative()) {
    return {
      ok: false,
      issue: fatalIssue(
        'KLINE_VOLUME_NEGATIVE',
        source,
        lineNumber,
        `field 7 (quote volume) must not be negative, got '${quoteVolumeField}'`,
      ),
    };
  }

  const warnings: ValidationIssue[] = [];

  const closeTimeField = fields[6] ?? '';
  if (!SIXTEEN_DIGITS.test(closeTimeField)) {
    warnings.push(
      warningIssue(
        'KLINE_CLOSE_TIME_FORMAT',
        source,
        lineNumber,
        `field 6 should be a 16-digit microsecond timestamp, got '${closeTimeField}'`,
      ),
    );
  } else if (BigInt(closeTimeField) - BigInt(openTimeField) !== EXPECTED_CLOSE_TIME_DELTA) {
    warnings.push(
      warningIssue(
        'KLINE_CLOSE_TIME_MISMATCH',
        source,
        lineNumber,
        `field 6 (${closeTimeField}) is not one millisecond before midnight after field 0 (${openTimeField})`,
      ),
    );
  }

  const tradesField = fields[8] ?? '';
  if (!UNSIGNED_INTEGER.test(tradesField)) {
    warnings.push(
      warningIssue(
        'KLINE_TRADES_FORMAT',
        source,
        lineNumber,
        `field 8 (trade count) should be a non-negative integer, got '${tradesField}'`,
      ),
    );
  }

  for (const index of [9, 10]) {
    const raw = fields[index] ?? '';
    if (parseNumber(raw) === null) {
      warnings.push(
        warningIssue(
          'KLINE_TAKER_FORMAT',
          source,
          lineNumber,
          `field ${index} (taker-buy volume) should be a decimal number, got '${raw}'`,
        ),
      );
    }
  }

  const ignoreField = fields[11] ?? '';
  if (ignoreField !== '0') {
    warnings.push(
      warningIssue(
        'KLINE_IGNORE_FIELD',
        source,
        lineNumber,
        `field 11 should be '0' by convention, got '${ignoreField}'`,
      ),
    );
  }

  for (const { index, name } of priceFields) {
    const raw = fields[index] ?? '';
    if (hasMoreThanEightPlaces(raw)) {
      warnings.push(
        warningIssue(
          'KLINE_PRECISION',
          source,
          lineNumber,
          `field ${index} (${name}) carries more than ${DISPLAY_DECIMAL_PLACES} decimal places; ` +
            'the engine truncates quantities to that many, so extra precision here is not used',
        ),
      );
    }
  }
  for (const index of [5, 7]) {
    const raw = fields[index] ?? '';
    if (hasMoreThanEightPlaces(raw)) {
      warnings.push(
        warningIssue(
          'KLINE_PRECISION',
          source,
          lineNumber,
          `field ${index} carries more than ${DISPLAY_DECIMAL_PLACES} decimal places`,
        ),
      );
    }
  }

  return {
    ok: true,
    candle: {
      day: timestamp.day,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume,
    },
    warnings,
  };
}
