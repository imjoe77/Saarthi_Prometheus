import { Prisma, TransactionType, WalletStatus } from '@prisma/client';

import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { TreasuryService, utcMonthWindow } from './treasury.service';

/**
 * Decision coverage for the treasury read model: provisioned and missing
 * treasury states, the exact scoping of BOTH ledger aggregates (informational
 * DEPOSIT+TRANSFER_IN inflows vs the DEPOSIT-only reserve base), the UTC
 * month window, the computed 30% reserve floor and its statuses, the demo
 * INR capacity with its display-only conversion (including the unavailable
 * and unconfigured branches), treasury-scoped USDT utilization, and the
 * activity aggregates. Nothing in the service mutates anything, so the
 * read-only guarantee and the enforced-floor agreement are proven end to end
 * in `test/treasury.e2e-spec.ts` against the real database.
 */
describe('TreasuryService (unit)', () => {
  const emberAsset = { id: 'asset-ember', symbol: 'EMBER', decimals: 18, isActive: true };
  const usdtAsset = { id: 'asset-usdt', symbol: 'USDT', decimals: 6, isActive: true };

  const prismaMock = {
    user: { findUnique: jest.fn() },
    wallet: { findUnique: jest.fn() },
    asset: { findUnique: jest.fn() },
    transaction: { aggregate: jest.fn() },
    tokenBurn: { aggregate: jest.fn() },
    tokenBuyback: { groupBy: jest.fn(), aggregate: jest.fn() },
    tokenAllocation: { count: jest.fn() },
  };
  const walletServiceMock = {
    getBalances: jest.fn(),
  };

  interface ConfigOptions {
    capacityInr?: string | null;
    priceInr?: string | null;
  }

  const configFor = ({ capacityInr = '300000000', priceInr = '99.9' }: ConfigOptions = {}): AppConfig =>
    ({
      treasury: { monthlyCapacityInr: capacityInr },
      usdtPricing: { fallbackPriceInr: priceInr },
    }) as unknown as AppConfig;

  const service = (options: ConfigOptions = {}) =>
    new TreasuryService(
      configFor(options),
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

  /** Mid-month, so the window assertions pin exact UTC boundaries. */
  const now = new Date('2026-10-20T12:34:56.000Z');

  const balanceRow = (symbol: string, available: string, locked = '0') => ({
    asset: { id: `asset-${symbol.toLowerCase()}`, symbol },
    available: new Prisma.Decimal(available),
    locked: new Prisma.Decimal(locked),
  });

  // The three ledger aggregates the summary drives, individually settable.
  const aggregates = {
    utilization: '16.5',
    fundedIn: '1000000',
    qualifyingFunding: '1000000',
  };

  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: implementations set with
    // mockImplementation survive a clear and would leak into the next test.
    jest.resetAllMocks();

    aggregates.utilization = '16.5';
    aggregates.fundedIn = '1000000';
    aggregates.qualifyingFunding = '1000000';

    prismaMock.asset.findUnique.mockImplementation(({ where }: { where: { symbol: string } }) =>
      where.symbol === 'EMBER' ? emberAsset : usdtAsset,
    );
    prismaMock.tokenBurn.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _sum: { amount: new Prisma.Decimal('4800') },
    });
    prismaMock.tokenBuyback.groupBy.mockResolvedValue([
      { status: 'SIMULATED', _count: { _all: 2 } },
      { status: 'RECORDED_SIMULATED_EXECUTION', _count: { _all: 1 } },
    ]);
    prismaMock.tokenBuyback.aggregate.mockResolvedValue({
      _sum: { executedEmber: new Prisma.Decimal('3200') },
    });
    prismaMock.tokenAllocation.count.mockResolvedValue(4);
    prismaMock.transaction.aggregate.mockImplementation(
      (args: { where: { createdAt?: unknown; type: unknown } }) => {
        if (args.where.createdAt) {
          return { _sum: { amount: new Prisma.Decimal(aggregates.utilization) } };
        }
        if (Array.isArray((args.where.type as { in?: unknown[] }).in)) {
          return { _sum: { amount: new Prisma.Decimal(aggregates.fundedIn) } };
        }
        return { _sum: { amount: new Prisma.Decimal(aggregates.qualifyingFunding) } };
      },
    );
  });

  const provisionTreasury = (
    status: WalletStatus = WalletStatus.ACTIVE,
    emberAvailable = '1000000',
  ): void => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-user' });
    prismaMock.wallet.findUnique.mockResolvedValue({ id: 'treasury-wallet', status });
    walletServiceMock.getBalances.mockResolvedValue([
      balanceRow('EMBER', emberAvailable, '25000'),
      balanceRow('USDT', '50000'),
    ]);
  };

  describe('utcMonthWindow', () => {
    it('bounds the current UTC calendar month and labels it YYYY-MM', () => {
      expect(utcMonthWindow(now)).toEqual({
        gte: new Date('2026-10-01T00:00:00.000Z'),
        lt: new Date('2026-11-01T00:00:00.000Z'),
        label: '2026-10',
      });
    });

    it('rolls the label correctly at the year boundary', () => {
      expect(utcMonthWindow(new Date('2025-12-15T00:00:00.000Z'))).toEqual({
        gte: new Date('2025-12-01T00:00:00.000Z'),
        lt: new Date('2026-01-01T00:00:00.000Z'),
        label: '2025-12',
      });
    });
  });

  describe('missing treasury', () => {
    it('reports an unprovisioned treasury with null reserve figures and performs no ledger read', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const summary = await service().summary(now);

      expect(summary.treasury).toEqual({
        email: 'treasury@prometheus.local',
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
      expect(walletServiceMock.getBalances).not.toHaveBeenCalled();
      expect(prismaMock.transaction.aggregate).not.toHaveBeenCalled();
    });

    it('still reports the demo capacity, converted for display', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const summary = await service().summary(now);

      expect(summary.usdtCapacity).toMatchObject({
        configured: true,
        demo: true,
        capacityInr: '300000000',
        capacity: '3003003.003003',
        utilization: '0',
        remaining: '3003003.003003',
        window: '2026-10',
        timezone: 'UTC',
        utilizationBasis: 'TREASURY_WALLET_USDT_OUTFLOWS',
        conversion: { source: 'USDT_FALLBACK_PRICE_INR', priceInr: '99.9', reason: null },
        exhaustion: 'AVAILABLE',
        note: expect.stringContaining('never blocks'),
      });
    });
  });

  describe('provisioned treasury', () => {
    it('maps balances, wallet state and the funded-in figure', async () => {
      provisionTreasury();

      const summary = await service().summary(now);

      expect(summary.treasury.provisioned).toBe(true);
      expect(summary.treasury.walletStatus).toBe(WalletStatus.ACTIVE);
      expect(summary.ember).toEqual({ available: '1000000', locked: '25000', total: '1025000' });
      expect(summary.usdt).toEqual({ available: '50000', locked: '0', total: '50000' });
      expect(summary.emberLifetimeFundedIn).toBe('1000000');
      expect(walletServiceMock.getBalances).toHaveBeenCalledWith('treasury-user');
    });

    it('computes funded-in from DEPOSIT + TRANSFER_IN inflow legs (informational history)', async () => {
      provisionTreasury();

      await service().summary(now);

      const fundedInCall = prismaMock.transaction.aggregate.mock.calls
        .map(([args]) => args)
        .find((args) => Array.isArray(args.where.type?.in) && !args.where.createdAt);

      expect(fundedInCall.where).toMatchObject({
        walletId: 'treasury-wallet',
        assetId: 'asset-ember',
        status: 'COMPLETED',
      });
      expect(fundedInCall.where.type.in).toEqual([
        TransactionType.DEPOSIT,
        TransactionType.TRANSFER_IN,
      ]);
    });

    it('computes the reserve base from COMPLETED DEPOSIT legs only', async () => {
      provisionTreasury();

      const summary = await service().summary(now);

      const qualifyingCall = prismaMock.transaction.aggregate.mock.calls
        .map(([args]) => args)
        .find((args) => args.where.type === TransactionType.DEPOSIT);

      expect(qualifyingCall.where).toMatchObject({
        walletId: 'treasury-wallet',
        assetId: 'asset-ember',
        type: TransactionType.DEPOSIT,
        status: 'COMPLETED',
      });
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

    it('keeps the floor base independent of the current balance - burns never shrink it', async () => {
      // Available has fallen below the funded-in figure (as after burns) while
      // the qualifying DEPOSIT basis stays at its historical total.
      provisionTreasury(WalletStatus.ACTIVE, '999995');

      const summary = await service().summary(now);

      expect(summary.reserve.floorBaseAmount).toBe('1000000');
      expect(summary.reserve.floorAmount).toBe('300000');
      expect(summary.reserve.discretionaryCapacity).toBe('699995');
      expect(summary.reserve.status).toBe('OK');
    });

    it('reports BELOW_FLOOR with zero discretionary capacity when available sits under the floor', async () => {
      provisionTreasury(WalletStatus.ACTIVE, '200000');

      const summary = await service().summary(now);

      expect(summary.reserve.status).toBe('BELOW_FLOOR');
      expect(summary.reserve.discretionaryCapacity).toBe('0');
      expect(summary.reserve.floorAmount).toBe('300000');
    });

    it('scopes USDT utilization to the treasury wallet, outflow legs and the UTC month', async () => {
      provisionTreasury();

      const summary = await service().summary(now);

      const utilizationCall = prismaMock.transaction.aggregate.mock.calls
        .map(([args]) => args)
        .find((args) => args.where.createdAt);

      // The treasury-wallet scoping is what keeps individual users' USDT
      // movements out of the platform guardrail entirely.
      expect(utilizationCall.where).toMatchObject({
        walletId: 'treasury-wallet',
        assetId: 'asset-usdt',
        status: 'COMPLETED',
      });
      expect(utilizationCall.where.type.in).toEqual([
        TransactionType.WITHDRAWAL,
        TransactionType.TRANSFER_OUT,
      ]);
      expect(utilizationCall.where.createdAt).toEqual({
        gte: new Date('2026-10-01T00:00:00.000Z'),
        lt: new Date('2026-11-01T00:00:00.000Z'),
      });
      expect(summary.usdtCapacity.utilization).toBe('16.5');
      expect(summary.usdtCapacity.window).toBe('2026-10');
      expect(summary.usdtCapacity.timezone).toBe('UTC');
      expect(summary.usdtCapacity.utilizationBasis).toBe('TREASURY_WALLET_USDT_OUTFLOWS');
    });
  });

  describe('USDT capacity', () => {
    it('converts the demo INR capacity for display and tracks remaining exactly', async () => {
      provisionTreasury();

      const summary = await service().summary(now);

      expect(summary.usdtCapacity).toMatchObject({
        configured: true,
        demo: true,
        capacityInr: '300000000',
        capacity: '3003003.003003',
        utilization: '16.5',
        remaining: '3002986.503003',
        conversion: { source: 'USDT_FALLBACK_PRICE_INR', priceInr: '99.9', reason: null },
        exhaustion: 'AVAILABLE',
        note: expect.stringContaining('never blocks'),
      });
    });

    it('reports EXHAUSTED with a zero remainder once utilization meets the capacity', async () => {
      provisionTreasury();
      aggregates.utilization = '3003004';

      const summary = await service().summary(now);

      expect(summary.usdtCapacity.exhaustion).toBe('EXHAUSTED');
      expect(summary.usdtCapacity.remaining).toBe('0');
    });

    it('reports an unavailable conversion - never an invented rate - when the display rate is missing', async () => {
      provisionTreasury();

      const summary = await service({ priceInr: null }).summary(now);

      expect(summary.usdtCapacity).toMatchObject({
        configured: true,
        demo: true,
        capacityInr: '300000000',
        capacity: null,
        remaining: null,
        conversion: {
          source: 'USDT_FALLBACK_PRICE_INR',
          priceInr: null,
          reason: 'CONVERSION_RATE_UNAVAILABLE',
        },
        exhaustion: 'UNAVAILABLE',
      });
      // Utilization keeps flowing regardless - only the ceiling is unconvertible.
      expect(summary.usdtCapacity.utilization).toBe('16.5');
    });

    it('reports NOT_CONFIGURED only when no capacity value exists at all', async () => {
      provisionTreasury();

      const summary = await service({ capacityInr: null }).summary(now);

      expect(summary.usdtCapacity).toMatchObject({
        configured: false,
        demo: false,
        capacityInr: null,
        capacity: null,
        remaining: null,
        conversion: null,
        exhaustion: 'NOT_CONFIGURED',
        utilization: '16.5',
      });
    });
  });

  describe('activity aggregates', () => {
    it('maps platform-wide record aggregates without touching supply math', async () => {
      provisionTreasury();

      const summary = await service().summary(now);

      expect(summary.activity).toEqual({
        burns: { count: 3, recordedEmber: '4800' },
        buybacks: { count: 3, executedCount: 1, recordedEmber: '3200' },
        allocations: { count: 4 },
      });
    });
  });
});
