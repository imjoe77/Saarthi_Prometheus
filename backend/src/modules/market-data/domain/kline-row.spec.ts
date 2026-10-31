import { Prisma } from '@prisma/client';

import { parseKlineLine } from './kline-row';

/**
 * MODULE 06b - one Binance `1d` kline row.
 *
 * The constant timestamps are the real ones for the dataset's first day:
 * `1735689600000000` microseconds is UTC midnight on 2025-01-01 and its close
 * time is exactly 86,399,999,999 microseconds later. A valid row is twelve
 * comma-separated fields with prices that describe a real OHLC bar, so most
 * tests here corrupt exactly one field of that row and assert the single rule
 * the corruption trips.
 */
const OPEN_TIME = '1735689600000000';
const CLOSE_TIME = '1735775999999999';

function row(fields: Partial<Record<number, string>> = {}): string {
  const values = [
    OPEN_TIME,
    '100', // open
    '105', // high
    '95', // low
    '101', // close
    '1234.5', // base volume
    CLOSE_TIME,
    '125000', // quote volume
    '7', // trade count
    '600.25', // taker-buy base
    '61234', // taker-buy quote
    '0', // ignore
  ];
  for (const [index, value] of Object.entries(fields)) {
    if (value !== undefined) {
      values[Number(index)] = value;
    }
  }
  return values.join(',');
}

function parsed(line: string) {
  return parseKlineLine(line, 'a.csv', 1);
}

describe('parseKlineLine', () => {
  it('parses a valid row into a candle for its UTC day', () => {
    const result = parsed(row());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.candle.day).toBe('2025-01-01');
    expect(result.candle.open.equals(new Prisma.Decimal('100'))).toBe(true);
    expect(result.candle.high.equals(new Prisma.Decimal('105'))).toBe(true);
    expect(result.candle.low.equals(new Prisma.Decimal(95))).toBe(true);
    expect(result.candle.close.equals(new Prisma.Decimal('101'))).toBe(true);
    expect(result.candle.volume.equals(new Prisma.Decimal('1234.5'))).toBe(true);
    expect(result.candle.quoteVolume.equals(new Prisma.Decimal('125000'))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('strips a byte-order mark before parsing', () => {
    const result = parsed(`\uFEFF${row()}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candle.day).toBe('2025-01-01');
    }
  });

  it('derives the day from the open timestamp, not from a file name', () => {
    const result = parsed(row({ 0: '1738195200000000' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candle.day).toBe('2025-01-30');
    }
  });

  it.each([
    ['eleven fields', '1,2,3,4,5,6,7,8,9,10,11', 'KLINE_FIELD_COUNT'],
    ['thirteen fields', `${row()},extra`, 'KLINE_FIELD_COUNT'],
    ['an empty line outside the blank-line rule', '', 'KLINE_FIELD_COUNT'],
  ])('refuses %s as KLINE_FIELD_COUNT', (_label, value, rule) => {
    const result = parsed(value);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe(rule);
    }
  });

  it.each([
    ['a 15-digit timestamp', '173568960000000', 'KLINE_OPEN_TIME_FORMAT'],
    ['a 17-digit timestamp', '17356896000000000', 'KLINE_OPEN_TIME_FORMAT'],
    ['an alphanumeric timestamp', 'not-a-time', 'KLINE_OPEN_TIME_FORMAT'],
  ])('refuses %s as KLINE_OPEN_TIME_FORMAT', (_label, value, rule) => {
    const result = parsed(row({ 0: value }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe(rule);
    }
  });

  it('refuses a timestamp that is not a whole number of milliseconds', () => {
    const result = parsed(row({ 0: '1735689600000123' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_OPEN_TIME_NOT_MILLISECOND');
    }
  });

  it('refuses a timestamp that does not land on UTC midnight', () => {
    // Midnight plus two whole seconds is still a valid millisecond count, just
    // not one this module has a column for.
    const result = parsed(row({ 0: '1735689600002000' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_OPEN_TIME_NOT_MIDNIGHT');
    }
  });

  it('refuses the largest 16-digit timestamps as a millisecond or midnight problem, never a range one', () => {
    // A 16-digit microsecond value always lands inside JavaScript's safe date
    // range once divided by 1000, so the range guards cannot fire on anything
    // that passes the format gate. What *can* fire - and must - is the
    // millisecond check first, then the midnight check.
    const notWholeMs = parsed(row({ 0: '9999999999999001' }));

    expect(notWholeMs.ok).toBe(false);
    if (!notWholeMs.ok) {
      expect(notWholeMs.issue.rule).toBe('KLINE_OPEN_TIME_NOT_MILLISECOND');
    }

    const notMidnight = parsed(row({ 0: '9999999999999000' }));

    expect(notMidnight.ok).toBe(false);
    if (!notMidnight.ok) {
      expect(notMidnight.issue.rule).toBe('KLINE_OPEN_TIME_NOT_MIDNIGHT');
    }
  });

  it.each([
    ['open', 1],
    ['high', 2],
    ['low', 3],
    ['close', 4],
  ] as const)('refuses a non-decimal %s as KLINE_PRICE_FORMAT', (_name, index) => {
    const result = parsed(row({ [index]: 'abc' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_PRICE_FORMAT');
    }
  });

  it.each([
    ['a zero open', 1, '0', 'KLINE_PRICE_NOT_POSITIVE'],
    ['a negative low', 3, '-5', 'KLINE_PRICE_NOT_POSITIVE'],
    ['a NaN close', 4, 'NaN', 'KLINE_PRICE_FORMAT'],
  ] as const)('refuses %s', (_label, index, value, rule) => {
    const result = parsed(row({ [index]: value }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe(rule);
    }
  });

  it('accepts a leading-dot decimal as a price', () => {
    // `-?(?:\d+(?:\.\d+)?|\.\d+)` deliberately admits `.5`, which Decimal parses.
    // The low also has to drop below the 0.5 close or the bar is not a valid OHLC.
    const result = parsed(row({ 3: '0.1', 4: '.5' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candle.close.equals(new Prisma.Decimal('0.5'))).toBe(true);
      expect(result.candle.low.equals(new Prisma.Decimal('0.1'))).toBe(true);
    }
  });

  it('refuses a high below the open/close body', () => {
    const result = parsed(row({ 2: '99' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_OHLC_ORDER');
    }
  });

  it('refuses a low above the open/close body', () => {
    const result = parsed(row({ 3: '102' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_OHLC_ORDER');
    }
  });

  it('refuses a non-decimal volume as KLINE_VOLUME_FORMAT', () => {
    const result = parsed(row({ 5: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_VOLUME_FORMAT');
    }
  });

  it('refuses a negative volume as KLINE_VOLUME_NEGATIVE, but allows zero', () => {
    const negative = parsed(row({ 5: '-1' }));
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.issue.rule).toBe('KLINE_VOLUME_NEGATIVE');
    }

    expect(parsed(row({ 5: '0' })).ok).toBe(true);
  });

  it('refuses a negative quote volume as KLINE_VOLUME_NEGATIVE', () => {
    const result = parsed(row({ 7: '-1' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_VOLUME_NEGATIVE');
    }
  });

  it('collects independent warnings from a row that is still stored', () => {
    const result = parsed(
      row({ 6: 'not-a-time', 8: 'abc', 9: 'x', 10: 'y', 11: '1', 1: '100.123456789' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const rules = result.warnings.map((warning) => warning.rule);
    expect(rules).toContain('KLINE_CLOSE_TIME_FORMAT');
    expect(rules).toContain('KLINE_TRADES_FORMAT');
    expect(rules).toContain('KLINE_TAKER_FORMAT');
    expect(rules).toContain('KLINE_IGNORE_FIELD');
    expect(rules).toContain('KLINE_PRECISION');
  });

  it('warns about a close time that is not one millisecond before the next midnight', () => {
    const result = parsed(row({ 6: '1735775999999998' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((warning) => warning.rule)).toContain('KLINE_CLOSE_TIME_MISMATCH');
    }
  });

  it('does not warn about a good close time or a good trade count', () => {
    const result = parsed(row());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
    }
  });

  it('warns once per over-precise price field and volume field', () => {
    const result = parsed(row({ 1: '100.123456789', 5: '0.000000001' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const precisionWarnings = result.warnings.filter(
        (warning) => warning.rule === 'KLINE_PRECISION',
      );
      expect(precisionWarnings).toHaveLength(2);
    }
  });

  it('reports the file and line the finding came from', () => {
    const result = parseKlineLine('too,short', 'symbols/BTCUSDT/a.zip', 12);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.source).toBe('symbols/BTCUSDT/a.zip');
      expect(result.issue.line).toBe(12);
    }
  });

  it('returns only the first fatal finding, not a cascade', () => {
    // Wrong field count AND a malformed timestamp AND a negative price: one
    // answer, the structural one that stops the row first.
    const result = parseKlineLine('x', 'a.csv', 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.rule).toBe('KLINE_FIELD_COUNT');
    }
  });
});