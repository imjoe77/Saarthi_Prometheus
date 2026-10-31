import { ApiProperty } from '@nestjs/swagger';

import { formatDecimal } from '../../wallet/decimal.util';
import { EMBER_DECIMALS, INR_DECIMALS, type AllocationComputation } from '../domain/allocation-math';

/**
 * MODULE 11 — the response of POST /tokenomics/preview.
 *
 * The exact arithmetic `POST /tokenomics/allocations` would record, computed
 * through the same function and written NOWHERE: a preview is always
 * illustrative, and the client must label it as such. Nothing here moves a
 * balance, reduces supply or represents executed activity - the comparison it
 * enables (quantities across caller-chosen prices) is a calculation, not a
 * market.
 */
export class TokenomicsPreviewResponseDto {
  @ApiProperty({ description: 'Reference amount the split was computed from, INR.', example: '80000.00' })
  referenceAmount!: string;

  @ApiProperty({ description: 'Illustrative price the quantities were derived at, INR per EMBER.', example: '10.000000000000000000' })
  emberPrice!: string;

  @ApiProperty({ description: 'Direct-burn share used.', example: 60 })
  directBurnPct!: number;

  @ApiProperty({ description: 'Buyback share used.', example: 40 })
  buybackPct!: number;

  @ApiProperty({ description: 'Direct-burn portion of the reference amount, INR.', example: '48000.00' })
  directBurnInr!: string;

  @ApiProperty({ description: 'Buyback portion of the reference amount, INR. Always the exact remainder.', example: '32000.00' })
  buybackInr!: string;

  @ApiProperty({ description: 'EMBER the direct-burn portion buys at the price, floored to 18dp.', example: '4800.000000000000000000' })
  directBurnEmber!: string;

  @ApiProperty({ description: 'EMBER the buyback portion buys at the price, floored to 18dp.', example: '3200.000000000000000000' })
  buybackEmber!: string;

  @ApiProperty({
    description: 'Sum of both floored quantities: the total EMBER this allocation could burn if both portions executed. Illustrative, never a recorded figure.',
    example: '8000.000000000000000000',
  })
  potentialBurnEmber!: string;

  static from(computation: AllocationComputation): TokenomicsPreviewResponseDto {
    const dto = new TokenomicsPreviewResponseDto();
    dto.referenceAmount = formatDecimal(computation.referenceAmount, INR_DECIMALS);
    dto.emberPrice = formatDecimal(computation.emberPrice, EMBER_DECIMALS);
    dto.directBurnPct = computation.directBurnPct;
    dto.buybackPct = computation.buybackPct;
    dto.directBurnInr = formatDecimal(computation.directBurnInr, INR_DECIMALS);
    dto.buybackInr = formatDecimal(computation.buybackInr, INR_DECIMALS);
    dto.directBurnEmber = formatDecimal(computation.directBurnEmber, EMBER_DECIMALS);
    dto.buybackEmber = formatDecimal(computation.buybackEmber, EMBER_DECIMALS);
    dto.potentialBurnEmber = formatDecimal(
      computation.directBurnEmber.add(computation.buybackEmber),
      EMBER_DECIMALS,
    );
    return dto;
  }
}
