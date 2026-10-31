import { isMarketOpen, zonedClock, US_EQUITY_MARKET_TIME_ZONE } from './market-state';

/**
 * MODULE 06c - the session rule, pinned to instants that cannot drift.
 *
 * Every date below is a fixed calendar fact, not a `new Date()`: January is
 * firmly outside daylight saving in New York, so UTC offsets are stable and an
 * assertion written today still holds on any machine. The close is tested as
 * exclusive (16:00 is closed) because that is the boundary the implementation
 * states, and the open is tested as inclusive for the same reason.
 */
describe('market-state', () => {
  /** Monday 2026-01-05, chosen because January has no DST transition. */
  const MONDAY = '2026-01-05';
  const SATURDAY = '2026-01-10';
  const SUNDAY = '2026-01-11';

  function utc(isoLocal: string): Date {
    return new Date(`${isoLocal}:00.000Z`);
  }

  describe('zonedClock', () => {
    it('reads the New York wall clock, not the machine local zone', () => {
      // 14:30 UTC in January is 09:30 EST.
      expect(zonedClock(utc(`${MONDAY}T14:30`))).toEqual({ weekday: 1, minutes: 9 * 60 + 30 });
      // The same instant in July is 10:30 EDT, which is the point of using
      // Intl rather than a fixed offset.
      expect(zonedClock(utc('2026-07-06T14:30'))).toEqual({ weekday: 1, minutes: 10 * 60 + 30 });
    });

    it('reports midnight as hour zero rather than hour 24', () => {
      expect(zonedClock(utc(`${MONDAY}T05:00`))).toEqual({ weekday: 1, minutes: 0 });
    });

    it('honours an explicit time zone', () => {
      const tokyo = zonedClock(utc(`${MONDAY}T14:30`), 'Asia/Tokyo');
      expect(tokyo.weekday).toBe(1);
      expect(tokyo.minutes).toBe(23 * 60 + 30);
    });
  });

  describe('equities', () => {
    it('opens at 09:30 New York time, inclusively', () => {
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T14:30`))).toBe('OPEN');
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T14:31`))).toBe('OPEN');
    });

    it('closes at 16:00 New York time, exclusively', () => {
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T20:59`))).toBe('OPEN');
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T21:00`))).toBe('CLOSED');
    });

    it('is closed before the open and after the close', () => {
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T14:29`))).toBe('CLOSED');
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T21:01`))).toBe('CLOSED');
    });

    it('is closed at the very start and very end of the session window', () => {
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T00:00`))).toBe('CLOSED');
      expect(isMarketOpen('STOCK', utc(`${MONDAY}T23:59`))).toBe('CLOSED');
    });

    it('is closed all weekend, because the rule states no weekend session', () => {
      expect(isMarketOpen('STOCK', utc(`${SATURDAY}T15:00`))).toBe('CLOSED');
      expect(isMarketOpen('STOCK', utc(`${SUNDAY}T15:00`))).toBe('CLOSED');
      // A Saturday that would otherwise be mid-session, to prove the weekday
      // check runs before the clock check.
      expect(isMarketOpen('STOCK', utc(`${SATURDAY}T17:00`))).toBe('CLOSED');
    });

    it('is open on every weekday inside the window', () => {
      for (const day of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) {
        expect(isMarketOpen('STOCK', utc(`${day}T16:00`))).toBe('OPEN');
      }
    });

    it('uses the documented New York zone by default', () => {
      expect(US_EQUITY_MARKET_TIME_ZONE).toBe('America/New_York');
    });
  });

  describe('crypto', () => {
    it('is always open, including at instants equities are closed', () => {
      expect(isMarketOpen('CRYPTO', utc(`${SATURDAY}T03:00`))).toBe('OPEN');
      expect(isMarketOpen('CRYPTO', utc(`${SUNDAY}T23:59`))).toBe('OPEN');
      expect(isMarketOpen('CRYPTO', utc(`${MONDAY}T05:00`))).toBe('OPEN');
      expect(isMarketOpen('CRYPTO', utc(`${MONDAY}T21:00`))).toBe('OPEN');
    });

    it('never consults the session clock at all', () => {
      // A crypto instant that is closed for equities must still be OPEN, which
      // is the whole reason the kind is a parameter.
      expect(isMarketOpen('CRYPTO', new Date(0))).toBe('OPEN');
      expect(isMarketOpen('CRYPTO', new Date('2038-01-19T03:14:08.000Z'))).toBe('OPEN');
    });
  });
});
