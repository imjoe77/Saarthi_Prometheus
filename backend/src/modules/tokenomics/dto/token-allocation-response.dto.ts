import { ApiProperty } from '@nestjs/swagger';
import type { TokenAllocation } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { EMBER_DECIMALS, INR_DECIMALS } from '../domain/allocation-math';

/**
 * MODULE 11 — one recorded allocation proposal.
 *
 * All figures are snapshots taken at proposal time: the percentage pair in
 * particular, so a later configuration change cannot rewrite what this record
 * meant. Nothing in an allocation moves a balance or changes supply - it is a
 * proposal, and only a burn record destroys EMBER.
 */
export class TokenAllocationResponseDto {
  @ApiProperty({ description: 'Surrogate key of the allocation.', example: '0f8b6f4e-93ac-4c71-9f6a-96a2ecb2f9e8' })
  allocationId!: string;

  @ApiProperty({ description: 'Reference amount the split was computed from, INR. A reference-price metric, never cash or funding.', example: '80000.00' })
  referenceAmount!: string;

  @ApiProperty({ description: 'Illustrative price the quantities were derived at, INR per EMBER.', example: '10.000000000000000000' })
  emberPrice!: string;

  @ApiProperty({ description: 'Direct-burn share at proposal time.', example: 60 })
  directBurnPct!: number;

  @ApiProperty({ description: 'Buyback share at proposal time.', example: 40 })
  buybackPct!: number;

  @ApiProperty({ description: 'Direct-burn portion, INR.', example: '48000.00' })
  directBurnInr!: string;

  @ApiProperty({ description: 'Buyback portion, INR. The exact remainder of the reference amount.', example: '32000.00' })
  buybackInr!: string;

  @ApiProperty({ description: 'EMBER the direct-burn portion buys at emberPrice, floored to 18dp.', example: '4800.000000000000000000' })
  directBurnEmber!: string;

  @ApiProperty({ description: 'EMBER the buyback portion buys at emberPrice, floored to 18dp.', example: '3200.000000000000000000' })
  buybackEmber!: string;

  @ApiProperty({ description: 'The idempotency key that created this record.', example: '4b556011-9474-4e9b-a3cb-042c99e70ae8' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the proposal was accepted.', example: '2026-10-18T12:00:00.000Z' })
  allocatedAt!: string;

  static from(allocation: TokenAllocation): TokenAllocationResponseDto {
    const dto = new TokenAllocationResponseDto();
    dto.allocationId = allocation.allocationId;
    dto.referenceAmount = formatDecimal(allocation.referenceAmount, INR_DECIMALS);
    dto.emberPrice = formatDecimal(allocation.emberPrice, EMBER_DECIMALS);
    dto.directBurnPct = allocation.directBurnPct;
    dto.buybackPct = allocation.buybackPct;
    dto.directBurnInr = formatDecimal(allocation.directBurnInr, INR_DECIMALS);
    dto.buybackInr = formatDecimal(allocation.buybackInr, INR_DECIMALS);
    dto.directBurnEmber = formatDecimal(allocation.directBurnEmber, EMBER_DECIMALS);
    dto.buybackEmber = formatDecimal(allocation.buybackEmber, EMBER_DECIMALS);
    dto.clientRequestId = allocation.clientRequestId;
    dto.allocatedAt = allocation.allocatedAt.toISOString();
    return dto;
  }
}
