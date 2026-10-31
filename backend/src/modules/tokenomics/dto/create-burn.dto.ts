import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 11 — the request body for POST /tokenomics/burns.
 *
 * The one record type that destroys EMBER. Every burn debits the treasury
 * wallet's AVAILABLE balance with a BURN ledger leg in the same transaction
 * as the record, so a burn row exists if and only if the destruction
 * committed, and supply's burned figure (SUM over BURN legs) reconciles 1:1
 * with this table.
 *
 * `source` chooses how the amount is determined rather than being free-form:
 *  - DIRECT requires `amount` and forbids `buybackId`: the caller states how
 *    much treasury-controlled EMBER to destroy.
 *  - BUYBACK requires `buybackId` and forbids `amount`: the amount is the
 *    referenced buyback's recorded executed quantity, exactly - accepting a
 *    second amount would allow burning more or less than the record claims.
 *
 * Only one burn can reference a given buyback (`buyback_id` is unique), which
 * is what makes burn-after-buyback count once.
 */
export class CreateBurnDto {
  @ApiProperty({
    description: 'Where the burned EMBER comes from.',
    enum: ['DIRECT', 'BUYBACK'],
    example: 'DIRECT',
  })
  @IsIn(['DIRECT', 'BUYBACK'])
  source!: 'DIRECT' | 'BUYBACK';

  @ApiPropertyOptional({
    description: 'Required for BUYBACK burns (the executed buyback to burn); forbidden for DIRECT burns.',
    example: '0f8b6f4e-93ac-4c71-9f6a-96a2ecb2f9e8',
  })
  @IsOptional()
  @IsUUID()
  buybackId?: string;

  @ApiPropertyOptional({
    description:
      'EMBER to destroy. Required for DIRECT burns; forbidden for BUYBACK burns (the executed quantity is used).',
    example: '1500',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  amount?: string;

  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;
}
