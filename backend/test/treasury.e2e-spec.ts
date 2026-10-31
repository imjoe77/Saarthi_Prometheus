import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { utcMonthWindow } from '../src/modules/treasury/treasury.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * MODULE 12 - treasury guardrails over HTTP: the read-only summary with its
 * computed 30% reserve floor, the demo USDT capacity tracking, and the
 * STRICT reserve enforcement that runs inside Module 11's burn transaction.
 *
 * Boots the real application against the real database, because the claims
 * that matter here are about actual ledger rows: the floor base must come
 * from the treasury wallet's own DEPOSIT legs and never from a user, a
 * rejected burn must leave zero side effects (no leg, no record, no supply
 * change), concurrent burns must serialise so the floor cannot be
 * overdrawn, and funding must never be blocked.
 *
 * Isolation mirrors Module 11's own suite: token tables, BURN legs and the
 * treasury user are purged at START as well as at the end, so a crashed run
 * can neither leave activity counts inflated for this suite nor leave
 * absolute-zero-violating BURN legs for Module 10's suite, whichever order
 * Jest happens to run them in. The suite-start baseline is asserted to be
 * zero activity, which is itself the cross-check that the purge worked.
 *
 * The treasury wallet's status is asserted ACTIVE throughout: enforcement
 * is the in-transaction advisory-locked check, never a status lever, and
 * this round's rules forbid treating the wallet's status as one.
 */
describe('Treasury guardrails - reserve enforcement, dashboard and USDT tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const TREASURY_EMAIL = 'treasury@prometheus.local';
  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  interface SummaryPayload {
    treasury: {
      email: string;
      provisioned: boolean;
      userId: string | null;
      walletId: string | null;
      walletStatus: string | null;
    };
    ember: { available: string; locked: string; total: string } | null;
    usdt: { available: string; locked: string; total: string } | null;
    emberLifetimeFundedIn: string | null;
    reserve: {
      floorPercent: number;
      floorBase: string;
      floorBaseAmount: string | null;
      floorAmount: string | null;
      discretionaryCapacity: string | null;
      status: string;
      note: string;
    };
    usdtCapacity: {
      configured: boolean;
      demo: boolean;
      capacityInr: string | null;
      capacity: string | null;
      utilization: string;
      remaining: string | null;
      window: string;
      timezone: string;
      utilizationBasis: string;
      conversion: { source: string; priceInr: string | null; reason: string | null } | null;
      exhaustion: string;
      note: string;
    };
    activity: {
      burns: { count: number; recordedEmber: string };
      buybacks: { count: number; executedCount: number; recordedEmber: string };
      allocations: { count: number };
    };
  }

  // -------------------------------------------------------------------------
  // Boot, purge, helpers
  // -------------------------------------------------------------------------

  /** Token tables, BURN legs and the treasury account - start AND end. */
  async function purgeTreasuryFootprint(): Promise<void> {
    await prisma.tokenBurn.deleteMany({});
    await prisma.tokenBuyback.deleteMany({});
    await prisma.tokenAllocation.deleteMany({});
    await prisma.transaction.deleteMany({ where: { type: 'BURN' } });

    const treasury = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    if (!treasury) return;
    await prisma.transaction.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.wallet.deleteMany({ where: { userId: treasury.id } });
    await prisma.user.delete({ where: { id: treasury.id } });
  }

  /** This suite's non-treasury users, fully removed in FK-safe order. */
  async function purgeSuiteUsers(): Promise<void> {
    if (createdUserIds.length === 0) return;
    await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
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

    await purgeTreasuryFootprint();
    await purgeSuiteUsers();
  });

  afterAll(async () => {
    await purgeTreasuryFootprint();
    await purgeSuiteUsers();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const assetId = (symbol: string) => assetIdBySymbol.get(symbol) as string;

  const minted = { token: '', userId: '' };

  beforeAll(async () => {
    minted.token = await mintToken({
      subject: `google:treasury-reader-${randomUUID()}`,
      email: `treasury-reader-${randomUUID()}@treasury.test`,
    });

    // GET /api/treasury/summary is PLATFORM_ADMIN-only (Module 13 RBAC).
    // This suite only ever reads through this one identity, so grant admin
    // once here rather than rewriting every call site; the 403 path for a
    // non-admin is covered in rbac.e2e-spec.ts.
    const me = await http().get('/api/auth/me').set(bearer(minted.token)).expect(200);
    minted.userId = me.body.id as string;
    createdUserIds.push(minted.userId);
    await prisma.userRole.upsert({
      where: { userId_role: { userId: minted.userId, role: 'PLATFORM_ADMIN' } },
      create: { userId: minted.userId, role: 'PLATFORM_ADMIN' },
      update: {},
    });
  });

  async function fetchSummary(token = minted.token): Promise<SummaryPayload> {
    const res = await http().get('/api/treasury/summary').set(bearer(token));
    expect(res.status).toBe(200);
    return res.body as SummaryPayload;
  }

  /** Provisions treasury user + wallet the way Module 09's pattern does, without funding. */
  async function provisionTreasury(): Promise<{ userId: string; walletId: string }> {
    const user = await prisma.user.create({ data: { email: TREASURY_EMAIL } });
    const { wallet } = await walletService.getOrCreateForUser(user.id);
    return { userId: user.id, walletId: wallet.id };
  }

  async function createWalletUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `treasury-other-${randomUUID()}@treasury.test` },
    });
    createdUserIds.push(user.id);
    await walletService.getOrCreateForUser(user.id);
    return user.id;
  }

  /** Drives Module 11's real burn endpoint - the enforcement boundary. */
  const createBurn = (body: Record<string, unknown>) =>
    http()
      .post('/api/tokenomics/burns')
      .set(bearer(minted.token))
      .send({ clientRequestId: randomUUID(), ...body });

  const burnRowCount = () => prisma.tokenBurn.count();
  const burnLegCount = () => prisma.transaction.count({ where: { type: 'BURN' } });
  const treasuryTxCount = (walletId: string) =>
    prisma.transaction.count({ where: { walletId } });
  const emberAvailable = async (walletId: string): Promise<string> => {
    const row = await prisma.walletBalance.findUniqueOrThrow({
      where: { walletId_assetId: { walletId, assetId: assetId('EMBER') } },
    });
    return row.available.toString();
  };
  const burnedEmberSum = async (): Promise<string> => {
    const sum = await prisma.transaction.aggregate({
      where: { type: 'BURN' },
      _sum: { amount: true },
    });
    return sum._sum.amount?.toString() ?? '0';
  };

  /**
   * JSON round-trip that canonicalises Prisma Decimals to strings so two
   * snapshots compare structurally regardless of Decimal's internal shape.
   */
  const json = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === 'object' && typeof (entry as { toFixed?: unknown }).toFixed === 'function'
          ? String(entry)
          : entry,
      ),
    );

  // -------------------------------------------------------------------------
  // Unauthenticated
  // -------------------------------------------------------------------------

  it('refuses an unauthenticated caller with 401', async () => {
    const res = await http().get('/api/treasury/summary');
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Unprovisioned treasury (no treasury account yet)
  // -------------------------------------------------------------------------

  it('reports an unprovisioned treasury with the approved policy and the demo capacity', async () => {
    const summary = await fetchSummary();

    expect(Object.keys(summary).sort()).toEqual([
      'activity',
      'ember',
      'emberLifetimeFundedIn',
      'reserve',
      'treasury',
      'usdt',
      'usdtCapacity',
    ]);
    expect(summary.treasury).toEqual({
      email: TREASURY_EMAIL,
      provisioned: false,
      userId: null,
      walletId: null,
      walletStatus: null,
    });
    expect(summary.ember).toBeNull();
    expect(summary.usdt).toBeNull();
    expect(summary.emberLifetimeFundedIn).toBeNull();

    // The approved policy is reported; nothing floor-shaped is fabricated
    // for a treasury that does not exist yet.
    expect(summary.reserve).toEqual({
      floorPercent: 30,
      floorBase: 'QUALIFYING_TREASURY_FUNDING',
      floorBaseAmount: null,
      floorAmount: null,
      discretionaryCapacity: null,
      status: 'UNPROVISIONED',
      note: expect.stringContaining('DEPOSIT ledger legs'),
    });

    // The approved demo capacity (Rs 30 crore at the configured display-only
    // rate), reporting-only and never claiming anything is blocked.
    expect(summary.usdtCapacity).toEqual({
      configured: true,
      demo: true,
      capacityInr: '300000000',
      capacity: '3003003.003003',
      utilization: '0',
      remaining: '3003003.003003',
      window: expect.any(String),
      timezone: 'UTC',
      utilizationBasis: 'TREASURY_WALLET_USDT_OUTFLOWS',
      conversion: { source: 'USDT_FALLBACK_PRICE_INR', priceInr: '99.9', reason: null },
      exhaustion: 'AVAILABLE',
      note: expect.stringContaining('never blocks'),
    });

    // Suite-start cross-check: the purge worked, activity baselines at zero.
    expect(summary.activity).toEqual({
      burns: { count: 0, recordedEmber: '0' },
      buybacks: { count: 0, executedCount: 0, recordedEmber: '0' },
      allocations: { count: 0 },
    });
  });

  describe('funded treasury', () => {
    let treasuryUserId = '';
    let treasuryWalletId = '';

    beforeAll(async () => {
      const provisioned = await provisionTreasury();
      treasuryUserId = provisioned.userId;
      treasuryWalletId = provisioned.walletId;
      // The only way tests and seeds ever fund the treasury: through the
      // wallet service, never an API route - no minting surface exists.
      await walletService.credit(treasuryWalletId, assetId('EMBER'), '1000000');
      await walletService.credit(treasuryWalletId, assetId('USDT'), '50000');
    });

    it('reports provisioned state, balances and the computed 30% reserve floor', async () => {
      const summary = await fetchSummary();

      expect(summary.treasury).toEqual({
        email: TREASURY_EMAIL,
        provisioned: true,
        userId: treasuryUserId,
        walletId: treasuryWalletId,
        walletStatus: 'ACTIVE',
      });
      expect(summary.ember).toEqual({ available: '1000000', locked: '0', total: '1000000' });
      expect(summary.usdt).toEqual({ available: '50000', locked: '0', total: '50000' });
      expect(summary.emberLifetimeFundedIn).toBe('1000000');

      // The floor base is the qualifying DEPOSIT funding: 30% of 1,000,000.
      expect(summary.reserve).toEqual({
        floorPercent: 30,
        floorBase: 'QUALIFYING_TREASURY_FUNDING',
        floorBaseAmount: '1000000',
        floorAmount: '300000',
        discretionaryCapacity: '700000',
        status: 'OK',
        note: expect.stringContaining('DEPOSIT ledger legs'),
      });
    });

    it('tracks USDT utilization from treasury outflow legs only, with the demo capacity', async () => {
      await walletService.debit(treasuryWalletId, assetId('USDT'), '125.5');

      // A second user's USDT outflow of far larger size must not move the
      // platform figure: individual transactions never feed the guardrail.
      const otherUserId = await createWalletUser();
      const otherWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: otherUserId } });
      await walletService.credit(otherWallet.id, assetId('USDT'), '9999');
      await walletService.debit(otherWallet.id, assetId('USDT'), '9999');

      const beforeLabel = utcMonthWindow(new Date()).label;
      const summary = await fetchSummary();
      const afterLabel = utcMonthWindow(new Date()).label;

      expect([beforeLabel, afterLabel]).toContain(summary.usdtCapacity.window);
      expect(summary.usdtCapacity.utilization).toBe('125.5');
      expect(summary.usdtCapacity).toMatchObject({
        configured: true,
        demo: true,
        capacityInr: '300000000',
        capacity: '3003003.003003',
        remaining: '3002877.503003',
        conversion: { source: 'USDT_FALLBACK_PRICE_INR', priceInr: '99.9', reason: null },
        exhaustion: 'AVAILABLE',
        note: expect.stringContaining('never blocks'),
      });
      expect(summary.usdt).toEqual({ available: '49874.5', locked: '0', total: '49874.5' });
      expect(summary.treasury.walletStatus).toBe('ACTIVE');
    });

    it('mutates nothing while producing the summary', async () => {
      const snapshot = async () =>
        json({
          count: await prisma.transaction.count(),
          treasuryTxs: await prisma.transaction.findMany({
            where: { walletId: treasuryWalletId },
            orderBy: { createdAt: 'asc' },
          }),
          balances: await prisma.walletBalance.findMany({
            where: { walletId: treasuryWalletId },
            orderBy: { assetId: 'asc' },
          }),
          wallet: await prisma.wallet.findUnique({ where: { id: treasuryWalletId } }),
        });

      const before = await snapshot();
      await fetchSummary();
      const after = await snapshot();

      expect(after).toEqual(before);
    });

    it('sits on Module 11 real activity without owning it, and burns never shrink the floor base', async () => {
      // One DIRECT burn through Module 11's public API - a burn the floor
      // allows - and the three figures must stay independent: the read model
      // reflects it, funded-in history stays put, and the qualifying DEPOSIT
      // basis does NOT shrink (burns destroy EMBER, not history).
      const burnRes = await createBurn({ source: 'DIRECT', amount: '5' });
      expect(burnRes.status).toBe(201);

      const summary = await fetchSummary();

      expect(summary.activity.burns).toEqual({ count: 1, recordedEmber: '5' });
      expect(summary.emberLifetimeFundedIn).toBe('1000000');
      expect(summary.ember).toEqual({ available: '999995', locked: '0', total: '999995' });
      expect(summary.reserve).toMatchObject({
        floorBaseAmount: '1000000',
        floorAmount: '300000',
        discretionaryCapacity: '699995',
        status: 'OK',
      });

      // Separation: an EMBER burn moves no USDT figure and no capacity number.
      expect(summary.usdt).toEqual({ available: '49874.5', locked: '0', total: '49874.5' });
      expect(summary.usdtCapacity.utilization).toBe('125.5');

      // The treasury wallet was never transitioned by any read or burn.
      expect(summary.treasury.walletStatus).toBe('ACTIVE');
    });

    it('rejects a burn that would breach the floor, with zero side effects', async () => {
      // Available 999995, floor 300000: burning 700000 would land at 299995,
      // below the floor. The balance CAN cover the amount, so the reserve -
      // not insufficient balance - is the refusal.
      const burnRowsBefore = await burnRowCount();
      const burnLegsBefore = await burnLegCount();
      const txsBefore = await treasuryTxCount(treasuryWalletId);
      const availableBefore = await emberAvailable(treasuryWalletId);
      const burnedBefore = await burnedEmberSum();

      const refused = await createBurn({ source: 'DIRECT', amount: '700000' }).expect(409);
      expect(refused.body.code).toBe('TREASURY_RESERVE_BREACH');
      expect(refused.body.details).toEqual([
        'reserve_floor:300000',
        'treasury_available:999995',
        'requested:700000',
      ]);

      // Zero side effects: no ledger leg, no burn record, no balance change,
      // and the wallet's status is never the lever.
      expect(await burnRowCount()).toBe(burnRowsBefore);
      expect(await burnLegCount()).toBe(burnLegsBefore);
      expect(await treasuryTxCount(treasuryWalletId)).toBe(txsBefore);
      expect(await emberAvailable(treasuryWalletId)).toBe(availableBefore);
      expect(await burnedEmberSum()).toBe(burnedBefore);

      const summary = await fetchSummary();
      expect(summary.activity.burns).toEqual({ count: 1, recordedEmber: '5' });
      expect(summary.treasury.walletStatus).toBe('ACTIVE');
    });

    it('allows a burn that lands exactly on the floor, then refuses any further burn', async () => {
      // Exactly 699995 may burn: 999995 - 699995 = 300000 = the floor.
      const burn = await createBurn({ source: 'DIRECT', amount: '699995' }).expect(201);
      expect(burn.body.amount).toBe('699995.000000000000000000');

      const atFloor = await fetchSummary();
      expect(atFloor.ember?.available).toBe('300000');
      expect(atFloor.reserve).toMatchObject({
        floorBaseAmount: '1000000',
        floorAmount: '300000',
        discretionaryCapacity: '0',
        status: 'AT_FLOOR',
      });

      // Exactly at the floor, no burn of any size is possible: one wei would
      // cross below it.
      const burnRowsBefore = await burnRowCount();
      const availableBefore = await emberAvailable(treasuryWalletId);

      const refused = await createBurn({
        source: 'DIRECT',
        amount: '0.000000000000000001',
      }).expect(409);
      expect(refused.body.code).toBe('TREASURY_RESERVE_BREACH');

      expect(await burnRowCount()).toBe(burnRowsBefore);
      expect(await emberAvailable(treasuryWalletId)).toBe(availableBefore);
    });

    it('never blocks funding, and restored capacity makes burns possible again', async () => {
      // Qualifying funding is the one flow the floor cannot refuse: it raises
      // the balance without lowering the floor.
      await walletService.credit(treasuryWalletId, assetId('EMBER'), '1000000');

      const funded = await fetchSummary();
      expect(funded.ember?.available).toBe('1300000');
      expect(funded.emberLifetimeFundedIn).toBe('2000000');
      expect(funded.reserve).toMatchObject({
        floorBaseAmount: '2000000',
        floorAmount: '600000',
        discretionaryCapacity: '700000',
        status: 'OK',
      });

      // A burn within the restored discretionary capacity succeeds.
      await createBurn({ source: 'DIRECT', amount: '100' }).expect(201);
      expect(await emberAvailable(treasuryWalletId)).toBe('1299900');
    });

    it('preserves INSUFFICIENT_BALANCE precedence over the reserve refusal', async () => {
      // Available 1299900: one more than that cannot be funded at all, so the
      // faithful refusal is INSUFFICIENT_BALANCE - frozen Module 11 contract.
      const refused = await createBurn({ source: 'DIRECT', amount: '1299901' }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(await emberAvailable(treasuryWalletId)).toBe('1299900');
    });

    it('serialises concurrent burns so the floor can never be overdrawn', async () => {
      // Available 1299900, floor 600000: two 400000 burns cannot both fit
      // (the second would land at 499900). The advisory lock must give
      // exactly one success and one reserve refusal - never two successes,
      // never a partial write.
      const [first, second] = await Promise.all([
        createBurn({ source: 'DIRECT', amount: '400000' }),
        createBurn({ source: 'DIRECT', amount: '400000' }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const refused = first.status === 409 ? first : second;
      expect(refused.body.code).toBe('TREASURY_RESERVE_BREACH');

      // Exactly one destruction committed: 400000 left the treasury, nothing
      // else moved.
      expect(await emberAvailable(treasuryWalletId)).toBe('899900');
      expect(await burnedEmberSum()).toBe('1100100');
      expect(await burnRowCount()).toBe(4);
    });

    it('reports EXHAUSTED once month utilization meets the demo capacity - reporting-only', async () => {
      // Push treasury USDT utilization past the converted demo ceiling
      // (3003003.003003 USDT). The outflow is test-only and nets to zero on
      // the balance; utilization is what the guardrail reports.
      await walletService.credit(treasuryWalletId, assetId('USDT'), '3003004');
      await walletService.debit(treasuryWalletId, assetId('USDT'), '3003004');

      const summary = await fetchSummary();
      expect(summary.usdtCapacity).toMatchObject({
        configured: true,
        demo: true,
        capacityInr: '300000000',
        capacity: '3003003.003003',
        utilization: '3003129.5',
        remaining: '0',
        exhaustion: 'EXHAUSTED',
        conversion: { source: 'USDT_FALLBACK_PRICE_INR', priceInr: '99.9', reason: null },
        note: expect.stringContaining('never blocks'),
      });
      // Reporting-only, proven: the EMBER reserve is untouched by USDT
      // utilization, and the wallet is still ACTIVE - no operation was
      // blocked or transitioned by exhaustion.
      expect(summary.reserve.status).toBe('OK');
      expect(summary.treasury.walletStatus).toBe('ACTIVE');
      expect(summary.usdt?.available).toBe('49874.5');
    });
  });
});
