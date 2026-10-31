import { Prisma } from '@prisma/client';

import {
  RESERVE_FLOOR_BASE,
  RESERVE_FLOOR_PERCENT,
  convertCapacityInrToUsdt,
  discretionaryCapacity,
  monthCapacityLeft,
  projectedBalance,
  reserveFloor,
  reserveStatus,
} from './treasury-policy';

/**
 * The pure policy arithmetic: exact floor math over ledger-scale Decimals
 * (the 60-significant-digit clone, not the process-wide 20-digit default),
 * the clamped discretionary capacity, the three floor-relative statuses, and
 * the display-only INR->USDT capacity conversion that must never invent a
 * rate. Everything here is database-free on purpose: the same functions run
 * inside Module 11's transaction (guard) and in the dashboard read model.
 */
describe('treasury policy arithmetic (unit)', () => {
  const dec = (value: string) => new Prisma.Decimal(value);

  describe('reserveFloor', () => {
    it('exposes the approved percentage and base label', () => {
      expect(RESERVE_FLOOR_PERCENT).toBe(30);
      expect(RESERVE_FLOOR_BASE).toBe('QUALIFYING_TREASURY_FUNDING');
    });

    it('computes 30% of a round funding basis exactly', () => {
      expect(reserveFloor(dec('1000000')).toString()).toBe('300000');
      expect(reserveFloor(dec('0')).toString()).toBe('0');
      expect(reserveFloor(dec('10')).toString()).toBe('3');
    });

    it('keeps an 18dp basis exact where the 20-digit default would lose digits', () => {
      // 30% of this is 370370367.0370370367037037034 - more significant
      // digits than decimal.js' default precision carries.
      expect(reserveFloor(dec('1234567890.123456789012345678')).toString()).toBe(
        '370370367.0370370367037037034',
      );
      expect(reserveFloor(dec('333333.333333333333333333')).toString()).toBe(
        '99999.9999999999999999999',
      );
    });

    it('floors a zero basis to zero - reported, never fabricated', () => {
      expect(reserveFloor(dec('0')).isZero()).toBe(true);
    });
  });

  describe('projectedBalance', () => {
    it('subtracts exactly at ledger scale', () => {
      expect(projectedBalance(dec('1234567890.123456789012345678'), dec('0.000000000000000001')).toString()).toBe(
        '1234567890.123456789012345677',
      );
    });
  });

  describe('discretionaryCapacity', () => {
    it('is the strictly-above-floor remainder', () => {
      expect(discretionaryCapacity(dec('1000000'), dec('300000')).toString()).toBe('700000');
    });

    it('is exactly zero at the floor and clamped below it', () => {
      expect(discretionaryCapacity(dec('300000'), dec('300000')).isZero()).toBe(true);
      expect(discretionaryCapacity(dec('200000'), dec('300000')).isZero()).toBe(true);
    });
  });

  describe('reserveStatus', () => {
    it('classifies strictly above, exactly at, and below the floor', () => {
      expect(reserveStatus(dec('300001'), dec('300000'))).toBe('OK');
      expect(reserveStatus(dec('300000'), dec('300000'))).toBe('AT_FLOOR');
      expect(reserveStatus(dec('299999'), dec('300000'))).toBe('BELOW_FLOOR');
    });

    it('classifies an unfunded treasury (zero available, zero floor) as AT_FLOOR', () => {
      expect(reserveStatus(dec('0'), dec('0'))).toBe('AT_FLOOR');
    });
  });

  describe('convertCapacityInrToUsdt', () => {
    it('converts the approved ₹30 crore demo capacity at the display rate, floored to 6dp', () => {
      const { capacityUsdt, conversion } = convertCapacityInrToUsdt(dec('300000000'), '99.9');

      expect(capacityUsdt).toBe('3003003.003003');
      expect(conversion).toEqual({
        source: 'USDT_FALLBACK_PRICE_INR',
        priceInr: '99.9',
        reason: null,
      });
    });

    it('reports an unavailable conversion when no rate is configured - never invents one', () => {
      const { capacityUsdt, conversion } = convertCapacityInrToUsdt(dec('300000000'), null);

      expect(capacityUsdt).toBeNull();
      expect(conversion).toEqual({
        source: 'USDT_FALLBACK_PRICE_INR',
        priceInr: null,
        reason: 'CONVERSION_RATE_UNAVAILABLE',
      });
    });
  });

  describe('monthCapacityLeft', () => {
    it('reports remaining capacity and AVAILABLE while under the limit', () => {
      expect(monthCapacityLeft('3003003.003003', '125.5')).toEqual({
        remaining: '3002877.503003',
        exhaustion: 'AVAILABLE',
      });
    });

    it('reports EXHAUSTED with a zero remainder once utilization meets the capacity', () => {
      expect(monthCapacityLeft('3003003.003003', '3003003.003003')).toEqual({
        remaining: '0',
        exhaustion: 'EXHAUSTED',
      });
      expect(monthCapacityLeft('3003003.003003', '4000000')).toEqual({
        remaining: '0',
        exhaustion: 'EXHAUSTED',
      });
    });
  });
});
