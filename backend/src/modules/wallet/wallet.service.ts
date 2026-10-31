import { Injectable } from '@nestjs/common';
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
import { PrismaService } from '../../database/prisma.service';
import { decodeCursor, encodeCursor } from './cursor.util';
import { normaliseAmount } from './decimal.util';
import type { BalanceWithAsset, TransactionWithAsset } from './wallet.types';

/**
 * MODULE 03 — the wallet and asset accounting boundary.
 *
 * This service is the *only* place in the codebase that writes `wallet_balances`
 * or `transactions`. Future modules - copy trading, the risk engine, settlement -
 * depend on it and call `credit`/`debit`/`lock`/`unlock`; none of them touches the
 * ledger tables directly. That single boundary is what makes the invariants below
 * enforceable in one place.
 *
 * Invariants every mutation upholds:
 *  - the wallet is ACTIVE and the asset is active;
 *  - the amount is a finite decimal, greater than zero, within the asset's scale;
 *  - available and locked never go negative;
 *  - a debit or lock is refused unless available covers it, an unlock unless
 *    locked covers it;
 *  - the balance change and its ledger row are one atomic unit.
 *
 * Concurrency is handled by the database, not by read-then-write. Each balance
 * step is a guarded `UPDATE` whose `WHERE` restates the invariant (`available >=
 * amount`), so two concurrent debits cannot both pass a stale balance check: the
 * second matches zero rows and is rejected. The balance write and the ledger
 * insert share an interactive transaction, so a failure in either rolls back both.
 * The `CHECK (available >= 0)` constraints in the schema are the final backstop.
 *
 * NOTE: mutations take a `walletId`, not a user id. They are internal APIs for
 * trusted server code, and it is the caller's job to have established that the
 * user owns the wallet (public endpoints derive the wallet from `@CurrentUser`).
 */

/** The four internal accounting operations. */
export type WalletOperation = 'credit' | 'debit' | 'lock' | 'unlock';

/**
 * Extra ledger metadata a caller may attach to a mutation.
 *
 * `type` overrides the default mapping - a future transfer module records
 * `TRANSFER_IN`/`TRANSFER_OUT` against a credit/debit rather than a
 * deposit/withdrawal. `ADJUSTMENT` additionally requires a non-blank `note`,
 * because an unexplained manual correction is indistinguishable from a bug.
 */
export interface LedgerContext {
  type?: TransactionType;
  note?: string;
}

export interface TransactionPage {
  items: TransactionWithAsset[];
  nextCursor: string | null;
}

/**
 * The default `TransactionType` for each operation. The enum has no CREDIT or
 * DEBIT member; these four are its closest honest equivalents, and the service
 * method names stay aligned with the accounting action rather than the enum.
 */
const DEFAULT_LEDGER_TYPE: Record<WalletOperation, TransactionType> = {
  credit: TransactionType.DEPOSIT,
  debit: TransactionType.WITHDRAWAL,
  lock: TransactionType.LOCK,
  unlock: TransactionType.UNLOCK,
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Wallet lifecycle and reads
  // ---------------------------------------------------------------------------

  /**
   * Returns the user's wallet, creating it on first call.
   *
   * `created` tells the controller whether to answer 201 or 200, so a retried or
   * concurrent creation is idempotent instead of a conflict. The database's
   * unique `wallets.user_id` is the real arbiter: if two requests race past the
   * initial lookup, one insert loses with P2002 and is resolved by reading the
   * winner back rather than surfacing an error.
   */
  async getOrCreateForUser(userId: string): Promise<{ wallet: Wallet; created: boolean }> {
    const existing = await this.prisma.wallet.findUnique({ where: { userId } });

    if (existing) {
      return { wallet: existing, created: false };
    }

    try {
      const wallet = await this.prisma.wallet.create({ data: { userId } });
      return { wallet, created: true };
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.prisma.wallet.findUniqueOrThrow({ where: { userId } });
        return { wallet: winner, created: false };
      }
      throw error;
    }
  }

  async findForUser(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async getForUserOrThrow(userId: string): Promise<Wallet> {
    const wallet = await this.findForUser(userId);

    if (!wallet) {
      throw DomainException.notFound('Wallet');
    }

    return wallet;
  }

  /** Every balance the wallet holds, with its asset, in stable symbol order. */
  async getBalances(userId: string): Promise<BalanceWithAsset[]> {
    const wallet = await this.getForUserOrThrow(userId);

    return this.prisma.walletBalance.findMany({
      where: { walletId: wallet.id },
      include: { asset: true },
      orderBy: { asset: { symbol: 'asc' } },
    });
  }

  /**
   * One keyset page of the wallet's ledger, newest first.
   *
   * Fetches `limit + 1` rows to learn whether another page exists without a
   * second count query; the extra row is dropped and its `(createdAt, id)`
   * becomes the `nextCursor`.
   */
  async getTransactionPage(
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<TransactionPage> {
    const wallet = await this.getForUserOrThrow(userId);
    const take = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const where: Prisma.TransactionWhereInput = { walletId: wallet.id };

    if (options.cursor) {
      const { createdAt, id } = decodeCursor(options.cursor);
      where.OR = [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: id } },
      ];
    }

    const rows = await this.prisma.transaction.findMany({
      where,
      include: { asset: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal accounting operations
  // ---------------------------------------------------------------------------

  /**
   * Adds to available. Backs deposits and, later, settlement receipts.
   *
   * `client` joins an outer transaction: a caller executing a multi-step flow
   * (Module 08's buy is debit INR, credit USDT and insert the order row) passes
   * the same client for every leg, so all legs and the caller's own writes
   * commit or roll back as one unit. Omit it - as every existing caller does -
   * and the mutation runs in its own transaction exactly as before.
   */
  async credit(
    walletId: string,
    assetId: string,
    amount: string | Prisma.Decimal,
    context?: LedgerContext,
    client?: Prisma.TransactionClient,
  ): Promise<BalanceWithAsset> {
    return this.mutate('credit', walletId, assetId, amount, context, client);
  }

  /** Removes from available. Backs withdrawals and, later, settlement payments. See {@link credit} for `client`. */
  async debit(
    walletId: string,
    assetId: string,
    amount: string | Prisma.Decimal,
    context?: LedgerContext,
    client?: Prisma.TransactionClient,
  ): Promise<BalanceWithAsset> {
    return this.mutate('debit', walletId, assetId, amount, context, client);
  }

  /** Moves funds from available to locked, holding them for a pending obligation. See {@link credit} for `client`. */
  async lock(
    walletId: string,
    assetId: string,
    amount: string | Prisma.Decimal,
    context?: LedgerContext,
    client?: Prisma.TransactionClient,
  ): Promise<BalanceWithAsset> {
    return this.mutate('lock', walletId, assetId, amount, context, client);
  }

  /** Releases locked funds back to available. See {@link credit} for `client`. */
  async unlock(
    walletId: string,
    assetId: string,
    amount: string | Prisma.Decimal,
    context?: LedgerContext,
    client?: Prisma.TransactionClient,
  ): Promise<BalanceWithAsset> {
    return this.mutate('unlock', walletId, assetId, amount, context, client);
  }

  // ---------------------------------------------------------------------------
  // Internals - separated so tests can fail one step of a real transaction
  // ---------------------------------------------------------------------------

  private async mutate(
    operation: WalletOperation,
    walletId: string,
    assetId: string,
    amount: string | Prisma.Decimal,
    context?: LedgerContext,
    client?: Prisma.TransactionClient,
  ): Promise<BalanceWithAsset> {
    const type = this.resolveLedgerType(operation, context);

    const run = async (tx: Prisma.TransactionClient): Promise<BalanceWithAsset> => {
      const wallet = await this.loadActiveWallet(tx, walletId);
      const asset = await this.loadActiveAsset(tx, assetId);
      const value = normaliseAmount(amount, asset);

      const balance = await this.applyMutation(tx, operation, wallet.id, asset.id, value, asset.symbol);

      await this.appendLedger(tx, {
        walletId: wallet.id,
        assetId: asset.id,
        type,
        amount: value,
        availableAfter: balance.available,
        lockedAfter: balance.locked,
        note: context?.note ?? null,
      });

      return { ...balance, asset };
    };

    return client ? run(client) : this.prisma.$transaction(run);
  }

  /**
   * Applies the balance change and returns the post-mutation row.
   *
   * Every branch is atomic: `credit` is an `upsert` (Postgres ON CONFLICT, so a
   * concurrent first credit cannot create a duplicate balance), and the other
   * three are guarded `updateMany` whose `WHERE` encodes the sufficiency test.
   * `count === 0` means the guard, not a missing row, refused the operation.
   */
  private async applyMutation(
    tx: Prisma.TransactionClient,
    operation: WalletOperation,
    walletId: string,
    assetId: string,
    amount: Prisma.Decimal,
    assetSymbol: string,
  ): Promise<WalletBalance> {
    if (operation === 'credit') {
      await tx.walletBalance.upsert({
        where: { walletId_assetId: { walletId, assetId } },
        create: { walletId, assetId, available: amount, locked: new Prisma.Decimal(0) },
        update: { available: { increment: amount } },
      });
    } else if (operation === 'debit') {
      const result = await tx.walletBalance.updateMany({
        where: { walletId, assetId, available: { gte: amount } },
        data: { available: { decrement: amount } },
      });

      if (result.count === 0) {
        throw DomainException.insufficientBalance(assetSymbol);
      }
    } else if (operation === 'lock') {
      const result = await tx.walletBalance.updateMany({
        where: { walletId, assetId, available: { gte: amount } },
        data: { available: { decrement: amount }, locked: { increment: amount } },
      });

      if (result.count === 0) {
        throw DomainException.insufficientBalance(assetSymbol);
      }
    } else {
      const result = await tx.walletBalance.updateMany({
        where: { walletId, assetId, locked: { gte: amount } },
        data: { locked: { decrement: amount }, available: { increment: amount } },
      });

      if (result.count === 0) {
        throw DomainException.insufficientBalance(assetSymbol);
      }
    }

    return tx.walletBalance.findUniqueOrThrow({
      where: { walletId_assetId: { walletId, assetId } },
    });
  }

  /**
   * Writes the ledger row for a successful balance change.
   *
   * Runs inside the mutation's transaction, so it is not possible for the ledger
   * to disagree with the balance: either both are committed or neither is. The
   * status is set explicitly - the column default is PENDING, which would leave
   * a completed movement looking unresolved.
   */
  private async appendLedger(
    tx: Prisma.TransactionClient,
    entry: {
      walletId: string;
      assetId: string;
      type: TransactionType;
      amount: Prisma.Decimal;
      availableAfter: Prisma.Decimal;
      lockedAfter: Prisma.Decimal;
      note: string | null;
    },
  ): Promise<void> {
    await tx.transaction.create({
      data: {
        walletId: entry.walletId,
        assetId: entry.assetId,
        type: entry.type,
        status: TransactionStatus.COMPLETED,
        amount: entry.amount,
        availableAfter: entry.availableAfter,
        lockedAfter: entry.lockedAfter,
        note: entry.note,
      },
    });
  }

  private async loadActiveWallet(tx: Prisma.TransactionClient, walletId: string): Promise<Wallet> {
    const wallet = await tx.wallet.findUnique({ where: { id: walletId } });

    if (!wallet) {
      throw DomainException.notFound('Wallet');
    }

    if (wallet.status !== WalletStatus.ACTIVE) {
      throw DomainException.walletFrozen();
    }

    return wallet;
  }

  private async loadActiveAsset(tx: Prisma.TransactionClient, assetId: string): Promise<Asset> {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });

    if (!asset) {
      throw DomainException.notFound('Asset');
    }

    if (!asset.isActive) {
      throw DomainException.assetInactive(asset.symbol);
    }

    return asset;
  }

  private resolveLedgerType(operation: WalletOperation, context?: LedgerContext): TransactionType {
    const type = context?.type ?? DEFAULT_LEDGER_TYPE[operation];

    if (!Object.values(TransactionType).includes(type)) {
      throw DomainException.badRequest(`Unknown transaction type '${String(type)}'.`);
    }

    if (type === TransactionType.ADJUSTMENT && (context?.note?.trim().length ?? 0) === 0) {
      throw DomainException.badRequest('An ADJUSTMENT transaction requires a note.');
    }

    return type;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
