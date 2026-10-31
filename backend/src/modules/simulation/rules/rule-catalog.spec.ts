import { Prisma } from '@prisma/client';

import { unsimulatedRuleKeys } from '../market-seed';
import { findRule, ruleKeys, SIMULATION_RULES } from './rule-catalog';
import type { SimulationRule } from './simulation-rule';

/**
 * MODULE 06b - the rule catalogue.
 *
 * The catalogue is the promise that every strategy a seed ships has a rule to
 * run, and the `desire` assertions below are the timing contract written out:
 * a rule reads closes through `t` and nothing later, and the engine fills one
 * step behind - so each test here states which closes a decision may look at.
 */
describe('rule catalogue', () => {
  function closes(...values: number[]): Prisma.Decimal[] {
    return values.map((value) => new Prisma.Decimal(value));
  }

  it('ships exactly the three rules the three seeded strategies run', () => {
    expect(ruleKeys()).toEqual(['buyhold-btc', 'sma-cross-eth', 'donchian-sol']);
    expect(SIMULATION_RULES.map((rule) => rule.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
    ]);
  });

  it('looks every rule up by key and returns null for an unknown key', () => {
    expect(findRule('buyhold-btc')).not.toBeNull();
    expect(findRule('sma-cross-eth')).not.toBeNull();
    expect(findRule('donchian-sol')).not.toBeNull();
    expect(findRule('momentum-btc')).toBeNull();
  });

  it('records a version and firing notes with every rule', () => {
    for (const rule of SIMULATION_RULES) {
      expect(rule.version).toBe(1);
      expect(rule.enterNote.length).toBeGreaterThan(0);
      expect(rule.exitNote.length).toBeGreaterThan(0);
    }
  });

  it('has no rule whose strategy the seed forgot to ship', () => {
    expect(unsimulatedRuleKeys()).toEqual([]);
  });

  describe('buyhold-btc', () => {
    const rule = findRule('buyhold-btc') as SimulationRule;

    it('wants to be long on the first close the window provides', () => {
      expect(rule.desire(closes(100), 0)).toBe('long');
    });

    it('never forms an exit opinion afterwards', () => {
      for (let t = 1; t < 10; t += 1) {
        expect(rule.desire(closes(...Array(10).fill(100)), t)).toBe('hold');
      }
    });
  });

  describe('sma-cross-eth', () => {
    const rule = findRule('sma-cross-eth') as SimulationRule;

    it('holds its tongue until the 50th close exists', () => {
      const series = closes(...Array(49).fill(100));
      expect(rule.desire(series, 0)).toBe('hold');
      expect(rule.desire(series, 48)).toBe('hold');
    });

    it('reads closes only through t when it does speak', () => {
      // The 20-day average ends at t and the 50-day average ends at t too; a
      // rule that peeked at t+1 on an identically flat series would not change
      // its answer here, so the next tests pin the actual crossover shapes.
      const flat = closes(...Array(60).fill(100));
      expect(rule.desire(flat, 49)).toBe('flat');
    });

    it('wants to be long when the fast average sits above the slow one', () => {
      const rising = closes(...Array.from({ length: 60 }, (_, i) => 1000 + i));

      expect(rule.desire(rising, 49)).toBe('long');
    });

    it('wants out when the fast average sits below the slow one', () => {
      const falling = closes(...Array.from({ length: 60 }, (_, i) => 1000 - i));

      expect(rule.desire(falling, 49)).toBe('flat');
    });

    it('treats equality as no crossover rather than as a buy', () => {
      const flat = closes(...Array(60).fill(100));

      expect(rule.desire(flat, 49)).toBe('flat');
    });
  });

  describe('donchian-sol', () => {
    const rule = findRule('donchian-sol') as SimulationRule;

    it('holds its tongue before a 20-day window exists', () => {
      const series = closes(...Array(20).fill(100));

      expect(rule.desire(series, 0)).toBe('hold');
      expect(rule.desire(series, 19)).toBe('hold');
    });

    it('wants to be long on a 20-day ceiling break', () => {
      // Day 20 closes above every one of the 20 closes before it.
      const series = closes(...Array(20).fill(100), 110);

      expect(rule.desire(series, 20)).toBe('long');
    });

    it('wants out on a 10-day floor break', () => {
      const series = closes(...Array(20).fill(100), 50);

      expect(rule.desire(series, 20)).toBe('flat');
    });

    it('stays silent when neither band fires', () => {
      const series = closes(...Array(20).fill(100), 100);

      expect(rule.desire(series, 20)).toBe('hold');
    });

    it('uses the 10-day window for exits, not the 20-day one', () => {
      // A close above the 20-day maximum cannot also be below the 10-day
      // minimum (the exit band is contained in the entry band), so the entry
      // fires first - deterministically, never shadowed by an exit.
      const series = closes(...Array(20).fill(100));

      expect(rule.desire(series, 19)).toBe('hold');
    });

    it('reads the entry band as the closes strictly before t', () => {
      // If the rule included its own close in the ceiling, day 20 could never
      // break out; 110 > every prior close is what fires it.
      const series = closes(...Array(20).fill(100), 110);

      expect(rule.desire(series, 20)).toBe('long');
    });
  });
});