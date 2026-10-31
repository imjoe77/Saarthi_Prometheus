import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { reportFailed } from '../src/modules/market-data/importer/import-report';
import { importMarketData } from '../src/modules/market-data/importer/market-data-importer';
import { runSimulation } from '../src/modules/simulation/persistence/simulation-store';
import { findRule } from '../src/modules/simulation/rules/rule-catalog';
import type { SimulationRule } from '../src/modules/simulation/rules/simulation-rule';
import { mintToken } from './token-minting';

/**
 * The shape of a risk evaluation as it comes back over HTTP.
 *
 * Declared, as everywhere, so a DTO rename surfaces as a compile error here.
 */
interface RiskPayload {
  strategyId: string;
  status: string;
  reason: string | null;
  riskLevel: string | null;
  metrics: {
    maxDrawdown: number;
    dailyVolatility: number;
    annualisedVolatility: number;
  } | null;
  evidence: {
    observations: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    requiredObservations: number;
    sampleDescription: string;
  };
  evaluatedAt: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

/**
 * MODULE 06b - the guard between the market-data tables and the Risk Engine.
 *
 * Every other suite that reads equity arrives at it through a simulation the
 * seed computed. This suite arrives through a simulation it computes itself,
 * on a strategy and user it creates itself, and then proceeds to *damage the
 * curve* in controlled ways and measure what the Risk Engine answers - because
 * the property that deserves an e2e is not that a healthy curve is evaluated,
 * but that a broken one is refused instead of being measured.
 *
 * The series contract lives in `risk/domain/series.ts` and the fixings in the
 * module wiring: `risk.module.ts` replaced the stand-in empty series with
 * `PersistedDailyValueSeries`, so the Risk Engine now reads what a simulation
 * actually stored. That binding is the whole point of the module swap and the
 * reason this suite is an integration test rather than a unit test.
 *
 * WHAT THE SUITE NEVER DOES: it never runs the market seed (that would reach
 * into the three expert strategies), and it never tidies someone else's rows.
 * Each test owns one private strategy; afterAll deletes simulation rows before
 * strategies because `strategy_simulations.strategy_id` is ON DELETE RESTRICT.
 */
describe('Market data guard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];
  const createdStrategyIds: string[] = [];

  let buyholdRule: SimulationRule;

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);

    const report = await importMarketData(prisma);
    expect(reportFailed(report)).toBe(false);

    const rule = findRule('buyhold-btc');
    if (rule === null) {
      throw new Error('buyhold-btc must be in the rule catalogue');
    }
    buyholdRule = rule;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: { in: createdStrategyIds } },
      });
      await prisma.strategyFill.deleteMany({ where: { simulationId: { in: createdStrategyIds } } });
      await prisma.strategySimulation.deleteMany({
        where: { strategyId: { in: createdStrategyIds } },
      });
      await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** An ACTIVE user owning one private, never-simulated strategy each. */
  async function newPaperAccount(): Promise<{ token: string; userId: string; strategyId: string }> {
    const token = await mintToken({
      subject: `google:guard-${randomUUID()}`,
      email: `guard-${randomUUID()}@market-guard.test`,
    });

    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(me.body.id);

    const created = await http()
      .post('/api/strategies')
      .set(bearer(token))
      .send({ name: `Guard strategy ${randomUUID().slice(0, 8)}`, visibility: 'PRIVATE' })
      .expect(201);

    const strategyId = created.body.id as string;
    createdStrategyIds.push(strategyId);

    return { token, userId: me.body.id, strategyId };
  }

  async function evaluate(userToken: string, strategyId: string): Promise<RiskPayload> {
    const response = await http()
      .get(`/api/risk/strategies/${strategyId}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as RiskPayload;
  }

  function expectDomainError(
    response: request.Response,
    code: DomainException['code'],
    status: number,
  ): ErrorPayload {
    const body = response.body as ErrorPayload;
    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    return body;
  }

  /** Fingerprint of every row this strategy's evaluation could plausibly read. */
  async function fingerprint(strategyId: string): Promise<string> {
    const [simulation, fills, balances] = await Promise.all([
      prisma.strategySimulation.findUnique({ where: { strategyId } }),
      prisma.strategyFill.findMany({ where: { simulationId: strategyId }, orderBy: { sequenceNo: 'asc' } }),
      prisma.strategyDailyBalance.findMany({ where: { simulationId: strategyId }, orderBy: { day: 'asc' } }),
    ]);

    return JSON.stringify({ simulation, fills, balances });
  }

  function expectExcellent(body: RiskPayload): void {
    expect(body.status).toBe('EVALUATED');
    expect(body.reason).toBeNull();
    expect(body.metrics).not.toBeNull();
    expect(body.riskLevel).toMatch(/^(LOW|MEDIUM|HIGH)$/);

    if (body.metrics === null) {
      throw new Error('expected metrics on an EVALUATED reading');
    }
    for (const metric of [body.metrics.maxDrawdown, body.metrics.dailyVolatility, body.metrics.annualisedVolatility]) {
      expect(Number.isFinite(metric)).toBe(true);
      expect(metric).toBeGreaterThan(0);
    }
  }

  function expectInsufficient(body: RiskPayload, reason: string): void {
    expect(body.status).toBe('INSUFFICIENT_DATA');
    expect(body.reason).toBe(reason);
    expect(body.riskLevel).toBeNull();
    expect(body.metrics).toBeNull();
  }

  // ---------------------------------------------------------------------------

  describe('the guard against measuring nothing', () => {
    it('refuses to state anything about a strategy the market data never covered', async () => {
      const account = await newPaperAccount();
      const body = await evaluate(account.token, account.strategyId);

      expectInsufficient(body, 'NO_HISTORY');
      expect(body.evidence.observations).toBe(0);
      expect(body.evidence.firstObservedAt).toBeNull();
      expect(body.evidence.lastObservedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------

  describe('the guard swaps the empty series for the persisted one', () => {
    it('measures the simulated curve once it exists, with the window it actually ran', async () => {
      const account = await newPaperAccount();
      await runSimulation(prisma, account.strategyId, buyholdRule);

      const body = await evaluate(account.token, account.strategyId);

      expectExcellent(body);
      expect(body.evidence.observations).toBe(644);
      expect(body.evidence.firstObservedAt).toBe('2025-01-01');
      expect(body.evidence.lastObservedAt).toBe('2026-10-06');
      expect(body.evidence.requiredObservations).toBe(30);
      expect(body.evidence.sampleDescription).toBe('daily equity points');
      expect(() => new Date(body.evaluatedAt).toISOString()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------

  describe('the guard against a torn curve', () => {
    it('refuses a series with a day missing in the middle, and heals when recomputed', async () => {
      const account = await newPaperAccount();
      await runSimulation(prisma, account.strategyId, buyholdRule);

      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: account.strategyId, day: fromIsoMidnight('2025-02-10') },
      });

      const torn = await evaluate(account.token, account.strategyId);
      expectInsufficient(torn, 'INVALID_SERIES');
      expect(torn.evidence.observations).toBe(643);

      await runSimulation(prisma, account.strategyId, buyholdRule);
      const healed = await evaluate(account.token, account.strategyId);
      expectExcellent(healed);
      expect(healed.evidence.observations).toBe(644);
    });

    it('refuses a series that silently extends before the simulation window', async () => {
      const account = await newPaperAccount();
      await runSimulation(prisma, account.strategyId, buyholdRule);

      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: account.strategyId, day: fromIsoMidnight('2025-01-01') },
      });
      await prisma.strategyDailyBalance.create({
        data: {
          simulationId: account.strategyId,
          day: fromIsoMidnight('2024-12-31'),
          cash: new Prisma.Decimal('100000'),
          positionQty: new Prisma.Decimal('0'),
          positionValue: new Prisma.Decimal('0'),
          value: new Prisma.Decimal('100000'),
        },
      });

      const extended = await evaluate(account.token, account.strategyId);
      expectInsufficient(extended, 'INVALID_SERIES');
    });

    it('reports the true window when history is pruned from the front rather than guessing', async () => {
      const account = await newPaperAccount();
      await runSimulation(prisma, account.strategyId, buyholdRule);

      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: account.strategyId, day: fromIsoMidnight('2025-01-01') },
      });

      const body = await evaluate(account.token, account.strategyId);

      expectExcellent(body);
      expect(body.evidence.observations).toBe(643);
      expect(body.evidence.firstObservedAt).toBe('2025-01-02');
      expect(body.evidence.lastObservedAt).toBe('2026-10-06');
    });
  });

  // ---------------------------------------------------------------------------

  describe('the guard leaves the evidence alone', () => {
    it('moves no row whether it evaluates the curve or refuses it', async () => {
      const account = await newPaperAccount();
      await runSimulation(prisma, account.strategyId, buyholdRule);

      const healthyBefore = await fingerprint(account.strategyId);
      await evaluate(account.token, account.strategyId);
      expect(await fingerprint(account.strategyId)).toBe(healthyBefore);

      await prisma.strategyDailyBalance.deleteMany({
        where: { simulationId: account.strategyId, day: fromIsoMidnight('2025-02-10') },
      });

      const tornBefore = await fingerprint(account.strategyId);
      const refused = await evaluate(account.token, account.strategyId);
      expectInsufficient(refused, 'INVALID_SERIES');
      expect(await fingerprint(account.strategyId)).toBe(tornBefore);
    });
  });

  // ---------------------------------------------------------------------------

  describe('boundaries around the guard', () => {
    it('answers 400 for an id that is not a UUID', async () => {
      const account = await newPaperAccount();
      await http().get('/api/risk/strategies/not-a-uuid').set(bearer(account.token)).expect(400);
    });

    it('still hides a private strategy from a stranger', async () => {
      const owner = await newPaperAccount();
      await runSimulation(prisma, owner.strategyId, buyholdRule);

      const stranger = await newPaperAccount();

      const response = await http()
        .get(`/api/risk/strategies/${owner.strategyId}`)
        .set(bearer(stranger.token))
        .expect(404);

      expectDomainError(response, 'NOT_FOUND', 404);
    });
  });
});

/** Midnight UTC instant for a bare calendar day, exactly as rows store days. */
function fromIsoMidnight(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}