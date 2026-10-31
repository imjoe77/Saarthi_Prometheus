import { Prisma } from '@prisma/client';

import { resolveBurnSplit, treasuryHealthPercentage } from './burn-policy';

/**
 * Pure decision-branch coverage for the adaptive burn split arithmetic.
 */
describe('burn-policy (unit)', () => {
  const settings = {
    baselineDirectBurnPct: 60,
    adaptiveSplit: true,
    upperHealthPct: 45,
    lowerHealthPct: 31,
    minDirectBurnPct: 40,
  };
  const health = (available: string, funding: string) => ({
    treasuryAvailableEmber: new Prisma.Decimal(available),
    qualifyingFundingEmber: new Prisma.Decimal(funding),
  });

  it('keeps the baseline when the layer is disabled', () => {
    const decision = resolveBurnSplit({ ...settings, adaptiveSplit: false }, health('1000', '1000'));
    expect(decision.directBurnPct).toBe(60);
    expect(decision.buybackPct).toBe(40);
    expect(decision.splitSource).toBe('BASELINE');
  });

  it('stays at baseline with unknown treasury health (no funding history yet)', () => {
    const decision = resolveBurnSplit(settings, null);
    expect(decision.splitSource).toBe('BASELINE');
    expect(decision.directBurnPct).toBe(60);
    expect(decision.treasuryHealthPct).toBeNull();
  });

  it('reads health as available over qualifying funding', () => {
    expect(treasuryHealthPercentage(health('450', '1000'))).toBe(45);
    expect(treasuryHealthPercentage(health('310', '1000'))).toBe(31);
    expect(treasuryHealthPercentage(health('0', '1000'))).toBe(0);
    expect(treasuryHealthPercentage(health('1000', '0'))).toBeNull();
  });

  it('stays at baseline when the treasury is healthy (>= upper threshold)', () => {
    const decision = resolveBurnSplit(settings, health('500', '1000'));
    expect(decision.splitSource).toBe('BASELINE');
    expect(decision.directBurnPct).toBe(60);
    expect(decision.treasuryHealthPct).toBe(50);
  });

  it('dials down to the minimum at or below the lower threshold', () => {
    const decision = resolveBurnSplit(settings, health('250', '1000'));
    expect(decision.splitSource).toBe('ADAPTIVE_RAMP');
    expect(decision.directBurnPct).toBe(40);
    expect(decision.treasuryHealthPct).toBe(25);
  });

  it('ramps linearly between the thresholds and rounds to integer percentages', () => {
    const mid = resolveBurnSplit(settings, health('380', '1000'));
    expect(mid.treasuryHealthPct).toBe(38);
    // 38% health sits exactly halfway down the 45->31 ramp: 60 -> 40 gives 50.
    expect(mid.directBurnPct).toBe(50);
    expect(mid.buybackPct).toBe(50);

    const slightlyLower = resolveBurnSplit(settings, health('331', '1000'));
    // 33.1% health sits at 15% of the ramp: 40 + 20*0.15 = 43.
    expect(slightlyLower.directBurnPct).toBe(43);
  });

  it('never dials the burn share above the baseline or below the minimum', () => {
    expect(resolveBurnSplit(settings, health('10000', '1000')).directBurnPct).toBe(60);
    expect(resolveBurnSplit(settings, health('0', '1000')).directBurnPct).toBe(40);
  });

  it('refuses settings that would plan burns the reserve guard would refuse', () => {
    expect(() =>
      resolveBurnSplit({ ...settings, lowerHealthPct: 30 }, health('100', '1000')),
    ).toThrow();
  });

  it('refuses a minimum share above the baseline', () => {
    expect(() =>
      resolveBurnSplit({ ...settings, minDirectBurnPct: 70 }, health('100', '1000')),
    ).toThrow();
  });
});
