import { HttpStatus } from '@nestjs/common';
import {
  Prisma,
  TransactionStatus,
  TransactionType,
  WalletStatus,
  type Asset,
  type Wallet,
  type WalletBalance,
} from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { LedgerContext, WalletOperation } from './wallet.service';
import { WalletService } from './wallet.service';

/**
 * MODULE 03 - the wallet service's decision logic.
 *
 * The integration suite proves the SQL actually holds under contention; these
 * tests prove the branches *choose* the right SQL (which guard, which ledger
 * type, which error) without needing a database. That split is why the service
 * keeps `applyMutation`, `appendLedger` and `resolveLedgerType` as separate
 * methods rather than one long expression.
 *
 * The Prisma client is replaced with hand-written jest fakes. Using the real
 * client here would make these tests integration tests under a unit-test name,
 * and would couple every assertion to whether Postgres happens to be running.
 */

interface TxMock {
  wallet: { findUnique: jest.Mock };
  asset: { findUnique: jest.Mock };
  walletBalance: {
    upsert: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  transaction: { create: jest.Mock };
}

interface PrismaMock {
  wallet: { findUnique: jest.Mock; create: jest.Mock; findUniqueOrThrow: jest.Mock };
  walletBalance: { findMany: jest.Mock };
  transaction: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

interface ServiceInternals {
  resolveLedgerType: (operation: WalletOperation, context?: LedgerContext) => TransactionType;
  applyMutation: (
    tx: TxMock,
    operation: WalletOperation,
    walletId: string,
    assetId: string,
    amount: Prisma.Decimal,
    assetSymbol: string,
  ) => Promise<WalletBalance>;
}

const now = new Date('2026-10-02T10:00:00.000Z');

const userId = 'user-1111';
const walletId = 'wallet-2222';
const assetId = 'asset-3333';
const balanceId = 'balance-4444';

const activeWallet: Wallet = {
  id: walletId,
  userId,
  status: WalletStatus.ACTIVE,
  createdAt: now,
  updatedAt: now,
};

const usdt: Asset = {
  id: assetId,
  symbol: 'USDT',
  name: 'Tether USD',
  kind: 'STABLECOIN',
  decimals: 6,
  isActive: true,
  createdAt: now,
  updatedAt: now,
};

const usdtBalance: WalletBalance = {
  id: balanceId,
  walletId,
  assetId,
  available: new Prisma.Decimal('100'),
  locked: new Prisma.Decimal('0'),
  createdAt: now,
  updatedAt: now,
};

function makeMocks(): { prisma: PrismaMock; tx: TxMock } {
  const tx: TxMock = {
    wallet: { findUnique: jest.fn() },
    asset: { findUnique: jest.fn() },
    walletBalance: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    transaction: { create: jest.fn() },
  };

  const prisma: PrismaMock = {
    wallet: { findUnique: jest.fn(), create: jest.fn(), findUniqueOrThrow: jest.fn() },
    walletBalance: { findMany: jest.fn() },
    transaction: { findMany: jest.fn() },
    $transaction: jest.fn((callback: (client: TxMock) => Promise<unknown>) => callback(tx)),
  };

  return { prisma, tx };
}

function serviceWith(prisma: PrismaMock): WalletService {
  return new WalletService(prisma as unknown as PrismaService);
}

function internalsOf(service: WalletService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

async function captureDomainError(run: () => Promise<unknown>): Promise<DomainException> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainException);
    return error as DomainException;
  }

  throw new Error('Expected a DomainException, but the call succeeded.');
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`user_id`)', {
    code: 'P2002',
    clientVersion: '6.15.0',
  });
}

describe('WalletService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: WalletService;

  beforeEach(() => {
    ({ prisma, tx } = makeMocks());
    service = serviceWith(prisma);
  });

  // -------------------------------------------------------------------------
  // Wallet lifecycle
  // -------------------------------------------------------------------------

  describe('getOrCreateForUser', () => {
    it('returns the existing wallet without creating another', async () => {
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);

      const result = await service.getOrCreateForUser(userId);

      expect(result).toEqual({ wallet: activeWallet, created: false });
      expect(prisma.wallet.create).not.toHaveBeenCalled();
    });

    it('creates the wallet on the first call', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);
      prisma.wallet.create.mockResolvedValue(activeWallet);

      const result = await service.getOrCreateForUser(userId);

      expect(result).toEqual({ wallet: activeWallet, created: true });
      expect(prisma.wallet.create).toHaveBeenCalledWith({ data: { userId } });
    });

    it('resolves a lost creation race to the winner rather than erroring', async () => {
      prisma.wallet.findUnique.mockResolvedValueOnce(null);
      prisma.wallet.create.mockRejectedValue(uniqueViolation());
      prisma.wallet.findUniqueOrThrow.mockResolvedValue(activeWallet);

      const result = await service.getOrCreateForUser(userId);

      expect(result).toEqual({ wallet: activeWallet, created: false });
      expect(prisma.wallet.findUniqueOrThrow).toHaveBeenCalledWith({ where: { userId } });
    });

    it('propagates an unexpected creation failure', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);
      prisma.wallet.create.mockRejectedValue(new Error('connection reset'));

      await expect(service.getOrCreateForUser(userId)).rejects.toThrow('connection reset');
    });
  });

  describe('getForUserOrThrow', () => {
    it('throws NOT_FOUND when the user has no wallet', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      const error = await captureDomainError(() => service.getForUserOrThrow(userId));

      expect(error.code).toBe('NOT_FOUND');
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('returns the wallet when it exists', async () => {
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);

      await expect(service.getForUserOrThrow(userId)).resolves.toBe(activeWallet);
    });
  });

  describe('getBalances', () => {
    it('scopes the query to the wallet and includes the asset', async () => {
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);
      prisma.walletBalance.findMany.mockResolvedValue([{ ...usdtBalance, asset: usdt }]);

      const balances = await service.getBalances(userId);

      expect(prisma.walletBalance.findMany).toHaveBeenCalledWith({
        where: { walletId },
        include: { asset: true },
        orderBy: { asset: { symbol: 'asc' } },
      });
      expect(balances).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction paging
  // -------------------------------------------------------------------------

  describe('getTransactionPage', () => {
    it('reports no next page when everything fits', async () => {
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);
      prisma.transaction.findMany.mockResolvedValue([{ id: 't1', asset: usdt, createdAt: now }]);

      const page = await service.getTransactionPage(userId);

      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
    });

    it('fetches one extra row and derives a cursor from the last kept row', async () => {
      const rows = [
        { id: 't3', createdAt: new Date('2026-10-02T10:00:03.000Z'), asset: usdt },
        { id: 't2', createdAt: new Date('2026-10-02T10:00:02.000Z'), asset: usdt },
        { id: 't1', createdAt: new Date('2026-10-02T10:00:01.000Z'), asset: usdt },
      ];
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);
      prisma.transaction.findMany.mockResolvedValue(rows);

      const page = await service.getTransactionPage(userId, { limit: 2 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3 }),
      );
      expect(page.items.map((row) => row.id)).toEqual(['t3', 't2']);
      expect(page.nextCursor).not.toBeNull();

      // The cursor must point at the last *returned* row, not the discarded one.
      const decoded = JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString('utf8')) as {
        id: string;
      };
      expect(decoded.id).toBe('t2');
    });

    it('rejects a malformed cursor', async () => {
      prisma.wallet.findUnique.mockResolvedValue(activeWallet);

      const error = await captureDomainError(() => service.getTransactionPage(userId, { cursor: 'nonsense' }));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // -------------------------------------------------------------------------
  // Ledger type resolution
  // -------------------------------------------------------------------------

  describe('ledger type resolution', () => {
    it.each([
      ['credit', TransactionType.DEPOSIT],
      ['debit', TransactionType.WITHDRAWAL],
      ['lock', TransactionType.LOCK],
      ['unlock', TransactionType.UNLOCK],
    ] as const)('maps %s to %s by default', (operation, expected) => {
      expect(internalsOf(service).resolveLedgerType(operation)).toBe(expected);
    });

    it('allows an explicit override for future transfers', () => {
      const type = internalsOf(service).resolveLedgerType('credit', {
        type: TransactionType.TRANSFER_IN,
      });

      expect(type).toBe(TransactionType.TRANSFER_IN);
    });

    it('refuses an ADJUSTMENT with no note', () => {
      expect(() =>
        internalsOf(service).resolveLedgerType('credit', { type: TransactionType.ADJUSTMENT }),
      ).toThrow(DomainException);
    });

    it('refuses an ADJUSTMENT whose note is only whitespace', () => {
      expect(() =>
        internalsOf(service).resolveLedgerType('credit', {
          type: TransactionType.ADJUSTMENT,
          note: '   ',
        }),
      ).toThrow(DomainException);
    });

    it('accepts an ADJUSTMENT with a note', () => {
      const type = internalsOf(service).resolveLedgerType('debit', {
        type: TransactionType.ADJUSTMENT,
        note: 'correcting a mis-keyed deposit',
      });

      expect(type).toBe(TransactionType.ADJUSTMENT);
    });

    it('refuses a type that is not a TransactionType', () => {
      expect(() =>
        internalsOf(service).resolveLedgerType('credit', { type: 'BOGUS' as TransactionType }),
      ).toThrow(DomainException);
    });
  });

  // -------------------------------------------------------------------------
  // Balance mutation branches
  // -------------------------------------------------------------------------

  describe('applyMutation', () => {
    const amount = new Prisma.Decimal('25');

    it('credits through an upsert so a concurrent first credit cannot duplicate', async () => {
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);

      const result = await internalsOf(service).applyMutation(
        tx,
        'credit',
        walletId,
        assetId,
        amount,
        'USDT',
      );

      expect(tx.walletBalance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { walletId_assetId: { walletId, assetId } },
          create: expect.objectContaining({ walletId, assetId }),
          update: { available: { increment: amount } },
        }),
      );
      expect(result).toBe(usdtBalance);
    });

    it('debits through a guard that requires sufficient available funds', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 1 });
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);

      await internalsOf(service).applyMutation(tx, 'debit', walletId, assetId, amount, 'USDT');

      expect(tx.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId, assetId, available: { gte: amount } },
        data: { available: { decrement: amount } },
      });
    });

    it('refuses a debit the balance cannot fund', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 0 });

      const error = await captureDomainError(() =>
        internalsOf(service).applyMutation(tx, 'debit', walletId, assetId, amount, 'USDT'),
      );

      expect(error.code).toBe('INSUFFICIENT_BALANCE');
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    });

    it('locks by moving available into locked in one statement', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 1 });
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);

      await internalsOf(service).applyMutation(tx, 'lock', walletId, assetId, amount, 'USDT');

      expect(tx.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId, assetId, available: { gte: amount } },
        data: { available: { decrement: amount }, locked: { increment: amount } },
      });
    });

    it('unlocks by moving locked back into available', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 1 });
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);

      await internalsOf(service).applyMutation(tx, 'unlock', walletId, assetId, amount, 'USDT');

      expect(tx.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId, assetId, locked: { gte: amount } },
        data: { locked: { decrement: amount }, available: { increment: amount } },
      });
    });

    it('refuses an unlock the locked balance cannot cover', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 0 });

      const error = await captureDomainError(() =>
        internalsOf(service).applyMutation(tx, 'unlock', walletId, assetId, amount, 'USDT'),
      );

      expect(error.code).toBe('INSUFFICIENT_BALANCE');
    });
  });

  // -------------------------------------------------------------------------
  // Full mutation, through the transaction
  // -------------------------------------------------------------------------

  describe('credit', () => {
    beforeEach(() => {
      tx.wallet.findUnique.mockResolvedValue(activeWallet);
      tx.asset.findUnique.mockResolvedValue(usdt);
      tx.walletBalance.upsert.mockResolvedValue(undefined);
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);
      tx.transaction.create.mockResolvedValue(undefined);
    });

    it('writes the balance and a completed ledger row together', async () => {
      const result = await service.credit(walletId, assetId, '100');

      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: {
          walletId,
          assetId,
          type: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          amount: new Prisma.Decimal('100'),
          availableAfter: usdtBalance.available,
          lockedAfter: usdtBalance.locked,
          note: null,
        },
      });
      expect(result.asset).toBe(usdt);
      expect(result.available.toString()).toBe('100');
    });

    it('returns the asset alongside the balance so callers can format it', async () => {
      const result = await service.credit(walletId, assetId, '1');

      expect(result).toMatchObject({ walletId, assetId, asset: usdt });
    });

    it('refuses a frozen wallet before touching any balance', async () => {
      tx.wallet.findUnique.mockResolvedValue({ ...activeWallet, status: WalletStatus.FROZEN });

      const error = await captureDomainError(() => service.credit(walletId, assetId, '1'));

      expect(error.code).toBe('WALLET_FROZEN');
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(tx.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('refuses an inactive asset before touching any balance', async () => {
      tx.asset.findUnique.mockResolvedValue({ ...usdt, isActive: false });

      const error = await captureDomainError(() => service.credit(walletId, assetId, '1'));

      expect(error.code).toBe('ASSET_INACTIVE');
      expect(tx.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('refuses an amount beyond the asset scale before writing', async () => {
      const error = await captureDomainError(() => service.credit(walletId, assetId, '0.0000001'));

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(tx.walletBalance.upsert).not.toHaveBeenCalled();
    });
  });

  describe('lock and unlock', () => {
    beforeEach(() => {
      tx.wallet.findUnique.mockResolvedValue(activeWallet);
      tx.asset.findUnique.mockResolvedValue(usdt);
      tx.walletBalance.updateMany.mockResolvedValue({ count: 1 });
      tx.walletBalance.findUniqueOrThrow.mockResolvedValue(usdtBalance);
      tx.transaction.create.mockResolvedValue(undefined);
    });

    it('locks by moving available into locked and writing a LOCK ledger row', async () => {
      const result = await service.lock(walletId, assetId, '40');

      expect(tx.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId, assetId, available: { gte: new Prisma.Decimal('40') } },
        data: { available: { decrement: new Prisma.Decimal('40') }, locked: { increment: new Prisma.Decimal('40') } },
      });
      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: TransactionType.LOCK, status: TransactionStatus.COMPLETED }),
      });
      expect(result.asset).toBe(usdt);
    });

    it('unlocks by moving locked back into available and writing an UNLOCK ledger row', async () => {
      await service.unlock(walletId, assetId, '15');

      expect(tx.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId, assetId, locked: { gte: new Prisma.Decimal('15') } },
        data: { locked: { decrement: new Prisma.Decimal('15') }, available: { increment: new Prisma.Decimal('15') } },
      });
      expect(tx.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: TransactionType.UNLOCK, status: TransactionStatus.COMPLETED }),
      });
    });

    it('joins a caller-provided transaction instead of opening its own', async () => {
      const callerTx = tx as unknown as Prisma.TransactionClient;

      await service.lock(walletId, assetId, '10', undefined, callerTx);
      await service.unlock(walletId, assetId, '10', undefined, callerTx);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.walletBalance.updateMany).toHaveBeenCalledTimes(2);
    });

    it('refuses a lock the available balance cannot cover', async () => {
      tx.walletBalance.updateMany.mockResolvedValue({ count: 0 });

      const error = await captureDomainError(() => service.lock(walletId, assetId, '10'));

      expect(error.code).toBe('INSUFFICIENT_BALANCE');
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });
  });
});
