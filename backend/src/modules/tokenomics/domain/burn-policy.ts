import { Prisma } from '@prisma/client';

import { DomainException } from '../../../common/errors/domain.exception';

/**
 * Pure adaptive burn-split arithmetic (owner-pending defaults):
 *
 * The baseline split (60% direct burn / 40% buyback) is what a HEALTHY
 * treasury burns directly. The adaptive policy dials only the direct-burn
 * share DOWN - never UP - as treasury health falls: the linear ramp is
 * health 45% -> 31% mapping the direct-burn share 60% -> 40%, with the
 * floor at the configured minimum that must itself sit at or below the
 * baseline and strictly above the fixed 30% on-chain reserve requirement.
 *
 * The 30% reserve guard (treasury-policy) stays exactly where it is: the
 * ramp shapes WHERE the split lies inside what the treasury can afford,
 * and the guard is still the hard stop that refuses a burn the balance
 * cannot fund without breaching the floor.
 */

export interface TreasuryHealthReading {
  treasuryAvailableEmber: Prisma.Decimal;
  qualifyingFundingEmber: Prisma.Decimal;
}

export interface BurnPolicyDecision {
  directBurnPct: number;
  buybackPct: number;
  splitSource: 'BASELINE' | 'ADAPTIVE_RAMP';
  treasuryHealthPct: number | null;
}

export interface BurnPolicySettings {
  baselineDirectBurnPct: number;
  adaptiveSplit: boolean;
  upperHealthPct: number;
  lowerHealthPct: number;
  minDirectBurnPct: number;
}

const MathDecimal = Prisma.Decimal.clone({ precision: 60 });

/** Health as a percentage: available treasury EMBER over COMPLETED DEPOSIT funding. */
export function treasuryHealthPercentage(health: TreasuryHealthReading | null): number | null {
  if (!health) return null;
  if (health.qualifyingFundingEmber.lte(0)) return null;
  if (health.treasuryAvailableEmber.lte(0)) return 0;
  const pct = new MathDecimal(health.treasuryAvailableEmber.toString())
    .div(new MathDecimal(health.qualifyingFundingEmber.toString()))
    .times(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return Number(pct.toFixed(2));
}

/** Decision, given settings and optionally a health reading. */
export function resolveBurnSplit(settings: BurnPolicySettings, health: TreasuryHealthReading | null): BurnPolicyDecision {
  assertSettings(settings);

  const baselineDecision: BurnPolicyDecision = {
    directBurnPct: settings.baselineDirectBurnPct,
    buybackPct: 100 - settings.baselineDirectBurnPct,
    splitSource: 'BASELINE',
    treasuryHealthPct: null,
  };
  if (!settings.adaptiveSplit) {
    return baselineDecision;
  }

  const healthPct = treasuryHealthPercentage(health);
  if (healthPct === null) {
    return { ...baselineDecision, treasuryHealthPct: null, splitSource: 'BASELINE' };
  }

  const buybackPct = 100 - settings.baselineDirectBurnPct;
  if (healthPct >= settings.upperHealthPct) {
    return {
      directBurnPct: settings.baselineDirectBurnPct,
      buybackPct,
      splitSource: 'BASELINE',
      treasuryHealthPct: healthPct,
    };
  }

  if (healthPct <= settings.lowerHealthPct) {
    return {
      directBurnPct: settings.minDirectBurnPct,
      buybackPct: 100 - settings.minDirectBurnPct,
      splitSource: 'ADAPTIVE_RAMP',
      treasuryHealthPct: healthPct,
    };
  }

  const ramp = new MathDecimal(healthPct - settings.lowerHealthPct).div(
    new MathDecimal(settings.upperHealthPct - settings.lowerHealthPct),
  );
  const adaptivePct = new MathDecimal(settings.baselineDirectBurnPct - settings.minDirectBurnPct)
    .times(ramp)
    .plus(settings.minDirectBurnPct)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
  const directBurnPct = Math.min(Math.max(adaptivePct, settings.minDirectBurnPct), settings.baselineDirectBurnPct);

  return {
    directBurnPct,
    buybackPct: 100 - directBurnPct,
    splitSource: 'ADAPTIVE_RAMP',
    treasuryHealthPct: healthPct,
  };
}

function assertSettings(settings: BurnPolicySettings): void {
  const validPct = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 100;
  if (!validPct(settings.baselineDirectBurnPct) || !validPct(settings.minDirectBurnPct)) {
    throw DomainException.badRequest('Burn percentages must be integers between 0 and 100.');
  }
  if (!validPct(settings.upperHealthPct) || !validPct(settings.lowerHealthPct)) {
    throw DomainException.badRequest('Health thresholds must be integers between 0 and 100.');
  }
  if (settings.minDirectBurnPct > settings.baselineDirectBurnPct) {
    throw DomainException.badRequest(
      'The minimum direct-burn share must not exceed the baseline; the baseline is the most protective share the policy may dial down from.',
    );
  }
  if (settings.lowerHealthPct > settings.upperHealthPct) {
    throw DomainException.badRequest('The lower health threshold must not exceed the upper one.');
  }
  if (settings.lowerHealthPct <= 30) {
    throw DomainException.badRequest(
      'The lower health threshold must stay strictly above the fixed 30% reserve floor. Policy that plans to keep the treasury at or below the floor is not a policy; the reserve guard would refuse the burns the ramp encourages.',
    );
  }
}
