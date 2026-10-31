import { randomUUID } from 'node:crypto';

import { Prisma, TokenBuybackStatus, TransactionType } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { TokenomicsService } from './tokenomics.service';

/**
 * Decision-branch coverage against a mocked database: every refusal that must
 * fire before or around a write (input validation, ownership, state
 * conflicts, the concurrent-unique races) and the burn's transaction
 * boundaries. Everything that actually moves money is exercised for real in
 * `test/tokenomics.e2e-spec.ts`, where the ledger can be read back and the
 * supply reconciliation proven end to end.
 */
describe('TokenomicsService (unit)', () => {
  const emberAsset = { id: 'asset-ember', symbol: 'EMBER', decimals: 18, isActive: true };

  const prismaMock = {
    asset: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), create: jest.fn() },
    tokenAllocation: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    tokenBuyback: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    tokenBurn: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const walletServiceMock = {
    getOrCreateForUser: jest.fn(),
    debit: jest.fn(),
  };
  const reserveGuardMock = {
    assertDiscretionaryEmberDebit: jest.fn(),
  };

  const configMock = {
    tokenomics: { directBurnPct: 60, buybackPct: 40 },
  } as unknown as AppConfig;

  const service = () =>
    new TokenomicsService(
      configMock,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
      // The guard mock is structurally callable, so it needs no cast.
      reserveGuardMock,
    );

  // The transaction client the service receives inside $transaction: it must
  // carry the model the burn inserts (the burn row).
  const txClient = { tokenBurn: prismaMock.tokenBurn };

  const uniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  const allocationRow = (overrides: Record<string, unknown> = {}) => ({
    allocationId: 'alloc-1',
    userId: 'caller-1',
    referenceAmount: new Prisma.Decimal('80000'),
    emberPrice: new Prisma.Decimal('10'),
    directBurnPct: 60,
    buybackPct: 40,
    directBurnInr: new Prisma.Decimal('48000'),
    buybackInr: new Prisma.Decimal('32000'),
    directBurnEmber: new Prisma.Decimal('4800'),
    buybackEmber: new Prisma.Decimal('3200'),
    clientRequestId: 'alloc-req-1',
    allocatedAt: new Date('2026-10-18T12:00:00.000Z'),
    ...overrides,
  });

  const buybackRow = (overrides: Record<string, unknown> = {}) => ({
    buybackId: 'bb-1',
    allocationId: 'alloc-1',
    userId: 'caller-1',
    status: TokenBuybackStatus.SIMULATED,
    executedPrice: null,
    executedEmber: null,
    executedAt: null,
    clientRequestId: 'bb-req-1',
    simulatedAt: new Date('2026-10-18T12:01:00.000Z'),
    allocation: allocationRow(),
    ...overrides,
  });

  const burnRow = (overrides: Record<string, unknown> = {}) => ({
    burnId: 'burn-1',
    userId: 'caller-1',
    source: 'DIRECT',
    buybackId: null,
    amount: new Prisma.Decimal('4800'),
    clientRequestId: 'burn-req-1',
    burnedAt: new Date('2026-10-18T12:02:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: mockRejectedValue implementations
    // survive a clear and would leak a refusal into the next test.
    jest.resetAllMocks();
    prismaMock.asset.findUnique.mockResolvedValue(emberAsset);
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txClient),
    );
    walletServiceMock.getOrCreateForUser.mockResolvedValue({
      wallet: { id: 'wallet-treasury' },
      created: false,
    });
    // The Module 12 reserve guard allows by default; individual tests refuse.
    reserveGuardMock.assertDiscretionaryEmberDebit.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Reads: configuration and preview
  // -------------------------------------------------------------------------

  it('summarises the configured split', () => {
    expect(service().configSummary()).toEqual({ directBurnPct: 60, buybackPct: 40 });
  });

  it('previews an allocation through the shared arithmetic without touching the database', async () => {
    const result = await service().preview({ referenceAmount: '80000', emberPrice: '10' });

    expect(result.directBurnInr.toString()).toBe('48000');
    expect(result.buybackInr.toString()).toBe('32000');
    expect(result.directBurnEmber.toString()).toBe('4800');
    expect(result.buybackEmber.toString()).toBe('3200');
    expect(prismaMock.tokenAllocation.create).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('refuses an invalid preview the same way a record would', async () => {
    await expect(service().preview({ referenceAmount: '0', emberPrice: '10' })).rejects.toThrow(
      DomainException,
    );
    expect(prismaMock.tokenAllocation.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Allocations
  // -------------------------------------------------------------------------

  it('records an allocation with its computed figures and reports it as created', async () => {
    const stored = allocationRow();
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(null);
    prismaMock.tokenAllocation.create.mockResolvedValue(stored);

    const result = await service().createAllocation('caller-1', {
      referenceAmount: '80000',
      emberPrice: '10',
      clientRequestId: 'alloc-req-1',
    });

    expect(result).toEqual({ allocation: stored, created: true });
    expect(prismaMock.tokenAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'caller-1',
        directBurnInr: new Prisma.Decimal('48000'),
        buybackInr: new Prisma.Decimal('32000'),
        directBurnEmber: new Prisma.Decimal('4800'),
        buybackEmber: new Prisma.Decimal('3200'),
        clientRequestId: 'alloc-req-1',
      }),
    });
    // An allocation moves nothing, ever: no wallet is touched on this path.
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('replays an identical allocation without writing a second row', async () => {
    const stored = allocationRow();
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(stored);

    const result = await service().createAllocation('caller-1', {
      referenceAmount: '80000',
      emberPrice: '10',
      clientRequestId: 'alloc-req-1',
    });

    expect(result).toEqual({ allocation: stored, created: false });
    expect(prismaMock.tokenAllocation.create).not.toHaveBeenCalled();
  });

  it('refuses a replayed key whose amount differs from the original', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());

    await expect(
      service().createAllocation('caller-1', {
        referenceAmount: '90000',
        emberPrice: '10',
        clientRequestId: 'alloc-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(prismaMock.tokenAllocation.create).not.toHaveBeenCalled();
  });

  it('refuses a replayed key whose price differs from the original', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());

    await expect(
      service().createAllocation('caller-1', {
        referenceAmount: '80000',
        emberPrice: '11',
        clientRequestId: 'alloc-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it('treats a lost unique race as a replay of the winner', async () => {
    const winner = allocationRow();
    prismaMock.tokenAllocation.findUnique
      .mockResolvedValueOnce(null) // pre-check: nothing yet
      .mockResolvedValueOnce(winner); // after the race: the winner
    prismaMock.tokenAllocation.create.mockRejectedValue(uniqueViolation());

    const result = await service().createAllocation('caller-1', {
      referenceAmount: '80000',
      emberPrice: '10',
      clientRequestId: 'alloc-req-1',
    });

    expect(result).toEqual({ allocation: winner, created: false });
  });

  it('rethrows a unique violation that was not this key', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(null);
    prismaMock.tokenAllocation.create.mockRejectedValue(uniqueViolation());

    await expect(
      service().createAllocation('caller-1', {
        referenceAmount: '80000',
        emberPrice: '10',
        clientRequestId: 'alloc-req-1',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // -------------------------------------------------------------------------
  // Simulated buybacks
  // -------------------------------------------------------------------------

  it('refuses a buyback against an unknown allocation', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(null);

    await expect(
      service().createBuyback('caller-1', { allocationId: 'alloc-x', clientRequestId: 'bb-req-1' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(prismaMock.tokenBuyback.create).not.toHaveBeenCalled();
  });

  it('refuses a buyback against another caller’s allocation with 404, not 403', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow({ userId: 'someone-else' }));

    await expect(
      service().createBuyback('caller-1', { allocationId: 'alloc-1', clientRequestId: 'bb-req-1' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(prismaMock.tokenBuyback.create).not.toHaveBeenCalled();
  });

  it('records a simulated buyback that moves nothing', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(null);
    const stored = buybackRow();
    prismaMock.tokenBuyback.create.mockResolvedValue(stored);

    const result = await service().createBuyback('caller-1', {
      allocationId: 'alloc-1',
      clientRequestId: 'bb-req-1',
    });

    expect(result).toEqual({ buyback: stored, created: true });
    expect(prismaMock.tokenBuyback.create).toHaveBeenCalledWith({
      data: { allocationId: 'alloc-1', userId: 'caller-1', clientRequestId: 'bb-req-1' },
      include: { allocation: true },
    });
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('replays an identical buyback proposal without writing a second row', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());
    const stored = buybackRow();
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(stored);

    const result = await service().createBuyback('caller-1', {
      allocationId: 'alloc-1',
      clientRequestId: 'bb-req-1',
    });

    expect(result).toEqual({ buyback: stored, created: false });
    expect(prismaMock.tokenBuyback.create).not.toHaveBeenCalled();
  });

  it('refuses a replayed key that names a different allocation', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(buybackRow());

    await expect(
      service().createBuyback('caller-1', {
        allocationId: 'alloc-2',
        clientRequestId: 'bb-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it('refuses a second buyback for an allocation that already lost the unique race', async () => {
    prismaMock.tokenAllocation.findUnique.mockResolvedValue(allocationRow());
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(null); // key never used
    prismaMock.tokenBuyback.create.mockRejectedValue(uniqueViolation());

    await expect(
      service().createBuyback('caller-1', {
        allocationId: 'alloc-1',
        clientRequestId: 'bb-req-2',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  // -------------------------------------------------------------------------
  // Simulated executions
  // -------------------------------------------------------------------------

  it('refuses an execute against an unknown or foreign buyback with 404', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(null);

    await expect(
      service().executeBuyback('caller-1', 'bb-x', { executedPrice: '10' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    prismaMock.tokenBuyback.findUnique.mockResolvedValue(buybackRow({ userId: 'someone-else' }));

    await expect(
      service().executeBuyback('caller-1', 'bb-1', { executedPrice: '10' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(prismaMock.tokenBuyback.updateMany).not.toHaveBeenCalled();
  });

  it('records a simulated execution with the floored quantity and reports it as created', async () => {
    const executed = buybackRow({
      status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
      executedPrice: new Prisma.Decimal('10'),
      executedEmber: new Prisma.Decimal('3200'),
      executedAt: new Date('2026-10-18T12:05:00.000Z'),
    });
    prismaMock.tokenBuyback.findUnique.mockResolvedValueOnce(buybackRow());
    prismaMock.tokenBuyback.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.tokenBuyback.findUniqueOrThrow.mockResolvedValue(executed);

    const result = await service().executeBuyback('caller-1', 'bb-1', { executedPrice: '10' });

    expect(result).toEqual({ buyback: executed, created: true });
    expect(prismaMock.tokenBuyback.updateMany).toHaveBeenCalledWith({
      where: { buybackId: 'bb-1', status: TokenBuybackStatus.SIMULATED },
      data: expect.objectContaining({
        status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
        executedPrice: new Prisma.Decimal('10'),
        executedEmber: new Prisma.Decimal('3200'),
      }),
    });
    // Still simulated: an execution moves nothing.
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('refuses a price at which the buyback portion would floor to a zero quantity', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValueOnce(
      buybackRow({ allocation: allocationRow({ buybackInr: new Prisma.Decimal('0.01') }) }),
    );

    await expect(
      service().executeBuyback('caller-1', 'bb-1', { executedPrice: '100000000000000000000' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.tokenBuyback.updateMany).not.toHaveBeenCalled();
  });

  it('replays an already-recorded execution at the same price without rewriting it', async () => {
    const executed = buybackRow({
      status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
      executedPrice: new Prisma.Decimal('10'),
      executedEmber: new Prisma.Decimal('3200'),
      executedAt: new Date('2026-10-18T12:05:00.000Z'),
    });
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(executed);

    const result = await service().executeBuyback('caller-1', 'bb-1', { executedPrice: '10' });

    expect(result).toEqual({ buyback: executed, created: false });
    expect(prismaMock.tokenBuyback.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a second execution at a different price: one-way, never overwritten', async () => {
    const executed = buybackRow({
      status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
      executedPrice: new Prisma.Decimal('11'),
      executedEmber: new Prisma.Decimal('2909.090909090909090909'),
      executedAt: new Date('2026-10-18T12:05:00.000Z'),
    });
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(executed);

    await expect(
      service().executeBuyback('caller-1', 'bb-1', { executedPrice: '10' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    expect(prismaMock.tokenBuyback.updateMany).not.toHaveBeenCalled();
  });

  it('resolves a racing execution to exactly one winner', async () => {
    const winner = buybackRow({
      status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
      executedPrice: new Prisma.Decimal('10'),
      executedEmber: new Prisma.Decimal('3200'),
      executedAt: new Date('2026-10-18T12:05:00.000Z'),
    });
    prismaMock.tokenBuyback.findUnique
      .mockResolvedValueOnce(buybackRow()) // pre-read: still SIMULATED
      .mockResolvedValueOnce(winner); // re-read after losing the update
    prismaMock.tokenBuyback.updateMany.mockResolvedValue({ count: 0 });

    const result = await service().executeBuyback('caller-1', 'bb-1', { executedPrice: '10' });

    expect(result).toEqual({ buyback: winner, created: false });
    expect(prismaMock.tokenBuyback.updateMany).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Burns - DIRECT
  // -------------------------------------------------------------------------

  it('refuses a DIRECT burn that names a buyback instead of an amount', async () => {
    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '10',
        buybackId: 'bb-1',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('refuses a DIRECT burn with no amount', async () => {
    await expect(
      service().createBurn('caller-1', { source: 'DIRECT', clientRequestId: 'burn-req-1' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('refuses a zero or negative DIRECT burn amount', async () => {
    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '0',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('records a DIRECT burn: one transaction carrying the BURN leg and the record', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    const stored = burnRow();
    prismaMock.tokenBurn.create.mockResolvedValue(stored);

    const result = await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '4800',
      clientRequestId: 'burn-req-1',
    });

    expect(result).toEqual({ burn: stored, created: true });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(walletServiceMock.debit).toHaveBeenCalledWith(
      'wallet-treasury',
      'asset-ember',
      new Prisma.Decimal('4800'),
      { type: TransactionType.BURN, note: expect.stringContaining('EMBER burn ') },
      txClient,
    );
    expect(prismaMock.tokenBurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'caller-1',
        source: 'DIRECT',
        buybackId: null,
        amount: new Prisma.Decimal('4800'),
        clientRequestId: 'burn-req-1',
      }),
    });
  });

  it('runs the Module 12 reserve guard inside the burn transaction, before the debit', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    prismaMock.tokenBurn.create.mockResolvedValue(burnRow());

    await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '4800',
      clientRequestId: 'burn-req-1',
    });

    expect(reserveGuardMock.assertDiscretionaryEmberDebit).toHaveBeenCalledWith(txClient, {
      walletId: 'wallet-treasury',
      assetId: 'asset-ember',
      amount: new Prisma.Decimal('4800'),
    });
    // The check precedes the only mutation: guard first, debit second.
    const guardOrder = reserveGuardMock.assertDiscretionaryEmberDebit.mock.invocationCallOrder[0] as number;
    const debitOrder = walletServiceMock.debit.mock.invocationCallOrder[0] as number;
    expect(guardOrder).toBeLessThan(debitOrder);
  });

  it('writes nothing when the reserve guard refuses the burn', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    reserveGuardMock.assertDiscretionaryEmberDebit.mockRejectedValue(
      DomainException.treasuryReserveBreach('300', '100', '50'),
    );

    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '50',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TREASURY_RESERVE_BREACH });

    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('propagates an insufficient treasury balance and writes no burn record', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    walletServiceMock.debit.mockRejectedValue(DomainException.insufficientBalance('EMBER'));

    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '4800',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_BALANCE });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('replays an identical burn without debiting the treasury again', async () => {
    const stored = burnRow();
    prismaMock.tokenBurn.findUnique.mockResolvedValue(stored);
    prismaMock.asset.findUnique.mockResolvedValue(emberAsset);

    const result = await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '4800',
      clientRequestId: 'burn-req-1',
    });

    expect(result).toEqual({ burn: stored, created: false });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('refuses a replayed burn key whose amount differs', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(burnRow());
    prismaMock.asset.findUnique.mockResolvedValue(emberAsset);

    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '100',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('treats a lost burn-key race as a replay of the winner', async () => {
    const winner = burnRow();
    prismaMock.tokenBurn.findUnique
      .mockResolvedValueOnce(null) // pre-check: nothing yet
      .mockResolvedValueOnce(winner); // after the race: the winner
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    prismaMock.tokenBurn.create.mockRejectedValue(uniqueViolation());

    const result = await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '4800',
      clientRequestId: 'burn-req-1',
    });

    expect(result).toEqual({ burn: winner, created: false });
    // The debit ran inside the losing transaction, which rolled back with it.
    expect(walletServiceMock.debit).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Burns - BUYBACK
  // -------------------------------------------------------------------------

  it('refuses a BUYBACK burn with no buybackId and one that tries to state its own amount', async () => {
    await expect(
      service().createBurn('caller-1', { source: 'BUYBACK', clientRequestId: 'burn-req-1' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    prismaMock.tokenBuyback.findUnique.mockResolvedValue(buybackRow());
    await expect(
      service().createBurn('caller-1', {
        source: 'BUYBACK',
        buybackId: 'bb-1',
        amount: '10',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('refuses a BUYBACK burn of an unknown or foreign buyback with 404', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(null);

    await expect(
      service().createBurn('caller-1', {
        source: 'BUYBACK',
        buybackId: 'bb-x',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    prismaMock.tokenBuyback.findUnique.mockResolvedValue(buybackRow({ userId: 'someone-else' }));

    await expect(
      service().createBurn('caller-1', {
        source: 'BUYBACK',
        buybackId: 'bb-1',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  it('refuses a BUYBACK burn before the execution is recorded', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(buybackRow()); // status SIMULATED

    await expect(
      service().createBurn('caller-1', {
        source: 'BUYBACK',
        buybackId: 'bb-1',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('burns exactly the executed quantity of a BUYBACK burn, taken from the record', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(
      buybackRow({
        status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
        executedPrice: new Prisma.Decimal('10'),
        executedEmber: new Prisma.Decimal('3200'),
        executedAt: new Date('2026-10-18T12:05:00.000Z'),
      }),
    );
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'treasury-1' });
    const stored = burnRow({ source: 'BUYBACK', buybackId: 'bb-1', amount: new Prisma.Decimal('3200') });
    prismaMock.tokenBurn.create.mockResolvedValue(stored);

    const result = await service().createBurn('caller-1', {
      source: 'BUYBACK',
      buybackId: 'bb-1',
      clientRequestId: 'burn-req-1',
    });

    expect(result).toEqual({ burn: stored, created: true });
    expect(walletServiceMock.debit).toHaveBeenCalledWith(
      'wallet-treasury',
      'asset-ember',
      new Prisma.Decimal('3200'),
      { type: TransactionType.BURN, note: expect.stringContaining('EMBER burn ') },
      txClient,
    );
    expect(prismaMock.tokenBurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'BUYBACK',
        buybackId: 'bb-1',
        amount: new Prisma.Decimal('3200'),
      }),
    });
  });

  it('refuses a second BUYBACK burn of the same buyback before touching the treasury', async () => {
    prismaMock.tokenBuyback.findUnique.mockResolvedValue(
      buybackRow({
        status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
        executedPrice: new Prisma.Decimal('10'),
        executedEmber: new Prisma.Decimal('3200'),
        executedAt: new Date('2026-10-18T12:05:00.000Z'),
      }),
    );
    prismaMock.tokenBurn.findUnique
      .mockResolvedValueOnce(null) // this key was never used: no replay
      .mockResolvedValueOnce(burnRow({ buybackId: 'bb-1' })); // but another key already burned it

    await expect(
      service().createBurn('caller-1', {
        source: 'BUYBACK',
        buybackId: 'bb-1',
        clientRequestId: 'burn-req-2',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Treasury provisioning
  // -------------------------------------------------------------------------

  it('auto-provisions the treasury on first burn and reuses it afterwards', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // no treasury yet
      .mockResolvedValueOnce({ id: 'treasury-new' });
    prismaMock.user.create.mockResolvedValue({ id: 'treasury-new' });
    const stored = burnRow();
    prismaMock.tokenBurn.create.mockResolvedValue(stored);

    const result = await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '1',
      clientRequestId: 'burn-req-1',
    });

    expect(result.created).toBe(true);
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: { email: 'treasury@prometheus.local' },
    });
    expect(walletServiceMock.getOrCreateForUser).toHaveBeenCalledWith('treasury-new');
  });

  it('lets a racing first burn lose the treasury creation and read the winner', async () => {
    prismaMock.tokenBurn.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValueOnce(null); // first read: none yet
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ id: 'treasury-winner' });
    prismaMock.user.create.mockRejectedValue(uniqueViolation());
    const stored = burnRow();
    prismaMock.tokenBurn.create.mockResolvedValue(stored);

    const result = await service().createBurn('caller-1', {
      source: 'DIRECT',
      amount: '1',
      clientRequestId: 'burn-req-1',
    });

    expect(result.created).toBe(true);
    expect(walletServiceMock.getOrCreateForUser).toHaveBeenCalledWith('treasury-winner');
  });

  it('refuses to burn against a retired EMBER asset', async () => {
    prismaMock.asset.findUnique.mockResolvedValue({ ...emberAsset, isActive: false });

    await expect(
      service().createBurn('caller-1', {
        source: 'DIRECT',
        amount: '10',
        clientRequestId: 'burn-req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ASSET_INACTIVE });

    expect(prismaMock.tokenBurn.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  it('lists only the caller’s own records, newest first, bounded per type', async () => {
    prismaMock.tokenAllocation.findMany.mockResolvedValue([allocationRow()]);
    prismaMock.tokenBuyback.findMany.mockResolvedValue([buybackRow()]);
    prismaMock.tokenBurn.findMany.mockResolvedValue([burnRow()]);

    const records = await service().records('caller-1');

    expect(records.allocations).toHaveLength(1);
    expect(records.buybacks).toHaveLength(1);
    expect(records.burns).toHaveLength(1);

    expect(prismaMock.tokenAllocation.findMany).toHaveBeenCalledWith({
      where: { userId: 'caller-1' },
      orderBy: { allocatedAt: 'desc' },
      take: 50,
    });
    expect(prismaMock.tokenBuyback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'caller-1' }, take: 50 }),
    );
    expect(prismaMock.tokenBurn.findMany).toHaveBeenCalledWith({
      where: { userId: 'caller-1' },
      orderBy: { burnedAt: 'desc' },
      take: 50,
    });
  });

  it('returns empty lists rather than failing when the caller has no records', async () => {
    prismaMock.tokenAllocation.findMany.mockResolvedValue([]);
    prismaMock.tokenBuyback.findMany.mockResolvedValue([]);
    prismaMock.tokenBurn.findMany.mockResolvedValue([]);

    const records = await service().records(randomUUID());

    expect(records).toEqual({ allocations: [], buybacks: [], burns: [] });
  });
});
