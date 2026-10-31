import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma, type TokenBuybackStatus } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * MODULE 11 - EMBER tokenomics over HTTP: allocation, simulated buyback, real
 * burns.
 *
 * Boots the real application against the real database, the same way Modules
 * 03 and 10 do. The guarantees this module claims - that a burn either
 * destroys EMBER and records it or does neither, that a replayed idempotency
 * key never burns twice, that one execution can never burn twice, that
 * simulated stages move nothing at all, and that supply's burned figure
 * reconciles 1:1 with both the ledger legs and the token_burns table - only
 * exist in the database, so a suite against a mock would prove nothing.
 *
 * Isolation, and why it is exhaustive: Module 10's suite asserts ABSOLUTE
 * zeros (`burnedSupply === '0.000000000000000000'`, `circulating ===
 * issued`) whenever it happens to run, and e2e files run serially (maxWorkers
 * 1) in an order this suite does not control. So the suite purges its whole
 * footprint at START as well as at the end - token tables, every BURN ledger
 * leg, and the treasury user (which the service auto-provisions mid-suite and
 * which no other suite knows about). The suite-start baseline is itself
 * asserted to be zero burns, which is a cross-check that the purge worked.
 *
 * Supply assertions are DELTAS against reads taken inside this suite: the
 * database is shared, so only the change caused by this suite's own
 * operations is well-defined. The one absolute assertion is that baseline -
 * deliberately, because it is the promise Module 10 depends on.
 *
 * The treasury is funded the only way tests and seeds ever fund it: through
 * `walletService.credit`, never through an API route - no minting surface
 * exists to call.
 */
describe('EMBER tokenomics - allocation, simulated buyback, burns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  const TREASURY_EMAIL = 'treasury@prometheus.local';

  interface SupplyPayload {
    asset: string;
    totalIssuedSupply: string;
    circulatingSupply: string;
    lockedSupply: string;
    availableSupply: string;
    burnedSupply: string;
  }

  // -------------------------------------------------------------------------
  // Boot, purge, helpers
  // -------------------------------------------------------------------------

  /**
   * The module's entire footprint, removed in FK-safe order (token tables
   * reference users; ledger rows reference wallets). Called at start AND at
   * the end: at start it makes this suite's own state deterministic and
   * protects every suite that runs after it, even if a previous run died
   * mid-suite.
   */
  async function purgeTokenomicsFootprint(): Promise<void> {
    await prisma.tokenBurn.deleteMany({});
    await prisma.tokenBuyback.deleteMany({});
    await prisma.tokenAllocation.deleteMany({});
    // Every BURN leg ever written belongs to this module; strays from a
    // crashed run would otherwise inflate Module 10's burned figure forever.
    await prisma.transaction.deleteMany({ where: { type: 'BURN' } });
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

    await purgeTokenomicsFootprint();
    await purgeSuiteUsers();
  });

  afterAll(async () => {
    await purgeTokenomicsFootprint();
    await purgeSuiteUsers();
    createdUserIds.length = 0;
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const emberId = () => assetIdBySymbol.get('EMBER') as string;

  const minted = { token: '', userId: '' };

  beforeAll(async () => {
    minted.token = await mintToken({
      subject: `google:tokenomics-reader-${randomUUID()}`,
      email: `tokenomics-reader-${randomUUID()}@tokenomics.test`,
    });

    // The mutation routes (allocations/buybacks/executions/burns) are now
    // PLATFORM_ADMIN-gated (prompt §9), so this suite grants admin to its one
    // identity and covers the non-admin 403 below explicitly.
    const me = await http().get('/api/auth/me').set(bearer(minted.token)).expect(200);
    minted.userId = (me.body as { id: string }).id;
    createdUserIds.push(minted.userId);
    await prisma.userRole.upsert({
      where: { userId_role: { userId: minted.userId, role: 'PLATFORM_ADMIN' } },
      create: { userId: minted.userId, role: 'PLATFORM_ADMIN' },
      update: {},
    });
  });

  async function createUser(
    label: string,
    opts: { admin?: boolean } = {},
  ): Promise<{ token: string; userId: string; email: string }> {
    const email = `${label}-${randomUUID()}@tokenomics.test`.toLowerCase();
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    // Every suite identity acts on the gated mutation routes except the one
    // that exists purely to prove the 403 (admin defaults to granted).
    if (opts.admin !== false) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: response.body.id, role: 'PLATFORM_ADMIN' } },
        create: { userId: response.body.id, role: 'PLATFORM_ADMIN' },
        update: {},
      });
    }

    return { token, userId: response.body.id as string, email: response.body.email as string };
  }

  async function supply(): Promise<SupplyPayload> {
    const response = await http().get('/api/ember/supply').set(bearer(minted.token)).expect(200);
    return response.body as SupplyPayload;
  }

  /** after - before, at ledger precision. */
  function delta(after: string, before: string): string {
    return new Prisma.Decimal(after).minus(before).toFixed(18);
  }

  async function treasuryBalance(): Promise<{ available: string; locked: string }> {
    const zeros = { available: '0.000000000000000000', locked: '0.000000000000000000' };
    const treasury = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    if (!treasury) return zeros;

    const wallet = await prisma.wallet.findUnique({ where: { userId: treasury.id } });
    if (!wallet) return zeros;

    const balance = await prisma.walletBalance.findUnique({
      where: { walletId_assetId: { walletId: wallet.id, assetId: emberId() } },
    });
    return {
      available: (balance?.available ?? new Prisma.Decimal(0)).toFixed(18),
      locked: (balance?.locked ?? new Prisma.Decimal(0)).toFixed(18),
    };
  }

  /**
   * Funds the treasury the only sanctioned way: a test-level credit through
   * Module 03's write boundary. No API route mints anything - there is none
   * to call.
   */
  async function fundTreasury(amount: string): Promise<void> {
    const treasury = await prisma.user.upsert({
      where: { email: TREASURY_EMAIL },
      create: { email: TREASURY_EMAIL },
      update: {},
    });
    const { wallet } = await walletService.getOrCreateForUser(treasury.id);
    await walletService.credit(wallet.id, emberId(), amount);
  }

  // Request helpers: a fresh idempotency key per call unless the test passes one.
  const get = (path: string, token: string) => http().get(path).set(bearer(token));

  const post = (path: string, token: string, body: Record<string, unknown>) =>
    http().post(path).set(bearer(token)).send(body);

  const createAllocation = (
    token: string,
    body: { referenceAmount: string; emberPrice: string; clientRequestId?: string },
  ) => post('/api/tokenomics/allocations', token, { clientRequestId: randomUUID(), ...body });

  const createBuyback = (token: string, body: { allocationId: string; clientRequestId?: string }) =>
    post('/api/tokenomics/buybacks', token, { clientRequestId: randomUUID(), ...body });

  const executeBuyback = (token: string, buybackId: string, body: { executedPrice: string }) =>
    post(`/api/tokenomics/buybacks/${buybackId}/execute`, token, body);

  const createBurn = (
    token: string,
    body: {
      source: 'DIRECT' | 'BUYBACK';
      amount?: string;
      buybackId?: string;
      clientRequestId?: string;
    },
  ) => post('/api/tokenomics/burns', token, { clientRequestId: randomUUID(), ...body });

  interface AllocationBody {
    allocationId: string;
    referenceAmount: string;
    emberPrice: string;
    directBurnPct: number;
    buybackPct: number;
    directBurnInr: string;
    buybackInr: string;
    directBurnEmber: string;
    buybackEmber: string;
    clientRequestId: string;
    allocatedAt: string;
  }

  interface BuybackBody {
    buybackId: string;
    allocationId: string;
    status: TokenBuybackStatus;
    buybackInr: string;
    emberQuantity: string;
    executedPrice: string | null;
    executedEmber: string | null;
    executedAt: string | null;
    clientRequestId: string;
  }

  interface BurnBody {
    burnId: string;
    source: string;
    buybackId: string | null;
    amount: string;
    clientRequestId: string;
    burnedAt: string;
  }

  // -------------------------------------------------------------------------
  // Authentication and configuration
  // -------------------------------------------------------------------------

  describe('authentication and configuration', () => {
    it.each([
      ['GET', '/api/tokenomics/config'],
      ['POST', '/api/tokenomics/preview'],
      ['POST', '/api/tokenomics/allocations'],
      ['POST', '/api/tokenomics/buybacks'],
      ['POST', `/api/tokenomics/buybacks/${randomUUID()}/execute`],
      ['POST', '/api/tokenomics/burns'],
      ['GET', '/api/tokenomics/records'],
    ] as const)('refuses %s %s without a token', async (method, path) => {
      await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
    });

    it('refuses a mutation route to an authenticated non-admin (403), while reads stay open', async () => {
      const nonAdmin = await createUser('tokenomics-nonadmin', { admin: false });

      await http()
        .post('/api/tokenomics/allocations')
        .set(bearer(nonAdmin.token))
        .send({ referenceAmount: '100', emberPrice: '10', clientRequestId: randomUUID() })
        .expect(403);
      await http()
        .post('/api/tokenomics/burns')
        .set(bearer(nonAdmin.token))
        .send({ source: 'DIRECT', amount: '1', clientRequestId: randomUUID() })
        .expect(403);

      await get('/api/tokenomics/config', nonAdmin.token).expect(200);
      await get('/api/tokenomics/records', nonAdmin.token).expect(200);
    });

    it('reports the default 60/40 split the configuration resolved at boot', async () => {
      const response = await get('/api/tokenomics/config', minted.token).expect(200);

      expect(response.body).toEqual({ directBurnPct: 60, buybackPct: 40 });
    });

    it('starts from a zero-burn baseline: Module 10 absolute-zero figures hold', async () => {
      // The suite-start purge must have restored the state Module 10's suite
      // asserts whenever it runs - if this fails, residue leaked in.
      const before = await supply();
      expect(before.burnedSupply).toBe('0.000000000000000000');
      expect(before.circulatingSupply).toBe(before.totalIssuedSupply);
    });
  });

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  describe('POST /api/tokenomics/preview - computation only', () => {
    it('splits the documented 60/40 worked example: 80000 INR at a price of 10', async () => {
      const response = await post('/api/tokenomics/preview', minted.token, {
        referenceAmount: '80000',
        emberPrice: '10',
      }).expect(200);

      expect(response.body).toEqual({
        referenceAmount: '80000.00',
        emberPrice: '10.000000000000000000',
        directBurnPct: 60,
        buybackPct: 40,
        directBurnInr: '48000.00',
        buybackInr: '32000.00',
        directBurnEmber: '4800.000000000000000000',
        buybackEmber: '3200.000000000000000000',
        potentialBurnEmber: '8000.000000000000000000',
      });
    });

    it('rounds the direct portion HALF_UP and gives the buyback the exact remainder', async () => {
      const response = await post('/api/tokenomics/preview', minted.token, {
        referenceAmount: '100.01',
        emberPrice: '1',
      }).expect(200);

      // 100.01 x 60% = 60.006 -> 60.01; the buyback is the remainder 40.00,
      // so the two sum to the reference amount with no drift.
      expect(response.body['directBurnInr']).toBe('60.01');
      expect(response.body['buybackInr']).toBe('40.00');
      expect(
        new Prisma.Decimal(response.body['directBurnInr'] as string)
          .plus(response.body['buybackInr'] as string)
          .toFixed(2),
      ).toBe('100.01');
    });

    it('refuses zero, negative and over-precision inputs with 400', async () => {
      for (const referenceAmount of ['0', '-1', '10.005']) {
        const refused = await post('/api/tokenomics/preview', minted.token, {
          referenceAmount,
          emberPrice: '10',
        }).expect(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }

      const badPrice = await post('/api/tokenomics/preview', minted.token, {
        referenceAmount: '80000',
        emberPrice: '0',
      }).expect(400);
      expect(badPrice.body.code).toBe('VALIDATION_FAILED');
    });

    it('writes nothing: no allocation row and no supply movement', async () => {
      const allocationsBefore = await prisma.tokenAllocation.count();
      const before = await supply();

      await post('/api/tokenomics/preview', minted.token, {
        referenceAmount: '80000',
        emberPrice: '10',
      }).expect(200);

      expect(await prisma.tokenAllocation.count()).toBe(allocationsBefore);
      expect(await supply()).toEqual(before);
    });

    it('agrees exactly with the record POST /allocations would write', async () => {
      const user = await createUser('preview-matches');

      const preview = await post('/api/tokenomics/preview', user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
      }).expect(200);

      const recorded = await createAllocation(user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
      }).expect(201);

      const body = recorded.body as AllocationBody;
      expect(body.directBurnInr).toBe(preview.body['directBurnInr']);
      expect(body.buybackInr).toBe(preview.body['buybackInr']);
      expect(body.directBurnEmber).toBe(preview.body['directBurnEmber']);
      expect(body.buybackEmber).toBe(preview.body['buybackEmber']);
    });
  });

  // -------------------------------------------------------------------------
  // Allocations
  // -------------------------------------------------------------------------

  describe('POST /api/tokenomics/allocations - recording a proposal', () => {
    it('records the split with the configured percentages and moves nothing', async () => {
      const user = await createUser('allocation');
      const before = await supply();
      const burnRowsBefore = await prisma.tokenBurn.count();

      const response = await createAllocation(user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
      }).expect(201);

      const body = response.body as AllocationBody;
      expect(body.allocationId).toEqual(expect.any(String));
      expect(body.directBurnPct).toBe(60);
      expect(body.buybackPct).toBe(40);
      expect(body.directBurnInr).toBe('48000.00');
      expect(body.buybackInr).toBe('32000.00');
      expect(body.directBurnEmber).toBe('4800.000000000000000000');
      expect(body.buybackEmber).toBe('3200.000000000000000000');
      expect(body.clientRequestId).toEqual(expect.any(String));

      const row = await prisma.tokenAllocation.findUniqueOrThrow({
        where: { allocationId: body.allocationId },
      });
      expect(row.userId).toBe(user.userId);

      // An allocation is a proposal: no ledger row, no burn row, no supply
      // movement of any kind.
      expect(await prisma.transaction.count({ where: { wallet: { userId: user.userId } } })).toBe(0);
      expect(await prisma.tokenBurn.count()).toBe(burnRowsBefore);
      expect(await supply()).toEqual(before);
    });

    it('replays an identical allocation with 200 and writes exactly one row', async () => {
      const user = await createUser('allocation-replay');
      const clientRequestId = randomUUID();
      const payload = { referenceAmount: '80000', emberPrice: '10', clientRequestId };

      const first = await createAllocation(user.token, payload).expect(201);
      const second = await createAllocation(user.token, payload).expect(200);

      expect(second.body).toEqual(first.body);
      expect(
        await prisma.tokenAllocation.count({ where: { clientRequestId, userId: user.userId } }),
      ).toBe(1);
    });

    it('refuses a replayed key whose amount or price differs with 409 CONFLICT', async () => {
      const user = await createUser('allocation-conflict');
      const clientRequestId = randomUUID();

      await createAllocation(user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
        clientRequestId,
      }).expect(201);

      const amountChanged = await createAllocation(user.token, {
        referenceAmount: '90000',
        emberPrice: '10',
        clientRequestId,
      }).expect(409);
      expect(amountChanged.body.code).toBe('CONFLICT');

      const priceChanged = await createAllocation(user.token, {
        referenceAmount: '80000',
        emberPrice: '11',
        clientRequestId,
      }).expect(409);
      expect(priceChanged.body.code).toBe('CONFLICT');

      expect(
        await prisma.tokenAllocation.count({ where: { clientRequestId, userId: user.userId } }),
      ).toBe(1);
    });

    it('scopes the key per caller: two users may reuse the same clientRequestId', async () => {
      const alice = await createUser('key-scope-alice');
      const bob = await createUser('key-scope-bob');
      const clientRequestId = randomUUID();

      await createAllocation(alice.token, {
        referenceAmount: '1000',
        emberPrice: '10',
        clientRequestId,
      }).expect(201);
      await createAllocation(bob.token, {
        referenceAmount: '1000',
        emberPrice: '10',
        clientRequestId,
      }).expect(201);
    });

    it('settles two racing identical requests on exactly one allocation', async () => {
      const user = await createUser('allocation-race');
      const payload = { referenceAmount: '80000', emberPrice: '10', clientRequestId: randomUUID() };

      const [a, b] = await Promise.all([
        createAllocation(user.token, payload),
        createAllocation(user.token, payload),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as AllocationBody).allocationId).toBe(
        (b.body as AllocationBody).allocationId,
      );
      expect(
        await prisma.tokenAllocation.count({ where: { clientRequestId: payload.clientRequestId } }),
      ).toBe(1);
    });

    it('refuses invalid inputs and unknown fields with 400', async () => {
      const user = await createUser('allocation-validation');

      const zero = await createAllocation(user.token, {
        referenceAmount: '0',
        emberPrice: '10',
      }).expect(400);
      expect(zero.body.code).toBe('VALIDATION_FAILED');

      const numericAmount = await post('/api/tokenomics/allocations', user.token, {
        referenceAmount: 80000,
        emberPrice: '10',
        clientRequestId: randomUUID(),
      }).expect(400);
      expect(numericAmount.body.code).toBe('VALIDATION_FAILED');

      const badKey = await createAllocation(user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
        clientRequestId: 'not-a-uuid',
      }).expect(400);
      expect(badKey.body.code).toBe('VALIDATION_FAILED');

      const unknownField = await post('/api/tokenomics/allocations', user.token, {
        referenceAmount: '80000',
        emberPrice: '10',
        clientRequestId: randomUUID(),
        extra: true,
      }).expect(400);
      expect(unknownField.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Simulated buybacks
  // -------------------------------------------------------------------------

  describe('simulated buybacks - two stages, neither moving anything', () => {
    it('proposes a SIMULATED buyback and records an execution, changing no supply', async () => {
      const user = await createUser('buyback-lifecycle');
      const before = await supply();
      const burnRowsBefore = await prisma.tokenBurn.count();

      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;

      const proposed = await createBuyback(user.token, {
        allocationId: allocation.allocationId,
      }).expect(201);
      const proposal = proposed.body as BuybackBody;
      expect(proposal.status).toBe('SIMULATED');
      expect(proposal.buybackInr).toBe('32000.00');
      expect(proposal.emberQuantity).toBe('3200.000000000000000000');
      expect(proposal.executedPrice).toBeNull();
      expect(proposal.executedEmber).toBeNull();

      const executed = await executeBuyback(user.token, proposal.buybackId, {
        executedPrice: '10',
      }).expect(201);
      const execution = executed.body as BuybackBody;
      expect(execution.status).toBe('RECORDED_SIMULATED_EXECUTION');
      expect(execution.executedPrice).toBe('10.000000000000000000');
      expect(execution.executedEmber).toBe('3200.000000000000000000');
      expect(execution.executedAt).toEqual(expect.any(String));

      // The whole buyback lifecycle is simulation: no BURN leg, no record, no
      // supply movement, treasury untouched. This is what separates it from a
      // burn - buyback without burn changes nothing real.
      expect(await prisma.tokenBurn.count()).toBe(burnRowsBefore);
      expect(await supply()).toEqual(before);
      expect(await treasuryBalance()).toEqual({
        available: '0.000000000000000000',
        locked: '0.000000000000000000',
      });
    });

    it('replays an execution at the same price with 200, and refuses a different one with 409', async () => {
      const user = await createUser('execute-replay');
      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const buyback = (
        await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;

      const first = await executeBuyback(user.token, buyback.buybackId, {
        executedPrice: '10',
      }).expect(201);
      const replay = await executeBuyback(user.token, buyback.buybackId, {
        executedPrice: '10',
      }).expect(200);
      expect(replay.body).toEqual(first.body);

      const changed = await executeBuyback(user.token, buyback.buybackId, {
        executedPrice: '11',
      }).expect(409);
      expect(changed.body.code).toBe('CONFLICT');

      const stored = await prisma.tokenBuyback.findUniqueOrThrow({
        where: { buybackId: buyback.buybackId },
      });
      expect(stored.executedPrice?.toFixed(18)).toBe('10.000000000000000000');
    });

    it('resolves two racing executions at the same price to exactly one winner', async () => {
      const user = await createUser('execute-race');
      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const buyback = (
        await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;

      const [a, b] = await Promise.all([
        executeBuyback(user.token, buyback.buybackId, { executedPrice: '10' }),
        executeBuyback(user.token, buyback.buybackId, { executedPrice: '10' }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as BuybackBody).executedEmber).toBe(
        (b.body as BuybackBody).executedEmber,
      );
    });

    it('allows one buyback per allocation: the second is 409 even under a new key', async () => {
      const user = await createUser('one-buyback');
      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;

      await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201);

      const second = await createBuyback(user.token, {
        allocationId: allocation.allocationId,
      }).expect(409);
      expect(second.body.code).toBe('CONFLICT');
      expect(await prisma.tokenBuyback.count({ where: { allocationId: allocation.allocationId } })).toBe(1);
    });

    it('refuses a replayed buyback key that names another allocation with 409', async () => {
      const user = await createUser('buyback-replay');
      const first = (
        await createAllocation(user.token, { referenceAmount: '1000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const second = (
        await createAllocation(user.token, { referenceAmount: '2000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;

      const clientRequestId = randomUUID();
      await createBuyback(user.token, {
        allocationId: first.allocationId,
        clientRequestId,
      }).expect(201);

      const replay = await createBuyback(user.token, {
        allocationId: first.allocationId,
        clientRequestId,
      }).expect(200);
      expect((replay.body as BuybackBody).allocationId).toBe(first.allocationId);

      const changed = await createBuyback(user.token, {
        allocationId: second.allocationId,
        clientRequestId,
      }).expect(409);
      expect(changed.body.code).toBe('CONFLICT');
    });

    it('answers an unknown or foreign allocation with 404, never 403', async () => {
      const owner = await createUser('buyback-owner');
      const stranger = await createUser('buyback-stranger');
      const allocation = (
        await createAllocation(owner.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;

      const unknown = await createBuyback(stranger.token, {
        allocationId: randomUUID(),
      }).expect(404);
      expect(unknown.body.code).toBe('NOT_FOUND');

      const foreign = await createBuyback(stranger.token, {
        allocationId: allocation.allocationId,
      }).expect(404);
      expect(foreign.body.code).toBe('NOT_FOUND');

      const foreignExecute = await executeBuyback(stranger.token, randomUUID(), {
        executedPrice: '10',
      }).expect(404);
      expect(foreignExecute.body.code).toBe('NOT_FOUND');
    });

    it('refuses a non-UUID buyback id on the execute route with 400', async () => {
      const user = await createUser('execute-param');
      await post('/api/tokenomics/buybacks/not-a-uuid/execute', user.token, {
        executedPrice: '10',
      }).expect(400);
    });

    it('refuses a price whose quantity floors to zero rather than recording nothing', async () => {
      const user = await createUser('execute-zero');
      // A reference amount this small makes the buyback portion exactly 0.00
      // after the split (0.01 - 0.01), so any price floors its quantity to zero.
      const allocation = (
        await createAllocation(user.token, { referenceAmount: '0.01', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      expect(allocation.buybackInr).toBe('0.00');
      const buyback = (
        await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;

      const refused = await executeBuyback(user.token, buyback.buybackId, {
        executedPrice: '10',
      }).expect(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');

      const stored = await prisma.tokenBuyback.findUniqueOrThrow({
        where: { buybackId: buyback.buybackId },
      });
      expect(stored.status).toBe('SIMULATED');
      expect(stored.executedEmber).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Burns
  // -------------------------------------------------------------------------

  describe('POST /api/tokenomics/burns - the one operation that destroys EMBER', () => {
    // MUST run first in this describe: it requires the treasury not to exist
    // yet, which the suite-start purge guarantees. Every later test may fund
    // or create it.
    it('auto-provisions the treasury on the first burn attempt, and refuses it unfunded', async () => {
      expect(await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } })).toBeNull();

      const user = await createUser('burn-first');
      const before = await supply();

      const refused = await createBurn(user.token, { source: 'DIRECT', amount: '10' }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

      // The treasury user and wallet now exist, funded by nothing, so this
      // burn destroyed nothing - supply is untouched and no record was written.
      const treasury = await prisma.user.findUniqueOrThrow({ where: { email: TREASURY_EMAIL } });
      expect(await prisma.wallet.count({ where: { userId: treasury.id } })).toBe(1);
      expect(await treasuryBalance()).toEqual({
        available: '0.000000000000000000',
        locked: '0.000000000000000000',
      });
      expect(await prisma.tokenBurn.count()).toBe(0);
      expect(await supply()).toEqual(before);
    });

    it('burns DIRECT: one BURN ledger leg plus one record, supply down by exactly the amount', async () => {
      await fundTreasury('1000');
      const user = await createUser('burn-direct');

      const before = await supply();
      const treasuryBefore = await treasuryBalance();
      const burnRowsBefore = await prisma.tokenBurn.count();

      const response = await createBurn(user.token, { source: 'DIRECT', amount: '100' }).expect(201);
      const burn = response.body as BurnBody;
      expect(burn.source).toBe('DIRECT');
      expect(burn.buybackId).toBeNull();
      expect(burn.amount).toBe('100.000000000000000000');
      expect(burn.burnedAt).toEqual(expect.any(String));

      // The record exists if and only if the destruction committed: read back
      // both the ledger and the table, plus the treasury that funded it.
      const treasury = await prisma.user.findUniqueOrThrow({ where: { email: TREASURY_EMAIL } });
      const legs = await prisma.transaction.findMany({
        where: { type: 'BURN', note: `EMBER burn ${burn.burnId}` },
      });
      expect(legs).toHaveLength(1);
      expect(legs[0]?.amount.toFixed(18)).toBe('100.000000000000000000');
      const treasuryWallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: treasury.id },
      });
      expect(legs[0]?.walletId).toBe(treasuryWallet.id);

      expect(await prisma.tokenBurn.count()).toBe(burnRowsBefore + 1);
      expect(await treasuryBalance()).toEqual({
        available: new Prisma.Decimal(treasuryBefore.available).minus('100').toFixed(18),
        locked: treasuryBefore.locked,
      });

      const after = await supply();
      expect(delta(after.burnedSupply, before.burnedSupply)).toBe('100.000000000000000000');
      expect(delta(before.circulatingSupply, after.circulatingSupply)).toBe('100.000000000000000000');
      expect(after.totalIssuedSupply).toBe(before.totalIssuedSupply);
      expect(delta(before.availableSupply, after.availableSupply)).toBe('100.000000000000000000');
      expect(after.lockedSupply).toBe(before.lockedSupply);
    });

    it('replays an identical burn with 200: one record, one debit', async () => {
      const user = await createUser('burn-replay');
      const before = await supply();
      const treasuryBefore = await treasuryBalance();

      const clientRequestId = randomUUID();
      const payload = { source: 'DIRECT' as const, amount: '50', clientRequestId };

      const first = await createBurn(user.token, payload).expect(201);
      const second = await createBurn(user.token, payload).expect(200);
      expect(second.body).toEqual(first.body);

      expect(await prisma.tokenBurn.count({ where: { clientRequestId, userId: user.userId } })).toBe(1);
      expect(await treasuryBalance()).toEqual({
        available: new Prisma.Decimal(treasuryBefore.available).minus('50').toFixed(18),
        locked: treasuryBefore.locked,
      });

      const after = await supply();
      expect(delta(after.burnedSupply, before.burnedSupply)).toBe('50.000000000000000000');
    });

    it('refuses a replayed burn key whose amount differs with 409 CONFLICT', async () => {
      const user = await createUser('burn-conflict');
      const clientRequestId = randomUUID();

      await createBurn(user.token, {
        source: 'DIRECT',
        amount: '10',
        clientRequestId,
      }).expect(201);

      const refused = await createBurn(user.token, {
        source: 'DIRECT',
        amount: '11',
        clientRequestId,
      }).expect(409);
      expect(refused.body.code).toBe('CONFLICT');
      expect(
        await prisma.tokenBurn.count({ where: { clientRequestId, userId: user.userId } }),
      ).toBe(1);
    });

    it('settles two racing identical burns on exactly one record and one debit', async () => {
      const user = await createUser('burn-race');
      const treasuryBefore = await treasuryBalance();
      const burnedBefore = (await supply()).burnedSupply;

      const payload = { source: 'DIRECT' as const, amount: '25', clientRequestId: randomUUID() };
      const [a, b] = await Promise.all([
        createBurn(user.token, payload),
        createBurn(user.token, payload),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as BurnBody).burnId).toBe((b.body as BurnBody).burnId);
      expect(
        await prisma.tokenBurn.count({ where: { clientRequestId: payload.clientRequestId } }),
      ).toBe(1);

      // The loser's debit rolled back with its failed insert: exactly 25 gone.
      expect(await treasuryBalance()).toEqual({
        available: new Prisma.Decimal(treasuryBefore.available).minus('25').toFixed(18),
        locked: treasuryBefore.locked,
      });
      expect(delta((await supply()).burnedSupply, burnedBefore)).toBe('25.000000000000000000');
    });

    it('refuses a burn the treasury cannot fund with 409, writing no record and moving no supply', async () => {
      const user = await createUser('burn-insufficient');
      const funded = await treasuryBalance();
      const before = await supply();
      const burnRowsBefore = await prisma.tokenBurn.count();

      const tooMuch = new Prisma.Decimal(funded.available).plus('0.01').toFixed(18);
      const refused = await createBurn(user.token, {
        source: 'DIRECT',
        amount: tooMuch,
      }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

      expect(await prisma.tokenBurn.count()).toBe(burnRowsBefore);
      expect(await treasuryBalance()).toEqual(funded);
      expect(await supply()).toEqual(before);
    });

    it('refuses invalid DIRECT burns with 400 before anything is written', async () => {
      const user = await createUser('burn-validation');
      const burnRowsBefore = await prisma.tokenBurn.count();

      const noAmount = await createBurn(user.token, { source: 'DIRECT' }).expect(400);
      expect(noAmount.body.code).toBe('VALIDATION_FAILED');

      for (const amount of ['0', '-5', '1.0000000000000000001']) {
        const refused = await createBurn(user.token, { source: 'DIRECT', amount }).expect(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }

      const withBuyback = await createBurn(user.token, {
        source: 'DIRECT',
        amount: '10',
        buybackId: randomUUID(),
      }).expect(400);
      expect(withBuyback.body.code).toBe('VALIDATION_FAILED');

      const numeric = await post('/api/tokenomics/burns', user.token, {
        source: 'DIRECT',
        amount: 10,
        clientRequestId: randomUUID(),
      }).expect(400);
      expect(numeric.body.code).toBe('VALIDATION_FAILED');

      expect(await prisma.tokenBurn.count()).toBe(burnRowsBefore);
    });

    it('refuses invalid BUYBACK burns with 400: no amount allowed, id required', async () => {
      const user = await createUser('burn-buyback-validation');

      const noId = await createBurn(user.token, { source: 'BUYBACK' }).expect(400);
      expect(noId.body.code).toBe('VALIDATION_FAILED');

      const withAmount = await createBurn(user.token, {
        source: 'BUYBACK',
        buybackId: randomUUID(),
        amount: '10',
      }).expect(400);
      expect(withAmount.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a BUYBACK burn before its execution is recorded with 409', async () => {
      const user = await createUser('burn-before-execute');
      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const buyback = (
        await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;

      const refused = await createBurn(user.token, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
      }).expect(409);
      expect(refused.body.code).toBe('CONFLICT');
      expect(await prisma.tokenBurn.count({ where: { buybackId: buyback.buybackId } })).toBe(0);
    });

    it('burns BUYBACK: exactly the executed quantity, counted once, in the same shape as a DIRECT burn', async () => {
      await fundTreasury('5000');
      const user = await createUser('burn-buyback');

      const allocation = (
        await createAllocation(user.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const buyback = (
        await createBuyback(user.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;
      const execution = (
        await executeBuyback(user.token, buyback.buybackId, { executedPrice: '10' }).expect(201)
      ).body as BuybackBody;

      const before = await supply();
      const treasuryBefore = await treasuryBalance();

      const response = await createBurn(user.token, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
      }).expect(201);
      const burn = response.body as BurnBody;
      expect(burn.source).toBe('BUYBACK');
      expect(burn.buybackId).toBe(buyback.buybackId);
      // The amount is the executed quantity exactly - never caller-stated.
      expect(burn.amount).toBe('3200.000000000000000000');
      expect(burn.amount).toBe(execution.executedEmber);

      const after = await supply();
      expect(delta(after.burnedSupply, before.burnedSupply)).toBe('3200.000000000000000000');
      expect(delta(before.circulatingSupply, after.circulatingSupply)).toBe('3200.000000000000000000');
      expect(after.totalIssuedSupply).toBe(before.totalIssuedSupply);
      expect(await treasuryBalance()).toEqual({
        available: new Prisma.Decimal(treasuryBefore.available).minus('3200').toFixed(18),
        locked: treasuryBefore.locked,
      });

      // One burn per execution, enforced by the database: a second attempt
      // under a different key is 409, not a second destruction.
      const secondKey = await createBurn(user.token, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
      }).expect(409);
      expect(secondKey.body.code).toBe('CONFLICT');
      expect(await prisma.tokenBurn.count({ where: { buybackId: buyback.buybackId } })).toBe(1);

      // An identical replay is 200 and still does not burn again.
      const replay = await createBurn(user.token, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
        clientRequestId: burn.clientRequestId,
      }).expect(200);
      expect(replay.body).toEqual(burn);
      expect(await prisma.tokenBurn.count({ where: { buybackId: buyback.buybackId } })).toBe(1);
    });

    it('answers an unknown or foreign buyback burn with 404, never 403', async () => {
      const owner = await createUser('burn-owner');
      const stranger = await createUser('burn-stranger');

      const unknown = await createBurn(stranger.token, {
        source: 'BUYBACK',
        buybackId: randomUUID(),
      }).expect(404);
      expect(unknown.body.code).toBe('NOT_FOUND');

      const allocation = (
        await createAllocation(owner.token, { referenceAmount: '80000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const buyback = (
        await createBuyback(owner.token, { allocationId: allocation.allocationId }).expect(201)
      ).body as BuybackBody;
      await executeBuyback(owner.token, buyback.buybackId, { executedPrice: '10' }).expect(201);

      const foreign = await createBurn(stranger.token, {
        source: 'BUYBACK',
        buybackId: buyback.buybackId,
      }).expect(404);
      expect(foreign.body.code).toBe('NOT_FOUND');
      expect(await prisma.tokenBurn.count({ where: { buybackId: buyback.buybackId } })).toBe(0);
    });

    it('reconciles all three views of burning: ledger, token_burns table and supply', async () => {
      // Suite-start baseline asserted zero burns, so everything burned in
      // this suite is visible in all three places - and they must agree.
      const totalBurned = await prisma.tokenBurn.aggregate({ _sum: { amount: true } });
      const ledgerBurned = await prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'BURN' },
      });
      const burnRows = await prisma.tokenBurn.count();
      const ledgerRows = await prisma.transaction.count({ where: { type: 'BURN' } });

      const sum = totalBurned._sum.amount ?? new Prisma.Decimal(0);
      const ledgerSum = ledgerBurned._sum.amount ?? new Prisma.Decimal(0);
      expect(ledgerSum.toFixed(18)).toBe(sum.toFixed(18));
      expect(ledgerRows).toBe(burnRows);
      expect(sum.gt(0)).toBe(true);

      const body = await supply();
      expect(body.burnedSupply).toBe(sum.toFixed(18));

      // The shared-ledger invariant, now including real burns.
      expect(
        new Prisma.Decimal(body.availableSupply).plus(body.lockedSupply).toFixed(18),
      ).toBe(new Prisma.Decimal(body.circulatingSupply).toFixed(18));
      expect(
        new Prisma.Decimal(body.totalIssuedSupply).minus(body.burnedSupply).toFixed(18),
      ).toBe(new Prisma.Decimal(body.circulatingSupply).toFixed(18));
    });
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  describe('GET /api/tokenomics/records - per-caller history', () => {
    it('returns only the caller’s records, newest first, and nothing for an empty caller', async () => {
      const alice = await createUser('records-alice');
      const bob = await createUser('records-bob');

      const allocationOne = (
        await createAllocation(alice.token, { referenceAmount: '1000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const allocationTwo = (
        await createAllocation(alice.token, { referenceAmount: '2000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;

      const bobAllocation = (
        await createAllocation(bob.token, { referenceAmount: '3000', emberPrice: '10' }).expect(201)
      ).body as AllocationBody;
      const bobBuyback = (
        await createBuyback(bob.token, { allocationId: bobAllocation.allocationId }).expect(201)
      ).body as BuybackBody;

      const bobRecords = (
        await get('/api/tokenomics/records', bob.token).expect(200)
      ).body as {
        allocations: AllocationBody[];
        buybacks: BuybackBody[];
        burns: unknown[];
      };
      expect(bobRecords.allocations.map((row) => row.allocationId)).toEqual([
        bobAllocation.allocationId,
      ]);
      expect(bobRecords.buybacks.map((row) => row.buybackId)).toEqual([bobBuyback.buybackId]);
      expect(bobRecords.burns).toEqual([]);
      // Alice's records never appear in Bob's listing.
      const aliceIds = [allocationOne.allocationId, allocationTwo.allocationId];
      expect(JSON.stringify(bobRecords)).not.toContain(aliceIds[0]);
      expect(JSON.stringify(bobRecords)).not.toContain(aliceIds[1]);

      const aliceRecords = (
        await get('/api/tokenomics/records', alice.token).expect(200)
      ).body as { allocations: AllocationBody[]; buybacks: unknown[]; burns: unknown[] };
      expect(aliceRecords.allocations.map((row) => row.allocationId).sort()).toEqual(
        [...aliceIds].sort(),
      );
      // Newest first: the second-created allocation never sorts above the first.
      const [first, second] = aliceRecords.allocations;
      expect(
        first !== undefined && second !== undefined && first.allocatedAt >= second.allocatedAt,
      ).toBe(true);
      expect(aliceRecords.buybacks).toEqual([]);
      expect(aliceRecords.burns).toEqual([]);

      const empty = (
        await get('/api/tokenomics/records', minted.token).expect(200)
      ).body as { allocations: unknown[]; buybacks: unknown[]; burns: unknown[] };
      expect(empty).toEqual({ allocations: [], buybacks: [], burns: [] });
    });
  });
});
