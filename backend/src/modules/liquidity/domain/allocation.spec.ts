import { Prisma } from '@prisma/client';

import { type AllocatableCommitment, planAllocation, sumAvailable } from './allocation';

/**
 * Allocation planning is pure arithmetic over caller-supplied candidates:
 * no wall clock, no database - committedAt stamps are part of the input so
 * "oldest first" is a property of the plan, not of query row order.
 */
function candidate(
  commitmentId: string,
  availableUsdt: string,
  committedAt: string,
): AllocatableCommitment {
  return {
    commitmentId,
    lpId: `lp-of-${commitmentId}`,
    availableUsdt: new Prisma.Decimal(availableUsdt),
    committedAt: new Date(committedAt),
  };
}

const LP1 = candidate('commitment-1', '100000', '2026-10-17T10:00:00.000Z');
const LP2 = candidate('commitment-2', '250000', '2026-10-17T11:00:00.000Z');
const LP3 = candidate('commitment-3', '500000', '2026-10-17T12:00:00.000Z');

describe('planAllocation', () => {
  it('fills a single order fully from one commitment when it alone covers it', () => {
    const slices = planAllocation(new Prisma.Decimal('100000'), [LP1]);

    expect(slices).toEqual([
      { commitmentId: 'commitment-1', lpId: 'lp-of-commitment-1', usdtAmount: new Prisma.Decimal('100000') },
    ]);
  });

  it('allocates oldest commitment first across several LPs', () => {
    const slices = planAllocation(new Prisma.Decimal('200000'), [LP1, LP2, LP3]);

    expect(slices?.map((slice) => [slice.commitmentId, slice.usdtAmount.toString()])).toEqual([
      ['commitment-1', '100000'],
      ['commitment-2', '100000'],
    ]);
  });

  it('produces the identical plan for identical state regardless of input order', () => {
    const order = new Prisma.Decimal('350000');
    const forwards = planAllocation(order, [LP1, LP2, LP3]);
    const backwards = planAllocation(order, [LP3, LP2, LP1]);
    const shuffled = planAllocation(order, [LP2, LP3, LP1]);

    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
    expect(forwards?.map((slice) => slice.commitmentId)).toEqual(['commitment-1', 'commitment-2']);
  });

  it('returns null when aggregate eligible liquidity falls short - never a partial plan', () => {
    expect(planAllocation(new Prisma.Decimal('1000000'), [LP1, LP2])).toBeNull();
  });

  it('returns null when nothing is eligible', () => {
    expect(planAllocation(new Prisma.Decimal('1'), [])).toBeNull();
  });

  it('treats an exact-equality order as fully coverable, consuming the commitment exactly', () => {
    const slices = planAllocation(new Prisma.Decimal('100000'), [LP1]);

    expect(slices).toHaveLength(1);
    expect(slices?.[0]?.usdtAmount.toString()).toBe('100000');
  });

  it('skips commitments with no positive availability instead of emitting zero slices', () => {
    const exhausted: AllocatableCommitment = { ...LP2, availableUsdt: new Prisma.Decimal(0) };
    const slices = planAllocation(new Prisma.Decimal('150000'), [LP1, exhausted, LP3]);

    expect(slices?.map((slice) => slice.commitmentId)).toEqual(['commitment-1', 'commitment-3']);
    expect(slices?.[1]?.usdtAmount.toString()).toBe('50000');
  });

  it('breaks committedAt ties deterministically by commitment id', () => {
    const twinA = candidate('commitment-a', '50000', '2026-10-17T10:00:00.000Z');
    const twinB = candidate('commitment-b', '50000', '2026-10-17T10:00:00.000Z');
    const slices = planAllocation(new Prisma.Decimal('60000'), [twinB, twinA]);

    expect(slices?.map((slice) => slice.commitmentId)).toEqual(['commitment-a', 'commitment-b']);
    expect(slices?.[1]?.usdtAmount.toString()).toBe('10000');
  });

  it('splits three ways when each commitment is too small alone', () => {
    const slices = planAllocation(new Prisma.Decimal('400000'), [LP1, LP2, LP3]);

    expect(slices?.map((slice) => slice.usdtAmount.toString())).toEqual(['100000', '250000', '50000']);
  });

  it('handles a fractional order to full precision without floating point drift', () => {
    const slices = planAllocation(new Prisma.Decimal('99999.999999999999999999'), [LP1]);

    expect(slices?.[0]?.usdtAmount.toString()).toBe('99999.999999999999999999');
  });
});

describe('sumAvailable', () => {
  it('totals candidate liquidity to full precision', () => {
    expect(sumAvailable([LP1, LP2, LP3]).toString()).toBe('850000');
  });

  it('is zero for no candidates', () => {
    expect(sumAvailable([]).toString()).toBe('0');
  });
});
