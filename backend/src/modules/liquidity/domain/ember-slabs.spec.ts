import { Prisma } from '@prisma/client';

import { type EmberLiquiditySlab } from '../../../config/app.config';
import { emberLockDelta, requiredEmberLock, slabsConfigured } from './ember-slabs';

/**
 * Thresholds here are TEST-FIXTURE VALUES ONLY. They are deliberately shaped
 * like the tier layout of the demo data so boundary arithmetic is exercised;
 * they now equal the approved production table (2026-10-18), but production
 * values come from configuration and must never be inferred from this file.
 */
const SLABS: EmberLiquiditySlab[] = [
  { minUsdt: '0', requiredEmber: '1000' },
  { minUsdt: '100000', requiredEmber: '20000' },
  { minUsdt: '250000', requiredEmber: '45000' },
  { minUsdt: '500000', requiredEmber: '80000' },
];

describe('ember-slabs domain', () => {
  describe('slabsConfigured', () => {
    it('is false for an empty slab list, disabling commitment endpoints', () => {
      expect(slabsConfigured([])).toBe(false);
    });

    it('is true once any slab is configured', () => {
      expect(slabsConfigured(SLABS)).toBe(true);
    });
  });

  describe('requiredEmberLock', () => {
    it('returns null for an empty list - configuration is checked first, never interpreted as a threshold miss', () => {
      expect(requiredEmberLock([], new Prisma.Decimal('100000'))).toBeNull();
    });

    it('returns null when the commitment sits below the lowest configured slab', () => {
      const slabs: EmberLiquiditySlab[] = [{ minUsdt: '100000', requiredEmber: '20000' }];

      expect(requiredEmberLock(slabs, new Prisma.Decimal('99999.999999999999999999'))).toBeNull();
    });

    it('locks exactly at a slab boundary - the boundary belongs to its own slab', () => {
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('100000'))?.toString()).toBe('20000');
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('500000'))?.toString()).toBe('80000');
    });

    it('one unit below a boundary still requires the previous slab, not the higher one', () => {
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('99999.999999999999999999'))?.toString()).toBe('1000');
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('249999.999999999999999999'))?.toString()).toBe('20000');
    });

    it('a commitment between two thresholds requires the lower slab it qualifies for', () => {
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('100001'))?.toString()).toBe('20000');
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('499999'))?.toString()).toBe('45000');
    });

    it('covers commitments above the highest slab with the top slab (flat cliff, no invented ceiling)', () => {
      expect(requiredEmberLock(SLABS, new Prisma.Decimal('1000000'))?.toString()).toBe('80000');
    });

    it('handles a zero USDT commitment against a first slab of zero', () => {
      expect(requiredEmberLock(SLABS, new Prisma.Decimal(0))?.toString()).toBe('1000');
    });
  });

  describe('emberLockDelta', () => {
    it('locks only the difference when the requirement grows', () => {
      const delta = emberLockDelta(new Prisma.Decimal('1000'), new Prisma.Decimal('45000'));

      expect(delta.direction).toBe('lock');
      expect(delta.amount.toString()).toBe('44000');
    });

    it('unlocks exactly the surplus when the requirement falls - never more than held', () => {
      const delta = emberLockDelta(new Prisma.Decimal('45000'), new Prisma.Decimal('20000'));

      expect(delta.direction).toBe('unlock');
      expect(delta.amount.toString()).toBe('25000');
    });

    it('does nothing when the requirement is unchanged', () => {
      const delta = emberLockDelta(new Prisma.Decimal('20000'), new Prisma.Decimal('20000'));

      expect(delta.direction).toBe('none');
      expect(delta.amount.toString()).toBe('0');
    });

    it('raises the requirement for a brand-new commitment locked from zero', () => {
      const delta = emberLockDelta(new Prisma.Decimal(0), new Prisma.Decimal('1000'));

      expect(delta.direction).toBe('lock');
      expect(delta.amount.toString()).toBe('1000');
    });
  });
});
