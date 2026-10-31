import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { LiquidityService } from './liquidity.service';

/**
 * Decision-branch coverage for the commitment service against a mocked
 * database: the gates that must fire BEFORE any write (no slabs configured)
 * and their exact contract - 503, the machine-readable detail key, and not a
 * single query issued. Everything that writes money is exercised for real in
 * `test/liquidity.e2e-spec.ts`, where the wallet ledger can be read back.
 */
describe('LiquidityService (unit)', () => {
  const emptySlabsConfig = {
    liquidity: { minAvailableUsdt: '200000', emberSlabs: [] },
  } as unknown as AppConfig;

  const prismaMock = {
    asset: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    liquidityProvider: { findUnique: jest.fn(), findMany: jest.fn() },
    liquidityCommitment: { findUnique: jest.fn() },
    liquidityAllocation: { findMany: jest.fn() },
    liquidityCommitmentReduction: { findMany: jest.fn() },
    walletBalance: { findMany: jest.fn() },
  };
  const walletServiceMock = {
    getOrCreateForUser: jest.fn(),
    lock: jest.fn(),
    unlock: jest.fn(),
  };

  const service = () =>
    new LiquidityService(
      emptySlabsConfig,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

  beforeEach(() => jest.clearAllMocks());

  it('refuses to open a commitment with 503 while no slabs are approved, touching nothing', async () => {
    await expect(
      service().createCommitment('user-1', {
        usdtAmount: '100000',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      details: ['liquidity_ember_slabs_not_configured'],
    });

    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.getOrCreateForUser).not.toHaveBeenCalled();
  });

  it('refuses to reduce a commitment with 503 while no slabs are approved, touching nothing', async () => {
    await expect(
      service().reduceCommitment('user-1', {
        commitmentId: randomUUID(),
        usdtAmount: '100000',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      details: ['liquidity_ember_slabs_not_configured'],
    });

    expect(prismaMock.asset.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('reports commitments as disabled on the read path even with no slabs', async () => {
    prismaMock.liquidityProvider.findUnique.mockResolvedValue(null);

    const result = await service().getMyCommitment('user-1');

    expect(result).toEqual({ provider: null, commitment: null, commitmentsEnabled: false });
  });

  it('maps an ownership miss to a not-found refusal rather than a forbidden one', async () => {
    const slabsConfig = {
      liquidity: {
        minAvailableUsdt: '200000',
        emberSlabs: [{ minUsdt: '0', requiredEmber: '1000' }],
      },
    } as unknown as AppConfig;
    const configured = new LiquidityService(
      slabsConfig,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

    prismaMock.liquidityCommitment.findUnique.mockResolvedValue({
      lp: { userId: 'someone-else' },
    });

    await expect(
      configured.reduceCommitment('user-1', {
        commitmentId: randomUUID(),
        usdtAmount: '1',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('sanity: a configured service never trips the empty-slab gate', async () => {
    // Guards the fixture itself: if slabsConfigured ever disagrees with the
    // config shape above, the first two tests would silently stop proving the
    // gate they exist for.
    const configured = new LiquidityService(
      {
        liquidity: {
          minAvailableUsdt: '200000',
          emberSlabs: [{ minUsdt: '0', requiredEmber: '1000' }],
        },
      } as unknown as AppConfig,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

    prismaMock.liquidityProvider.findUnique.mockResolvedValue(null);

    await expect(configured.getMyCommitment('user-1')).resolves.toMatchObject({
      commitmentsEnabled: true,
    });
  });

  // -------------------------------------------------------------------------
  // Admin distribution read (GET /liquidity/distribution)
  // -------------------------------------------------------------------------

  const decimal = (value: string) => new Prisma.Decimal(value);

  /**
   * A small but complete pool: alpha and bravo have funded orders (alpha also
   * withdrew 10k at some point), charlie registered but never committed. The
   * numbers reconcile with the invariant on purpose - committed - consumed =
   * available holds row by row and in total.
   */
  const mockDistribution = () => {
    prismaMock.liquidityProvider.findMany.mockResolvedValue([
      {
        lpId: 'lp-alpha',
        userId: 'user-alpha',
        status: 'ACTIVE',
        registeredAt: new Date('2026-01-01T00:00:00.000Z'),
        user: { id: 'user-alpha', email: 'alpha@prometheus.demo' },
        commitment: {
          commitmentId: 'commit-alpha',
          lpId: 'lp-alpha',
          usdtCommitted: decimal('100000'),
          usdtConsumed: decimal('60000'),
          usdtAvailable: decimal('40000'),
          emberLocked: decimal('500'),
          status: 'ACTIVE',
          clientRequestId: randomUUID(),
          committedAt: new Date('2026-01-01T00:00:00.000Z'),
          closedAt: null,
        },
      },
      {
        lpId: 'lp-bravo',
        userId: 'user-bravo',
        status: 'ACTIVE',
        registeredAt: new Date('2026-01-02T00:00:00.000Z'),
        user: { id: 'user-bravo', email: 'bravo@prometheus.demo' },
        commitment: {
          commitmentId: 'commit-bravo',
          lpId: 'lp-bravo',
          usdtCommitted: decimal('300000'),
          usdtConsumed: decimal('50000'),
          usdtAvailable: decimal('250000'),
          emberLocked: decimal('1500'),
          status: 'ACTIVE',
          clientRequestId: randomUUID(),
          committedAt: new Date('2026-01-02T00:00:00.000Z'),
          closedAt: null,
        },
      },
      {
        lpId: 'lp-charlie',
        userId: 'user-charlie',
        status: 'SUSPENDED',
        registeredAt: new Date('2026-01-03T00:00:00.000Z'),
        user: { id: 'user-charlie', email: 'charlie@prometheus.demo' },
        commitment: null,
      },
    ]);

    // Two distinct calls: the aggregation pass over every slice, then the
    // recent-slices page with its order/provider includes.
    prismaMock.liquidityAllocation.findMany.mockReset();
    prismaMock.liquidityAllocation.findMany
      .mockResolvedValueOnce([
        {
          allocationId: 'alloc-1',
          commitmentId: 'commit-alpha',
          orderId: 'order-A',
          usdtAmount: decimal('60000'),
          priceInr: decimal('88'),
          allocatedAt: new Date('2026-02-01T10:00:00.000Z'),
        },
        {
          allocationId: 'alloc-2',
          commitmentId: 'commit-bravo',
          orderId: 'order-A',
          usdtAmount: decimal('40000'),
          priceInr: decimal('88'),
          allocatedAt: new Date('2026-02-01T10:00:00.000Z'),
        },
        {
          allocationId: 'alloc-3',
          commitmentId: 'commit-bravo',
          orderId: 'order-B',
          usdtAmount: decimal('10000'),
          priceInr: decimal('90'),
          allocatedAt: new Date('2026-02-02T11:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          allocationId: 'alloc-3',
          commitmentId: 'commit-bravo',
          orderId: 'order-B',
          usdtAmount: decimal('10000'),
          priceInr: decimal('90'),
          allocatedAt: new Date('2026-02-02T11:00:00.000Z'),
          order: { side: 'BUY', usdtAmount: decimal('10000') },
          commitment: { lpId: 'lp-bravo', lp: { user: { email: 'bravo@prometheus.demo' } } },
        },
      ]);

    prismaMock.liquidityCommitmentReduction.findMany.mockResolvedValue([
      { commitmentId: 'commit-alpha', usdtAmount: decimal('10000') },
    ]);

    prismaMock.walletBalance.findMany.mockResolvedValue([
      { available: decimal('25000'), locked: decimal('0'), wallet: { userId: 'user-alpha' } },
      { available: decimal('175000'), locked: decimal('0'), wallet: { userId: 'user-bravo' } },
    ]);
  };

  it('reports the full per-provider distribution: contribution, remaining, shares and order counts', async () => {
    mockDistribution();

    const result = await service().getDistribution();

    // Pool totals reconcile: remaining = committed - distributed, in totals.
    expect(result.totals.totalCommittedUsdt.toFixed(6)).toBe('400000.000000');
    expect(result.totals.totalDistributedUsdt.toFixed(6)).toBe('110000.000000');
    expect(result.totals.totalRemainingUsdt.toFixed(6)).toBe('290000.000000');
    expect(result.totals.totalWithdrawnUsdt.toFixed(6)).toBe('10000.000000');
    expect(result.totals.distributedInr.toFixed(2)).toBe('9700000.00');
    expect(result.totals.allocationCount).toBe(3);
    expect(result.totals.ordersFunded).toBe(2);
    expect(result.totals.providerCount).toBe(3);
    expect(result.totals.activeProviderCount).toBe(2);
    expect(result.totals.activeRemainingUsdt.toFixed(6)).toBe('290000.000000');
    // 290k eligible beats the 200k threshold: met, not short.
    expect(result.totals.belowThreshold).toBe(false);
    expect(result.totals.shortfallUsdt.toFixed(6)).toBe('0.000000');
    expect(result.totals.commitmentsEnabled).toBe(false);

    // Biggest contributor first; the never-committed provider still appears.
    expect(result.providers.map((row) => row.lpId)).toEqual([
      'lp-alpha',
      'lp-bravo',
      'lp-charlie',
    ]);

    const alpha = result.providers[0];
    expect(alpha?.email).toBe('alpha@prometheus.demo');
    expect(alpha?.contributedUsdt.toFixed(6)).toBe('60000.000000');
    expect(alpha?.contributedInr.toFixed(2)).toBe('5280000.00');
    expect(alpha?.allocationCount).toBe(1);
    expect(alpha?.ordersFunded).toBe(1);
    expect(alpha?.lastAllocatedAt?.toISOString()).toBe('2026-02-01T10:00:00.000Z');
    expect(alpha?.reducedUsdt.toFixed(6)).toBe('10000.000000');
    expect(alpha?.shareOfCommittedPct.toFixed(2)).toBe('25.00');
    expect(alpha?.shareOfAvailablePct.toFixed(2)).toBe('13.79');
    expect(alpha?.wallet?.available.toFixed(6)).toBe('25000.000000');

    const bravo = result.providers[1];
    expect(bravo?.contributedUsdt.toFixed(6)).toBe('50000.000000');
    expect(bravo?.contributedInr.toFixed(2)).toBe('4420000.00');
    expect(bravo?.allocationCount).toBe(2);
    expect(bravo?.ordersFunded).toBe(2);
    expect(bravo?.shareOfCommittedPct.toFixed(2)).toBe('75.00');
    expect(bravo?.shareOfAvailablePct.toFixed(2)).toBe('86.21');
    expect(bravo?.reducedUsdt.toFixed(6)).toBe('0.000000');

    const charlie = result.providers[2];
    expect(charlie?.commitment).toBeNull();
    expect(charlie?.contributedUsdt.toFixed(6)).toBe('0.000000');
    expect(charlie?.shareOfCommittedPct.toFixed(2)).toBe('0.00');
    expect(charlie?.wallet).toBeNull();
  });

  it('answers recent slices with their order and provider, and never moves state', async () => {
    mockDistribution();

    const result = await service().getDistribution();

    expect(result.recentAllocations).toHaveLength(1);
    const recent = result.recentAllocations[0];
    expect(recent).toMatchObject({
      allocationId: 'alloc-3',
      orderId: 'order-B',
      orderSide: 'BUY',
      lpId: 'lp-bravo',
      providerEmail: 'bravo@prometheus.demo',
    });
    expect(recent?.orderUsdtAmount.toFixed(6)).toBe('10000.000000');
    expect(recent?.inrAmount.toFixed(2)).toBe('900000.00');

    // Read-only by contract: no transaction, and the service never even has a
    // top-up handle to reach for (a notice write would throw on the mock).
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('reports an empty pool as zeroed totals with the full shortfall, querying no wallets', async () => {
    prismaMock.liquidityProvider.findMany.mockResolvedValue([]);
    prismaMock.liquidityAllocation.findMany.mockReset();
    prismaMock.liquidityAllocation.findMany.mockResolvedValue([]);
    prismaMock.liquidityCommitmentReduction.findMany.mockResolvedValue([]);

    const result = await service().getDistribution();

    expect(result.providers).toEqual([]);
    expect(result.recentAllocations).toEqual([]);
    expect(result.totals.totalCommittedUsdt.toFixed(6)).toBe('0.000000');
    expect(result.totals.providerCount).toBe(0);
    expect(result.totals.activeProviderCount).toBe(0);
    expect(result.totals.belowThreshold).toBe(true);
    expect(result.totals.shortfallUsdt.toFixed(6)).toBe('200000.000000');
    expect(result.totals.commitmentsEnabled).toBe(false);
    expect(prismaMock.walletBalance.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
