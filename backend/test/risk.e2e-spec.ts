import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { mintToken } from './token-minting';

/**
 * The shape of a risk evaluation as it comes back over HTTP, and of a failure
 * as the exception filter renders it.
 *
 * Both are declared rather than left as `Record<string, unknown>` so that a
 * field rename in the DTO surfaces here as a type error instead of as an
 * assertion that quietly stops comparing.
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
 * MODULE 06 - the Risk Engine over HTTP.
 *
 * Boots the real application against the real database, because the properties
 * this module most needs proving are properties of the whole application: that
 * the global guard still covers a route added by a later module, that a
 * strategy another user may not see answers 404 rather than 403, and that a
 * request for a risk evaluation moves no row anywhere.
 *
 * Two boundaries are asserted as carefully as the happy paths, because they are
 * the ones a later module could quietly erode:
 *
 *  - NO EQUITY HISTORY EXISTS, SO NOTHING IS ESTIMATED. Today's honest answer
 *    is INSUFFICIENT_DATA with a reason and null figures. A future suite may
 *    replace that expectation when a producer of equity points exists, but it
 *    must replace it deliberately - a zero standing in for an absent
 *    measurement is the failure this module exists to make impossible.
 *  - NOTHING IS WRITTEN. The read-only fingerprint covers every row this
 *    request could plausibly touch, before and after. The shared `assets`
 *    catalogue is deliberately outside it: it is reference data another suite
 *    may write while this one runs, and fingerprinting it here would assert
 *    something about somebody else's test rather than about this endpoint.
 *
 * Isolation: users are created through the real auth path with a UUID in the
 * email, and purged in `afterAll`. Strategies are deleted before their users
 * because `strategies.owner_id` is ON DELETE RESTRICT, which this suite relies
 * on and also verifies.
 */
describe('Risk (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@risk.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  async function createStrategy(
    user: { token: string },
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; status: string; visibility: string }> {
    const response = await http()
      .post('/api/strategies')
      .set(bearer(user.token))
      .send({ name: `Strategy ${randomUUID().slice(0, 8)}`, ...body })
      .expect(201);

    return response.body;
  }

  async function evaluate(userToken: string, strategyId: string): Promise<RiskPayload> {
    const response = await http()
      .get(`/api/risk/strategies/${strategyId}`)
      .set(bearer(userToken))
      .expect(200);

    return response.body as RiskPayload;
  }

  /** Asserts a failure carries our stable code, and returns the body. */
  function expectDomainError(
    response: request.Response,
    code: DomainException['code'],
    status: HttpStatus,
  ): ErrorPayload {
    const body = response.body as ErrorPayload;
    expect(body.code).toBe(code);
    expect(response.status).toBe(status);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');

    return body;
  }

  /** The reason the whole release reads INSUFFICIENT_DATA: nothing records equity. */
  function expectNoHistory(body: RiskPayload): void {
    expect(body.status).toBe('INSUFFICIENT_DATA');
    expect(body.reason).toBe('NO_HISTORY');
    expect(body.riskLevel).toBeNull();
    expect(body.metrics).toBeNull();
    expect(body.evidence.observations).toBe(0);
    expect(body.evidence.firstObservedAt).toBeNull();
    expect(body.evidence.lastObservedAt).toBeNull();
  }

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses the only risk route without a token', async () => {
      const user = await createUser('surface');

      await http().get(`/api/risk/strategies/${randomUUID()}`).expect(401);
      await http().get(`/api/risk/strategies/${user.userId}`).expect(401);
    });

    it('exposes no batch endpoint, which would be a second contract to keep honest', async () => {
      const user = await createUser('nobatch');

      // Documented, not built: `GET /api/risk/strategies?ids=...` has no
      // implementation, and a 404 here is what keeps that true.
      await http().get('/api/risk/strategies').set(bearer(user.token)).expect(404);
      await http().get('/api/risk/strategies?ids=1').set(bearer(user.token)).expect(404);
    });
  });

  describe('input boundaries', () => {
    it('answers 400 for an id that is not a uuid', async () => {
      const user = await createUser('malformed');

      // Rejected by the pipe, before it reaches the service or the database.
      await http().get('/api/risk/strategies/not-a-uuid').set(bearer(user.token)).expect(400);
    });

    it('answers 404 for an id that does not exist', async () => {
      const user = await createUser('missing');

      const response = await http()
        .get(`/api/risk/strategies/${randomUUID()}`)
        .set(bearer(user.token))
        .expect(404);

      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });
  });

  describe('visibility', () => {
    it('answers 404 for another user’s private strategy, never 403', async () => {
      const owner = await createUser('privateowner');
      const stranger = await createUser('privatestranger');
      const strategy = await createStrategy(owner);

      const response = await http()
        .get(`/api/risk/strategies/${strategy.id}`)
        .set(bearer(stranger.token))
        .expect(404);

      // 403 would confirm the strategy exists to somebody who must not learn
      // that it does; 404 says only that there is nothing here for them.
      expect(response.status).not.toBe(403);
      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });

    it('answers 404 for another user’s archived strategy', async () => {
      const owner = await createUser('archivedowner');
      const stranger = await createUser('archivedstranger');
      const strategy = await createStrategy(owner);

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(owner.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const response = await http()
        .get(`/api/risk/strategies/${strategy.id}`)
        .set(bearer(stranger.token))
        .expect(404);

      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });
  });

  describe('evaluation', () => {
    it('reports the owner’s active strategy as having no history yet', async () => {
      const owner = await createUser('owneractive');
      const strategy = await createStrategy(owner);

      const body = await evaluate(owner.token, strategy.id);

      expect(body.strategyId).toBe(strategy.id);
      expectNoHistory(body);
      expect(typeof body.evaluatedAt).toBe('string');
    });

    it('reports a public strategy to another user in exactly the same shape', async () => {
      const owner = await createUser('publicowner');
      const reader = await createUser('publicreader');
      const strategy = await createStrategy(owner, { visibility: 'PUBLIC' });

      const asOwner = await evaluate(owner.token, strategy.id);
      const asReader = await evaluate(reader.token, strategy.id);

      expectNoHistory(asOwner);
      expectNoHistory(asReader);
      expect(asReader.strategyId).toBe(asOwner.strategyId);
      expect(asReader.status).toBe(asOwner.status);
      expect(asReader.reason).toBe(asOwner.reason);
      expect(asReader.evidence).toEqual(asOwner.evidence);
    });

    it('reports an archived strategy to its owner, because history outlives status', async () => {
      const owner = await createUser('ownerarchived');
      const strategy = await createStrategy(owner);

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(owner.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const body = await evaluate(owner.token, strategy.id);

      expect(body.strategyId).toBe(strategy.id);
      expectNoHistory(body);
    });

    it('states the evidence it would need, so a client need not hard-code the policy', async () => {
      const owner = await createUser('evidence');
      const strategy = await createStrategy(owner);

      const body = await evaluate(owner.token, strategy.id);

      expect(body.evidence.requiredObservations).toBe(30);
      expect(body.evidence.sampleDescription).toBe('daily equity points');
      expect(body.evidence.observations).toBe(0);
    });
  });

  describe('honest values only', () => {
    it('never reports a metric it could not measure', async () => {
      const owner = await createUser('nofigures');
      const strategy = await createStrategy(owner);

      const body = await evaluate(owner.token, strategy.id);
      const serialised = JSON.stringify(body);

      expect(body.riskLevel).toBeNull();
      expect(body.metrics).toBeNull();
      expect(body).not.toHaveProperty('return');
      expect(body).not.toHaveProperty('price');
      expect(body).not.toHaveProperty('equity');
      expect(body).not.toHaveProperty('pnl');
      expect(body.evidence).not.toHaveProperty('equity');
      expect(serialised).not.toContain('NaN');
      expect(serialised).not.toContain('Infinity');
    });

    it('returns exactly the documented fields and no more', async () => {
      const owner = await createUser('shape');
      const strategy = await createStrategy(owner);

      const body = await evaluate(owner.token, strategy.id);

      expect(Object.keys(body).sort()).toEqual([
        'evaluatedAt',
        'evidence',
        'metrics',
        'reason',
        'riskLevel',
        'status',
        'strategyId',
      ]);
      expect(Object.keys(body.evidence).sort()).toEqual([
        'firstObservedAt',
        'lastObservedAt',
        'observations',
        'requiredObservations',
        'sampleDescription',
      ]);
    });
  });

  describe('read-only', () => {
    it('changes no row, and creates no table', async () => {
      const owner = await createUser('readonlyowner');
      const reader = await createUser('readonlyreader');
      const strategy = await createStrategy(owner, { visibility: 'PUBLIC' });
      const userIds = [owner.userId, reader.userId];

      const fingerprint = async () => {
        const [strategyRow, users, wallets, balances, movements, accounts] = await Promise.all([
          prisma.strategy.findUniqueOrThrow({ where: { id: strategy.id } }),
          prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: 'asc' } }),
          prisma.wallet.findMany({ where: { userId: { in: userIds } }, orderBy: { id: 'asc' } }),
          prisma.walletBalance.findMany({
            where: { wallet: { userId: { in: userIds } } },
            orderBy: { assetId: 'asc' },
          }),
          prisma.transaction.findMany({
            where: { wallet: { userId: { in: userIds } } },
            orderBy: { createdAt: 'asc' },
          }),
          prisma.authAccount.findMany({ where: { userId: { in: userIds } } }),
        ]);

        return JSON.stringify({ strategyRow, users, wallets, balances, movements, accounts });
      };

      const before = await fingerprint();

      await evaluate(owner.token, strategy.id);
      await evaluate(owner.token, strategy.id);
      await evaluate(reader.token, strategy.id);

      expect(await fingerprint()).toBe(before);
    });

    it('leaves no risk table behind, because a risk reading is derived, not stored', async () => {
      const owner = await createUser('notable');
      const strategy = await createStrategy(owner);

      await evaluate(owner.token, strategy.id);

      const tables = await prisma.$queryRaw<{ tableName: string }[]>`
        SELECT table_name AS "tableName" FROM information_schema.tables WHERE table_schema = 'public'
      `;
      const names = tables.map((table) => table.tableName);

      for (const expected of [
        'users',
        'auth_accounts',
        'strategies',
        'wallets',
        'assets',
        'wallet_balances',
        'transactions',
      ]) {
        expect(names).toContain(expected);
      }

      expect(names.filter((name) => name.includes('risk'))).toEqual([]);
      expect(names.filter((name) => name.includes('equity'))).toEqual([]);
      expect(names.filter((name) => name.includes('trade'))).toEqual([]);
    });
  });
});
