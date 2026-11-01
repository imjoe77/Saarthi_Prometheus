import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type CopyEvent,
  type CopyRejectReason,
  type Strategy,
  type StrategyFollow,
} from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import type { PaperFill } from '../paper/ports/paper-execution.port';
import { planOrder } from '../trading/domain/position-book';
import {
  DEFAULT_COPY_INITIAL_CASH,
  evaluateEligibility,
  isAfter,
  sizeCopyOrder,
} from './domain/copy-sizing';

/** Transaction handle type, named here so Prisma's own naming stays inside Prisma. */
type CopyTx = Prisma.TransactionClient;

/** A follow as this engine reads it: the row plus the strategy it points at. */
type FollowWithStrategy = StrategyFollow & { strategy: Strategy };

/**
 * What one `applyFill` call did.
 *
 * `created` distinguishes an event this call *wrote* from one it merely found
 * already written. That distinction is the difference between "two fills were
 * consumed" and "two fills were delivered, one of them twice" - and a sync
 * route that reported the second as progress would be claiming work that never
 * happened. The event row itself is returned either way, because a caller that
 * wants the outcome (copied or refused, and why) wants it in both cases.
 */
export interface CopyApplyResult {
  readonly event: CopyEvent;
  readonly created: boolean;
}

/**
 * MODULE 07 - the copy execution engine: one committed expert fill, applied to
 * one follower, exactly once.
 *
 * ONE TRANSACTION PER (FOLLOW, FILL). Everything that must not desynchronise -
 * the eligibility re-read, the balance debit, the position move, the event row
 * and the cursor - happens inside a single `prisma.$transaction`, so a crash
 * leaves either all of it or none of it. There is no "finish it later" path,
 * because the cursor is the only thing that points at unfinished work and it
 * moves inside this same transaction.
 *
 * SERIALIZATION IS A PER-FOLLOW ADVISORY LOCK, NOT A GLOBAL ONE. The first
 * statement of every pass takes `pg_advisory_xact_lock` on a key derived from
 * (follower, strategy), so two workers racing on the same follow queue instead
 * of interleaving, and the loser re-reads the follow row *after* winning the
 * lock rather than working from a cursor it read a moment earlier. Different
 * followers take different keys and therefore run in parallel. The lock is
 * transaction scoped: PostgreSQL releases it at commit or rollback, so a
 * crashed worker cannot leave a follow wedged.
 *
 * IDEMPOTENCY IS A PRIMARY KEY, NOT A FLAG. `(follower_id, strategy_id,
 * expert_order_id)` is the table's key, so a fill delivered twice - by a retry,
 * a restart, or a second worker that read the same page - finds the row it
 * already wrote and only re-points the cursor. The read and the insert are
 * inside the lock, so the insert race cannot produce a duplicate either.
 *
 * REJECTIONS ARE ROWS, NOT EXCEPTIONS. A fill that cannot be copied is stored
 * with its reason and still consumes the cursor: it is *terminated*, and
 * terminating it is what stops the engine from retrying a decision that will
 * never change. Only infrastructure failures throw - and those roll the whole
 * transaction back, leaving the cursor behind so the fill is retried next pass.
 *
 * THE BOOK IS NET, AND SHARED WITH THE EXPERT'S LEDGER. The plan a fill
 * produces - which way the follower's position moves, what it costs, what it
 * realises - comes from the same kernel the expert's paper account uses, so a
 * copy of a LONG is a LONG and a copy of a SHORT is a SHORT, and neither
 * module can drift from the other on a rounding rule.
 */
@Injectable()
export class CopyExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Applies one expert fill to one follow.
   *
   * An already-consumed fill returns its original row with `created: false`,
   * which is how a duplicate delivery becomes a no-op that still keeps the
   * cursor honest - and still reports itself as nothing new.
   */
  async applyFill(followerId: string, strategyId: string, fill: PaperFill): Promise<CopyApplyResult> {
    const at = new Date();
    const lockKey = `copy:${followerId}:${strategyId}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

      const follow = await tx.strategyFollow.findUnique({
        where: { followerId_strategyId: { followerId, strategyId } },
        include: { strategy: true },
      });

      if (follow === null) {
        // Unreachable through the API: `strategy_follows` is RESTRICT against
        // deletion. Throwing keeps the transaction empty and the pass retryable
        // rather than inventing a row with no follow to attach it to.
        throw new Error(`Copy follow ${followerId}/${strategyId} is missing.`);
      }

      const existing = await tx.copyEvent.findUnique({
        where: {
          followerId_strategyId_expertOrderId: {
            followerId,
            strategyId,
            expertOrderId: fill.orderId,
          },
        },
      });

      if (existing !== null) {
        await this.advanceCursor(tx, follow, fill, at);
        return { event: existing, created: false };
      }

      const eligibility = evaluateEligibility({
        followStatus: follow.status,
        followedAt: follow.followedAt,
        fillFilledAt: fill.filledAt,
        strategy: { status: follow.strategy.status, visibility: follow.strategy.visibility },
      });

      if (!eligibility.eligible) {
        return {
          event: await this.recordRejection(tx, follow, fill, at, eligibility.rejectReason),
          created: true,
        };
      }

      return { event: await this.executeCopy(tx, follow, fill, at), created: true };
    });
  }

  /**
   * The eligible path: provision, size, move money, record.
   *
   * The account is provisioned here rather than at follow time so a follow that
   * has never executed reports *no account* instead of a balance that looks
   * spent-from. It is provisioned before sizing because sizing needs the cash
   * figure - and "you cannot afford this" is still a meaningful thing to record
   * against a freshly seeded account.
   */
  private async executeCopy(
    tx: CopyTx,
    follow: FollowWithStrategy,
    fill: PaperFill,
    at: Date,
  ): Promise<CopyEvent> {
    const account = await tx.copyAccount.upsert({
      where: { followerId_strategyId: { followerId: follow.followerId, strategyId: follow.strategyId } },
      create: {
        followerId: follow.followerId,
        strategyId: follow.strategyId,
        currency: 'USD',
        cash: DEFAULT_COPY_INITIAL_CASH,
        realizedPnl: new Prisma.Decimal(0),
        openedAt: at,
        lastActivityAt: at,
      },
      update: {},
    });

    const position = await tx.copyPosition.findUnique({
      where: {
        followerId_strategyId_symbol: {
          followerId: follow.followerId,
          strategyId: follow.strategyId,
          symbol: fill.symbol,
        },
      },
    });

    // Typed non-null by the port, but the column is nullable and a FILLED row
    // with no price would arrive here as null - which is exactly what the
    // sizing rules classify as `PRICE_UNAVAILABLE` rather than a price of 0.
    const expertPrice: Prisma.Decimal | null = fill.fillPrice ?? null;

    const walletUsdt = await this.walletService.getAvailableBalance(follow.followerId, 'USDT', tx);

    const sized = sizeCopyOrder({
      side: fill.side,
      expertQuantity: fill.quantity,
      allocationFraction: follow.allocationFraction,
      fillPrice: expertPrice,
      cash: account.cash,
      walletUsdt,
    });

    if (!sized.executable) {
      await tx.copyAccount.update({
        where: { followerId_strategyId: { followerId: follow.followerId, strategyId: follow.strategyId } },
        data: { lastActivityAt: at },
      });
      return this.recordRejection(tx, follow, fill, at, sized.rejectReason);
    }

    const plan = planOrder({
      side: fill.side,
      quantity: sized.quantity,
      fillPrice: sized.fillPrice,
      position:
        position === null
          ? null
          : {
              direction: position.direction,
              quantity: position.quantity,
              averageEntryPrice: position.averageEntryPrice,
            },
    });

    // The cash movement is the copy's own notional, signed by its direction: a
    // LONG spends it, a SHORT brings it in.
    if (plan.cashDelta.lt(0)) {
      const spend = plan.cashDelta.negated();
      // The guarded debit is both the affordability check and the concurrency
      // guard: `cash >= gross` is evaluated by PostgreSQL against the very row
      // it is about to update, so two copies racing for the last of the balance
      // cannot both pass it and drive the balance negative.
      const debit = await tx.copyAccount.updateMany({
        where: {
          followerId: follow.followerId,
          strategyId: follow.strategyId,
          cash: { gte: spend },
        },
        data: { cash: { decrement: spend }, lastActivityAt: at },
      });

      if (debit.count === 0) {
        return this.recordRejection(tx, follow, fill, at, 'INSUFFICIENT_COPY_CASH');
      }
    } else if (plan.cashDelta.gt(0)) {
      await tx.copyAccount.update({
        where: { followerId_strategyId: { followerId: follow.followerId, strategyId: follow.strategyId } },
        data: { cash: { increment: plan.cashDelta }, lastActivityAt: at },
      });
    }

    if (!plan.realizedPnl.isZero()) {
      await tx.copyAccount.update({
        where: { followerId_strategyId: { followerId: follow.followerId, strategyId: follow.strategyId } },
        data: { realizedPnl: { increment: plan.realizedPnl }, lastActivityAt: at },
      });
    }

    if (plan.position === null) {
      // A position that empties is deleted, never stored as a zero row: a zero
      // row would read as "held nothing" to one caller and "missing data" to
      // another, and this module refuses to make that ambiguity possible.
      await tx.copyPosition.delete({
        where: {
          followerId_strategyId_symbol: {
            followerId: follow.followerId,
            strategyId: follow.strategyId,
            symbol: fill.symbol,
          },
        },
      });
    } else if (position === null) {
      await tx.copyPosition.create({
        data: {
          followerId: follow.followerId,
          strategyId: follow.strategyId,
          symbol: fill.symbol,
          direction: plan.position.direction,
          quantity: plan.position.quantity,
          averageEntryPrice: plan.position.averageEntryPrice,
          openedAt: at,
          lastActivityAt: at,
        },
      });
    } else {
      await tx.copyPosition.update({
        where: {
          followerId_strategyId_symbol: {
            followerId: follow.followerId,
            strategyId: follow.strategyId,
            symbol: fill.symbol,
          },
        },
        data: {
          direction: plan.position.direction,
          quantity: plan.position.quantity,
          averageEntryPrice: plan.position.averageEntryPrice,
          lastActivityAt: at,
        },
      });
    }

    return this.recordFill(tx, follow, fill, at, sized, plan.realizedPnl);
  }

  private async recordFill(
    tx: CopyTx,
    follow: FollowWithStrategy,
    fill: PaperFill,
    at: Date,
    sized: { quantity: Prisma.Decimal; fillPrice: Prisma.Decimal; gross: Prisma.Decimal },
    realizedPnl: Prisma.Decimal,
  ): Promise<CopyEvent> {
    const event = await tx.copyEvent.create({
      data: {
        followerId: follow.followerId,
        strategyId: follow.strategyId,
        expertOrderId: fill.orderId,
        symbol: fill.symbol,
        side: fill.side,
        expertQuantity: fill.quantity,
        expertFillPrice: fill.fillPrice,
        expertFilledAt: fill.filledAt,
        allocationFraction: follow.allocationFraction,
        quantity: sized.quantity,
        fillPrice: sized.fillPrice,
        gross: sized.gross,
        realizedPnl: realizedPnl.isZero() ? null : realizedPnl,
        status: 'COPIED',
        rejectReason: null,
        processedAt: at,
      },
    });

    await this.advanceCursor(tx, follow, fill, at);
    return event;
  }

  private async recordRejection(
    tx: CopyTx,
    follow: FollowWithStrategy,
    fill: PaperFill,
    at: Date,
    rejectReason: CopyRejectReason,
  ): Promise<CopyEvent> {
    const event = await tx.copyEvent.create({
      data: {
        followerId: follow.followerId,
        strategyId: follow.strategyId,
        expertOrderId: fill.orderId,
        symbol: fill.symbol,
        side: fill.side,
        expertQuantity: fill.quantity,
        expertFillPrice: fill.fillPrice ?? null,
        expertFilledAt: fill.filledAt,
        allocationFraction: follow.allocationFraction,
        quantity: new Prisma.Decimal(0),
        fillPrice: null,
        gross: null,
        realizedPnl: null,
        status: 'REJECTED',
        rejectReason,
        processedAt: at,
      },
    });

    await this.advanceCursor(tx, follow, fill, at);
    return event;
  }

  /**
   * Moves the keyset cursor forward, never backward.
   *
   * The comparison is `isAfter` on the (filledAt, orderId) pair rather than a
   * bare timestamp, because the column has millisecond resolution and two fills
   * can share one - which is why the port tie-breaks on `orderId` in the first
   * place. A cursor already at or past this fill is left untouched: nothing
   * about the stored progress changes, and skipping the write keeps the hot
   * duplicate-delivery path cheap.
   */
  private async advanceCursor(
    tx: CopyTx,
    follow: FollowWithStrategy,
    fill: PaperFill,
    at: Date,
  ): Promise<void> {
    const position = { filledAt: fill.filledAt, orderId: fill.orderId };
    const current = { filledAt: follow.cursorFilledAt, orderId: follow.cursorOrderId };

    if (!isAfter(position, current)) {
      return;
    }

    await tx.strategyFollow.update({
      where: {
        followerId_strategyId: { followerId: follow.followerId, strategyId: follow.strategyId },
      },
      data: {
        cursorFilledAt: fill.filledAt,
        cursorOrderId: fill.orderId,
        lastProcessedAt: at,
      },
    });
  }
}
