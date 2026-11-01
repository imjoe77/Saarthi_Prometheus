import { ApiProperty } from '@nestjs/swagger';

import type { ExchangeRevenueSummary } from '../exchange-revenue.service';

/**
 * MODULE 08 x MODULE 11 — the response of GET /tokenomics/exchange-revenue.
 *
 * What settled USDT orders fed into the burn/buyback engine, and what the engine
 * made of each one. The shape is deliberately redundant in one place: the policy
 * travels alongside the figures it produced. A dashboard showing "0 EMBER burned"
 * cannot answer "because there were no orders", "because the revenue policy is
 * switched off" or "because the exchange retained nothing" without it, and those
 * three are different facts for different people.
 *
 * Every amount is a fixed-point string at the scale its module publishes: INR at
 * two decimals, EMBER at eighteen. Never a JSON number, because a binary float
 * cannot hold either.
 */
export class ExchangeRevenueBurnRefDto {
  @ApiProperty({ description: 'The Module 11 burn record id.' })
  burnId!: string;

  @ApiProperty({ description: 'EMBER destroyed by this record, at ledger scale.' })
  amount!: string;

  @ApiProperty({
    description:
      'On-chain state of the burn: NOT_REQUIRED when the blockchain layer is off, so a ledger burn is never reported as a confirmed chain burn.',
  })
  onChainStatus!: string;

  @ApiProperty({ description: 'Sepolia transaction hash, once one exists.', nullable: true })
  onChainTxHash!: string | null;
}

export class ExchangeRevenueAllocationDto {
  @ApiProperty({ description: 'The Module 11 allocation record id.' })
  allocationId!: string;

  @ApiProperty({
    description:
      'Direct-burn share actually applied. This is the adaptive decision for this allocation, which the 60/40 baseline is overridden by as treasury health changes.',
  })
  directBurnPct!: number;

  @ApiProperty({ description: 'Buyback share actually applied, the complement of directBurnPct.' })
  buybackPct!: number;

  @ApiProperty({ description: 'EMBER the direct portion bought at the allocation price.' })
  directBurnEmber!: string;

  @ApiProperty({ description: 'EMBER the buyback portion bought at the allocation price.' })
  buybackEmber!: string;
}

export class ExchangeRevenueEventDto {
  @ApiProperty() eventId!: string;

  @ApiProperty({ description: 'The USDT order this event was detected from. One order, at most one event.' })
  orderId!: string;

  @ApiProperty({ description: 'The customer whose order settled. Never the owner of the records it funded.' })
  userId!: string;

  @ApiProperty() side!: string;
  @ApiProperty() status!: string;

  @ApiProperty({
    description:
      'Why this event has the status it has, including the reasons nothing was allocated. Always present; a blank is indistinguishable from a bug.',
  })
  reasonCode!: string;

  @ApiProperty({ description: 'The refusal or outcome in the guardrail module\u2019s own words.', nullable: true })
  detail!: string | null;

  @ApiProperty({ description: 'INR the customer paid.' })
  customerInr!: string;

  @ApiProperty({ description: 'INR credited to liquidity providers by the settlement.' })
  lpInrSettled!: string;

  @ApiProperty({ description: 'INR the settlement left after every counterparty was paid. Never customer principal.' })
  retainedInr!: string;

  @ApiProperty({ description: 'INR attributed to tokenomics. Zero whenever nothing was attributed.' })
  revenueInr!: string;

  @ApiProperty({
    description:
      'INR the engine was sized against, which is what the allocation\u2019s reference amount was built from. Equals revenueInr under a revenue basis; equals the order\u2019s INR value under a volume basis, where revenueInr stays zero because turnover is not income.',
  })
  basisInr!: string;

  @ApiProperty({ description: 'The revenue mode this order was decided under.' })
  revenueMode!: string;

  @ApiProperty({ description: 'The rate in basis points this order was decided under.' })
  revenueBps!: number;

  @ApiProperty({ description: 'EMBER price the quantities were derived at.' })
  emberPrice!: string;

  @ApiProperty({ description: 'Baseline split snapshotted when the order was detected.' })
  directBurnPct!: number;

  @ApiProperty({ description: 'Baseline buyback share snapshotted when the order was detected.' })
  buybackPct!: number;

  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty() detectedAt!: string;

  @ApiProperty({ description: 'When the pipeline finished. Null while queued, blocked or retrying.', nullable: true })
  processedAt!: string | null;

  @ApiProperty({ nullable: true }) allocationId!: string | null;

  @ApiProperty({
    description: 'The allocation Module 11 actually recorded, including the split it applied. Null until reached.',
    nullable: true,
    type: ExchangeRevenueAllocationDto,
  })
  allocation!: ExchangeRevenueAllocationDto | null;

  @ApiProperty({ nullable: true }) buybackId!: string | null;

  @ApiProperty({
    description:
      'SIMULATED until recorded as executed. A buyback here is a calculated and recorded portion, not EMBER bought from a market.',
    nullable: true,
  })
  buybackStatus!: string | null;

  @ApiProperty({ description: 'EMBER the recorded buyback execution accounted for.', nullable: true })
  buybackExecutedEmber!: string | null;

  @ApiProperty({ nullable: true, type: ExchangeRevenueBurnRefDto }) directBurn!: ExchangeRevenueBurnRefDto | null;

  @ApiProperty({ nullable: true, type: ExchangeRevenueBurnRefDto }) buybackBurn!: ExchangeRevenueBurnRefDto | null;
}

export class ExchangeRevenueSummaryResponseDto {
  @ApiProperty({
    description: 'The configuration that produced these figures, so a zero can be explained rather than guessed at.',
  })
  policy!: ExchangeRevenueSummary['policy'];

  @ApiProperty({
    description:
      'Rupees and EMBER across every order seen. Allocated and burned are reported apart: an allocation promises supply, only a burn destroys it.',
  })
  totals!: ExchangeRevenueSummary['totals'];

  @ApiProperty({
    description: 'Counts and rupees per status, so the backlog is visible as a shape rather than a single number.',
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        revenueInr: { type: 'string' },
        basisInr: { type: 'string' },
        customerInr: { type: 'string' },
      },
    },
  })
  byStatus!: ExchangeRevenueSummary['byStatus'];

  @ApiProperty({ type: [ExchangeRevenueEventDto], description: 'The most recent orders, newest first.' })
  recent!: ExchangeRevenueEventDto[];

  static from(summary: ExchangeRevenueSummary): ExchangeRevenueSummaryResponseDto {
    const dto = new ExchangeRevenueSummaryResponseDto();
    dto.policy = summary.policy;
    dto.totals = summary.totals;
    dto.byStatus = summary.byStatus;
    dto.recent = summary.recent.map((event) => {
      const row = new ExchangeRevenueEventDto();
      Object.assign(row, event);
      return row;
    });
    return dto;
  }
}
