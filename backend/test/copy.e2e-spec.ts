import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { CopyWorkerService } from '../src/modules/copy/copy-worker.service';
import { FakeMarketDataProvider } from '../src/modules/live-data/providers/fake-market-data-provider';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * The nil keyset cursor a follow is seeded with - the point that means "copy
 * from here", so any fill after it is fair game and any fill before it is not.
 */
const NIL_CURSOR = '00000000-0000-0000-0000-000000000000';

interface PageEnvelope<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface FollowPayload {
  strategyId: string;
  strategyName: string;
  strategyStatus: 'ACTIVE' | 'ARCHIVED';
  status: 'ACTIVE' | 'UNFOLLOWED';
  allocationFraction: string;
  followedAt: string;
  unfollowedAt: string | null;
  lastProcessedAt: string | null;
  copiedCount: number;
  rejectedCount: number;
  eligibility: string;
}

interface FollowStatusPayload extends FollowPayload {
  hasPendingEvents: boolean;
}

interface CopyEventPayload {
  expertOrderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  expertQuantity: string;
  expertFillPrice: string | null;
  expertFilledAt: string;
  allocationFraction: string;
  quantity: string | null;
  fillPrice: string | null;
  gross: string | null;
  realizedPnl: string | null;
  status: 'COPIED' | 'REJECTED';
  rejectReason: string | null;
  processedAt: string;
}

interface CopyAccountPayload {
  currency: string;
  cash: string;
  realizedPnl: string;
  openedAt: string;
  lastActivityAt: string;
}

interface CopyPositionPayload {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  stale: boolean;
  openedAt: string;
  lastActivityAt: string;
}

interface FollowAccountPayload {
  account: CopyAccountPayload | null;
  positions: CopyPositionPayload[];
  walletUsdt: string;
}

interface AggregateAccountPayload {
  followCount: number;
  cash: string;
  realizedPnl: string;
  walletUsdt: string;
  positions: Array<{
    symbol: string;
    direction: 'LONG' | 'SHORT';
    quantity: string;
    averageEntryPrice: string;
    markPrice: string | null;
    marketValue: string | null;
    unrealizedPnl: string | null;
    stale: boolean;
    followCount: number;
  }>;
}

interface FollowerPayload {
  followerId: string;
  maskedEmail: string;
  status: 'ACTIVE' | 'UNFOLLOWED';
  allocationFraction: string;
  followedAt: string;
  unfollowedAt: string | null;
  copiedCount: number;
  rejectedCount: number;
}

interface SyncPayload {
  consumed: number;
  status: FollowStatusPayload;
}

interface PaperOrderPayload {
  orderId: string;
  status: 'FILLED' | 'REJECTED';
  fillPrice: string | null;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

/**
 * MODULE 07 - copy trading over HTTP, end to end.
 *
 * WHY NOTHING HERE NEEDS ALPACA. A copy executes at the expert's committed
 * fill price, so the engine reads a number the paper ledger already stored and
 * needs no feed of its own. The suite programs the deterministic fake the way
 * Module 06c's suite does, and every expected balance below is arithmetic on
 * those seeded prices.
 *
 * THE WORKER IS OFF, THE ROUTE IS NOT. `COPY_WORKER_ENABLED` is cleared before
 * the app boots so no background timer can move a balance between a request and
 * the assertion about it. The engine itself is still exercised for real: the
 * sync route runs the identical loop, and `worker.runOnce()` is called directly
 * where the background pass is the subject.
 *
 * CRYPTO ONLY FOR FILLS. `MARKET_CLOSED` is decided by the real clock, so a
 * stock fill would make these assertions time-of-day dependent. `SOL/USD`
 * trades continuously.
 *
 * Isolation: users are created through the real auth path, and every row they
 * own - copy events, follows, paper orders, strategies, wallets, users - is
 * purged in `afterAll`.
 */
describe('Copy Trading (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeMarketDataProvider;
  let worker: CopyWorkerService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // Both must be set before `createApp()`: the market provider is bound from
    // config while the module graph is built, and the worker reads its switch
    // during construction.
    process.env['MARKET_DATA_PROVIDER'] = 'fake';
    process.env['COPY_WORKER_ENABLED'] = 'false';

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    fake = app.get(FakeMarketDataProvider);
    worker = app.get(CopyWorkerService);
    walletService = app.get(WalletService);

    // The USDT balance every order's notional - and every copy's - is
    // checked against.
    await seedAssets(prisma);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const ownerWhere = { ownerId: { in: createdUserIds } };
      const strategies = await prisma.strategy.findMany({ where: ownerWhere, select: { id: true } });
      const strategyIds = strategies.map((strategy) => strategy.id);

      // Copy rows are reachable from either side of the follow - by the follower
      // (whose strategy may belong to somebody else) or by the strategy - so
      // both keys are purged rather than assuming one of them is enough.
      const followWhere = {
        OR: [{ followerId: { in: createdUserIds } }, { strategyId: { in: strategyIds } }],
      };

      await prisma.copyEvent.deleteMany({ where: followWhere });
      await prisma.copyPosition.deleteMany({ where: followWhere });
      await prisma.copyAccount.deleteMany({ where: followWhere });
      await prisma.strategyFollow.deleteMany({ where: followWhere });

      if (strategyIds.length > 0) {
        await prisma.paperOrder.deleteMany({ where: { strategyId: { in: strategyIds } } });
        await prisma.paperPosition.deleteMany({ where: { strategyId: { in: strategyIds } } });
        await prisma.paperAccount.deleteMany({ where: { strategyId: { in: strategyIds } } });
      }

      await prisma.strategy.deleteMany({ where: ownerWhere });
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Lets two statements land in different milliseconds when a boundary matters. */
  const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Credits the user's real USDT balance.
   *
   * Both halves of a copy are gated by the wallet: the expert's order needs
   * the notional covered, and so does the follower's copy of it. The credit
   * goes through the real wallet ledger, so the balance the gate reads is a
   * balance the system actually holds.
   */
  async function fundUsdt(userId: string, amount: string): Promise<void> {
    const wallet = await prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDT' } });

    await walletService.credit(wallet.id, asset.id, amount);
  }

  async function createUser(
    label: string,
    usdt = '1000000',
  ): Promise<{ token: string; userId: string; email: string }> {
    const email = `${label}-${randomUUID()}@copy.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id as string);

    await fundUsdt(response.body.id as string, usdt);

    return { token, userId: response.body.id as string, email };
  }

  /** Creates a strategy. PUBLIC by default: that is the posture a follow requires. */
  async function createStrategy(
    token: string,
    label: string,
    visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
  ): Promise<string> {
    const response = await http()
      .post('/api/strategies')
      .set(bearer(token))
      .send({ name: `${label}-${randomUUID()}`, description: 'copy e2e', visibility })
      .expect(201);

    return response.body.id as string;
  }

  function placeOrder(
    token: string,
    strategyId: string,
    options: { quantity?: string; side?: 'LONG' | 'SHORT'; symbol?: string } = {},
  ): request.Test {
    return http()
      .post(`/api/strategies/${strategyId}/paper/orders`)
      .set(bearer(token))
      .send({
        clientRequestId: randomUUID(),
        symbol: options.symbol ?? 'SOL/USD',
        side: options.side ?? 'LONG',
        quantity: options.quantity ?? '1',
      });
  }

  function seedFreshQuote(symbol: string, bid: string, ask: string): void {
    fake.seedQuote(symbol, ask, { bid, ask, asOf: new Date().toISOString() });
  }

  function follow(token: string, strategyId: string, allocationFraction: string): request.Test {
    return http()
      .post('/api/copy/follows')
      .set(bearer(token))
      .send({ strategyId, allocationFraction });
  }

  function sync(token: string, strategyId: string): request.Test {
    return http().post(`/api/copy/follows/${strategyId}/sync`).set(bearer(token));
  }

  async function status(token: string, strategyId: string): Promise<FollowStatusPayload> {
    const response = await http()
      .get(`/api/copy/follows/${strategyId}`)
      .set(bearer(token))
      .expect(200);
    return response.body as FollowStatusPayload;
  }

  async function copyOrders(token: string, strategyId: string): Promise<CopyEventPayload[]> {
    const response = await http()
      .get(`/api/copy/follows/${strategyId}/orders`)
      .set(bearer(token))
      .expect(200);
    const body = response.body as PageEnvelope<CopyEventPayload>;
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'page', 'total', 'totalPages']);
    return body.items;
  }

  async function followAccount(token: string, strategyId: string): Promise<FollowAccountPayload> {
    const response = await http()
      .get(`/api/copy/follows/${strategyId}/account`)
      .set(bearer(token))
      .expect(200);
    return response.body as FollowAccountPayload;
  }

  async function aggregateAccount(token: string): Promise<AggregateAccountPayload> {
    const response = await http().get('/api/copy/account').set(bearer(token)).expect(200);
    return response.body as AggregateAccountPayload;
  }

  async function followList(
    token: string,
    query = '',
  ): Promise<PageEnvelope<FollowPayload>> {
    const response = await http().get(`/api/copy/follows${query}`).set(bearer(token)).expect(200);
    return response.body as PageEnvelope<FollowPayload>;
  }

  async function followers(
    token: string,
    strategyId: string,
  ): Promise<PageEnvelope<FollowerPayload>> {
    const response = await http()
      .get(`/api/copy/strategies/${strategyId}/followers`)
      .set(bearer(token))
      .expect(200);
    return response.body as PageEnvelope<FollowerPayload>;
  }

  async function paperOrders(token: string, strategyId: string): Promise<PaperOrderPayload[]> {
    const response = await http()
      .get(`/api/strategies/${strategyId}/paper/orders`)
      .set(bearer(token))
      .expect(200);
    return response.body as PaperOrderPayload[];
  }

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

  /** An owner/follower pair with a public strategy, the minimum for any copy test. */
  async function fixture(label: string): Promise<{
    owner: { token: string; userId: string };
    follower: { token: string; userId: string };
    strategyId: string;
  }> {
    const owner = await createUser(`${label}-owner`);
    const follower = await createUser(`${label}-follower`);
    const strategyId = await createStrategy(owner.token, label);
    return { owner, follower, strategyId };
  }

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses every copy route without a token', async () => {
      const strategyId = randomUUID();

      await http().post('/api/copy/follows').send({ strategyId, allocationFraction: '1' }).expect(401);
      await http().get('/api/copy/follows').expect(401);
      await http().get(`/api/copy/follows/${strategyId}`).expect(401);
      await http().patch(`/api/copy/follows/${strategyId}`).send({ allocationFraction: '1' }).expect(401);
      await http().delete(`/api/copy/follows/${strategyId}`).expect(401);
      await http().post(`/api/copy/follows/${strategyId}/sync`).expect(401);
      await http().get(`/api/copy/follows/${strategyId}/orders`).expect(401);
      await http().get(`/api/copy/follows/${strategyId}/account`).expect(401);
      await http().get('/api/copy/account').expect(401);
      await http().get(`/api/copy/strategies/${strategyId}/followers`).expect(401);
    });

    it('rejects a strategy id that is not a UUID, because the route contract is a UUID', async () => {
      const user = await createUser('badid');

      await http().get('/api/copy/follows/joel').set(bearer(user.token)).expect(400);
      await http().post('/api/copy/follows/joel/sync').set(bearer(user.token)).expect(400);
      await http().delete('/api/copy/follows/joel').set(bearer(user.token)).expect(400);

      const response = await http()
        .post('/api/copy/follows')
        .set(bearer(user.token))
        .send({ strategyId: 'joel', allocationFraction: '1' })
        .expect(400);
      expectDomainError(response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);
    });
  });

  // ---------------------------------------------------------------------------

  describe('following', () => {
    it('creates a follow with the stated allocation, before any account exists', async () => {
      const { follower, strategyId } = await fixture('follow-new');

      const response = await follow(follower.token, strategyId, '0.25').expect(201);
      const created = response.body as FollowPayload;

      expect(created).toMatchObject({
        strategyId,
        strategyStatus: 'ACTIVE',
        status: 'ACTIVE',
        allocationFraction: '0.25',
        unfollowedAt: null,
        lastProcessedAt: null,
        copiedCount: 0,
        rejectedCount: 0,
        eligibility: 'ELIGIBLE',
      });
      expect(typeof created.strategyName).toBe('string');
      expect(Date.parse(created.followedAt)).toBeGreaterThan(0);

      const state = await status(follower.token, strategyId);
      expect(state).toMatchObject({ hasPendingEvents: false, copiedCount: 0, rejectedCount: 0 });

      // Nothing has been copied, so there is no pot to report - `null`, not a
      // balance that would invite arithmetic nobody can justify.
      const account = await followAccount(follower.token, strategyId);
      expect(account.account).toBeNull();
      expect(account.positions).toEqual([]);
      // The wallet balance is the gate every further copy has to pass, so it
      // is reported even when no copy has happened yet.
      expect(account.walletUsdt).toBe('1000000');

      const aggregate = await aggregateAccount(follower.token);
      expect(aggregate).toMatchObject({ followCount: 1, cash: '0', realizedPnl: '0', positions: [] });
    });

    it('lists the caller\'s follows with their outcome counts', async () => {
      const { follower, strategyId } = await fixture('follow-list');
      await follow(follower.token, strategyId, '1').expect(201);

      const page = await followList(follower.token);
      expect(page.total).toBe(1);
      expect(page.totalPages).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ strategyId, allocationFraction: '1', copiedCount: 0 });
    });

    it('refuses a duplicate follow with 409, because there is one row per follower per strategy', async () => {
      const { follower, strategyId } = await fixture('follow-dupe');
      await follow(follower.token, strategyId, '0.5').expect(201);

      const response = await follow(follower.token, strategyId, '0.5').expect(409);
      expectDomainError(response, 'CONFLICT', HttpStatus.CONFLICT);
    });

    it('refuses to follow your own strategy with 409', async () => {
      const owner = await createUser('follow-self');
      const strategyId = await createStrategy(owner.token, 'follow-self');

      const response = await follow(owner.token, strategyId, '1').expect(409);
      expectDomainError(response, 'CONFLICT', HttpStatus.CONFLICT);
    });

    it('reports a strategy you cannot see as 404, never 403', async () => {
      const stranger = await createUser('follow-stranger');
      const owner = await createUser('follow-hidden');
      const privateId = await createStrategy(owner.token, 'follow-hidden', 'PRIVATE');
      const missingId = randomUUID();

      const privateResponse = await follow(stranger.token, privateId, '1').expect(404);
      expectDomainError(privateResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      const missingResponse = await follow(stranger.token, missingId, '1').expect(404);
      expectDomainError(missingResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });

    const invalidAllocations: Array<[string, RegExp]> = [
      ['0', /greater than zero/],
      ['1.5', /cannot exceed 1/],
      ['abc', /positive decimal/],
      ['-0.1', /positive decimal/],
    ];

    it.each(invalidAllocations)('refuses the allocation %s with 400', async (allocationFraction, message) => {
      const { follower, strategyId } = await fixture('follow-allocation');
      const response = await follow(follower.token, strategyId, allocationFraction).expect(400);
      const body = expectDomainError(response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);
      expect(body.message).toMatch(message);
    });

    it('refuses a follow with no allocation at all, rather than defaulting to 1', async () => {
      const { follower, strategyId } = await fixture('follow-default');

      const response = await http()
        .post('/api/copy/follows')
        .set(bearer(follower.token))
        .send({ strategyId })
        .expect(400);
      expectDomainError(response, 'VALIDATION_FAILED', HttpStatus.BAD_REQUEST);
    });

    it('changes the allocation without rewriting what has already been copied', async () => {
      const { owner, follower, strategyId } = await fixture('follow-config');

      // Follow first: the cursor is seeded at the follow instant, so the fill
      // this test copies has to be the one after it.
      await follow(follower.token, strategyId, '0.25').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '4' }).expect(201);
      const first = await sync(follower.token, strategyId).expect(200);
      expect((first.body as SyncPayload).consumed).toBe(1);

      const response = await http()
        .patch(`/api/copy/follows/${strategyId}`)
        .set(bearer(follower.token))
        .send({ allocationFraction: '1' })
        .expect(200);
      expect((response.body as FollowPayload).allocationFraction).toBe('1');

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      // The event keeps the fraction it was sized with: 4 x 0.25 = 1 unit.
      expect(history[0]).toMatchObject({ allocationFraction: '0.25', quantity: '1' });

      await http()
        .patch(`/api/copy/follows/${strategyId}`)
        .set(bearer(follower.token))
        .send({ allocationFraction: '0' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------

  describe('copying a LONG', () => {
    it('mirrors a fraction of the expert fill at the expert price, and debits only the copy pot', async () => {
      const { owner, follower, strategyId } = await fixture('copy-buy');
      await follow(follower.token, strategyId, '0.25').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '4' }).expect(201);

      const pending = await status(follower.token, strategyId);
      expect(pending.hasPendingEvents).toBe(true);

      const response = await sync(follower.token, strategyId).expect(200);
      const result = response.body as SyncPayload;
      expect(result.consumed).toBe(1);
      expect(result.status).toMatchObject({
        hasPendingEvents: false,
        copiedCount: 1,
        rejectedCount: 0,
        eligibility: 'ELIGIBLE',
      });

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      const expertOrders = await paperOrders(owner.token, strategyId);
      expect(history[0]).toMatchObject({
        expertOrderId: expertOrders[0]?.orderId,
        symbol: 'SOL/USD',
        side: 'LONG',
        expertQuantity: '4',
        expertFillPrice: '100.5',
        allocationFraction: '0.25',
        quantity: '1',
        fillPrice: '100.5',
        gross: '100.5',
        status: 'COPIED',
        rejectReason: null,
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('99899.5'); // 100000 - (1 x 100.5)
      expect(account.account?.realizedPnl).toBe('0');
      expect(account.positions).toHaveLength(1);
      expect(account.positions[0]).toMatchObject({
        symbol: 'SOL/USD',
        direction: 'LONG',
        quantity: '1',
        averageEntryPrice: '100.5',
      });

      // The follower's cash is their own pot: the expert's ledger does not
      // appear here, and the wallet (Module 03) is untouched by any of this.
      const aggregate = await aggregateAccount(follower.token);
      expect(aggregate).toMatchObject({ followCount: 1, cash: '99899.5', realizedPnl: '0' });
      expect(aggregate.positions).toHaveLength(1);
      expect(aggregate.positions[0]).toMatchObject({ symbol: 'SOL/USD', quantity: '1', followCount: 1 });
    });

    it('blends the average entry price on a second copy', async () => {
      const { owner, follower, strategyId } = await fixture('copy-blend');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      seedFreshQuote('SOL/USD', '299.5', '300.5');
      await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      const account = await followAccount(follower.token, strategyId);
      expect(account.positions).toHaveLength(1);
      expect(account.positions[0]).toMatchObject({
        direction: 'LONG',
        quantity: '3',
        averageEntryPrice: '167.16666666666666667',
      });
      expect(account.account?.cash).toBe('99498.5'); // 100000 - 201 - 300.5
    });
  });

  // ---------------------------------------------------------------------------

  describe('copying a SHORT', () => {
    it('closes the position, credits the pot and realizes P&L against the entry price', async () => {
      const { owner, follower, strategyId } = await fixture('copy-sell');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '4' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      await placeOrder(owner.token, strategyId, { side: 'SHORT', quantity: '4' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        side: 'SHORT',
        expertQuantity: '4',
        expertFillPrice: '149.5',
        quantity: '4',
        fillPrice: '149.5',
        gross: '598',
        realizedPnl: '196',
        status: 'COPIED',
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('100196'); // 99598 + 598
      expect(account.account?.realizedPnl).toBe('196'); // (149.5 - 100.5) x 4
      // A position that empties is deleted, never stored as a zero row.
      expect(account.positions).toEqual([]);
    });

    it('opens a short when the follower holds nothing, because a SHORT is a direction', async () => {
      const { owner, follower, strategyId } = await fixture('copy-short');

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '4' }).expect(201);

      // Following after that fill means the follower starts flat: they were not
      // there for it, and back-filling would build a position nobody chose.
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '149.5', '150.5');
      await placeOrder(owner.token, strategyId, { side: 'SHORT', quantity: '4' }).expect(201);
      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      // The book is net: a SHORT against a flat book is not a refusal, it is
      // the opening of a short position. The notional comes in.
      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: 'COPIED',
        side: 'SHORT',
        quantity: '4',
        fillPrice: '149.5',
        gross: '598',
        realizedPnl: null,
        rejectReason: null,
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('100598'); // 100000 + 598
      expect(account.account?.realizedPnl).toBe('0');
      expect(account.positions).toHaveLength(1);
      expect(account.positions[0]).toMatchObject({
        symbol: 'SOL/USD',
        direction: 'SHORT',
        quantity: '4',
        averageEntryPrice: '149.5',
      });
    });

    it('reduces the follower\'s long and opens a short with the leftover', async () => {
      const { owner, follower, strategyId } = await fixture('copy-flip');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      // The expert closes more than the follower holds: the follower's long
      // is closed first and the remainder opens a short in the order's own
      // direction, at the fill price.
      seedFreshQuote('SOL/USD', '149.5', '150.5');
      await placeOrder(owner.token, strategyId, { side: 'SHORT', quantity: '4' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      const history = await copyOrders(follower.token, strategyId);
      expect(history[0]).toMatchObject({
        status: 'COPIED',
        side: 'SHORT',
        quantity: '4',
        realizedPnl: '98', // (149.5 - 100.5) x 2
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('100397'); // 99799 + 598
      expect(account.account?.realizedPnl).toBe('98');
      expect(account.positions).toHaveLength(1);
      expect(account.positions[0]).toMatchObject({
        direction: 'SHORT',
        quantity: '2',
        averageEntryPrice: '149.5',
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('refusals', () => {
    it('refuses a LONG the copy pot cannot fund, and moves nothing', async () => {
      const { owner, follower, strategyId } = await fixture('copy-poor');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      // Mirror pricing means the expert's pot and the follower's pot start
      // equal and move together, so "cannot fund" is a state reached by
      // spending. The pot is drained here rather than contrived through trades
      // that would take a hundred requests to build: with cash at zero the
      // affordability bound leaves nothing to execute.
      await prisma.copyAccount.update({
        where: { followerId_strategyId: { followerId: follower.userId, strategyId } },
        data: { cash: '0' },
      });

      seedFreshQuote('SOL/USD', '299.5', '300.5');
      await placeOrder(owner.token, strategyId, { quantity: '3' }).expect(201);
      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history[0]).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'INSUFFICIENT_COPY_CASH',
        quantity: null,
        fillPrice: null,
        gross: null,
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('0');
      expect(account.positions[0]).toMatchObject({ symbol: 'SOL/USD', quantity: '2' });

      const state = await status(follower.token, strategyId);
      expect(state).toMatchObject({ copiedCount: 1, rejectedCount: 1 });
    });

    it('records a fill that could not be priced as PRICE_UNAVAILABLE rather than at a guess', async () => {
      const { follower, strategyId } = await fixture('copy-unpriced');
      await follow(follower.token, strategyId, '1').expect(201);

      // A FILLED paper order with no price is not producible through the paper
      // API, so the row is written the way a ledger corruption would leave it.
      const order = await prisma.paperOrder.create({
        data: {
          strategyId,
          clientRequestId: randomUUID(),
          symbol: 'SOL/USD',
          side: 'LONG',
          quantity: '1',
          status: 'FILLED',
          filledAt: new Date(),
        },
      });

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        expertOrderId: order.orderId,
        status: 'REJECTED',
        rejectReason: 'PRICE_UNAVAILABLE',
        expertFillPrice: null,
        quantity: null,
      });

      // Sizing refusals are recorded against a live pot: the account is
      // provisioned before the price is looked up, so "your pot could not
      // price this" is an outcome with a balance behind it, and the balance
      // has not moved.
      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('100000');
      expect(account.positions).toEqual([]);
    });

    it('writes the reason for every refusal - never a silent skip', async () => {
      const { owner, follower, strategyId } = await fixture('copy-no-skips');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);
      await sync(follower.token, strategyId).expect(200);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]?.rejectReason).toBeNull();

      // A second sync with nothing new to consume writes nothing at all.
      const again = await sync(follower.token, strategyId).expect(200);
      expect((again.body as SyncPayload).consumed).toBe(0);
      expect(await copyOrders(follower.token, strategyId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('unfollow and re-follow', () => {
    it('stops copying at once, and still records what was pending as FOLLOW_NOT_ACTIVE', async () => {
      const { owner, follower, strategyId } = await fixture('copy-unfollow');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);

      // The fill is committed but not yet consumed when the follower leaves.
      const stateBefore = await status(follower.token, strategyId);
      expect(stateBefore.hasPendingEvents).toBe(true);

      const unfollowed = await http()
        .delete(`/api/copy/follows/${strategyId}`)
        .set(bearer(follower.token))
        .expect(200);
      expect((unfollowed.body as FollowPayload).status).toBe('UNFOLLOWED');
      expect((unfollowed.body as FollowPayload).eligibility).toBe('FOLLOW_NOT_ACTIVE');

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'FOLLOW_NOT_ACTIVE',
        quantity: null,
      });

      // No pot was ever provisioned: an ineligible fill never touches money.
      const account = await followAccount(follower.token, strategyId);
      expect(account.account).toBeNull();
      expect(account.positions).toEqual([]);
      // The wallet balance is the gate every further copy has to pass, so it
      // is reported even when no copy has happened yet.
      expect(account.walletUsdt).toBe('1000000');

      // Idempotent: the second unfollow reports the same state, not an error.
      const again = await http()
        .delete(`/api/copy/follows/${strategyId}`)
        .set(bearer(follower.token))
        .expect(200);
      expect((again.body as FollowPayload).status).toBe('UNFOLLOWED');
    });

    it('does not copy the fills from a gap between two follows', async () => {
      const { owner, follower, strategyId } = await fixture('copy-gap');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);

      await http().delete(`/api/copy/follows/${strategyId}`).set(bearer(follower.token)).expect(200);
      await delay(15);
      await follow(follower.token, strategyId, '1').expect(201);

      const row = await prisma.strategyFollow.findUniqueOrThrow({
        where: { followerId_strategyId: { followerId: follower.userId, strategyId } },
      });
      // The cursor survives the cycle on purpose: the gap's fills must be
      // walked and recorded rather than dropped, and `followed_at` is what
      // makes each of them a refusal instead of a copy.
      expect(row.cursorOrderId).toBe(NIL_CURSOR);

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'REJECTED', rejectReason: 'FOLLOW_NOT_ACTIVE' });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account).toBeNull();
      expect(account.positions).toEqual([]);
      // The wallet balance is the gate every further copy has to pass, so it
      // is reported even when no copy has happened yet.
      expect(account.walletUsdt).toBe('1000000');
    });

    it('resumes the same relationship when the follower comes back', async () => {
      const { owner, follower, strategyId } = await fixture('copy-resume');
      await follow(follower.token, strategyId, '1').expect(201);
      await http().delete(`/api/copy/follows/${strategyId}`).set(bearer(follower.token)).expect(200);

      const response = await follow(follower.token, strategyId, '0.5').expect(201);
      expect(response.body).toMatchObject({ status: 'ACTIVE', allocationFraction: '0.5' });

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '4' }).expect(201);
      const syncResult = await sync(follower.token, strategyId).expect(200);
      expect((syncResult.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ quantity: '2', status: 'COPIED' }); // 4 x 0.5
    });
  });

  // ---------------------------------------------------------------------------

  describe('archived strategy', () => {
    it('stops copying when the owner archives, and says which reason stopped it', async () => {
      const { owner, follower, strategyId } = await fixture('copy-archived');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);

      await http()
        .patch(`/api/strategies/${strategyId}`)
        .set(bearer(owner.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history[0]).toMatchObject({ status: 'REJECTED', rejectReason: 'STRATEGY_ARCHIVED' });

      const state = await status(follower.token, strategyId);
      expect(state).toMatchObject({
        strategyStatus: 'ARCHIVED',
        eligibility: 'STRATEGY_ARCHIVED',
        rejectedCount: 1,
      });

      const account = await followAccount(follower.token, strategyId);
      expect(account.account).toBeNull();
      expect(account.positions).toEqual([]);
      // The wallet balance is the gate every further copy has to pass, so it
      // is reported even when no copy has happened yet.
      expect(account.walletUsdt).toBe('1000000');
    });
  });

  // ---------------------------------------------------------------------------

  describe('idempotency and resume', () => {
    it('absorbs a replayed fill instead of copying it twice', async () => {
      const { owner, follower, strategyId } = await fixture('copy-replay');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);

      const first = await sync(follower.token, strategyId).expect(200);
      expect((first.body as SyncPayload).consumed).toBe(1);

      const row = await prisma.strategyFollow.findUniqueOrThrow({
        where: { followerId_strategyId: { followerId: follower.userId, strategyId } },
      });

      // Wind the cursor back to the follow instant: exactly the state a worker
      // restarts into when it dies after writing events but before committing
      // its progress.
      await prisma.strategyFollow.update({
        where: { followerId_strategyId: { followerId: follower.userId, strategyId } },
        data: { cursorFilledAt: row.followedAt, cursorOrderId: NIL_CURSOR },
      });

      const replay = await sync(follower.token, strategyId).expect(200);
      // Nothing new was written, and the route must not claim otherwise.
      expect((replay.body as SyncPayload).consumed).toBe(0);

      expect(await copyOrders(follower.token, strategyId)).toHaveLength(1);

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('99799'); // 100000 - 201, spent once
      expect(account.positions[0]?.quantity).toBe('2');
    });

    it('consumes a backlog in the expert\'s own order', async () => {
      const { owner, follower, strategyId } = await fixture('copy-order');
      await follow(follower.token, strategyId, '1').expect(201);

      for (const price of ['10.5', '11.5', '12.5']) {
        const [bid, ask] = [String(Number(price) - 1), price];
        seedFreshQuote('SOL/USD', bid, ask);
        await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);
        // Keep each fill in its own millisecond: the cursor and the history
        // both order on (timestamp, id), and a tie would make the expected
        // sequence depend on UUID order instead of placement order.
        await delay(5);
      }

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(3);

      const expertOrders = await paperOrders(owner.token, strategyId); // newest first
      const history = await copyOrders(follower.token, strategyId); // newest first

      expect(history).toHaveLength(3);
      expect(history.map((event) => event.expertOrderId)).toEqual(
        expertOrders.map((order) => order.orderId),
      );
      expect(history.map((event) => event.fillPrice)).toEqual(['12.5', '11.5', '10.5']);
    });
  });

  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('copies exactly once when two syncs race for the same fill', async () => {
      const { owner, follower, strategyId } = await fixture('copy-race');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '2' }).expect(201);

      const [a, b] = await Promise.all([sync(follower.token, strategyId), sync(follower.token, strategyId)]);
      const consumed = (a.body as SyncPayload).consumed + (b.body as SyncPayload).consumed;

      // The advisory lock serialises the two passes and the primary key makes
      // the loser a no-op, so the fill is written exactly once between them.
      expect(consumed).toBe(1);

      const history = await copyOrders(follower.token, strategyId);
      expect(history).toHaveLength(1);

      const account = await followAccount(follower.token, strategyId);
      expect(account.account?.cash).toBe('99799');
      expect(account.positions[0]?.quantity).toBe('2');
    });

    it('never overspends when two different follows of the same caller race', async () => {
      const owner = await createUser('race-owner');
      const follower = await createUser('race-follower');
      const first = await createStrategy(owner.token, 'race-a');
      const second = await createStrategy(owner.token, 'race-b');

      await follow(follower.token, first, '1').expect(201);
      await follow(follower.token, second, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, first, { quantity: '1' }).expect(201);
      await placeOrder(owner.token, second, { quantity: '1' }).expect(201);

      await Promise.all([sync(follower.token, first), sync(follower.token, second)]);

      const aggregate = await aggregateAccount(follower.token);
      expect(aggregate.followCount).toBe(2);
      // Two separate pots of 100000, each debited 100.5 by its own copy.
      expect(aggregate.cash).toBe('199799');
      // Positions merge per symbol across follows, so one holding of 2 with
      // both follows behind it - `followCount` is what says two, not one.
      expect(aggregate.positions).toHaveLength(1);
      expect(aggregate.positions[0]).toMatchObject({ symbol: 'SOL/USD', quantity: '2', followCount: 2 });
    });
  });

  // ---------------------------------------------------------------------------

  describe('the background pass', () => {
    it('processes every follow, including an unfollowed one, and records each outcome', async () => {
      const { owner, follower, strategyId } = await fixture('worker-pass');
      const second = await createStrategy(owner.token, 'worker-second');

      await follow(follower.token, strategyId, '1').expect(201);
      await follow(follower.token, second, '1').expect(201);
      await http().delete(`/api/copy/follows/${second}`).set(bearer(follower.token)).expect(200);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);
      await placeOrder(owner.token, second, { quantity: '1' }).expect(201);

      // The worker's own loop, called directly: no timer, no waiting.
      await worker.runOnce();

      const activeState = await status(follower.token, strategyId);
      expect(activeState).toMatchObject({
        hasPendingEvents: false,
        copiedCount: 1,
        rejectedCount: 0,
        eligibility: 'ELIGIBLE',
      });

      const unfollowedState = await status(follower.token, second);
      expect(unfollowedState).toMatchObject({
        status: 'UNFOLLOWED',
        hasPendingEvents: false,
        copiedCount: 0,
        rejectedCount: 1,
        eligibility: 'FOLLOW_NOT_ACTIVE',
      });

      const unfollowedHistory = await copyOrders(follower.token, second);
      expect(unfollowedHistory[0]?.rejectReason).toBe('FOLLOW_NOT_ACTIVE');
    });

    it('leaves a follow alone when there is nothing to consume', async () => {
      const { follower, strategyId } = await fixture('worker-idle');
      await follow(follower.token, strategyId, '1').expect(201);

      const response = await sync(follower.token, strategyId).expect(200);
      expect((response.body as SyncPayload).consumed).toBe(0);

      const state = await status(follower.token, strategyId);
      expect(state.hasPendingEvents).toBe(false);
      expect(state.lastProcessedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------

  describe('the owner view', () => {
    it('shows followers with masked addresses only', async () => {
      const owner = await createUser('followers-owner');
      const follower = await createUser('followers-subj');
      const strategyId = await createStrategy(owner.token, 'followers');
      await follow(follower.token, strategyId, '0.3').expect(201);

      const page = await followers(owner.token, strategyId);
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);

      const item = page.items[0]!;
      expect(item).toMatchObject({
        followerId: follower.userId,
        status: 'ACTIVE',
        allocationFraction: '0.3',
        copiedCount: 0,
        rejectedCount: 0,
      });
      expect(item.maskedEmail).toBe(`${follower.email[0]}***@copy.test`);
      expect(item.maskedEmail).not.toContain(follower.email.split('@')[0]);
      expect(JSON.stringify(item)).not.toContain(follower.email);
    });

    it('hides the follower list behind a 404 for anyone who does not own the strategy', async () => {
      const owner = await createUser('followers-priv');
      const stranger = await createUser('followers-stranger');
      const strategyId = await createStrategy(owner.token, 'followers-priv');

      const response = await http()
        .get(`/api/copy/strategies/${strategyId}/followers`)
        .set(bearer(stranger.token))
        .expect(404);
      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      await http()
        .get(`/api/copy/strategies/${randomUUID()}/followers`)
        .set(bearer(owner.token))
        .expect(404);
    });

    it('shows a follower their own follow and nobody else\'s', async () => {
      const owner = await createUser('scoping-owner');
      const follower = await createUser('scoping-follower');
      const stranger = await createUser('scoping-stranger');
      const strategyId = await createStrategy(owner.token, 'scoping');
      await follow(follower.token, strategyId, '1').expect(201);

      await status(follower.token, strategyId); // 200 for the follower

      const response = await http()
        .get(`/api/copy/follows/${strategyId}`)
        .set(bearer(stranger.token))
        .expect(404);
      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      const accountResponse = await http()
        .get(`/api/copy/follows/${strategyId}/account`)
        .set(bearer(stranger.token))
        .expect(404);
      expectDomainError(accountResponse, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    it('pages the copy history with the standard five-key envelope', async () => {
      const { owner, follower, strategyId } = await fixture('copy-page');
      await follow(follower.token, strategyId, '1').expect(201);

      seedFreshQuote('SOL/USD', '99.5', '100.5');
      for (let index = 0; index < 3; index += 1) {
        await placeOrder(owner.token, strategyId, { quantity: '1' }).expect(201);
      }
      await sync(follower.token, strategyId).expect(200);

      const response = await http()
        .get(`/api/copy/follows/${strategyId}/orders?page=1&limit=2`)
        .set(bearer(follower.token))
        .expect(200);
      const page = response.body as PageEnvelope<CopyEventPayload>;

      expect(page).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(page.items).toHaveLength(2);

      const second = await http()
        .get(`/api/copy/follows/${strategyId}/orders?page=2&limit=2`)
        .set(bearer(follower.token))
        .expect(200);
      expect((second.body as PageEnvelope<CopyEventPayload>).items).toHaveLength(1);

      await http()
        .get(`/api/copy/follows/${strategyId}/orders?page=0`)
        .set(bearer(follower.token))
        .expect(400);
      await http()
        .get(`/api/copy/follows/${strategyId}/orders?limit=101`)
        .set(bearer(follower.token))
        .expect(400);
      await http().get('/api/copy/follows?page=0').set(bearer(follower.token)).expect(400);
    });
  });
});
