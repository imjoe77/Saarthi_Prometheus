import { Prisma } from '@prisma/client';

/**
 * Deterministic LP allocation planning (Module 09).
 *
 * Given an order's USDT amount and the commitments that are eligible to fill
 * it, produce the exact slices - oldest commitment first, one slice per
 * commitment, no partial fills. The walk order lives here (not in a query's
 * incidental row order) so identical inputs and state always produce the same
 * allocation, whatever the database happens to return.
 *
 * Pure and side-effect free: the plan is computed before the caller applies
 * guarded updates, and refusal is an explicit `null` (insufficient aggregate
 * liquidity) that the caller turns into INSUFFICIENT_LIQUIDITY. Nothing here
 * touches wallets - execution price and money movement stay in the caller's
 * transaction.
 */

export interface AllocatableCommitment {
  readonly commitmentId: string;
  readonly lpId: string;
  readonly availableUsdt: Prisma.Decimal;
  readonly committedAt: Date;
}

export interface AllocationSlice {
  readonly commitmentId: string;
  readonly lpId: string;
  readonly usdtAmount: Prisma.Decimal;
}

/**
 * Plans slices covering `orderUsdt`, or null when eligible liquidity falls
 * short (the caller must then fail the whole order - never allocate less).
 */
export function planAllocation(
  orderUsdt: Prisma.Decimal,
  candidates: readonly AllocatableCommitment[],
): AllocationSlice[] | null {
  const ordered = [...candidates]
    .filter((candidate) => candidate.availableUsdt.gt(0))
    .sort(compareByOldestCommitment);

  const slices: AllocationSlice[] = [];
  let remaining = orderUsdt;

  for (const candidate of ordered) {
    if (remaining.lte(0)) break;

    const take = candidate.availableUsdt.lt(remaining) ? candidate.availableUsdt : remaining;
    slices.push({ commitmentId: candidate.commitmentId, lpId: candidate.lpId, usdtAmount: take });
    remaining = remaining.sub(take);
  }

  return remaining.lte(0) ? slices : null;
}

/** Aggregate eligible liquidity across the candidates, for error reporting. */
export function sumAvailable(candidates: readonly AllocatableCommitment[]): Prisma.Decimal {
  return candidates.reduce((total, candidate) => total.add(candidate.availableUsdt), new Prisma.Decimal(0));
}

/**
 * Oldest commitment first, then commitment id as the tiebreak - the approved
 * allocation order (LP1 seeded before LP2 before LP3 allocates in that order).
 */
function compareByOldestCommitment(left: AllocatableCommitment, right: AllocatableCommitment): number {
  const byTime = left.committedAt.getTime() - right.committedAt.getTime();
  if (byTime !== 0) return byTime;
  return left.commitmentId < right.commitmentId ? -1 : left.commitmentId > right.commitmentId ? 1 : 0;
}
