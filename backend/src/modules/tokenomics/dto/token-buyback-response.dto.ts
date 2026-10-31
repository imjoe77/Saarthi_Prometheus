import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TokenBuybackStatus, type TokenAllocation, type TokenBuyback } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { EMBER_DECIMALS, INR_DECIMALS } from '../domain/allocation-math';

/**
 * MODULE 11 — one simulated buyback, joined with the allocation it draws on.
 *
 * `status` distinguishes the only two stages this module can honestly record:
 * SIMULATED (proposed, nothing executed) and RECORDED_SIMULATED_EXECUTION (a
 * simulated execution is on record with its price and quantity). There is no
 * actual-execution state - no price venue, funding or settlement exists - and
 * this DTO therefore has no field that could be read as funded or executed
 * for real. Every figure is a reference-price calculation; nothing here moves
 * a balance or reduces supply.
 */
export class TokenBuybackResponseDto {
  @ApiProperty({ description: 'Surrogate key of the buyback.', example: '3c6f1b2a-8e5d-4a21-b7f4-1d2e3f4a5b6c' })
  buybackId!: string;

  @ApiProperty({ description: 'Allocation whose buyback portion this record acts on.', example: '0f8b6f4e-93ac-4c71-9f6a-96a2ecb2f9e8' })
  allocationId!: string;

  @ApiProperty({
    description: 'Lifecycle stage: SIMULATED or RECORDED_SIMULATED_EXECUTION. Actual execution is deliberately not a state.',
    enum: TokenBuybackStatus,
    example: TokenBuybackStatus.SIMULATED,
  })
  status!: TokenBuybackStatus;

  @ApiProperty({ description: 'Buyback portion of the allocation, INR.', example: '32000.00' })
  buybackInr!: string;

  @ApiProperty({ description: 'Illustrative price the allocation derived quantities at, INR per EMBER.', example: '10.000000000000000000' })
  emberPrice!: string;

  @ApiProperty({ description: 'EMBER the buyback portion buys at emberPrice, floored to 18dp.', example: '3200.000000000000000000' })
  emberQuantity!: string;

  @ApiPropertyOptional({
    description: 'Price the simulated execution was recorded at, INR per EMBER. Null until recorded.',
    example: '12.500000000000000000',
  })
  executedPrice!: string | null;

  @ApiPropertyOptional({
    description:
      'EMBER the buyback portion funds at executedPrice, floored to 18dp. Null until recorded; a burn can only reference a record that has it.',
    example: '2560.000000000000000000',
  })
  executedEmber!: string | null;

  @ApiProperty({ description: 'When the simulated buyback was proposed.', example: '2026-10-18T12:00:00.000Z' })
  simulatedAt!: string;

  @ApiPropertyOptional({ description: 'When the simulated execution was recorded. Null until then.', example: '2026-10-18T12:05:00.000Z' })
  executedAt!: string | null;

  @ApiProperty({ description: 'The idempotency key that created this record.', example: '4b556011-9474-4e9b-a3cb-042c99e70ae8' })
  clientRequestId!: string;

  static from(buyback: TokenBuyback & { allocation: TokenAllocation }): TokenBuybackResponseDto {
    const dto = new TokenBuybackResponseDto();
    dto.buybackId = buyback.buybackId;
    dto.allocationId = buyback.allocationId;
    dto.status = buyback.status;
    dto.buybackInr = formatDecimal(buyback.allocation.buybackInr, INR_DECIMALS);
    dto.emberPrice = formatDecimal(buyback.allocation.emberPrice, EMBER_DECIMALS);
    dto.emberQuantity = formatDecimal(buyback.allocation.buybackEmber, EMBER_DECIMALS);
    dto.executedPrice = buyback.executedPrice ? formatDecimal(buyback.executedPrice, EMBER_DECIMALS) : null;
    dto.executedEmber = buyback.executedEmber ? formatDecimal(buyback.executedEmber, EMBER_DECIMALS) : null;
    dto.simulatedAt = buyback.simulatedAt.toISOString();
    dto.executedAt = buyback.executedAt ? buyback.executedAt.toISOString() : null;
    dto.clientRequestId = buyback.clientRequestId;
    return dto;
  }
}
