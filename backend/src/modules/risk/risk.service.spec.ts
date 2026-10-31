import { Prisma, StrategyStatus, type Strategy } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { EquityPoint } from './domain/series';
import { RiskService } from './risk.service';
import type { StrategyService } from '../strategy/strategy.service';

/**
 * MODULE 06 - the decisions the service owns: eligibility, order and reason.
 *
 * The measurements themselves are pinned in the domain specs, where they are
 * computed from fixtures written out longhand. What only appears here is the
 * orchestration: which reason wins when two could apply, that visibility is
 * delegated rather than re-implemented, and that an insufficient answer carries
 * no level and no metrics at all.
 *
 * These run against hand-written fakes because none of this needs PostgreSQL.
 * The properties that genuinely need a real application - the route, the guard,
 * ownership over HTTP and the absence of a write - belong to
 * `test/risk.e2e-spec.ts`.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const STRATEGY_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const DAY_IN_MILLISECONDS = 86_400_000;

interface StrategyServiceMock {
  findVisibleTo: jest.Mock;
}

function makeStrategyService(overrides: Partial<Strategy> = {}): StrategyServiceMock {
  return {
    findVisibleTo: jest.fn().mockResolvedValue({
      id: STRATEGY_ID,
      ownerId: OWNER_ID,
      name: 'Reference',
      description: null,
      visibility: 'PRIVATE',
      status: StrategyStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }),
  };
}

function makePort(points: readonly EquityPoint[]): { dailyPoints: jest.Mock } {
  return { dailyPoints: jest.fn().mockResolvedValue(points) };
}

function serviceWith(
  points: readonly EquityPoint[] = [],
  strategyService: StrategyServiceMock = makeStrategyService(),
): {
  service: RiskService;
  strategyService: StrategyServiceMock;
  equitySeries: { dailyPoints: jest.Mock };
} {
  const equitySeries = makePort(points);

  return {
    service: new RiskService(strategyService as unknown as StrategyService, equitySeries),
    strategyService,
    equitySeries,
  };
}

function isoDay(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** `count` observations on consecutive UTC days starting 2026-01-01. */
function days(count: number): string[] {
  const dates: string[] = [];
  let day = Date.parse('2026-01-01T00:00:00.000Z');

  for (let index = 0; index < count; index += 1) {
    dates.push(isoDay(day));
    day += DAY_IN_MILLISECONDS;
  }

  return dates;
}

function flatSeries(count: number): EquityPoint[] {
  return days(count).map((observedAt) => ({ observedAt, equity: '100' }));
}

/** Consecutive except for one skipped day, so the contract is broken once. */
function gappedSeries(count: number): EquityPoint[] {
  let day = Date.parse('2026-01-01T00:00:00.000Z');

  return Array.from({ length: count }, (_unused, index) => {
    const observedAt = isoDay(day);
    day += (index === 10 ? 2 : 1) * DAY_IN_MILLISECONDS;

    return { observedAt, equity: String(100 + index) };
  });
}

/**
 * The reference series: 31 observations starting at 100 and alternating ×1.10
 * and ×0.90, giving thirty returns of alternating sign.
 *
 * Multiplied in decimal, not in binary floating point: `100 * 1.1` in doubles
 * drifts far enough to spoil the exact ±0.1 returns this fixture exists to
 * produce, and the published constants beside it would no longer follow.
 */
function referenceSeries(): EquityPoint[] {
  let day = Date.parse('2026-01-01T00:00:00.000Z');
  let equity = new Prisma.Decimal(100);

  return Array.from({ length: 31 }, (_unused, index) => {
    if (index > 0) {
      equity = equity.times(index % 2 === 1 ? '1.1' : '0.9');
    }

    const observedAt = isoDay(day);
    day += DAY_IN_MILLISECONDS;

    return { observedAt, equity: equity.toFixed() };
  });
}

describe('RiskService', () => {
  describe('insufficient evidence', () => {
    it('reports NO_HISTORY when the strategy has no equity history at all', async () => {
      const { service, equitySeries } = serviceWith([]);

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.reason).toBe('NO_HISTORY');
      expect(result.riskLevel).toBeNull();
      expect(result.metrics).toBeNull();
      expect(equitySeries.dailyPoints).toHaveBeenCalledWith(STRATEGY_ID);
    });

    it('reports INSUFFICIENT_HISTORY below thirty observations, before looking at flatness', async () => {
      // Flat as well as short. If flatness were checked first this would read
      // NO_ACTIVITY, which would claim the evidence said "nothing happened"
      // when in fact there is not enough of it to say anything.
      const { service } = serviceWith(flatSeries(29));

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.reason).toBe('INSUFFICIENT_HISTORY');
      expect(result.evidence.observations).toBe(29);
      expect(result.evidence.firstObservedAt).toBe('2026-01-01');
      expect(result.evidence.lastObservedAt).toBe('2026-01-29');
    });

    it('reports NO_ACTIVITY when a long enough series never moved', async () => {
      const { service } = serviceWith(flatSeries(30));

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.reason).toBe('NO_ACTIVITY');
      expect(result.evidence.observations).toBe(30);
      expect(result.riskLevel).toBeNull();
      expect(result.metrics).toBeNull();
    });

    it('reports INVALID_SERIES before counting, even when the count would suffice', async () => {
      // Forty observations, rising, one day missing. Counting first would
      // evaluate it; validation first refuses it, because a series with a hole
      // in it describes a history it does not actually contain.
      const { service } = serviceWith(gappedSeries(40));

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.reason).toBe('INVALID_SERIES');
      expect(result.riskLevel).toBeNull();
      expect(result.metrics).toBeNull();
    });

    it('reports no dates for a series it refused to trust', async () => {
      const { service } = serviceWith(gappedSeries(40));

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.evidence.firstObservedAt).toBeNull();
      expect(result.evidence.lastObservedAt).toBeNull();
    });

    it('echoes the policy so a client need not hard-code it', async () => {
      const { service } = serviceWith([]);

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.evidence.requiredObservations).toBe(30);
      expect(result.evidence.sampleDescription).toBe('daily equity points');
    });

    it('stamps the supplied evaluation time rather than the wall clock', async () => {
      const { service } = serviceWith([]);

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.evaluatedAt).toBe(NOW.toISOString());
    });
  });

  describe('evaluation', () => {
    it('evaluates a series of thirty-one observations with the reference figures', async () => {
      const { service } = serviceWith(referenceSeries());

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('EVALUATED');
      expect(result.reason).toBeNull();
      expect(result.riskLevel).toBe('HIGH');
      expect(result.metrics).toEqual({
        maxDrawdown: 0.2181,
        dailyVolatility: 0.1017,
        annualisedVolatility: 1.6146,
      });
      expect(result.evidence.observations).toBe(31);
      expect(result.evidence.firstObservedAt).toBe('2026-01-01');
      expect(result.evidence.lastObservedAt).toBe('2026-01-31');
      expect(result.evaluatedAt).toBe(NOW.toISOString());
    });

    it('treats exactly thirty observations as enough', async () => {
      const { service } = serviceWith(referenceSeries().slice(0, 30));

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.status).toBe('EVALUATED');
      expect(result.riskLevel).not.toBeNull();
      expect(result.metrics).not.toBeNull();
    });

    it('stamps the supplied evaluation time on a successful reading too', async () => {
      const { service } = serviceWith(referenceSeries());

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(result.evaluatedAt).toBe(NOW.toISOString());
    });

    it('never publishes a level without the metrics that justify it', async () => {
      const evaluated = await serviceWith(referenceSeries()).service.evaluate(
        VIEWER_ID,
        STRATEGY_ID,
        NOW,
      );
      const insufficient = await serviceWith([]).service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(evaluated.metrics).not.toBeNull();
      expect(insufficient.riskLevel).toBeNull();
      expect(insufficient.metrics).toBeNull();
    });

    it('publishes risk and nothing else', async () => {
      const result = await serviceWith(referenceSeries()).service.evaluate(
        VIEWER_ID,
        STRATEGY_ID,
        NOW,
      );

      expect(Object.keys(result).sort()).toEqual([
        'evaluatedAt',
        'evidence',
        'metrics',
        'reason',
        'riskLevel',
        'status',
        'strategyId',
      ]);
      expect(Object.keys(result.metrics ?? {}).sort()).toEqual([
        'annualisedVolatility',
        'dailyVolatility',
        'maxDrawdown',
      ]);
      expect(JSON.stringify(result)).not.toContain('return');
      expect(JSON.stringify(result)).not.toContain('price');
      expect(JSON.stringify(result)).not.toContain('pnl');
    });
  });

  describe('visibility', () => {
    it('resolves the strategy through the strategy service rather than reading it directly', async () => {
      const { service, strategyService } = serviceWith([]);

      await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(strategyService.findVisibleTo).toHaveBeenCalledWith(VIEWER_ID, STRATEGY_ID);
    });

    it('propagates a not-found failure untouched rather than translating it', async () => {
      const failure = DomainException.notFound('Strategy', STRATEGY_ID);
      const strategyService = makeStrategyService();
      strategyService.findVisibleTo.mockRejectedValue(failure);
      const { service } = serviceWith([], strategyService);

      await expect(service.evaluate(VIEWER_ID, STRATEGY_ID, NOW)).rejects.toBe(failure);

      // 404, never 403: a strategy the viewer may not see must not be confirmed
      // as existing, and this module must not soften that into an admission.
      expect(failure.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(failure.getStatus()).toBe(404);
      expect(failure.getStatus()).not.toBe(403);
    });

    it('measures an archived strategy for its owner, because history outlives status', async () => {
      const { service, strategyService } = serviceWith(
        [],
        makeStrategyService({ status: StrategyStatus.ARCHIVED }),
      );

      const result = await service.evaluate(VIEWER_ID, STRATEGY_ID, NOW);

      expect(strategyService.findVisibleTo).toHaveBeenCalled();
      expect(result.strategyId).toBe(STRATEGY_ID);
      expect(result.status).toBe('INSUFFICIENT_DATA');
    });
  });
});
