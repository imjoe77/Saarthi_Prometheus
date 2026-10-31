import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import type { WalletService } from '../wallet/wallet.service';
import { LiquidityAllocationService } from './liquidity-allocation.service';

/**
 * Branch coverage for BUY funding against a mocked transaction client: the
 * legacy no-provider path, the insufficient-liquidity refusal (both at plan
 * time and when a concurrent order wins the guarded update), and a successful
 * single-slice application with its exact wallet legs. The real database
 * behaviour - balances, ledgers, allocation rows - is asserted in
 * `test/liquidity.e2e-spec.ts`.
 */
describe('LiquidityAllocationService (unit)', () => {
  const walletServiceMock = { debit: jest.fn(), credit: jest.fn() };

  const txMock = {
    liquidityProvider: { count: jest.fn() },
    liquidityCommitment: { findMany: jest.fn(), updateMany: jest.fn() },
    wallet: { findUnique: jest.fn() },
    liquidityAllocation: { create: jest.fn() },
  };

  const service = () => new LiquidityAllocationService(walletServiceMock as unknown as WalletService);

  const baseInput = () => ({
    orderId: randomUUID(),
    usdtAmount: new Prisma.Decimal('10000'),
    inrAmount: new Prisma.Decimal('1001500.00'),
    priceInr: new Prisma.Decimal('100.15'),
    usdtAssetId: 'asset-usdt',
    inrAssetId: 'asset-inr',
  });

  /** One eligible candidate row as `findMany` returns it. */
  function candidateRow(commitmentId: string, available: string, committedAtIso: string) {
    return {
      commitmentId,
      usdtAvailable: new Prisma.Decimal(available),
      usdtConsumed: new Prisma.Decimal(0),
      committedAt: new Date(committedAtIso),
      lp: { lpId: `lp-of-${commitmentId}`, userId: `user-of-${commitmentId}` },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    txMock.liquidityAllocation.create.mockResolvedValue({});
    walletServiceMock.debit.mockResolvedValue({});
    walletServiceMock.credit.mockResolvedValue({});
  });

  it('is a no-op legacy path when no provider rows exist at all', async () => {
    txMock.liquidityProvider.count.mockResolvedValue(0);

    const outcome = await service().allocateBuy(
      txMock as unknown as Prisma.TransactionClient,
      baseInput(),
    );

    expect(outcome).toEqual({ legacy: true, slices: [] });
    expect(txMock.liquidityCommitment.findMany).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('refuses with 409 INSUFFICIENT_LIQUIDITY when providers exist but liquidity falls short', async () => {
    txMock.liquidityProvider.count.mockResolvedValue(1);
    txMock.liquidityCommitment.findMany.mockResolvedValue([
      candidateRow('commitment-1', '5000', '2026-10-17T10:00:00.000Z'),
    ]);

    const input = baseInput();

    await expect(
      service().allocateBuy(txMock as unknown as Prisma.TransactionClient, input),
    ).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_LIQUIDITY });

    // Refused before a single wallet leg or allocation row was written.
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
    expect(txMock.liquidityAllocation.create).not.toHaveBeenCalled();
  });

  it('refuses without moving funds when a concurrent order consumed the planned liquidity first', async () => {
    txMock.liquidityProvider.count.mockResolvedValue(1);
    txMock.liquidityCommitment.findMany.mockResolvedValue([
      candidateRow('commitment-1', '10000', '2026-10-17T10:00:00.000Z'),
    ]);
    // The guarded update matches zero rows: someone else spent it.
    txMock.liquidityCommitment.updateMany.mockResolvedValue({ count: 0 });
    txMock.wallet.findUnique.mockResolvedValue({ id: 'wallet-lp' });

    await expect(
      service().allocateBuy(txMock as unknown as Prisma.TransactionClient, baseInput()),
    ).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_LIQUIDITY });

    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(txMock.liquidityAllocation.create).not.toHaveBeenCalled();
  });

  it('applies a single-slice funding: guarded consumption, LP wallet legs and the allocation row', async () => {
    txMock.liquidityProvider.count.mockResolvedValue(1);
    txMock.liquidityCommitment.findMany.mockResolvedValue([
      candidateRow('commitment-1', '50000', '2026-10-17T10:00:00.000Z'),
    ]);
    txMock.liquidityCommitment.updateMany.mockResolvedValue({ count: 1 });
    txMock.wallet.findUnique.mockResolvedValue({ id: 'wallet-lp' });

    const input = baseInput();
    const outcome = await service().allocateBuy(
      txMock as unknown as Prisma.TransactionClient,
      input,
    );

    expect(outcome.legacy).toBe(false);
    expect(outcome.slices).toHaveLength(1);
    expect(outcome.slices[0]).toMatchObject({
      commitmentId: 'commitment-1',
      usdtAmount: new Prisma.Decimal('10000'),
      // Single slice absorbs the customer debit exactly - conservation holds.
      inrAmount: input.inrAmount,
      priceInr: input.priceInr,
    });

    expect(txMock.liquidityCommitment.updateMany).toHaveBeenCalledWith({
      where: { commitmentId: 'commitment-1', usdtAvailable: { gte: new Prisma.Decimal('10000') } },
      data: {
        usdtAvailable: { decrement: new Prisma.Decimal('10000') },
        usdtConsumed: { increment: new Prisma.Decimal('10000') },
      },
    });
    expect(walletServiceMock.debit).toHaveBeenCalledWith(
      'wallet-lp',
      'asset-usdt',
      new Prisma.Decimal('10000'),
      { note: `Liquidity outflow order ${input.orderId}` },
      expect.anything(),
    );
    expect(walletServiceMock.credit).toHaveBeenCalledWith(
      'wallet-lp',
      'asset-inr',
      input.inrAmount,
      { note: `Liquidity inflow order ${input.orderId}` },
      expect.anything(),
    );
    expect(txMock.liquidityAllocation.create).toHaveBeenCalledTimes(1);
  });
});
