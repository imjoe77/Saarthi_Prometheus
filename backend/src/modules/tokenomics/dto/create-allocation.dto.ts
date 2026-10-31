import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 11 — the request body for POST /tokenomics/allocations.
 *
 * `referenceAmount` is an INR figure the configured split is computed from -
 * a reference-price metric, never cash, revenue or buyback funding (the same
 * posture as Module 08's `savings`). It is validated against INR's 2dp scale
 * in the service and refused beyond it rather than rounded.
 *
 * `emberPrice` is the caller's illustrative EMBER price; no price feed
 * exists, so the quantity it produces is labelled simulated everywhere it is
 * shown. Zero and negative amounts and prices are refused.
 */
export class CreateAllocationDto {
  @ApiProperty({
    description:
      'Reference amount (INR) to split across the configured direct-burn / buyback percentages. A reference-price metric, never cash or funding.',
    example: '80000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  referenceAmount!: string;

  @ApiProperty({
    description: 'Illustrative EMBER price (INR per EMBER) the quantities are derived at.',
    example: '10',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  emberPrice!: string;

  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;
}
