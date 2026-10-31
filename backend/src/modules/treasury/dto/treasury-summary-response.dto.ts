import { ApiProperty } from '@nestjs/swagger';

import type { TreasurySummary } from '../treasury.service';

/**
 * MODULE 12 - the response of GET /treasury/summary.
 *
 * Two fields carry the module's honesty contract: `reserve` reports the
 * owner-approved 30% floor computed over cumulative qualifying treasury
 * EMBER funding (DEPOSIT ledger legs), and `usdtCapacity` reports the
 * approved demo monthly capacity (₹30 crore by default, converted to USDT
 * for display at the configured display-only rate) as reporting-only
 * tracking - nothing here claims any operation is blocked, because no
 * treasury USDT spending operation exists that enforces the capacity.
 */
export class TreasuryBalanceBlockDto {
  @ApiProperty({ description: 'Spendable balance of this asset held by the treasury.', example: '1000000' })
  available!: string;

  @ApiProperty({ description: 'Locked (not spendable) balance held by the treasury.', example: '0' })
  locked!: string;

  @ApiProperty({ description: 'available + locked, computed server-side with Decimal arithmetic.', example: '1000000' })
  total!: string;

  static from(block: { available: string; locked: string; total: string }): TreasuryBalanceBlockDto {
    const dto = new TreasuryBalanceBlockDto();
    dto.available = block.available;
    dto.locked = block.locked;
    dto.total = block.total;
    return dto;
  }
}

export class TreasuryReservePolicyDto {
  @ApiProperty({ description: 'Approved protected-floor percentage (master plan, Module 12).', example: 30 })
  floorPercent!: number;

  @ApiProperty({
    description:
      'Calculation base of the floor, as owner-approved: cumulative qualifying treasury EMBER funding (DEPOSIT ledger legs).',
    enum: ['QUALIFYING_TREASURY_FUNDING'],
    example: 'QUALIFYING_TREASURY_FUNDING',
  })
  floorBase!: string;

  @ApiProperty({
    description:
      'Cumulative qualifying EMBER funding (the floor base), summed from COMPLETED DEPOSIT legs on the treasury wallet. Null while the treasury account does not exist yet.',
    nullable: true,
    type: String,
    example: '1000000',
  })
  floorBaseAmount!: string | null;

  @ApiProperty({
    description: 'The protected floor: 30% of floorBaseAmount, exact Decimal arithmetic.',
    nullable: true,
    type: String,
    example: '300000',
  })
  floorAmount!: string | null;

  @ApiProperty({
    description:
      'Balance above the floor available at discretion (max(available - floorAmount, 0)). Null while unprovisioned.',
    nullable: true,
    type: String,
    example: '700000',
  })
  discretionaryCapacity!: string | null;

  @ApiProperty({
    description:
      'Floor-dependent reserve health: UNPROVISIONED (no treasury yet), OK (strictly above the floor), AT_FLOOR (exactly at it - no burn possible), BELOW_FLOOR (burns blocked until funding).',
    enum: ['UNPROVISIONED', 'OK', 'AT_FLOOR', 'BELOW_FLOOR'],
  })
  status!: string;

  @ApiProperty({ description: 'Plain-language statement of the approved policy.' })
  note!: string;

  static from(policy: TreasurySummary['reserve']): TreasuryReservePolicyDto {
    const dto = new TreasuryReservePolicyDto();
    dto.floorPercent = policy.floorPercent;
    dto.floorBase = policy.floorBase;
    dto.floorBaseAmount = policy.floorBaseAmount;
    dto.floorAmount = policy.floorAmount;
    dto.discretionaryCapacity = policy.discretionaryCapacity;
    dto.status = policy.status;
    dto.note = policy.note;
    return dto;
  }
}

export class TreasuryUsdtCapacityDto {
  @ApiProperty({ description: 'Whether a monthly capacity value is configured.', example: true })
  configured!: boolean;

  @ApiProperty({
    description:
      'Whether the capacity is the explicitly approved prototype/demo figure rather than real operating capital.',
    example: true,
  })
  demo!: boolean;

  @ApiProperty({
    description: 'Monthly capacity in INR, as approved (default 300000000 = ₹30 crore).',
    nullable: true,
    type: String,
    example: '300000000',
  })
  capacityInr!: string | null;

  @ApiProperty({
    description:
      'The same capacity converted to USDT for display at the configured display-only rate, floored to 6dp. Null when the rate is unavailable - never invented.',
    nullable: true,
    type: String,
    example: '3003003.003003',
  })
  capacity!: string | null;

  @ApiProperty({
    description:
      'Treasury USDT outflow legs (WITHDRAWAL + TRANSFER_OUT) in the current UTC month, on the treasury wallet only. Never derived from individual users.',
    example: '0',
  })
  utilization!: string;

  @ApiProperty({
    description: 'max(capacity - utilization, 0) in USDT. Null while capacity cannot be converted.',
    nullable: true,
    type: String,
    example: '3002877.503003',
  })
  remaining!: string | null;

  @ApiProperty({ description: 'The tracked calendar month, as YYYY-MM.', example: '2026-10' })
  window!: string;

  @ApiProperty({ description: 'The month window is computed in UTC.', enum: ['UTC'] })
  timezone!: 'UTC';

  @ApiProperty({
    description: 'What counts toward utilization.',
    enum: ['TREASURY_WALLET_USDT_OUTFLOWS'],
  })
  utilizationBasis!: 'TREASURY_WALLET_USDT_OUTFLOWS';

  @ApiProperty({
    description:
      'Where the INR->USDT display conversion got its rate (the configured display-only USDT_FALLBACK_PRICE_INR), or why it is unavailable. Null while no capacity is configured.',
    nullable: true,
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['USDT_FALLBACK_PRICE_INR'] },
      priceInr: { type: 'string', nullable: true, example: '99.9' },
      reason: { type: 'string', nullable: true, enum: ['CONVERSION_RATE_UNAVAILABLE', null] },
    },
  })
  conversion!: { source: string; priceInr: string | null; reason: string | null } | null;

  @ApiProperty({
    description:
      'Capacity state for the month: AVAILABLE (under the limit), EXHAUSTED (utilization >= capacity), UNAVAILABLE (no display rate to convert with), NOT_CONFIGURED (no capacity value). Reporting-only - this API never claims spending is blocked.',
    enum: ['AVAILABLE', 'EXHAUSTED', 'UNAVAILABLE', 'NOT_CONFIGURED'],
  })
  exhaustion!: string;

  @ApiProperty({ description: 'Plain-language statement of the reporting-only capacity contract.' })
  note!: string;

  static from(capacity: TreasurySummary['usdtCapacity']): TreasuryUsdtCapacityDto {
    const dto = new TreasuryUsdtCapacityDto();
    dto.configured = capacity.configured;
    dto.demo = capacity.demo;
    dto.capacityInr = capacity.capacityInr;
    dto.capacity = capacity.capacity;
    dto.utilization = capacity.utilization;
    dto.remaining = capacity.remaining;
    dto.window = capacity.window;
    dto.timezone = capacity.timezone;
    dto.utilizationBasis = capacity.utilizationBasis;
    dto.conversion = capacity.conversion;
    dto.exhaustion = capacity.exhaustion;
    dto.note = capacity.note;
    return dto;
  }
}

export class TreasuryActivityDto {
  @ApiProperty({
    description: 'Recorded burn records, platform-wide (all callers), plus their recorded EMBER quantities.',
    type: 'object',
    properties: {
      count: { type: 'integer', example: 3 },
      recordedEmber: { type: 'string', example: '4800' },
    },
  })
  burns!: { count: number; recordedEmber: string };

  @ApiProperty({
    description: 'Recorded buyback records, platform-wide: total, executed subset, recorded executed EMBER.',
    type: 'object',
    properties: {
      count: { type: 'integer', example: 2 },
      executedCount: { type: 'integer', example: 1 },
      recordedEmber: { type: 'string', example: '3200' },
    },
  })
  buybacks!: { count: number; executedCount: number; recordedEmber: string };

  @ApiProperty({
    description: 'Recorded allocation records, platform-wide.',
    type: 'object',
    properties: { count: { type: 'integer', example: 4 } },
  })
  allocations!: { count: number };

  static from(activity: TreasurySummary['activity']): TreasuryActivityDto {
    const dto = new TreasuryActivityDto();
    dto.burns = activity.burns;
    dto.buybacks = activity.buybacks;
    dto.allocations = activity.allocations;
    return dto;
  }
}

export class TreasurySummaryResponseDto {
  @ApiProperty({
    description: 'Identity and wallet state of the platform treasury system account.',
    type: 'object',
    properties: {
      email: { type: 'string', example: 'treasury@prometheus.local' },
      provisioned: { type: 'boolean', example: true },
      userId: { type: 'string', nullable: true },
      walletId: { type: 'string', nullable: true },
      walletStatus: { type: 'string', nullable: true, enum: ['ACTIVE', 'FROZEN'] },
    },
  })
  treasury!: TreasurySummary['treasury'];

  @ApiProperty({
    description: 'Treasury EMBER balances. Null while the treasury account does not exist yet.',
    type: TreasuryBalanceBlockDto,
    nullable: true,
  })
  ember!: TreasuryBalanceBlockDto | null;

  @ApiProperty({
    description: 'Treasury USDT balances (the separate working-capital pool). Null while unprovisioned.',
    type: TreasuryBalanceBlockDto,
    nullable: true,
  })
  usdt!: TreasuryBalanceBlockDto | null;

  @ApiProperty({
    description:
      'Lifetime EMBER inflows to the treasury (DEPOSIT + TRANSFER_IN legs). Informational balance history - deliberately broader than the reserve floor base, which counts qualifying DEPOSIT funding only.',
    nullable: true,
    type: String,
    example: '1000000',
  })
  emberLifetimeFundedIn!: string | null;

  @ApiProperty({ description: 'The computed 30% reserve floor over qualifying treasury funding.', type: TreasuryReservePolicyDto })
  reserve!: TreasuryReservePolicyDto;

  @ApiProperty({ description: 'Monthly USDT capacity tracking, separate from the EMBER reserve.', type: TreasuryUsdtCapacityDto })
  usdtCapacity!: TreasuryUsdtCapacityDto;

  @ApiProperty({ description: 'Platform-wide recorded tokenomics activity (display aggregates only).', type: TreasuryActivityDto })
  activity!: TreasuryActivityDto;

  static from(summary: TreasurySummary): TreasurySummaryResponseDto {
    const dto = new TreasurySummaryResponseDto();
    dto.treasury = summary.treasury;
    dto.ember = summary.ember ? TreasuryBalanceBlockDto.from(summary.ember) : null;
    dto.usdt = summary.usdt ? TreasuryBalanceBlockDto.from(summary.usdt) : null;
    dto.emberLifetimeFundedIn = summary.emberLifetimeFundedIn;
    dto.reserve = TreasuryReservePolicyDto.from(summary.reserve);
    dto.usdtCapacity = TreasuryUsdtCapacityDto.from(summary.usdtCapacity);
    dto.activity = TreasuryActivityDto.from(summary.activity);
    return dto;
  }
}
