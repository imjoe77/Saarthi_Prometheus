import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 09 — the request body for POST /liquidity/commitments/reduce.
 *
 * Withdraws USDT from the caller's own commitment, down to the liquidity that
 * orders have already consumed (`usdtAvailable` never goes below zero), and
 * recomputes the EMBER lock - unlocking only the surplus above the new slab
 * requirement. Reductions are idempotent on `(commitmentId, clientRequestId)`
 * through their own ledger row, exactly like the commitment's create key.
 *
 * Commitment endpoints answer 503 until EMBER slabs are approved and
 * configured; the service owns that gate, not this DTO.
 */
export class LiquidityCommitmentReduceDto {
  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: 'c7f0e9d2-51b4-4f8e-9a63-1d2e3f4a5b6c',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({ description: 'The commitment to reduce.', format: 'uuid' })
  @IsUUID()
  commitmentId!: string;

  @ApiProperty({ description: 'USDT to withdraw from the commitment.', example: '50000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  usdtAmount!: string;
}
