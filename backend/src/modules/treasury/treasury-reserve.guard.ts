import { Injectable } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { projectedBalance, reserveFloor } from './treasury-policy';

/**
 * MODULE 12 - the atomic reserve check, run inside Module 11's burn
 * transaction.
 *
 * The ONLY reachable treasury-funded EMBER operation in the architecture is
 * `TokenomicsService.createBurn` (verified: every other `debit` call site
 * operates on authenticated users' wallets, and treasury has no login), so
 * the reserve is enforced there - within the very transaction that debits
 * the treasury - rather than at a controller boundary a concurrent request
 * could race past.
 *
 * CONCURRENCY: a transaction-scoped Postgres advisory lock
 * (`pg_advisory_xact_lock`, the pattern Modules 06/07/09 already use) on
 * `treasury_reserve:<walletId>` serialises every check-and-debit pair for
 * one treasury: the second transaction re-reads balances only after the
 * first has committed, so the floor is never evaluated against a stale
 * balance (no TOCTOU).
 *
 * PRECEDENCE (owner-approved, preserves Module 11's frozen expectations):
 * when the available balance cannot cover the requested amount at all, the
 * guard defers - the upcoming `WalletService.debit` rejects with
 * `INSUFFICIENT_BALANCE` and the transaction rolls back. The reserve only
 * has an opinion about burns the balance can otherwise fund.
 *
 * The wallet's status is deliberately irrelevant here: this round's rules
 * forbid using the treasury wallet's status as a substitute for the strict
 * atomic check, so no status is read, compared or relied upon.
 */
@Injectable()
export class TreasuryReserveGuard {
  /**
   * Rejects a discretionary treasury EMBER debit that would take available
   * balance below the approved protected floor - before any ledger leg or
   * burn record can exist.
   *
   * @param tx - the caller's open transaction: the lock, the reads and the
   *   refusal all live inside it, so a rejected operation leaves zero rows.
   */
  async assertDiscretionaryEmberDebit(
    tx: Prisma.TransactionClient,
    params: { walletId: string; assetId: string; amount: Prisma.Decimal },
  ): Promise<void> {
    const lockKey = `treasury_reserve:${params.walletId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

    const funding = await tx.transaction.aggregate({
      where: {
        walletId: params.walletId,
        assetId: params.assetId,
        type: TransactionType.DEPOSIT,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
    const floor = reserveFloor(funding._sum.amount ?? new Prisma.Decimal(0));

    const balance = await tx.walletBalance.findUnique({
      where: { walletId_assetId: { walletId: params.walletId, assetId: params.assetId } },
      select: { available: true },
    });
    const available = balance?.available ?? new Prisma.Decimal(0);

    if (available.lt(params.amount)) {
      // Not fundable at all: INSUFFICIENT_BALANCE is the faithful refusal,
      // and the debit that follows is what produces it.
      return;
    }

    if (projectedBalance(available, params.amount).lt(floor)) {
      throw DomainException.treasuryReserveBreach(
        floor.toString(),
        available.toString(),
        params.amount.toString(),
      );
    }
  }
}
