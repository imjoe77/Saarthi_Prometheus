import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * MODULE: EMBER ecosystem over HTTP - the Hub, the simulated staking program
 * and the (disabled) blockchain admin surface.
 *
 * Why this suite exists: the unit specs of each module prove their internals
 * against mocks, but the guarantees this module claims only exist in the real
 * database - that a purchase moves four legs together or none, that a stake
 * locks REAL wallet value until the lock expires, and that every chain-touching
 * route answers 503 while BLOCKCHAIN_ENABLED is false rather than half-working.
 * None of that can be asserted against a mock.
 *
 * Isolation (the same house style as the tokenomics suite): the module owns
 * `ember_purchases` and `ember_stake_positions` outright, so both are purged at
 * START and at the end (a crashed previous run must not leak rows into this
 * one), and every suite user - including the auto-provisioned treasury, which
 * this suite funds and no other suite knows about - is removed with its
 * wallets, balances and ledger legs.
 *
 * Treasury and user funding only ever happens through `walletService.credit`,
 * never through an API route: no route may mint balance out of nothing.
 */
describe('EMBER ecosystem - hub, staking, blockchain admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  const TREASURY_EMAIL = 'treasury@prometheus.local';

  // -------------------------------------------------------------------------
  // Boot, purge, helpers
  // -------------------------------------------------------------------------

  /** The module's own tables, emptied at start AND end (house style). */
  async function purgeEcosystemFootprint(): Promise<void> {
    await prisma.emberStakePosition.deleteMany({});
    await prisma.emberPurchase.deleteMany({});
  }

  /** This suite's users (and the auto-provisioned treasury), fully removed. */
  async function purgeSuiteUsers(): Promise<void> {
    const treasury = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    const ids = [...createdUserIds];
    if (treasury && !ids.includes(treasury.id)) ids.push(treasury.id);
    if (ids.length === 0) return;

    await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: ids } } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: ids } } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);
    for (const symbol of ['INR', 'USDT', 'EMBER']) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol } });
      assetIdBySymbol.set(symbol, asset.id);
    }

    await purgeEcosystemFootprint();
    await purgeSuiteUsers();
  });

  afterAll(async () => {
    await purgeEcosystemFootprint();
    await purgeSuiteUsers();
    createdUserIds.length = 0;
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const assetId = (symbol: string) => assetIdBySymbol.get(symbol) as string;

  /** Fixed-point rendering so expectations never depend on Decimal toString. */
  const fixed18 = (value: unknown): string => new Prisma.Decimal(value as string).toFixed(18);

  const available = async (userId: string, symbol: string): Promise<string> => {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    const row = await prisma.walletBalance.findUniqueOrThrow({
      where: { walletId_assetId: { walletId: wallet.id, assetId: assetId(symbol) } },
    });
    return fixed18(row.available);
  };

  const locked = async (userId: string, symbol: string): Promise<string> => {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    const row = await prisma.walletBalance.findUniqueOrThrow({
      where: { walletId_assetId: { walletId: wallet.id, assetId: assetId(symbol) } },
    });
    return fixed18(row.locked);
  };

  const buyer = { token: '', userId: '' };
  const operator = { token: '', userId: '' };

  async function createIdentity(
    label: string,
    roles: Role[] = [],
  ): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@ember-ecosystem.test`.toLowerCase(),
    });
    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    const userId = (me.body as { id: string }).id;
    createdUserIds.push(userId);
    for (const role of roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId, role } },
        create: { userId, role },
        update: {},
      });
    }
    return { token, userId };
  }

  beforeAll(async () => {
    // The buyer holds no privileged role: the hub is open to any authenticated
    // caller, while staking mutations and the blockchain admin surface must
    // refuse this identity (asserted below).
    const plain = await createIdentity('ember-buyer');
    buyer.token = plain.token;
    buyer.userId = plain.userId;

    const privileged = await createIdentity('ember-operator', [
      Role.LIQUIDITY_PROVIDER,
      Role.PLATFORM_ADMIN,
    ]);
    operator.token = privileged.token;
    operator.userId = privileged.userId;
  });

  /**
   * The treasury is provisioned exactly the way the hub expects to find it and
   * funded only through the ledger service - never through a route.
   */
  const treasuryUserId = { value: '' };
  beforeAll(async () => {
    const existing = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    const treasury = existing ?? (await prisma.user.create({ data: { email: TREASURY_EMAIL } }));
    createdUserIds.push(treasury.id);
    treasuryUserId.value = treasury.id;

    const { wallet } = await walletService.getOrCreateForUser(treasury.id);
    await walletService.credit(wallet.id, assetId('EMBER'), '10000');

    const buyerWallet = await walletService.getOrCreateForUser(buyer.userId);
    await walletService.credit(buyerWallet.wallet.id, assetId('USDT'), '100');

    const operatorWallet = await walletService.getOrCreateForUser(operator.userId);
    await walletService.credit(operatorWallet.wallet.id, assetId('EMBER'), '1000');
  });

  // -------------------------------------------------------------------------
  // EMBER Hub: terms, scenarios, purchases
  // -------------------------------------------------------------------------

  describe('EMBER Hub - terms and display-only scenarios', () => {
    it('exposes the configured terms together with the treasury inventory that can actually deliver', async () => {
      const res = await http().get('/api/ember-hub/overview').set(bearer(buyer.token)).expect(200);

      expect(res.body).toMatchObject({
        baselinePriceInr: '2.45',
        dailyEmberLimit: '10000',
        monthlyEmberLimit: '100000',
        treasuryAvailableEmber: '10000.000000000000000000',
      });
      expect(Number(res.body.usdtRateInr)).toBeCloseTo(99.9, 6);
      expect(String(res.body.note)).toMatch(/On-chain supply does not change/);
    });

    it('prices the named scenarios display-only and records nothing', async () => {
      const before = await prisma.emberPurchase.count();

      const res = await http().get('/api/ember-hub/scenarios').set(bearer(buyer.token)).expect(200);

      expect(res.body.scenarios).toHaveLength(3);
      expect(res.body.scenarios[0]).toEqual({
        label: 'First taste',
        emberAmount: '250',
        totalInr: '612.50',
        totalUsdt: '6.131131',
      });
      expect(String(res.body.note)).toMatch(/display-only/i);
      await expect(prisma.emberPurchase.count()).resolves.toBe(before);
    });
  });

  describe('EMBER Hub - one atomic purchase', () => {
    const purchaseKey = randomUUID();
    let firstPurchaseId = '';

    it('moves all four legs together: treasury EMBER -> user, user USDT -> treasury', async () => {
      const res = await http()
        .post('/api/ember-hub/purchases')
        .set(bearer(buyer.token))
        .send({ emberAmount: '100', clientRequestId: purchaseKey })
        .expect(201);

      expect(res.body.created).toBe(true);
      expect(res.body.purchase).toMatchObject({
        status: 'COMPLETED',
        emberAmount: '100.000000000000000000',
        emberPriceInr: '2.450000000000000000',
        totalInr: '245.000000000000000000',
        totalUsdt: '2.452452000000000000',
        clientRequestId: purchaseKey,
      });
      expect(Number(res.body.purchase.usdtRateInr)).toBeCloseTo(99.9, 6);
      firstPurchaseId = res.body.purchase.purchaseId;

      expect(await available(buyer.userId, 'EMBER')).toBe('100.000000000000000000');
      expect(await available(buyer.userId, 'USDT')).toBe('97.547548000000000000');
      expect(await available(treasuryUserId.value, 'EMBER')).toBe('9900.000000000000000000');
      expect(await available(treasuryUserId.value, 'USDT')).toBe('2.452452000000000000');
    });

    it('replays the same idempotency key with 200 and moves nothing again', async () => {
      const res = await http()
        .post('/api/ember-hub/purchases')
        .set(bearer(buyer.token))
        .send({ emberAmount: '100', clientRequestId: purchaseKey })
        .expect(200);

      expect(res.body.created).toBe(false);
      expect(res.body.purchase.purchaseId).toBe(firstPurchaseId);

      expect(await available(buyer.userId, 'EMBER')).toBe('100.000000000000000000');
      expect(await available(buyer.userId, 'USDT')).toBe('97.547548000000000000');
      expect(await available(treasuryUserId.value, 'EMBER')).toBe('9900.000000000000000000');
    });

    it('lists the caller\'s own purchases, newest first', async () => {
      const res = await http().get('/api/ember-hub/purchases').set(bearer(buyer.token)).expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].purchaseId).toBe(firstPurchaseId);
    });

    it('refuses a malformed purchase request with 400 before anything is looked up', async () => {
      await http()
        .post('/api/ember-hub/purchases')
        .set(bearer(buyer.token))
        .send({ emberAmount: '100', clientRequestId: 'not-a-uuid' })
        .expect(400);
    });

    it('refuses a purchase beyond the daily per-user limit before anything moves', async () => {
      // 100 already bought today; 9950 more would reach 10050 > 10000.
      const res = await http()
        .post('/api/ember-hub/purchases')
        .set(bearer(buyer.token))
        .send({ emberAmount: '9950', clientRequestId: randomUUID() })
        .expect(409);

      expect(res.body.code).toBe('CONFLICT');
      expect(String(res.body.message)).toMatch(/daily/i);
      expect(await available(buyer.userId, 'USDT')).toBe('97.547548000000000000');
      expect(await available(treasuryUserId.value, 'EMBER')).toBe('9900.000000000000000000');
    });

    it('refuses an unfundable purchase with 409 and leaves the key reusable (no FAILED row)', async () => {
      // 5000 EMBER costs 12250 INR = 122.622623 USDT; the buyer holds 97.547548.
      const key = randomUUID();
      const send = () =>
        http()
          .post('/api/ember-hub/purchases')
          .set(bearer(buyer.token))
          .send({ emberAmount: '5000', clientRequestId: key });

      const first = await send().expect(409);
      expect(first.body.code).toBe('INSUFFICIENT_BALANCE');

      // A domain refusal records no FAILED row, so the SAME key may be retried
      // and must fail with the same domain error - not with a replay refusal.
      const second = await send().expect(409);
      expect(second.body.code).toBe('INSUFFICIENT_BALANCE');

      const rows = await prisma.emberPurchase.findMany({ where: { clientRequestId: key } });
      expect(rows).toHaveLength(0);
      expect(await available(buyer.userId, 'USDT')).toBe('97.547548000000000000');
    });
  });

  // -------------------------------------------------------------------------
  // RBAC: who may do what
  // -------------------------------------------------------------------------

  describe('RBAC boundaries of the ecosystem', () => {
    it('refuses staking mutations to an authenticated non-provider (403)', async () => {
      await http()
        .post('/api/ember-staking/stakes')
        .set(bearer(buyer.token))
        .send({ emberAmount: '10', clientRequestId: randomUUID() })
        .expect(403);
    });

    it('refuses the blockchain admin surface to an authenticated non-admin (403)', async () => {
      await http().get('/api/admin/blockchain/status').set(bearer(buyer.token)).expect(403);
      await http().get('/api/admin/blockchain/mints').set(bearer(buyer.token)).expect(403);
      await http().get('/api/admin/blockchain/reconciliation').set(bearer(buyer.token)).expect(403);
    });

    it('keeps reading one\'s own staking positions open to plain authenticated callers', async () => {
      const res = await http().get('/api/ember-staking/positions').set(bearer(buyer.token)).expect(200);
      expect(res.body.items).toEqual([]);
    });

    it('exposes the configured lock period and APR so the UI can label its controls', async () => {
      const res = await http().get('/api/ember-staking/config').set(bearer(buyer.token)).expect(200);

      expect(res.body).toEqual({
        aprPercent: expect.any(String),
        lockDays: expect.any(Number),
      });
      expect(Number(res.body.aprPercent)).toBeGreaterThan(0);
      expect(res.body.lockDays).toBeGreaterThan(0);
    });

    it('requires authentication for the staking config', async () => {
      await http().get('/api/ember-staking/config').expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Simulated staking: real locks, display-only rewards
  // -------------------------------------------------------------------------

  describe('Simulated EMBER staking - real wallet locks, simulated rewards', () => {
    const stakeKey = randomUUID();
    let stakeId = '';

    it('locks real EMBER into a position until the configured lock expires', async () => {
      const before = Date.now();
      const res = await http()
        .post('/api/ember-staking/stakes')
        .set(bearer(operator.token))
        .send({ emberAmount: '250', clientRequestId: stakeKey })
        .expect(201);

      expect(res.body.created).toBe(true);
      expect(res.body.position).toMatchObject({
        status: 'ACTIVE',
        amount: '250.000000000000000000',
        clientRequestId: stakeKey,
      });
      stakeId = res.body.position.stakeId;

      const lockUntil = new Date(res.body.position.lockUntil as string).getTime();
      expect(lockUntil).toBeGreaterThan(before);
      expect(lockUntil).toBeLessThanOrEqual(Date.now() + 31 * 24 * 60 * 60 * 1000);
      expect(Number(res.body.position.aprPercent)).toBeGreaterThan(0);
      expect(Number(res.body.position.elapsedDays)).toBeGreaterThanOrEqual(0);
      expect(Number(res.body.position.simulatedReward)).toBeGreaterThanOrEqual(0);

      expect(await available(operator.userId, 'EMBER')).toBe('750.000000000000000000');
      expect(await locked(operator.userId, 'EMBER')).toBe('250.000000000000000000');
    });

    it('replays the stake idempotency key without locking twice', async () => {
      const res = await http()
        .post('/api/ember-staking/stakes')
        .set(bearer(operator.token))
        .send({ emberAmount: '250', clientRequestId: stakeKey })
        .expect(200);

      expect(res.body.created).toBe(false);
      expect(res.body.position.stakeId).toBe(stakeId);
      expect(await locked(operator.userId, 'EMBER')).toBe('250.000000000000000000');
    });

    it('shows the position with a read-time simulated reward that was never credited', async () => {
      const res = await http()
        .get('/api/ember-staking/positions')
        .set(bearer(operator.token))
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].status).toBe('ACTIVE');
      expect(res.body.items[0].simulatedReward).toMatch(/^\d+\.\d{18}$/);
      expect(await locked(operator.userId, 'EMBER')).toBe('250.000000000000000000');
      expect(await available(operator.userId, 'EMBER')).toBe('750.000000000000000000');
    });

    it('refuses early unstaking with 409 rather than a penalty', async () => {
      const res = await http()
        .post(`/api/ember-staking/stakes/${stakeId}/unstake`)
        .set(bearer(operator.token))
        .expect(409);

      expect(res.body.code).toBe('CONFLICT');
      expect(String(res.body.message)).toMatch(/locked until/i);
      expect(await locked(operator.userId, 'EMBER')).toBe('250.000000000000000000');
    });

    it('answers a foreign position with 404 and a malformed id with 400', async () => {
      await http()
        .post(`/api/ember-staking/stakes/${randomUUID()}/unstake`)
        .set(bearer(operator.token))
        .expect(404);
      await http()
        .post('/api/ember-staking/stakes/not-a-uuid/unstake')
        .set(bearer(operator.token))
        .expect(400);
    });

    it('unlocks exactly once when the lock has expired, then replays as already unstaked', async () => {
      // Test time-travel: only the lock deadline is moved into the past; the
      // position row and every ledger figure stay exactly as they were.
      await prisma.emberStakePosition.update({
        where: { stakeId },
        data: { lockUntil: new Date(Date.now() - 1000) },
      });

      const first = await http()
        .post(`/api/ember-staking/stakes/${stakeId}/unstake`)
        .set(bearer(operator.token))
        .expect(201);
      expect(first.body.created).toBe(true);
      expect(first.body.position.status).toBe('UNSTAKED');
      expect(first.body.position.unstakedAt).toBeTruthy();

      expect(await available(operator.userId, 'EMBER')).toBe('1000.000000000000000000');
      expect(await locked(operator.userId, 'EMBER')).toBe('0.000000000000000000');

      const replay = await http()
        .post(`/api/ember-staking/stakes/${stakeId}/unstake`)
        .set(bearer(operator.token))
        .expect(200);
      expect(replay.body.created).toBe(false);
      expect(await available(operator.userId, 'EMBER')).toBe('1000.000000000000000000');
      expect(await locked(operator.userId, 'EMBER')).toBe('0.000000000000000000');
    });
  });

  // -------------------------------------------------------------------------
  // Blockchain admin surface with the layer disabled
  // -------------------------------------------------------------------------

  describe('Blockchain admin with BLOCKCHAIN_ENABLED=false', () => {
    it('reports the layer as disabled and makes no reachability claim', async () => {
      const res = await http()
        .get('/api/admin/blockchain/status')
        .set(bearer(operator.token))
        .expect(200);

      expect(res.body).toMatchObject({
        enabled: false,
        rpcConfigured: expect.any(Boolean),
        rpcReachable: null,
      });
      expect(res.body.tokenAddress).toBeNull();
    });

    it('refuses a mint broadcast with 503 and creates no request row', async () => {
      const res = await http()
        .post('/api/admin/blockchain/mints')
        .set(bearer(operator.token))
        .send({ amount: '100', clientRequestId: randomUUID(), reason: 'e2e' })
        .expect(503);

      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(String(res.body.message)).toMatch(/disabled/i);

      const list = await http().get('/api/admin/blockchain/mints').set(bearer(operator.token)).expect(200);
      expect(list.body.items).toHaveLength(0);
    });

    it('refuses recovery, event sync and reconciliation with 503 while disabled', async () => {
      await http().post('/api/admin/blockchain/recovery').set(bearer(operator.token)).expect(503);
      await http().post('/api/admin/blockchain/events/sync').set(bearer(operator.token)).expect(503);
      await http().get('/api/admin/blockchain/reconciliation').set(bearer(operator.token)).expect(503);
    });

    it('validates the mint body with 400 for an authenticated admin (before any chain concern)', async () => {
      const res = await http()
        .post('/api/admin/blockchain/mints')
        .set(bearer(operator.token))
        .send({ amount: 'not-a-number', clientRequestId: randomUUID() })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });
});
