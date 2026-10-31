import type { Prisma } from '@prisma/client';

import type { RiskLevel } from '../risk.types';
import {
  ANNUALISED_VOLATILITY_HIGH,
  ANNUALISED_VOLATILITY_MEDIUM,
  DRAWDOWN_HIGH,
  DRAWDOWN_MEDIUM,
} from './risk.constants';

/**
 * MODULE 06 - classification.
 *
 * THE THRESHOLDS ARE POLICY, NOT MEASUREMENT. Everything before this file
 * derives an observation from data; here the observation is read against four
 * published constants and folded into a word. Nothing is inferred, smoothed or
 * fitted, so the same series always yields the same level, and the level can be
 * re-derived from the metrics printed beside it.
 *
 * Two inputs either can dominate. A strategy with calm variance but one
 * catastrophic collapse is HIGH on drawdown alone; a strategy that never drops
 * far but whips constantly is HIGH on volatility alone. Requiring both would
 * miss both of those strategies, which is why each threshold is an independent
 * route to its level.
 *
 * COMPARISONS RUN ON UNROUNDED VALUES. A drawdown of 0.0999999 rounds to
 * 0.1000 for display and is not HIGH, because the comparison saw 0.0999999.
 * Rounding first would let a level disagree with the numbers printed beside it,
 * and the numbers are the part a client can check.
 */
export function classifyRiskLevel(
  drawdown: Prisma.Decimal,
  annualisedVolatility: Prisma.Decimal,
): RiskLevel {
  if (drawdown.gte(DRAWDOWN_HIGH) || annualisedVolatility.gte(ANNUALISED_VOLATILITY_HIGH)) {
    return 'HIGH';
  }

  if (drawdown.gte(DRAWDOWN_MEDIUM) || annualisedVolatility.gte(ANNUALISED_VOLATILITY_MEDIUM)) {
    return 'MEDIUM';
  }

  return 'LOW';
}
