import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 09 — the request body for POST /liquidity/commitments.
 *
 * Opens (or idempotently increases) the caller's single USDT commitment. The
 * EMBER-locking slab is configuration, not a request parameter: the server
 * resolves the requirement from the configured slabs, and with none approved
 * configured the endpoint answers 503 rather than accepting a commitment it
 * cannot gate.
 *
 * `clientRequestId` is stored on the commitment row, so a replayed create or
 * increase returns the original outcome instead of applying the amount a
 * second time - the same key mechanism Module 08 uses on orders.
 */
export class LiquidityCommitmentWriteDto {
  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '9f2a1f58-3a6c-4d47-b0d1-8f2f4a5b6c7d',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({ description: 'USDT to pledge to the commitment.', example: '250000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  usdtAmount!: string;
}
