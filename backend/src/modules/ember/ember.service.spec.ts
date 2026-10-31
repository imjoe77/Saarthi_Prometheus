import { randomUUID } from 'node:crypto';

import { Prisma, TransactionType } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { EmberService } from './ember.service';

/**
 * Decision-branch coverage against a mocked database: every refusal that must
 * fire before or around a write (unknown recipient, self-transfer, replay
 * payload conflict, the concurrent-unique race) and the supply aggregation's
 * arithmetic. Everything that moves money is exercised for real in
 * `test/ember.e2e-spec.ts`, where the wallet ledger can be read back.
 */
describe('EmberService (unit)', () => {
  const emberAsset = { id: 'asset-ember', symbol: 'EMBER', decimals: 18, isActive: true };

  const prismaMock = {
    asset: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    emberTransfer: { findUnique: jest.fn(), create: jest.fn() },
    transaction: { groupBy: jest.fn() },
    walletBalance: { aggregate: jest.fn() },
    $transaction: jest.fn(),
  };
  const walletServiceMock = {
    getForUserOrThrow: jest.fn(),
    getOrCreateForUser: jest.fn(),
    debit: jest.fn(),
    credit: jest.fn(),
  };

  const service = () =>
    new EmberService(
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

  // The transaction client the service receives inside $transaction: it must
  // carry the models the service touches (the transfer row insert).
  const txClient = { emberTransfer: prismaMock.emberTransfer };

  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: mockRejectedValue implementations
    // survive a clear and would leak a refusal into the next test.
    jest.resetAllMocks();
    prismaMock.asset.findUnique.mockResolvedValue(emberAsset);
    // The happy-path shell: $transaction invokes the callback with the client.
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txClient),
    );
  });

  // -------------------------------------------------------------------------
  // Refusals before any write
  // -------------------------------------------------------------------------

  it('refuses an unknown recipient with NOT_FOUND before touching any wallet', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'ghost@example.com',
        amount: '10',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(walletServiceMock.getForUserOrThrow).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a self-transfer with VALIDATION_FAILED before opening a transaction', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'sender-1' });

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'me@example.com',
        amount: '10',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative amount through normaliseAmount before any lookup beyond the asset', async () => {
    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'friend@example.com',
        amount: '0',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

    expect(prismaMock.emberTransfer.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idempotent replays
  // -------------------------------------------------------------------------

  it('returns the original transfer on an identical replay without moving a balance', async () => {
    const stored = {
      transferId: 't-1',
      senderUserId: 'sender-1',
      recipientUserId: 'recipient-1',
      amount: new Prisma.Decimal('10'),
      clientRequestId: 'req-1',
      transferredAt: new Date(),
    };
    prismaMock.emberTransfer.findUnique.mockResolvedValue(stored);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });

    const result = await service().transfer('sender-1', {
      recipientEmail: 'friend@example.com',
      amount: '10',
      clientRequestId: 'req-1',
    });

    expect(result).toEqual({ transfer: stored, created: false });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.debit).not.toHaveBeenCalled();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('refuses a replayed key whose amount differs with CONFLICT', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue({
      transferId: 't-1',
      senderUserId: 'sender-1',
      recipientUserId: 'recipient-1',
      amount: new Prisma.Decimal('10'),
      clientRequestId: 'req-1',
    });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'friend@example.com',
        amount: '999',
        clientRequestId: 'req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a replayed key that now names a different recipient with CONFLICT', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue({
      transferId: 't-1',
      senderUserId: 'sender-1',
      recipientUserId: 'recipient-1',
      amount: new Prisma.Decimal('10'),
      clientRequestId: 'req-1',
    });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'someone-else' });

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'other@example.com',
        amount: '10',
        clientRequestId: 'req-1',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  // -------------------------------------------------------------------------
  // The happy path, at the seams the mocks can see
  // -------------------------------------------------------------------------

  it('debits the sender with TRANSFER_OUT and credits the recipient with TRANSFER_IN inside one transaction', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });
    walletServiceMock.getForUserOrThrow.mockResolvedValue({ id: 'wallet-sender' });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-recipient' }, created: true });
    const created = {
      transferId: 't-new',
      senderUserId: 'sender-1',
      recipientUserId: 'recipient-1',
      amount: new Prisma.Decimal('25'),
      clientRequestId: 'req-new',
      transferredAt: new Date(),
    };
    prismaMock.emberTransfer.create.mockResolvedValue(created);

    const result = await service().transfer('sender-1', {
      recipientEmail: 'friend@example.com',
      amount: '25',
      clientRequestId: 'req-new',
    });

    expect(result).toEqual({ transfer: created, created: true });
    expect(walletServiceMock.debit).toHaveBeenCalledWith(
      'wallet-sender',
      'asset-ember',
      new Prisma.Decimal('25'),
      expect.objectContaining({ type: TransactionType.TRANSFER_OUT }),
      txClient,
    );
    expect(walletServiceMock.credit).toHaveBeenCalledWith(
      'wallet-recipient',
      'asset-ember',
      new Prisma.Decimal('25'),
      expect.objectContaining({ type: TransactionType.TRANSFER_IN }),
      txClient,
    );
    expect(prismaMock.emberTransfer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        senderUserId: 'sender-1',
        recipientUserId: 'recipient-1',
        clientRequestId: 'req-new',
      }),
    });
  });

  it('propagates an insufficient-available refusal from the sender debit (locked EMBER is not spendable)', async () => {
    prismaMock.emberTransfer.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });
    walletServiceMock.getForUserOrThrow.mockResolvedValue({ id: 'wallet-sender' });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-recipient' }, created: false });
    walletServiceMock.debit.mockRejectedValue(
      Object.assign(new Error('insufficient'), { code: ERROR_CODES.INSUFFICIENT_BALANCE }),
    );

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'friend@example.com',
        amount: '999999',
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_BALANCE });

    expect(walletServiceMock.credit).not.toHaveBeenCalled();
    expect(prismaMock.emberTransfer.create).not.toHaveBeenCalled();
  });

  it('treats a lost unique race as a replay of the winner', async () => {
    const winner = {
      transferId: 't-winner',
      senderUserId: 'sender-1',
      recipientUserId: 'recipient-1',
      amount: new Prisma.Decimal('10'),
      clientRequestId: 'req-race',
      transferredAt: new Date(),
    };
    prismaMock.emberTransfer.findUnique
      .mockResolvedValueOnce(null) // pre-check: nothing yet
      .mockResolvedValueOnce(winner); // after the race: the winner
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });
    walletServiceMock.getForUserOrThrow.mockResolvedValue({ id: 'wallet-sender' });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-recipient' }, created: false });
    prismaMock.emberTransfer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const result = await service().transfer('sender-1', {
      recipientEmail: 'friend@example.com',
      amount: '10',
      clientRequestId: 'req-race',
    });

    expect(result).toEqual({ transfer: winner, created: false });
  });

  it('refuses a lost unique race whose winner carries a different payload', async () => {
    const winner = {
      transferId: 't-winner',
      senderUserId: 'sender-1',
      recipientUserId: 'different-recipient',
      amount: new Prisma.Decimal('50'),
      clientRequestId: 'req-race',
      transferredAt: new Date(),
    };
    prismaMock.emberTransfer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'recipient-1' });
    walletServiceMock.getForUserOrThrow.mockResolvedValue({ id: 'wallet-sender' });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-recipient' }, created: false });
    prismaMock.emberTransfer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service().transfer('sender-1', {
        recipientEmail: 'friend@example.com',
        amount: '10',
        clientRequestId: 'req-race',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  // -------------------------------------------------------------------------
  // Supply aggregation
  // -------------------------------------------------------------------------

  it('derives supply: issued = deposits - withdrawals, circulating = issued - burned(0), locked from balances', async () => {
    prismaMock.transaction.groupBy.mockResolvedValue([
      { type: TransactionType.DEPOSIT, _sum: { amount: new Prisma.Decimal('500') } },
      { type: TransactionType.WITHDRAWAL, _sum: { amount: new Prisma.Decimal('50') } },
      { type: TransactionType.TRANSFER_IN, _sum: { amount: new Prisma.Decimal('30') } },
      { type: TransactionType.TRANSFER_OUT, _sum: { amount: new Prisma.Decimal('30') } },
      { type: TransactionType.LOCK, _sum: { amount: new Prisma.Decimal('20') } },
      { type: TransactionType.UNLOCK, _sum: { amount: new Prisma.Decimal('20') } },
    ]);
    prismaMock.walletBalance.aggregate.mockResolvedValue({
      _sum: { available: new Prisma.Decimal('320'), locked: new Prisma.Decimal('130') },
    });

    const figures = await service().supply();

    expect(figures.totalIssued.toNumber()).toBe(450); // 500 - 50; transfers/locks excluded
    expect(figures.burned.toNumber()).toBe(0);
    expect(figures.circulating.toNumber()).toBe(450);
    expect(figures.locked.toNumber()).toBe(130);
    expect(figures.available.toNumber()).toBe(320);
  });

  it('derives burned supply from BURN ledger legs so every Module 11 burn counts exactly once', async () => {
    prismaMock.transaction.groupBy.mockResolvedValue([
      { type: TransactionType.DEPOSIT, _sum: { amount: new Prisma.Decimal('500') } },
      { type: TransactionType.WITHDRAWAL, _sum: { amount: new Prisma.Decimal('50') } },
      { type: TransactionType.BURN, _sum: { amount: new Prisma.Decimal('40') } },
    ]);
    prismaMock.walletBalance.aggregate.mockResolvedValue({
      _sum: { available: new Prisma.Decimal('280'), locked: new Prisma.Decimal('130') },
    });

    const figures = await service().supply();

    expect(figures.totalIssued.toNumber()).toBe(450);
    expect(figures.burned.toNumber()).toBe(40);
    expect(figures.circulating.toNumber()).toBe(410);
  });

  it('reports an all-zero supply for an empty ledger without inventing a figure', async () => {
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.walletBalance.aggregate.mockResolvedValue({
      _sum: { available: null, locked: null },
    });

    const figures = await service().supply();

    expect(figures.totalIssued.toNumber()).toBe(0);
    expect(figures.circulating.toNumber()).toBe(0);
    expect(figures.locked.toNumber()).toBe(0);
    expect(figures.available.toNumber()).toBe(0);
    expect(figures.burned.toNumber()).toBe(0);
  });
});
