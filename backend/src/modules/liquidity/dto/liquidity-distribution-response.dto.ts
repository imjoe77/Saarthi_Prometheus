import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { INR_DECIMALS, USDT_DECIMALS } from '../../usdt/domain/usdt-pricing';
import type {
  LiquidityDistributionTotals,
  LiquidityProviderDistributionRow,
  LiquidityRecentAllocationRow,
} from '../liquidity.service';
import { LiquidityCommitmentDto } from './liquidity-commitment-response.dto';

/** Percent shares are presentation figures: 2 dp is plenty and stays stable. */
const SHARE_DECIMALS = 2;

/** One provider's own USDT wallet, as it stands right now. */
export class LiquidityProviderWalletDto {
  @ApiProperty({ description: 'Spendable USDT in the LP wallet.', example: '40000.000000' })
  availableUsdt!: string;

  @ApiProperty({ description: 'Locked USDT in the LP wallet (pending / pledged).', example: '0.000000' })
  lockedUsdt!: string;

  static from(wallet: { available: Prisma.Decimal; locked: Prisma.Decimal }): LiquidityProviderWalletDto {
    return {
      availableUsdt: formatDecimal(wallet.available, USDT_DECIMALS),
      lockedUsdt: formatDecimal(wallet.locked, USDT_DECIMALS),
    };
  }
}

/**
 * Platform-wide USDT distribution facts (admin surface).
 *
 * `totalDistributedUsdt` and `totalRemainingUsdt` come from the commitment
 * ledger (`usdt_consumed` / `usdt_available`), so they always satisfy
 * remaining = committed - distributed across the whole pool. `activeRemaining`
 * is the threshold-eligible subset the overview compares against: ACTIVE
 * commitments of ACTIVE providers only.
 */
export class LiquidityDistributionTotalsDto {
  @ApiProperty({ description: 'All USDT ever pledged by every provider, USDT.', example: '1050000.000000' })
  totalCommittedUsdt!: string;

  @ApiProperty({ description: 'USDT already distributed to customer BUY orders.', example: '120000.000000' })
  totalDistributedUsdt!: string;

  @ApiProperty({ description: 'USDT still allocatable after every distribution.', example: '930000.000000' })
  totalRemainingUsdt!: string;

  @ApiProperty({ description: 'USDT providers withdrew through reductions.', example: '0.000000' })
  totalWithdrawnUsdt!: string;

  @ApiProperty({ description: 'INR value of everything distributed, at slice prices.', example: '10440000.00' })
  distributedInr!: string;

  @ApiProperty({ description: 'Allocation slices written across all orders.', example: '7' })
  allocationCount!: number;

  @ApiProperty({ description: 'Distinct BUY orders funded by the pool.', example: '3' })
  ordersFunded!: number;

  @ApiProperty({ description: 'Registered liquidity providers.', example: '3' })
  providerCount!: number;

  @ApiProperty({ description: 'Providers currently ACTIVE.', example: '3' })
  activeProviderCount!: number;

  @ApiProperty({ description: 'Threshold-eligible remaining USDT (ACTIVE of ACTIVE), USDT.', example: '930000.000000' })
  activeRemainingUsdt!: string;

  @ApiProperty({ description: 'Configured shortfall threshold, USDT.', example: '200000.000000' })
  thresholdUsdt!: string;

  @ApiProperty({ description: 'How far below the threshold the eligible pool sits, USDT.', example: '0.000000' })
  shortfallUsdt!: string;

  @ApiProperty({ description: 'True while eligible liquidity sits below the threshold.' })
  belowThreshold!: boolean;

  @ApiProperty({ description: 'Whether commitment mutations are enabled (approved slabs configured).' })
  commitmentsEnabled!: boolean;

  static from(totals: LiquidityDistributionTotals): LiquidityDistributionTotalsDto {
    return {
      totalCommittedUsdt: formatDecimal(totals.totalCommittedUsdt, USDT_DECIMALS),
      totalDistributedUsdt: formatDecimal(totals.totalDistributedUsdt, USDT_DECIMALS),
      totalRemainingUsdt: formatDecimal(totals.totalRemainingUsdt, USDT_DECIMALS),
      totalWithdrawnUsdt: formatDecimal(totals.totalWithdrawnUsdt, USDT_DECIMALS),
      distributedInr: formatDecimal(totals.distributedInr, INR_DECIMALS),
      allocationCount: totals.allocationCount,
      ordersFunded: totals.ordersFunded,
      providerCount: totals.providerCount,
      activeProviderCount: totals.activeProviderCount,
      activeRemainingUsdt: formatDecimal(totals.activeRemainingUsdt, USDT_DECIMALS),
      thresholdUsdt: formatDecimal(totals.thresholdUsdt, USDT_DECIMALS),
      shortfallUsdt: formatDecimal(totals.shortfallUsdt, USDT_DECIMALS),
      belowThreshold: totals.belowThreshold,
      commitmentsEnabled: totals.commitmentsEnabled,
    };
  }
}

/**
 * One provider's place in the distribution: what they pledged, what their
 * commitment actually delivered to orders (USDT, INR value, slice and order
 * counts), what is left after every distribution and reduction, their share
 * of both the pledge and the remaining pool, and their own USDT wallet.
 */
export class LiquidityProviderDistributionDto {
  @ApiProperty({ description: 'Provider id.', format: 'uuid' })
  lpId!: string;

  @ApiProperty({ description: 'The user behind this provider.', format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: "Provider's Gmail.", format: 'email' })
  email!: string;

  @ApiProperty({ description: 'Provider status.', enum: ['ACTIVE', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({ description: 'When the user registered as an LP, ISO-8601.' })
  registeredAt!: string;

  @ApiPropertyOptional({ description: 'The provider\'s commitment, when one exists.' })
  commitment!: LiquidityCommitmentDto | null;

  @ApiProperty({ description: 'USDT this provider delivered to orders.', example: '80000.000000' })
  contributedUsdt!: string;

  @ApiProperty({ description: 'INR value this provider received for those slices.', example: '7040000.00' })
  contributedInr!: string;

  @ApiProperty({ description: 'Allocation slices written from this commitment.', example: '4' })
  allocationCount!: number;

  @ApiProperty({ description: 'Distinct orders this provider funded.', example: '2' })
  ordersFunded!: number;

  @ApiPropertyOptional({ description: 'When this provider last funded an order, ISO-8601.' })
  lastAllocatedAt!: string | null;

  @ApiProperty({ description: 'USDT this provider withdrew through reductions.', example: '0.000000' })
  reducedUsdt!: string;

  @ApiProperty({ description: 'Share of all pledged USDT, percent.', example: '28.57' })
  shareOfCommittedPct!: string;

  @ApiProperty({ description: 'Share of the still-allocatable pool, percent.', example: '32.26' })
  shareOfAvailablePct!: string;

  @ApiPropertyOptional({ description: 'The provider\'s own USDT wallet, when they have one.' })
  wallet!: LiquidityProviderWalletDto | null;

  static from(row: LiquidityProviderDistributionRow): LiquidityProviderDistributionDto {
    return {
      lpId: row.lpId,
      userId: row.userId,
      email: row.email,
      status: row.status,
      registeredAt: row.registeredAt.toISOString(),
      commitment: row.commitment ? LiquidityCommitmentDto.from(row.commitment) : null,
      contributedUsdt: formatDecimal(row.contributedUsdt, USDT_DECIMALS),
      contributedInr: formatDecimal(row.contributedInr, INR_DECIMALS),
      allocationCount: row.allocationCount,
      ordersFunded: row.ordersFunded,
      lastAllocatedAt: row.lastAllocatedAt?.toISOString() ?? null,
      reducedUsdt: formatDecimal(row.reducedUsdt, USDT_DECIMALS),
      shareOfCommittedPct: formatDecimal(row.shareOfCommittedPct, SHARE_DECIMALS),
      shareOfAvailablePct: formatDecimal(row.shareOfAvailablePct, SHARE_DECIMALS),
      wallet: row.wallet ? LiquidityProviderWalletDto.from(row.wallet) : null,
    };
  }
}

/** One recent allocation slice with its order and owning provider. */
export class LiquidityRecentAllocationDto {
  @ApiProperty({ description: 'Allocation slice id.', format: 'uuid' })
  allocationId!: string;

  @ApiProperty({ description: 'The customer order this slice funded.', format: 'uuid' })
  orderId!: string;

  @ApiProperty({ description: 'Order side - always BUY for LP-funded slices.', enum: ['BUY', 'SELL'] })
  orderSide!: string;

  @ApiProperty({ description: 'Total USDT volume of the order.', example: '50000.000000' })
  orderUsdtAmount!: string;

  @ApiProperty({ description: 'The commitment this slice came from.', format: 'uuid' })
  commitmentId!: string;

  @ApiProperty({ description: 'The provider this slice came from.', format: 'uuid' })
  lpId!: string;

  @ApiProperty({ description: "Provider's Gmail.", format: 'email' })
  providerEmail!: string;

  @ApiProperty({ description: 'USDT this slice delivered.', example: '25000.000000' })
  usdtAmount!: string;

  @ApiProperty({ description: 'Execution price of the slice, INR per USDT.', example: '88.000000' })
  priceInr!: string;

  @ApiProperty({ description: 'INR value of the slice.', example: '2200000.00' })
  inrAmount!: string;

  @ApiProperty({ description: 'When the slice settled, ISO-8601.' })
  allocatedAt!: string;

  static from(row: LiquidityRecentAllocationRow): LiquidityRecentAllocationDto {
    return {
      allocationId: row.allocationId,
      orderId: row.orderId,
      orderSide: row.orderSide,
      orderUsdtAmount: formatDecimal(row.orderUsdtAmount, USDT_DECIMALS),
      commitmentId: row.commitmentId,
      lpId: row.lpId,
      providerEmail: row.providerEmail,
      usdtAmount: formatDecimal(row.usdtAmount, USDT_DECIMALS),
      priceInr: formatDecimal(row.priceInr, USDT_DECIMALS),
      inrAmount: formatDecimal(row.inrAmount, INR_DECIMALS),
      allocatedAt: row.allocatedAt.toISOString(),
    };
  }
}

/**
 * MODULE 09 — how USDT is distributed across liquidity providers, for the
 * admin surface (`/admin/usdt`).
 *
 * Read-only: the response reports the three ledgers the allocation engine
 * already writes (pledges, slices, reductions) and never moves state. Rows
 * are ordered by contribution, largest first; `recentAllocations` carries the
 * latest slices so "who funded what, most recently" is visible without a
 * second request.
 */
export class LiquidityDistributionDto {
  @ApiProperty({ description: 'When this read was taken, ISO-8601.' })
  generatedAt!: string;

  @ApiProperty({ type: LiquidityDistributionTotalsDto })
  totals!: LiquidityDistributionTotalsDto;

  @ApiProperty({ type: [LiquidityProviderDistributionDto], description: 'Per-provider rows, biggest contributor first.' })
  providers!: LiquidityProviderDistributionDto[];

  @ApiProperty({ type: [LiquidityRecentAllocationDto], description: 'Latest 12 allocation slices, newest first.' })
  recentAllocations!: LiquidityRecentAllocationDto[];

  static from(input: {
    totals: LiquidityDistributionTotals;
    providers: LiquidityProviderDistributionRow[];
    recentAllocations: LiquidityRecentAllocationRow[];
  }): LiquidityDistributionDto {
    return {
      generatedAt: new Date().toISOString(),
      totals: LiquidityDistributionTotalsDto.from(input.totals),
      providers: input.providers.map((row) => LiquidityProviderDistributionDto.from(row)),
      recentAllocations: input.recentAllocations.map((row) => LiquidityRecentAllocationDto.from(row)),
    };
  }
}
