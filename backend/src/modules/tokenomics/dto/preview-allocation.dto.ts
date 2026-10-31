import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 11 — the request body for POST /tokenomics/preview.
 *
 * The same two inputs as recording an allocation, and deliberately NO
 * idempotency key: a preview writes nothing, so there is no outcome to make
 * idempotent. It computes through the exact function `POST /allocations`
 * uses, which is what makes a preview trustworthy as a preview of the record
 * it would create - and it changes no supply figure, because only burns do.
 */
export class PreviewAllocationDto {
  @ApiProperty({
    description: 'Reference amount (INR) to split across the configured percentages.',
    example: '80000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  referenceAmount!: string;

  @ApiProperty({
    description: 'Illustrative EMBER price (INR per EMBER) to derive quantities at.',
    example: '10',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  emberPrice!: string;
}
