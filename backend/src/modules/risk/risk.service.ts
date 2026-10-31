import { Inject, Injectable } from '@nestjs/common';

import {
  REQUIRED_OBSERVATIONS,
  SAMPLE_DESCRIPTION,
  toDisplayNumber,
} from './domain/risk.constants';
import { maxDrawdown } from './domain/drawdown';
import { classifyRiskLevel } from './domain/risk-level';
import { computeReturns, isFlat, validateSeries } from './domain/series';
import { annualisedVolatility, dailyVolatility } from './domain/volatility';
import { EQUITY_SERIES_PORT, type EquitySeriesPort } from './ports/equity-series.port';
import type { RiskEvaluation, RiskEvidence, RiskReason } from './risk.types';
import { StrategyService } from '../strategy/strategy.service';

/**
 * MODULE 06 - orchestration, and deliberately nothing else.
 *
 * NO FORMULA LIVES HERE. The service decides *order* and *eligibility*: who may
 * ask, what the series is, whether there is enough of it, and which reason wins
 * when several could apply. Every number comes from a domain function and every
 * threshold from a constant, so the service reads as a sequence of decisions and
 * each decision is tested against the same code the response is built from.
 *
 * READ-ONLY BY CONSTRUCTION. The service depends on `StrategyService` - for
 * visibility - and on `EquitySeriesPort` - for history. It has no Prisma client,
 * no repository and no write path of any kind, which is why nothing it does can
 * move a row: the read-only guarantee is structural, not a promise in a comment.
 *
 * ONE EVALUATION PER REQUEST, NEVER CACHED AND NEVER STORED. Two requests for
 * the same strategy can differ as history arrives, which is the desired
 * behaviour: the response describes what is true now, where a stored one would
 * describe what was true when it was written. There is no risk table to write
 * to, and adding one would only create a figure that can drift away from the
 * evidence behind it.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly strategyService: StrategyService,
    @Inject(EQUITY_SERIES_PORT) private readonly equitySeries: EquitySeriesPort,
  ) {}

  /**
   * Evaluate one strategy for one viewer.
   *
   * Visibility is resolved first and never re-implemented: `findVisibleTo`
   * throws 404 for a strategy the viewer may not see, for an unknown id and for
   * one that does not exist - deliberately not 403, since a 403 would confirm to
   * a stranger that the strategy exists.
   *
   * `now` is a parameter rather than a call to `new Date()` inside the method,
   * so `evaluatedAt` is deterministic under test and the wall clock is never
   * the reason an assertion fails.
   */
  async evaluate(
    viewerId: string,
    strategyId: string,
    now: Date = new Date(),
  ): Promise<RiskEvaluation> {
    const strategy = await this.strategyService.findVisibleTo(viewerId, strategyId);
    const points = await this.equitySeries.dailyPoints(strategy.id);

    const validation = validateSeries(points);

    // PRECEDENCE, IN THIS ORDER. Validation first: a series that broke the
    // contract says nothing reliable about how many points it held or whether
    // they moved, so it cannot be counted or inspected for flatness. Then the
    // count, because "not enough evidence" outranks "the evidence showed
    // nothing". Flatness last, since a series can only be called flat once it
    // is long enough to count. Exactly one reason is ever returned.
    if (!validation.ok) {
      return this.insufficient(strategy.id, 'INVALID_SERIES', points.length, null, null, now);
    }

    const { equity, firstObservedAt, lastObservedAt } = validation;
    const observations = equity.length;

    if (observations === 0) {
      return this.insufficient(strategy.id, 'NO_HISTORY', 0, null, null, now);
    }

    if (observations < REQUIRED_OBSERVATIONS) {
      return this.insufficient(
        strategy.id,
        'INSUFFICIENT_HISTORY',
        observations,
        firstObservedAt,
        lastObservedAt,
        now,
      );
    }

    if (isFlat(equity)) {
      return this.insufficient(
        strategy.id,
        'NO_ACTIVITY',
        observations,
        firstObservedAt,
        lastObservedAt,
        now,
      );
    }

    // Every figure below is computed from unrounded values and rounded exactly
    // once, at the moment it joins the response. Classification reads the same
    // unrounded decimals, so the published level always agrees with the
    // published numbers.
    const drawdown = maxDrawdown(equity);
    const daily = dailyVolatility(computeReturns(equity));
    const annualised = annualisedVolatility(daily);

    return {
      strategyId: strategy.id,
      status: 'EVALUATED',
      reason: null,
      riskLevel: classifyRiskLevel(drawdown, annualised),
      metrics: {
        maxDrawdown: toDisplayNumber(drawdown),
        dailyVolatility: toDisplayNumber(daily),
        annualisedVolatility: toDisplayNumber(annualised),
      },
      evidence: this.evidence(observations, firstObservedAt, lastObservedAt),
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * Build an `INSUFFICIENT_DATA` reading.
   *
   * `riskLevel` and `metrics` are null by construction rather than by
   * conditional, so no code path can ever attach a level to a series that was
   * not measured.
   */
  private insufficient(
    strategyId: string,
    reason: RiskReason,
    observations: number,
    firstObservedAt: string | null,
    lastObservedAt: string | null,
    now: Date,
  ): RiskEvaluation {
    return {
      strategyId,
      status: 'INSUFFICIENT_DATA',
      reason,
      riskLevel: null,
      metrics: null,
      evidence: this.evidence(observations, firstObservedAt, lastObservedAt),
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * What the statement was made from, on both paths.
   *
   * `requiredObservations` and `sampleDescription` are echoed rather than
   * hard-coded by clients so that a screen explaining an empty state - "0 of
   * 30 daily equity points" - stays true if the policy ever changes.
   */
  private evidence(
    observations: number,
    firstObservedAt: string | null,
    lastObservedAt: string | null,
  ): RiskEvidence {
    return {
      observations,
      firstObservedAt,
      lastObservedAt,
      requiredObservations: REQUIRED_OBSERVATIONS,
      sampleDescription: SAMPLE_DESCRIPTION,
    };
  }
}
