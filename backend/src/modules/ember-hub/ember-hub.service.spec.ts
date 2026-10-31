import { Prisma, TransactionType } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { EmberHubService } from './ember-hub.service';

describe('EmberHubService (unit)', () => {
  const emberAsset = { id: 'asset-ember', symbol: 'EMBER', isActive: true };
  const usdtAsset = { id: 'asset-usdt', symbol: 'USDT', isActive: true };
  const treasuryUser = { id: 'user-treasury', wallet: { id: 'wallet-treasury' } };

  const prismaMock = {
    emberPurchase: {
      findUnique: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      aggregate: jest.fn(),
      findMany: jest.fn(),
    },
    asset: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    wallet: { findUnique: jest.fn() },
    walletBalance: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const walletServiceMock = {
    getOrCreateForUser: jest.fn(),
    credit: jest.fn(),
    debit: jest.fn(),
  };
  const configMock = {
    emberHub: { baselinePriceInr: '2.45', dailyEmberLimit: '10000', monthlyEmberLimit: '100000' },
    usdtPricing: { fallbackPriceInr: '88.5' },
  } as unknown as AppConfig;

  const service = (config: AppConfig = configMock) =>
    new EmberHubService(
      config,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }));
    (prismaMock.asset.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: { symbol: string } }) =>
      where.symbol === 'EMBER' ? emberAsset : usdtAsset,
    );
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValue(treasuryUser);
    (prismaMock.emberPurchase.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.emberPurchase.aggregate as jest.Mock).mockResolvedValue({ _sum: { emberAmount: null } });
    (prismaMock.emberPurchase.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    (prismaMock.emberPurchase.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-user' } });

    const txMock = {
      emberPurchase: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
    };
    (prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock));
    (prismaMock as { txMock?: unknown }).txMock = txMock;
    walletServiceMock.debit.mockResolvedValue({});
    walletServiceMock.credit.mockResolvedValue({});
  });

  it('prices scenarios at the configured price and converts to USDT at the display rate', async () => {
    const { scenarios } = await service().scenarios();
    expect(scenarios[0]).toEqual({
      label: 'First taste',
      emberAmount: '250',
      totalInr: '612.50',
      totalUsdt: '6.920904',
    });
  });

  it('computes the purchase legs: treasury EMBER out, user EMBER in, user USDT out, treasury USDT in', async () => {
    const { purchase } = await service().purchase('user-1', { emberAmount: '100', clientRequestId: '7b7be60f',
    } as never);

    expect(walletServiceMock.debit).toHaveBeenCalledTimes(2);
    expect(walletServiceMock.credit).toHaveBeenCalledTimes(2);
    expect(walletServiceMock.debit.mock.calls[0][0]).toBe('wallet-treasury');
    expect(walletServiceMock.debit.mock.calls[0][2]).toEqual(new Prisma.Decimal('100'));
    expect(walletServiceMock.debit.mock.calls[0][3]).toMatchObject({ type: TransactionType.TRANSFER_OUT });
    expect(walletServiceMock.credit.mock.calls[0][0]).toBe('wallet-user');
    expect(walletServiceMock.credit.mock.calls[0][2]).toEqual(new Prisma.Decimal('100'));
    expect(walletServiceMock.debit.mock.calls[1][0]).toBe('wallet-user');
    expect(walletServiceMock.debit.mock.calls[1][2].toFixed(6)).toBe('2.768362');
    expect(walletServiceMock.credit.mock.calls[1][0]).toBe('wallet-treasury');
    expect(purchase.status).toBe('COMPLETED');
    expect(purchase.totalInr.toString()).toBe('245');
  });

  it('refuses the purchase inside the per-day and per-month limits before any leg moves', async () => {
    (prismaMock.emberPurchase.aggregate as jest.Mock).mockResolvedValue({
      _sum: { emberAmount: new Prisma.Decimal('9999') },
    });

    await expect(
      service().purchase('user-1', { emberAmount: '2', clientRequestId: '7b7be60f-9' } as never),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('replays a completed purchase on the same idempotency key without moving anything', async () => {
    (prismaMock.emberPurchase.findUnique as jest.Mock).mockResolvedValue({
      purchaseId: 'p1',
      status: 'COMPLETED',
      clientRequestId: '7b7be60f-9',
    });

    const { created } = await service().purchase('user-1', { emberAmount: '2', clientRequestId: '7b7be60f-9' } as never);
    expect(created).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a replayed key whose recorded attempt FAILED, so a retry is a conscious new request', async () => {
    (prismaMock.emberPurchase.findUnique as jest.Mock).mockResolvedValue({
      purchaseId: 'p1',
      status: 'FAILED',
      failedReason: 'insufficient USDT',
      clientRequestId: '7b7be60f-9',
    });

    await expect(
      service().purchase('user-1', { emberAmount: '2', clientRequestId: '7b7be60f-9' } as never),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it('refuses to price a purchase at all when no USDT/INR rate is configured, moving nothing (503)', async () => {
    const unpriced = service({ ...configMock, usdtPricing: { fallbackPriceInr: null } } as unknown as AppConfig);

    const error = await unpriced
      .purchase('user-1', { emberAmount: '2', clientRequestId: '7b7be60f-9' } as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.PRICING_UNAVAILABLE);
    expect((error as DomainException).getStatus()).toBe(503);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.emberPurchase.createMany).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('records a FAILED audit row and rethrows when the ledger refuses mid-transaction', async () => {
    walletServiceMock.debit.mockRejectedValue(new Error('no EMBER in treasury'));

    await expect(
      service().purchase('user-1', { emberAmount: '2', clientRequestId: '7b7be60f-9' } as never),
    ).rejects.toThrow('no EMBER in treasury');
    expect(prismaMock.emberPurchase.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', failedReason: expect.stringContaining('no EMBER') }),
      }),
    );
  });
});
