import { Injectable } from '@nestjs/common';
import { Prisma, LiquidityProviderStatus, LiquidityCommitmentStatus } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { formatDecimal } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';
import { INR_DECIMALS, USDT_DECIMALS } from '../usdt/domain/usdt-pricing';
import { planAllocation, sumAvailable } from './domain/allocation';

/**
 * MODULE 09 — drawing customer BUY orders from LP commitments.
 *
 * This service runs INSIDE the caller's BUY transaction (`UsdtService.place`):
 * every guarded commitment update, LP wallet leg and allocation row commits
 * with the customer's own legs or not at all, so a row exists if and only if
 * the money moved.
 *
 * LEGACY FALLBACK: when the system has no liquidity providers AT ALL, this is
 * a no-op - the order settles exactly as Module 08 always did (customer legs
 * only, USDT credited without an LP backing it). The moment any provider row
 * exists, allocation is MANDATORY: aggregate eligible liquidity short of the
 * order is 409 INSUFFICIENT_LIQUIDITY and the whole order rolls back. There
 * are no partial fills.
 *
 * CONCURRENCY: plans come from `domain/allocation` (oldest commitment first,
 * deterministic), and each slice is applied through a guarded update
 * (`WHERE usdt_available >= slice`). If a concurrent order consumed the
 * liquidity between planning and application, that guard matches zero rows and
 * the resulting refusal rolls back every leg - never a half-allocated order.
 *
 * CONSERVATION: the customer is debited exactly `inrAmount` and credited
 * exactly `usdtAmount`. LP USDT debits sum to the order volume; LP INR credits
 * sum to the customer's payment - non-final slices credit at the execution
 * price rounded down to whole paisa, and the final slice absorbs whatever
 * remains, so the ledger adds up to the paisa with no rounding drift.
 *
 * SELL is untouched: `allocateBuy` is only called from the BUY path.
 */
export interface BuyAllocationInput {
  readonly orderId: string;
  readonly usdtAmount: Prisma.Decimal;
  /** The customer's INR debit - LP INR credits sum to exactly this. */
  readonly inrAmount: Prisma.Decimal;
  /** Execution price (INR per USDT) the order settled at. */
  readonly priceInr: Prisma.Decimal;
  readonly usdtAssetId: string;
  readonly inrAssetId: string;
}

export interface BuyAllocationSlice {
  readonly commitmentId: string;
  readonly lpId: string;
  readonly usdtAmount: Prisma.Decimal;
  readonly inrAmount: Prisma.Decimal;
  readonly priceInr: Prisma.Decimal;
}

export type BuyAllocationOutcome =
  | { readonly legacy: true; readonly slices: [] }
  | { readonly legacy: false; readonly slices: BuyAllocationSlice[] };

@Injectable()
export class LiquidityAllocationService {
  constructor(private readonly walletService: WalletService) {}

  /**
   * Applies LP funding legs for a BUY order inside the caller's transaction.
   *
   * Returns `legacy: true` (nothing written) only when zero providers exist;
   * otherwise every slice is applied or the call throws and the caller's
   * transaction rolls back.
   */
  async allocateBuy(tx: Prisma.TransactionClient, input: BuyAllocationInput): Promise<BuyAllocationOutcome> {
    const providerCount = await tx.liquidityProvider.count();
    if (providerCount === 0) {
      return { legacy: true, slices: [] };
    }

    const candidates = await tx.liquidityCommitment.findMany({
      where: {
        status: LiquidityCommitmentStatus.ACTIVE,
        usdtAvailable: { gt: 0 },
        lp: { status: LiquidityProviderStatus.ACTIVE },
      },
      orderBy: [{ committedAt: 'asc' }, { commitmentId: 'asc' }],
      include: { lp: { select: { lpId: true, userId: true } } },
    });

    const allocatable = candidates.map((candidate) => ({
      commitmentId: candidate.commitmentId,
      lpId: candidate.lp.lpId,
      availableUsdt: candidate.usdtAvailable,
      committedAt: candidate.committedAt,
    }));
    const ownerByCommitmentId = new Map(candidates.map((candidate) => [candidate.commitmentId, candidate.lp.userId]));

    const plan = planAllocation(input.usdtAmount, allocatable);
    if (!plan) {
      throw DomainException.insufficientLiquidity(
        formatDecimal(input.usdtAmount, USDT_DECIMALS),
        formatDecimal(sumAvailable(allocatable), USDT_DECIMALS),
      );
    }

    const walletIdByUserId = await this.resolveWallets(tx, plan.map((slice) => ownerByCommitmentId.get(slice.commitmentId)!));

    const slices: BuyAllocationSlice[] = [];
    let creditedSoFar = new Prisma.Decimal(0);

    for (const [index, slice] of plan.entries()) {
      const guarded = await tx.liquidityCommitment.updateMany({
        where: { commitmentId: slice.commitmentId, usdtAvailable: { gte: slice.usdtAmount } },
        data: {
          usdtAvailable: { decrement: slice.usdtAmount },
          usdtConsumed: { increment: slice.usdtAmount },
        },
      });

      if (guarded.count === 0) {
        throw DomainException.insufficientLiquidity(
          formatDecimal(input.usdtAmount, USDT_DECIMALS),
          formatDecimal(sumAvailable(allocatable), USDT_DECIMALS),
        );
      }

      const userId = ownerByCommitmentId.get(slice.commitmentId);
      const walletId = userId ? walletIdByUserId.get(userId) : undefined;
      if (!walletId) {
        throw DomainException.notFound('Wallet');
      }

      const isFinal = index === plan.length - 1;
      // Non-final slices credit at the execution price floored to paisa so the
      // credits can never overshoot the customer's debit; the final slice
      // takes the remainder (always >= 0 by that construction).
      const sliceInr = isFinal
        ? input.inrAmount.sub(creditedSoFar)
        : slice.usdtAmount.mul(input.priceInr).toDecimalPlaces(INR_DECIMALS, Prisma.Decimal.ROUND_FLOOR);

      if (isFinal && sliceInr.isZero()) {
        // Exact-paisa totals: every non-final credit already summed to the
        // customer's debit, so there is nothing left to credit this LP.
        slices.push({ ...slice, inrAmount: sliceInr, priceInr: input.priceInr });
        continue;
      }

      if (sliceInr.lte(0)) {
        throw new Error(`LP INR legs exceeded the customer debit for order ${input.orderId}`);
      }

      await this.walletService.debit(
        walletId,
        input.usdtAssetId,
        slice.usdtAmount,
        { note: `Liquidity outflow order ${input.orderId}` },
        tx,
      );
      await this.walletService.credit(
        walletId,
        input.inrAssetId,
        sliceInr,
        { note: `Liquidity inflow order ${input.orderId}` },
        tx,
      );
      creditedSoFar = creditedSoFar.add(sliceInr);

      await tx.liquidityAllocation.create({
        data: {
          commitmentId: slice.commitmentId,
          orderId: input.orderId,
          usdtAmount: slice.usdtAmount,
          priceInr: input.priceInr,
        },
      });

      slices.push({ ...slice, inrAmount: sliceInr, priceInr: input.priceInr });
    }

    return { legacy: false, slices };
  }

  /** One wallet per LP user; registration always creates it up front. */
  private async resolveWallets(tx: Prisma.TransactionClient, userIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(userIds)];
    const walletIdByUserId = new Map<string, string>();

    for (const userId of uniqueIds) {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw DomainException.notFound('Wallet');
      }
      walletIdByUserId.set(userId, wallet.id);
    }

    return walletIdByUserId;
  }
}
