import {
  findMissingDays,
  fromDayNumber,
  fromIsoDay,
  listDaysBetween,
  toDayNumber,
  toIsoDay,
} from './day-window';

/**
 * MODULE 06b - calendar arithmetic on UTC days.
 *
 * The assertions that pin real dates were chosen to cover the arithmetic that
 * `Date` would get wrong: month lengths (`2025-01-31 .. 2025-02-02`) and leap
 * years (`2024-02-28 .. 2024-03-01`). The 2025-01-01 anchor doubles as the
 * dataset's window start.
 */
describe('day window', () => {
  describe('toDayNumber', () => {
    it('reduces a real calendar day to a whole day count', () => {
      expect(toDayNumber('2025-01-01')).toBe(20089);
    });

    it('round-trips every day', () => {
      for (const [year, month, day] of [
        [2024, 2, 29],
        [2025, 1, 1],
        [2026, 10, 6],
      ] as const) {
        const rendered = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        expect(fromDayNumber(toDayNumber(rendered) ?? -1)).toBe(rendered);
      }
    });

    it.each([
      ['a date that does not exist', '2026-02-30'],
      ['a timestamp', '2025-01-01T00:00:00Z'],
      ['a short zero-padded day', '2025-1-1'],
      ['an alphanumeric string', 'not-a-date'],
      ['an empty string', ''],
      ['more than one date', '2025-01-01,2025-01-02'],
    ])('refuses %s', (_label, value) => {
      expect(toDayNumber(value)).toBeNull();
    });
  });

  describe('fromDayNumber', () => {
    it('renders the day count back as a calendar day', () => {
      expect(fromDayNumber(20089)).toBe('2025-01-01');
      expect(fromDayNumber(20091)).toBe('2025-01-03');
    });
  });

  describe('listDaysBetween', () => {
    it('lists every day from start to end, inclusive', () => {
      expect(listDaysBetween('2025-01-01', '2025-01-03')).toEqual([
        '2025-01-01',
        '2025-01-02',
        '2025-01-03',
      ]);
    });

    it('steps across a month boundary', () => {
      expect(listDaysBetween('2025-01-31', '2025-02-02')).toEqual([
        '2025-01-31',
        '2025-02-01',
        '2025-02-02',
      ]);
    });

    it('steps across a leap day', () => {
      expect(listDaysBetween('2024-02-28', '2024-03-01')).toEqual([
        '2024-02-28',
        '2024-02-29',
        '2024-03-01',
      ]);
    });

    it('runs across the dataset window in 644 steps', () => {
      expect(listDaysBetween('2025-01-01', '2026-10-06')).toHaveLength(644);
    });

    it('returns an empty list when the end precedes the start', () => {
      expect(listDaysBetween('2025-01-03', '2025-01-01')).toEqual([]);
    });

    it('returns an empty list when either end is not a real day', () => {
      expect(listDaysBetween('2026-02-30', '2026-03-01')).toEqual([]);
      expect(listDaysBetween('2026-01-01', 'garbage')).toEqual([]);
    });
  });

  describe('findMissingDays', () => {
    it('finds nothing in a contiguous run', () => {
      expect(findMissingDays(['2025-01-01', '2025-01-02', '2025-01-03'])).toEqual([]);
    });

    it('finds the absent day between two present ones', () => {
      expect(findMissingDays(['2025-01-01', '2025-01-03'])).toEqual(['2025-01-02']);
    });

    it('finds every absent day in a longer window', () => {
      const missing = findMissingDays(['2025-01-01', '2025-01-02', '2025-01-05', '2025-01-06']);

      expect(missing).toEqual(['2025-01-03', '2025-01-04']);
    });

    it('ignores duplicates and disorder when deciding what is present', () => {
      const days = ['2025-01-03', '2025-01-01', '2025-01-01', '2025-01-02'];

      expect(findMissingDays(days)).toEqual([]);
    });

    it('skips an unparseable entry rather than failing the whole window', () => {
      const missing = findMissingDays(['2025-01-01', 'not-a-date', '2025-01-03']);

      expect(missing).toEqual(['2025-01-02']);
    });

    it('needs two present days before claiming anything is missing', () => {
      expect(findMissingDays([])).toEqual([]);
      expect(findMissingDays(['2025-01-01'])).toEqual([]);
    });

    it('does not judge days outside the observed window', () => {
      // 2024-12-31 is before the window starts: nothing claimed it existed.
      const missing = findMissingDays(['2025-01-01', '2025-01-03']);

      expect(missing).not.toContain('2024-12-31');
    });
  });

  describe('the Date conversions', () => {
    it('reads a day off a UTC instant', () => {
      expect(toIsoDay(new Date('2025-01-02T18:00:00.000Z'))).toBe('2025-01-02');
    });

    it('writes a day as a UTC midnight instant', () => {
      expect(fromIsoDay('2025-01-02').toISOString()).toBe('2025-01-02T00:00:00.000Z');
    });
  });
});