import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { createAppConfig } from '../src/config/app.config';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { LiquidityService } from '../src/modules/liquidity/liquidity.service';
import { decideExchangeRevenue } from '../src/modules/tokenomics/domain/exchange-revenue';
import { WalletService } from '../src/modules/wallet/wallet.service';
import {
  clearTestLiquidityEnv,
  configureTestLiquidityEnv,
  resetLiquidityTables,
} from './liquidity-test-fixture';
import { mintToken } from './token-minting';

/**
 * MODULE 08 x MODULE 11 - the settled order reaches the burn engine, over HTTP,
 * against the real database.
 *
 * The unit suite for this bridge (`src/modules/tokenomics/exchange-revenue
 * .service.spec.ts`) covers the queue mechanics against a mock, because two
 * processes losing the same row-lock cannot be put on a schedule. This suite is
 * the other half: what is only true on a real Postgres - the UNIQUE on `order_id`
 * actually rejecting a second event, a guarded `updateMany` actually serialising
 * two passes, a burn actually debiting a treasury and actually moving
 * `burnedSupply`, and the supply figure reconciling with the ledger legs.
 *
 * WHY THE SUITE BOOTS WITH THE REVENUE POLICY SWITCHED ON
 * ------------------------------------------------------
 * A deployment starts at `TOKENOMICS_EXCHANGE_REVENUE_MODE=NONE` and that default
 * is asserted here too, in its own test. Proving the economics needs the opposite:
 * the policy enabled at its ceiling (10,000 bps of everything retained), so the
 * zero a settled BUY produces cannot be blamed on a switch. Under that setting the
 * attributed revenue is still ₹0, which is the finding rather than a configuration.
 *
 * WHY SOME TESTS SEED AN EVENT ROW DIRECTLY
 * -----------------------------------------
 * The headline finding of this integration is that a settled BUY retains
 * nothing: the customer's entire INR is credited to the liquidity providers who
 * supplied the USDT. That is asserted first, from a real order through the real
 * route, with no mock in sight. It also means the pipeline downstream cannot be
 * reached by a real order today - so the pipeline tests take a real settled order
 * and write a margin over its event, carrying the one thing a settlement cannot
 * produce. Those tests are about the *processor*. Nothing here is evidence that
 * burning purchase money works, because it does not, and the suite says so in the
 * read model rather than hiding it.
 *
 * TREASURY ARITHMETIC
 * -------------------
 * The reserve floor is 30% of the treasury wallet's cumulative qualifying
 * DEPOSIT legs. The treasury is therefore deleted between tests (its funding
 * history is the floor) and re-funded per test, and every amount is chosen
 * against 1,000 EMBER of funding - 2,000 where the test needs both burns to
 * land: available 1,000, protected 300. A burn that fits inside 1,000 but
 * crosses 300 is a reserve breach; one that does not fit is an insufficient
 * balance. Both must be reported and retried, never routed around.
 *
 * The split itself is the adaptive policy's, not a fixture's: at these funding
 * levels the treasury reads as healthy, so it resolves to the configured 60/40
 * baseline, and each test's EMBER quantities follow from that.
 *
 * Isolation follows the suites this one touches: a fixture LP so BUYs draw real
 * commitments, UUID-per-user emails, and purges in FK-safe order (revenue events
 * Restrict-reference both orders and users, so they always go first).
 */
describe('USDT exchange to EMBER tokenomics - the settlement bridge (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  const TREASURY_EMAIL = 'treasury@prometheus.local';
  const ENGINE_EMAIL = 'tokenomics-engine@prometheus.local';

  let adminToken: string;
  let plainToken: string;

  interface SupplyPayload {
    burnedSupply: string;
    circulatingSupply: string;
    totalIssuedSupply: string;
  }

  /**
   * Everything this suite can create, in FK-safe order. Also run at start, so a
   * run that died mid-suite cannot leave burns that Module 10's absolute-zero
   * assertions would then blame on an innocent suite.
   */
  async function purgeFootprint(): Promise<void> {
    await prisma.exchangeRevenueEvent.deleteMany({});
    await prisma.tokenBurn.deleteMany({});
    await prisma.tokenBuyback.deleteMany({});
    await prisma.tokenAllocation.deleteMany({});
    await prisma.transaction.deleteMany({ where: { type: 'BURN' } });
  }

  /**
   * The treasury's whole history, not just its balance. Its qualifying DEPOSIT
   * legs ARE the reserve floor's basis, so leaving funding behind would move the
   * floor under the next test's arithmetic.
   */
  async function removeTreasury(): Promise<void> {
    const treasury = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL }, select: { id: true } });
    if (!treasury) return;

    await prisma.transaction.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.wallet.deleteMany({ where: { userId: treasury.id } });
    await prisma.userRole.deleteMany({ where: { userId: treasury.id } });
    await prisma.user.deleteMany({ where: { id: treasury.id } });
  }

  async function purgeUsers(): Promise<void> {
    const ids = [...createdUserIds];
    for (const email of [TREASURY_EMAIL, ENGINE_EMAIL]) {
      const found = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (found && !ids.includes(found.id)) ids.push(found.id);
    }
    if (ids.length === 0) return;

    await prisma.exchangeRevenueEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.usdtOrder.deleteMany({ where: { userId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: ids } } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: ids } } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    // Module 09 slabs must exist before boot - configuration is read once.
    configureTestLiquidityEnv();

    // The revenue policy is switched ON for this suite, at the most aggressive
    // setting it permits (every retained rupee attributed). The shipped default is
    // `NONE` - asserted separately below - and running the suite switched off would
    // prove nothing: a zero under `NONE` is the switch, not the economics. With the
    // policy at 10,000 bps, the zero that a settled BUY still produces can only
    // come from the settlement retaining nothing, which is the finding this suite
    // exists to establish.
    process.env['TOKENOMICS_EXCHANGE_REVENUE_MODE'] = 'RETAINED_BPS';
    process.env['TOKENOMICS_EXCHANGE_REVENUE_BPS'] = '10000';

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);
    for (const symbol of ['INR', 'USDT', 'EMBER']) {
      assetIdBySymbol.set(symbol, (await prisma.asset.findUniqueOrThrow({ where: { symbol } })).id);
    }

    await purgeFootprint();
    await removeTreasury();
    // Liquidity before users: `liquidity_allocations.order_id` Restrict-references
    // the order, so an order cannot go while a slice still points at it.
    await resetLiquidityTables(prisma);
    await purgeUsers();

    // One generous LP, so a BUY settles against a real commitment and the event's
    // `lpInrSettled` is the true LP credit rather than a legacy-path zero.
    await seedBridgeLiquidity();

    adminToken = (await createUser('bridge-admin', true)).token;
    plainToken = (await createUser('bridge-caller')).token;
  });

  /**
   * The fixture provider every BUY needs to be LP-backed. Re-callable because one
   * test removes all providers to reach Module 08's legacy mint path and must put
   * the world back for the suites that follow.
   */
  async function seedBridgeLiquidity(): Promise<void> {
    const lp = await createUser(`bridge-lp-${randomUUID().slice(0, 8)}`);
    await fund(lp.userId, 'USDT', '1000000');
    await fund(lp.userId, 'EMBER', '150000');
    await app.get(LiquidityService).createCommitment(lp.userId, {
      usdtAmount: '1000000',
      clientRequestId: randomUUID(),
    });
  }

  afterAll(async () => {
    await purgeFootprint();
    await removeTreasury();
    await resetLiquidityTables(prisma);
    await purgeUsers();
    createdUserIds.length = 0;
    clearTestLiquidityEnv();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const assetId = (symbol: 'INR' | 'USDT' | 'EMBER') => assetIdBySymbol.get(symbol) as string;

  async function createUser(label: string, admin = false): Promise<{ token: string; userId: string }> {
    const email = `${label}-${randomUUID()}@bridge.test`.toLowerCase();
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });
    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    const userId = (me.body as { id: string }).id;
    createdUserIds.push(userId);

    await http().post('/api/wallets').set(bearer(token)).expect(201);

    if (admin) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId, role: 'PLATFORM_ADMIN' } },
        create: { userId, role: 'PLATFORM_ADMIN' },
        update: {},
      });
    }

    return { token, userId };
  }

  async function walletIdFor(userId: string): Promise<string> {
    return (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).id;
  }

  async function fund(userId: string, symbol: 'INR' | 'USDT' | 'EMBER', amount: string): Promise<void> {
    await walletService.credit(await walletIdFor(userId), assetId(symbol), amount);
  }

  async function availableOf(userId: string, symbol: 'INR' | 'USDT' | 'EMBER'): Promise<Prisma.Decimal> {
    const balance = await prisma.walletBalance.findUnique({
      where: { walletId_assetId: { walletId: await walletIdFor(userId), assetId: assetId(symbol) } },
    });
    return balance?.available ?? new Prisma.Decimal(0);
  }

  async function supply(): Promise<SupplyPayload> {
    const response = await http().get('/api/ember/supply').set(bearer(plainToken)).expect(200);
    return response.body as SupplyPayload;
  }

  /**
   * The treasury, created exactly the way Module 11 creates it on a first burn
   * (unique email, then the wallet service). Pre-created rather than provoked,
   * because a burn that rolls back takes its auto-provisioned treasury with it -
   * and every guardrail test here is about a burn that rolls back.
   */
  async function ensureTreasury(): Promise<string> {
    const existing = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL }, select: { id: true } });
    const userId = existing?.id ?? (await prisma.user.create({ data: { email: TREASURY_EMAIL } })).id;
    await walletService.getOrCreateForUser(userId);
    return userId;
  }

  /** Funds the treasury with `amount` EMBER of qualifying DEPOSIT legs. */
  async function fundTreasury(amount: string): Promise<string> {
    const userId = await ensureTreasury();
    await fund(userId, 'EMBER', amount);
    return userId;
  }

  function buy(token: string, usdtAmount: string): request.Test {
    return http().post('/api/usdt/buy').set(bearer(token)).send({ clientRequestId: randomUUID(), usdtAmount });
  }

  const event = (eventId: string) => prisma.exchangeRevenueEvent.findUniqueOrThrow({ where: { eventId } });

  /**
   * An event row carrying the one thing a real settlement cannot: a retained
   * margin. See the header.
   *
   * `order_id` is a real foreign key, so the fixture starts from a genuine settled
   * BUY and then rewrites its economic columns. They stay mutually consistent -
   * the customer's INR equals the LP credit plus the retention - so the row is a
   * valid snapshot of a different economy rather than a contradiction. Only the
   * rupees are fiction; the order, the buyer and the queue are the database's own.
   *
   * `revenueInr` is the rupees attributed, so at an EMBER price of 1 the burn
   * quantities are that number split by the adaptive policy - which is what makes
   * the guardrail arithmetic above readable at a glance. The fixture writes
   * `basisInr` to match, because this row is dressed as a `RETAINED_BPS` decision
   * and the pipeline sizes itself from the basis, not from the revenue.
   */
  async function seedEligibleEvent(params: {
    referenceInr: string;
    emberPrice?: string;
    status?: 'PENDING' | 'PROCESSING' | 'BLOCKED';
    maxAttempts?: number;
    nextAttemptAt?: Date | null;
  }): Promise<string> {
    const orderId = await settledOrderId();

    const updated = await prisma.exchangeRevenueEvent.update({
      where: { orderId },
      data: {
        customerInr: new Prisma.Decimal(params.referenceInr).plus('1.00'),
        lpInrSettled: '1.00',
        retainedInr: params.referenceInr,
        revenueMode: 'RETAINED_BPS',
        revenueBps: 10_000,
        revenueInr: params.referenceInr,
        basisInr: params.referenceInr,
        emberPrice: params.emberPrice ?? '1',
        directBurnPct: 60,
        buybackPct: 40,
        status: params.status ?? 'PENDING',
        reasonCode: 'ATTRIBUTED',
        detail: 'Fixture order carrying a retained margin the live exchange cannot produce.',
        maxAttempts: params.maxAttempts ?? 12,
        nextAttemptAt: params.nextAttemptAt === undefined ? new Date() : params.nextAttemptAt,
      },
    });

    return updated.eventId;
  }

  /**
   * One real settled BUY, and the id of the order that settled. Every fixture
   * event hangs off this, so the foreign key, the buyer and the settlement's own
   * columns are all genuinely there before the margin is written over them.
   */
  async function settledOrderId(): Promise<string> {
    const buyer = await createUser(`margin-buyer-${randomUUID().slice(0, 8)}`);
    await fund(buyer.userId, 'INR', '1000000');
    await buy(buyer.token, '1').expect(201);

    return (
      await prisma.usdtOrder.findFirstOrThrow({ where: { userId: buyer.userId }, select: { orderId: true } })
    ).orderId;
  }

  /**
   * Backdate `updated_at` past the worker lease, which is how a crashed process
   * is actually recognised. Raw SQL because `@updatedAt` is Prisma's own field and
   * an `update()` would stamp it back to now - and a lease test that never really
   * ages the row is not testing the lease.
   */
  async function ageEvent(eventId: string, minutes: number): Promise<void> {
    // The casts are load-bearing: bind parameters arrive as `text`/`unknown` and
    // Postgres will not compare one against a `uuid` column on its own.
    await prisma.$executeRaw`UPDATE exchange_revenue_events
      SET updated_at = NOW() - (${minutes}::int * INTERVAL '1 minute')
      WHERE event_id = ${eventId}::uuid`;
  }

  const runOnce = () => http().post('/api/tokenomics/exchange-revenue/run-once').set(bearer(adminToken));

  /** Rupees whose direct + buyback burn at price 1 equals the attributed revenue. */
  const emberFrom = (revenueInr: string, price = '1'): Prisma.Decimal =>
    new Prisma.Decimal(revenueInr).div(price);

  /** Clears what the bridge can write, and the treasury's floor basis with it. */
  async function resetWorld(): Promise<void> {
    await prisma.exchangeRevenueEvent.deleteMany({});
    await prisma.tokenBurn.deleteMany({});
    await prisma.tokenBuyback.deleteMany({});
    await prisma.tokenAllocation.deleteMany({});
    await prisma.transaction.deleteMany({ where: { type: 'BURN' } });
    await removeTreasury();
  }

  // -------------------------------------------------------------------------
  // 1. What a real settled BUY actually produces
  // -------------------------------------------------------------------------

  describe('a settled BUY through the real exchange route', () => {
    it('records one event that says the platform retained nothing', async () => {
      const buyer = await createUser('buyer-retain');
      await fund(buyer.userId, 'INR', '100000');

      await buy(buyer.token, '10').expect(201);

      const order = await prisma.usdtOrder.findFirstOrThrow({ where: { userId: buyer.userId } });
      const events = await prisma.exchangeRevenueEvent.findMany({ where: { orderId: order.orderId } });

      expect(events).toHaveLength(1);
      const recorded = events[0]!;

      // THE finding, proven from the money rather than from a comment: the LPs
      // were credited the customer's debit to the paisa, so nothing was retained,
      // so there is no revenue, so nothing may be burned.
      expect(recorded.lpInrSettled.toFixed(2)).toBe(recorded.customerInr.toFixed(2));
      expect(recorded.retainedInr.isZero()).toBe(true);
      expect(recorded.revenueInr.isZero()).toBe(true);
      expect(recorded.status).toBe('INELIGIBLE');
      expect(recorded.reasonCode).toBe('NO_RETAINED_MARGIN');
      expect(recorded.nextAttemptAt).toBeNull();

      expect(await prisma.tokenAllocation.count()).toBe(0);
      expect(await prisma.tokenBurn.count()).toBe(0);
    });

    it('refuses to read an unbacked order as income', async () => {
      // Module 08's legacy path mints the USDT with no provider behind it, so the
      // customer's INR is unmatched rather than retained. Treating it as revenue
      // would mint burnable value out of nothing, which is the one thing §2 forbids.
      await resetLiquidityTables(prisma);
      try {
        const buyer = await createUser('buyer-unbacked');
        await fund(buyer.userId, 'INR', '100000');
        await buy(buyer.token, '10').expect(201);

        const order = await prisma.usdtOrder.findFirstOrThrow({ where: { userId: buyer.userId } });
        const recorded = await prisma.exchangeRevenueEvent.findFirstOrThrow({ where: { orderId: order.orderId } });

        // Nothing was credited to any provider, and the policy still attributes zero.
        expect(recorded.lpInrSettled.isZero()).toBe(true);
        expect(recorded.retainedInr.isZero()).toBe(true);
        expect(recorded.revenueInr.isZero()).toBe(true);
        expect(recorded.reasonCode).toBe('LEGACY_NO_LP_BACKING');
        expect(recorded.status).toBe('INELIGIBLE');
      } finally {
        await seedBridgeLiquidity();
      }
    });

    it('carries the source order, so the dashboard can point at it', async () => {
      const buyer = await createUser('buyer-source');
      await fund(buyer.userId, 'INR', '100000');
      await buy(buyer.token, '5').expect(201);

      const order = await prisma.usdtOrder.findFirstOrThrow({ where: { userId: buyer.userId } });
      const recorded = await prisma.exchangeRevenueEvent.findFirstOrThrow({ where: { orderId: order.orderId } });

      expect(recorded.userId).toBe(buyer.userId);
      expect(recorded.side).toBe('BUY');
      expect(recorded.usdtAmount.toFixed()).toBe(order.usdtAmount.toFixed());
      expect(recorded.customerInr.toFixed()).toBe(order.inrAmount.toFixed());
    });

    it('records nothing at all for a BUY that never settled', async () => {
      // §3. The event is written inside the settlement transaction, so an order
      // refused for balance, liquidity or price leaves no row to retry. Two
      // different refusals, because "the row is in the transaction" has to hold
      // whichever guard stopped the order.
      const broke = await createUser('buyer-broke');
      await fund(broke.userId, 'INR', '10');
      const oversize = await createUser('buyer-oversize');
      await fund(oversize.userId, 'INR', '100000000');

      const before = await prisma.exchangeRevenueEvent.count();

      // A balance the wallet cannot fund, and an order bigger than the market's
      // published depth.
      const refused = await buy(broke.token, '5').expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');
      const beyondDepth = await buy(oversize.token, '20000').expect(503);
      expect(beyondDepth.body.code).toBe('PRICING_UNAVAILABLE');

      for (const userId of [broke.userId, oversize.userId]) {
        expect(await prisma.usdtOrder.count({ where: { userId } })).toBe(0);
      }
      expect(await prisma.exchangeRevenueEvent.count()).toBe(before);
    });

    it('does not queue a SELL, which hands INR back to the customer', async () => {
      const trader = await createUser('seller');
      await fund(trader.userId, 'INR', '100000');
      await buy(trader.token, '10').expect(201);
      await prisma.exchangeRevenueEvent.deleteMany({});

      await http()
        .post('/api/usdt/sell')
        .set(bearer(trader.token))
        .send({ clientRequestId: randomUUID(), usdtAmount: '5' })
        .expect(201);

      const recorded = await prisma.exchangeRevenueEvent.findFirstOrThrow({ where: { userId: trader.userId } });
      expect(recorded.side).toBe('SELL');
      expect(recorded.status).toBe('INELIGIBLE');
      expect(recorded.reasonCode).toBe('SELL_OUT_OF_SCOPE');
      expect(recorded.nextAttemptAt).toBeNull();
    });

    it('produces one event for a replayed order, not one per attempt', async () => {
      // §3: at most one allocation per order. Module 08 answers a replayed
      // clientRequestId with the original order, and the UNIQUE on order_id is the
      // second lock, so N HTTP calls cannot become N allocations.
      const buyer = await createUser('buyer-replay');
      await fund(buyer.userId, 'INR', '100000');

      const body = { clientRequestId: randomUUID(), usdtAmount: '7' };
      const first = await http().post('/api/usdt/buy').set(bearer(buyer.token)).send(body).expect(201);
      // The replay is answered with the original order, and Module 08 says so with
      // 200 rather than 201 - nothing new was created.
      const replay = await http().post('/api/usdt/buy').set(bearer(buyer.token)).send(body).expect(200);

      expect((replay.body as { orderId: string }).orderId).toBe((first.body as { orderId: string }).orderId);
      expect(await prisma.exchangeRevenueEvent.count({ where: { userId: buyer.userId } })).toBe(1);
    });

    it('refuses a second event for the same order at the database level', async () => {
      // The constraint is the last line of defence and has to be real, not implied
      // by worker behaviour. An order that already has its event cannot get another,
      // however the second insert is dressed up.
      const orderId = await settledOrderId();
      const existing = await prisma.exchangeRevenueEvent.findFirstOrThrow({ where: { orderId } });

      await expect(
        prisma.exchangeRevenueEvent.create({
          data: {
            orderId,
            userId: existing.userId,
            side: 'BUY',
            usdtAmount: '1',
            customerInr: '100',
            lpInrSettled: '0',
            retainedInr: '100',
            revenueMode: 'RETAINED_BPS',
            revenueBps: 10_000,
            revenueInr: '100',
            basisInr: '100',
            emberPrice: '1',
            directBurnPct: 60,
            buybackPct: 40,
            status: 'PENDING',
            reasonCode: 'ATTRIBUTED',
            maxAttempts: 12,
            nextAttemptAt: new Date(),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // -------------------------------------------------------------------------
  // 2. The pipeline, on a margin the exchange cannot produce
  // -------------------------------------------------------------------------

  describe('the tokenomics pipeline', () => {
    beforeEach(resetWorld);

    it('allocates, buys back, executes and burns, and supply moves by exactly that', async () => {
      // 2000 EMBER of funding: available 2000, protected floor 600. The order asks
      // for 600 then 400, so both fit above the floor and the pipeline completes.
      const eventId = await seedEligibleEvent({ referenceInr: '1000.00', emberPrice: '1' });
      await fundTreasury('2000');
      expect((await supply()).burnedSupply).toBe('0.000000000000000000');

      const processed = await runOnce().expect(200);
      expect((processed.body as { processed: number }).processed).toBe(1);

      const completed = await event(eventId);
      expect(completed.status).toBe('COMPLETED');
      expect(completed.reasonCode).toBe('PIPELINE_COMPLETED');
      expect(completed.allocationId).not.toBeNull();
      expect(completed.buybackId).not.toBeNull();
      expect(completed.directBurnId).not.toBeNull();
      expect(completed.buybackBurnId).not.toBeNull();
      expect(completed.processedAt).not.toBeNull();

      const allocation = await prisma.tokenAllocation.findUniqueOrThrow({
        where: { allocationId: completed.allocationId! },
      });
      expect(allocation.referenceAmount.toFixed(2)).toBe('1000.00');
      expect(allocation.directBurnEmber.toFixed(18)).toBe('600.000000000000000000');
      expect(allocation.buybackEmber.toFixed(18)).toBe('400.000000000000000000');

      // The event carries the two burn ids it produced; that reference is what
      // ties a destroyed supply back to the order that paid for it.
      const burns = await prisma.tokenBurn.findMany({
        where: { burnId: { in: [completed.directBurnId!, completed.buybackBurnId!] } },
      });
      expect(burns.map((b) => b.source).sort()).toEqual(['BUYBACK', 'DIRECT']);

      // The figure `GET /ember/supply` reports as burned is exactly the sum of the
      // burns this order produced - the reconciliation Module 10 promises.
      const after = await supply();
      expect(await prisma.tokenBurn.count()).toBe(burns.length);
      expect(after.burnedSupply).toBe(
        new Prisma.Decimal(burns.reduce((sum, b) => sum.plus(b.amount), new Prisma.Decimal(0))).toFixed(18),
      );

      // The records belong to the system account, not to the customer whose order
      // funded them: `GET /tokenomics/records` lists by proposer.
      expect(allocation.userId).toBe(await engineUserId());
      const customerRecords = await http().get('/api/tokenomics/records').set(bearer(plainToken)).expect(200);
      expect((customerRecords.body as { allocations: unknown[] }).allocations).toHaveLength(0);
    });

    it('burns on a volume basis while the revenue line stays honestly zero', async () => {
      // The demo case, and the reason `basis_inr` is its own column. A real
      // settled BUY credits its whole INR to LPs, so it earns the platform
      // nothing - and under VOLUME_LINKED it is still turnover the engine is
      // measured against. The EMBER destroyed comes out of the treasury; no
      // rupee is taken from the customer or from a provider, and the row must
      // still report ₹0.00 of revenue afterwards or the ledger is lying.
      const orderId = await settledOrderId();
      const order = await prisma.usdtOrder.findUniqueOrThrow({ where: { orderId } });

      await prisma.exchangeRevenueEvent.update({
        where: { orderId },
        data: {
          revenueMode: 'VOLUME_LINKED',
          revenueBps: 10_000,
          retainedInr: '0.00',
          revenueInr: '0.00',
          basisInr: order.customerInr,
          emberPrice: '1',
          status: 'PENDING',
          reasonCode: 'VOLUME_SIZED',
          detail: 'Volume-linked sizing from a settlement that retained nothing.',
          nextAttemptAt: new Date(),
        },
      });
      await fundTreasury('2000');

      const processed = await runOnce().expect(200);
      expect((processed.body as { processed: number }).processed).toBe(1);

      const completed = await prisma.exchangeRevenueEvent.findFirstOrThrow({ where: { orderId } });
      expect(completed.status).toBe('COMPLETED');
      expect(completed.revenueInr.toFixed(2)).toBe('0.00');
      expect(completed.basisInr.toFixed(2)).toBe(order.customerInr.toFixed(2));

      // Sized against the volume, split by the healthy-treasury 60/40 baseline.
      const allocation = await prisma.tokenAllocation.findUniqueOrThrow({
        where: { allocationId: completed.allocationId! },
      });
      expect(allocation.referenceAmount.toFixed(2)).toBe(order.customerInr.toFixed(2));
      expect([allocation.directBurnPct, allocation.buybackPct]).toEqual([60, 40]);
      // The split is exact at the paisa scale (the direct leg rounds, the buyback
      // takes the remainder) and, at the fixture price of ₹1 an EMBER, the two
      // EMBER legs account for the whole basis.
      expect(allocation.directBurnInr.plus(allocation.buybackInr).toFixed(2)).toBe(
        order.customerInr.toFixed(2),
      );
      expect(allocation.directBurnEmber.plus(allocation.buybackEmber).toFixed(18)).toBe(
        order.customerInr.toFixed(18),
      );
      expect(allocation.directBurnEmber.div(order.customerInr).toSignificantDigits(4).toNumber()).toBeCloseTo(
        0.6,
        3,
      );

      // The supply figure moved by exactly what the two burns destroyed.
      const burns = await prisma.tokenBurn.findMany({ where: { burnId: { in: [completed.directBurnId!, completed.buybackBurnId!] } } });
      expect((await supply()).burnedSupply).toBe(
        new Prisma.Decimal(burns.reduce((sum, b) => sum.plus(b.amount), new Prisma.Decimal(0))).toFixed(18),
      );

      // And the read model shows the pair apart, so the dashboard cannot present
      // turnover as income.
      const summary = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const row = (summary.body as { recent: { revenueInr: string; basisInr: string }[] }).recent[0]!;
      expect(row.revenueInr).toBe('0.00');
      expect(row.basisInr).toBe(order.customerInr.toFixed(2));
    });

    it('is a ledger burn while the chain is off, and never claims more', async () => {
      // §4: an off-chain simulated burn must never be reported as an on-chain one.
      // With BLOCKCHAIN_ENABLED unset the layer is off and the honest state is
      // NOT_REQUIRED with no transaction hash.
      await seedEligibleEvent({ referenceInr: '100.00', emberPrice: '1' });
      await fundTreasury('1000');
      await runOnce().expect(200);

      const burns = await prisma.tokenBurn.findMany();
      expect(burns).toHaveLength(2);
      for (const burn of burns) {
        expect(burn.onChainStatus).toBe('NOT_REQUIRED');
        expect(burn.onChainTxHash).toBeNull();
      }

      const summary = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const totals = (summary.body as { totals: { burnedEmberByChainState: Record<string, string> } }).totals;
      expect(Object.keys(totals.burnedEmberByChainState)).toEqual(['NOT_REQUIRED']);
      expect(totals.burnedEmberByChainState.NOT_REQUIRED).toBe(emberFrom('100').toFixed(18));
    });

    it('re-running the queue burns the same order exactly once', async () => {
      await seedEligibleEvent({ referenceInr: '500.00', emberPrice: '1' });
      await fundTreasury('1000');

      await runOnce().expect(200);
      const firstAllocationId = (await prisma.tokenAllocation.findFirstOrThrow()).allocationId;
      const burnsAfterFirst = await prisma.tokenBurn.count();
      const supplyAfterFirst = await supply();

      // Make the completed row look due again, the way an expired lease would.
      await prisma.exchangeRevenueEvent.updateMany({
        where: {},
        data: { status: 'PENDING', nextAttemptAt: new Date(), processedAt: null },
      });
      await runOnce().expect(200);

      expect(await prisma.tokenAllocation.count()).toBe(1);
      expect((await prisma.tokenAllocation.findFirstOrThrow()).allocationId).toBe(firstAllocationId);
      expect(await prisma.tokenBurn.count()).toBe(burnsAfterFirst);
      expect((await supply()).burnedSupply).toBe(supplyAfterFirst.burnedSupply);
    });

    it('lets three passes race for one order and have one win', async () => {
      // The claim is a guarded `updateMany`, so exactly one pass moves PENDING to
      // PROCESSING. On a real database this is the race the unit mock can only
      // describe; here three requests genuinely arrive together.
      await seedEligibleEvent({ referenceInr: '300.00', emberPrice: '1' });
      await fundTreasury('1000');

      await Promise.all([runOnce(), runOnce(), runOnce()]);

      expect(await prisma.tokenAllocation.count()).toBe(1);
      expect(await prisma.tokenBuyback.count()).toBe(1);
      expect(await prisma.tokenBurn.count()).toBeLessThanOrEqual(2);

      const completed = await prisma.exchangeRevenueEvent.findFirstOrThrow();
      expect(completed.attempts).toBe(1);
    });

    it('reports the buyback as a simulated portion executed at the configured price', async () => {
      // §5: no EMBER was bought from a market, and nothing here may say it was.
      await seedEligibleEvent({ referenceInr: '200.00', emberPrice: '1' });
      await fundTreasury('1000');
      await runOnce().expect(200);

      const buyback = await prisma.tokenBuyback.findFirstOrThrow();
      // Module 11's own name for this state, and the reason the assertion is worth
      // making: `SIMULATED -> RECORDED_SIMULATED_EXECUTION` is as far as anything in
      // this codebase goes. No status says EMBER was bought, because it was not.
      expect(buyback.status).toBe('RECORDED_SIMULATED_EXECUTION');
      expect(buyback.executedEmber?.toFixed(18)).toBe('80.000000000000000000');

      const summary = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const recent = (
        summary.body as {
          recent: { buybackStatus: string; buybackExecutedEmber: string; allocation: { buybackPct: number } }[];
        }
      ).recent;
      expect(recent[0]!.buybackStatus).toBe('RECORDED_SIMULATED_EXECUTION');
      expect(recent[0]!.buybackExecutedEmber).toBe('80.000000000000000000');
      expect(recent[0]!.allocation.buybackPct).toBe(40);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Guardrails
  // -------------------------------------------------------------------------

  describe('treasury guardrails', () => {
    beforeEach(resetWorld);

    it('stops at the reserve floor and says so, without burning into it', async () => {
      // 1000 EMBER funded, 300 protected. 1000 INR at price 1 asks for a 600
      // direct burn (leaves 400, above the floor: allowed) and then a 400 buyback
      // burn (leaves 0: refused). The order keeps the half it was allowed.
      const eventId = await seedEligibleEvent({ referenceInr: '1000.00', emberPrice: '1' });
      const treasuryId = await fundTreasury('1000');
      const before = await supply();

      await runOnce().expect(200);

      const blocked = await event(eventId);
      expect(blocked.status).toBe('BLOCKED');
      expect(blocked.reasonCode).toBe('TREASURY_RESERVE_FLOOR');
      expect(blocked.allocationId).not.toBeNull();
      expect(blocked.buybackId).not.toBeNull();
      expect(blocked.nextAttemptAt).not.toBeNull();
      expect(blocked.detail).toContain('reserve floor');

      expect(await prisma.tokenBurn.count({ where: { source: 'DIRECT' } })).toBe(1);
      expect(await prisma.tokenBurn.count({ where: { source: 'BUYBACK' } })).toBe(0);

      const after = await supply();
      expect(new Prisma.Decimal(after.burnedSupply).minus(before.burnedSupply).toFixed(18)).toBe(
        '600.000000000000000000',
      );
      expect((await availableOf(treasuryId, 'EMBER')).toFixed(18)).toBe('400.000000000000000000');
    });

    it('calls an unfundable burn an insufficient balance, which is a different fact', async () => {
      // 5000 INR at price 1 wants a 3000 EMBER direct burn against 1000 available.
      // The guard defers and the debit refuses: the owner-approved precedence.
      const eventId = await seedEligibleEvent({ referenceInr: '5000.00', emberPrice: '1' });
      await fundTreasury('1000');

      await runOnce().expect(200);

      const blocked = await event(eventId);
      expect(blocked.status).toBe('BLOCKED');
      expect(blocked.reasonCode).toBe('TREASURY_INSUFFICIENT_BALANCE');
      expect(await prisma.tokenBurn.count()).toBe(0);
      expect((await supply()).burnedSupply).toBe('0.000000000000000000');
    });

    it('finishes the order when the treasury is funded later, on the same allocation', async () => {
      // The blocked state is a wait, not a loss. The allocation and buyback are
      // kept and the retry replays onto them instead of proposing new ones.
      const eventId = await seedEligibleEvent({ referenceInr: '1000.00', emberPrice: '1' });
      await fundTreasury('1000');
      await runOnce().expect(200);

      const blocked = await event(eventId);
      expect(blocked.status).toBe('BLOCKED');
      const allocationId = blocked.allocationId;
      expect(allocationId).not.toBeNull();

      await fundTreasury('10000');
      // Stand in for the backoff elapsing; otherwise the row is not due for 5s.
      await prisma.exchangeRevenueEvent.update({ where: { eventId }, data: { nextAttemptAt: new Date() } });
      await runOnce().expect(200);

      const completed = await event(eventId);
      expect(completed.status).toBe('COMPLETED');
      expect(completed.allocationId).toBe(allocationId);
      expect(await prisma.tokenAllocation.count()).toBe(1);
      expect(await prisma.tokenBuyback.count()).toBe(1);
      expect(await prisma.tokenBurn.count()).toBe(2);
    });

    it('gives up after the event’s retry budget and leaves the reason on the row', async () => {
      // A permanently empty treasury must surface as FAILED rather than sit in the
      // queue forever looking like work in progress.
      const eventId = await seedEligibleEvent({ referenceInr: '5000.00', emberPrice: '1', maxAttempts: 2 });
      await fundTreasury('1000');

      // Two attempts is the whole budget; each pass is stood in for the backoff by
      // putting the row inside its own due window, which is all a waiting worker
      // would have needed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await prisma.exchangeRevenueEvent.update({ where: { eventId }, data: { nextAttemptAt: new Date() } });
        await runOnce().expect(200);
      }

      const failed = await event(eventId);
      expect(failed.status).toBe('FAILED');
      expect(failed.reasonCode).toBe('RETRIES_EXHAUSTED');
      expect(failed.nextAttemptAt).toBeNull();

      // Terminal means terminal: a further pass must not pick the order back up and
      // must not rewrite what exhausted it.
      await runOnce().expect(200);
      expect(await event(eventId)).toMatchObject({ status: 'FAILED', reasonCode: 'RETRIES_EXHAUSTED' });
      expect(await prisma.tokenBurn.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Crash recovery and the read model
  // -------------------------------------------------------------------------

  describe('recovery and reporting', () => {
    beforeEach(resetWorld);

    it('picks up work a dead worker left half-run', async () => {
      // PROCESSING with an update older than the lease means the process that
      // claimed it is gone. The row must be re-claimed and driven to completion -
      // and re-claimed *on schedule*, since the row it left behind carries the
      // dead attempt's own due time.
      const eventId = await seedEligibleEvent({
        referenceInr: '400.00',
        emberPrice: '1',
        status: 'PROCESSING',
        nextAttemptAt: null,
      });
      await ageEvent(eventId, 20);
      await fundTreasury('1000');

      const processed = await runOnce().expect(200);
      expect((processed.body as { processed: number }).processed).toBe(1);

      const completed = await event(eventId);
      expect(completed.status).toBe('COMPLETED');
      expect(await prisma.tokenAllocation.count()).toBe(1);
    });

    it('waits on a burn still in flight, which is not the same as a dead worker', async () => {
      // A burn can legitimately sit in PROCESSING for a minute waiting for a chain
      // receipt. Sweeping it early would put two workers on one order.
      const eventId = await seedEligibleEvent({ referenceInr: '400.00', emberPrice: '1', status: 'PROCESSING' });

      const processed = await runOnce().expect(200);
      expect((processed.body as { processed: number }).processed).toBe(0);
      expect((await event(eventId)).status).toBe('PROCESSING');
    });

    it('answers every settled order to any authenticated caller, with its reasons', async () => {
      await seedEligibleEvent({ referenceInr: '100.00', emberPrice: '1' });
      await fundTreasury('1000');
      await runOnce();

      const response = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const body = response.body as {
        policy: { mode: string; bps: number; baselineDirectBurnPct: number; splitIsAdaptive: boolean };
        totals: { ordersSeen: number; eligibleOrders: number; revenueInr: string };
        byStatus: Record<string, { count: number }>;
        recent: { reasonCode: string }[];
      };

      // The mode this suite boots with, reported next to the figures it produced:
      // the read model never asks the caller to guess which policy made a number.
      expect(body.policy.mode).toBe('RETAINED_BPS');
      expect(body.policy.bps).toBe(10_000);
      expect(body.policy.baselineDirectBurnPct).toBe(60);
      expect(body.policy.splitIsAdaptive).toBe(true);
      expect(body.totals.ordersSeen).toBe(1);
      expect(body.totals.eligibleOrders).toBe(1);
      expect(body.totals.revenueInr).toBe('100.00');
      expect(body.byStatus.COMPLETED?.count).toBe(1);
      expect(body.recent).toHaveLength(1);
      expect(body.recent[0]!.reasonCode).toBe('PIPELINE_COMPLETED');
    });

    it('shows a zero that explains itself', async () => {
      // The finding of this suite, in the shape an operator sees it: the policy is
      // on, switched all the way up, and a real BUY still attributes nothing -
      // because the settlement kept nothing. One real BUY, read back through the route.
      const buyer = await createUser('buyer-explain');
      await fund(buyer.userId, 'INR', '100000');
      await buy(buyer.token, '10').expect(201);

      const response = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const body = response.body as {
        policy: { mode: string };
        totals: { ordersSeen: number; eligibleOrders: number; revenueInr: string; retainedInr: string; customerInr: string };
        recent: { reasonCode: string; revenueInr: string; retainedInr: string }[];
      };

      expect(body.totals.revenueInr).toBe('0.00');
      expect(body.totals.ordersSeen).toBe(1);
      expect(body.totals.eligibleOrders).toBe(0);
      expect(body.policy.mode).toBe('RETAINED_BPS');
      expect(body.recent[0]!.reasonCode).toBe('NO_RETAINED_MARGIN');
      expect(body.recent[0]!.revenueInr).toBe('0.00');
      expect(body.recent[0]!.retainedInr).toBe('0.00');
      // The customer's rupees stay visible as what they spent, never as income.
      expect(Number(body.totals.customerInr)).toBeGreaterThan(0);
      expect(body.totals.retainedInr).toBe('0.00');
    });

    it('ships with the attribution switched off, so this suite had to turn it on', async () => {
      // The evidence above is only worth having because a deployment starts the
      // other way. No env, no decision: the policy resolves to `NONE`, every order
      // is reported as `POLICY_DISABLED`, and nothing is attributed or burned until
      // somebody chooses the rate. That choice is the business decision §2 asks for.
      expect(createAppConfig({}).tokenomics.exchangeRevenueMode).toBe('NONE');
      expect(
        decideExchangeRevenue({ mode: 'NONE', bps: 10_000 }, {
          side: 'BUY',
          customerInr: new Prisma.Decimal('1000.00'),
          lpInrSettled: new Prisma.Decimal('900.00'),
          lpBacked: true,
        }),
      ).toMatchObject({ eligible: false, revenueInr: new Prisma.Decimal(0), reasonCode: 'POLICY_DISABLED' });
    });

    it('agrees with the rows the database actually holds', async () => {
      // §7's "dashboard figures matching backend records": the summary is a read
      // over the same tables, so the two must not be able to drift.
      await seedEligibleEvent({ referenceInr: '250.00', emberPrice: '1' });
      await fundTreasury('1000');
      await runOnce();

      const response = await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      const body = response.body as {
        totals: { ordersSeen: number; allocationsRecorded: number; revenueInr: string; allocatedDirectBurnEmber: string };
        recent: { allocation: { directBurnEmber: string } }[];
      };

      expect(body.totals.ordersSeen).toBe(await prisma.exchangeRevenueEvent.count());
      expect(body.totals.allocationsRecorded).toBe(await prisma.tokenAllocation.count());
      expect(body.totals.revenueInr).toBe('250.00');
      expect(body.recent[0]!.allocation.directBurnEmber).toBe('150.000000000000000000');
      expect(body.totals.allocatedDirectBurnEmber).toBe('150.000000000000000000');
    });

    it('is readable without a role and drainable only by a platform admin', async () => {
      // §8: RBAC is not bypassed to make the automation possible. The read is like
      // every other GET; the trigger that drives burns is admin-only.
      await http().get('/api/tokenomics/exchange-revenue').set(bearer(plainToken)).expect(200);
      await http().post('/api/tokenomics/exchange-revenue/run-once').set(bearer(plainToken)).expect(403);
      await http().post('/api/tokenomics/exchange-revenue/run-once').expect(401);
    });

    it('reports nothing processed when the queue is empty', async () => {
      const processed = await runOnce().expect(200);
      expect((processed.body as { processed: number }).processed).toBe(0);
    });
  });

  async function engineUserId(): Promise<string> {
    const engine = await prisma.user.findUnique({ where: { email: ENGINE_EMAIL }, select: { id: true } });
    if (!engine) throw new Error('the pipeline should have provisioned the engine account');
    return engine.id;
  }
});
