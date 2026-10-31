import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { TokenBurn } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';
import { EMBER_DECIMALS } from '../domain/allocation-math';

/**
 * MODULE 11 — one completed burn: the record type that actually destroys EMBER.
 *
 * Committed in the same transaction as a BURN debit of the treasury wallet's
 * available balance, so this row exists if and only if the ledger destruction
 * committed. supply's burned figure is SUM over those BURN legs, which
 * reconciles 1:1 with this table by construction.
 *
 * `source` records provenance, not a difference in accounting: DIRECT burns
 * treasury-controlled EMBER directly; BUYBACK burns the executed quantity of
 * a recorded (simulated) buyback. Both are real destruction counted exactly
 * once - `buybackId` is unique, so one execution can never burn twice.
 */
export class TokenBurnResponseDto {
  @ApiProperty({ description: 'Surrogate key of the burn.', example: '9d1e2f3a-4b5c-4d6e-8f7a-1b2c3d4e5f6a' })
  burnId!: string;

  @ApiProperty({
    description: 'Where the burned EMBER came from: DIRECT (treasury-controlled) or BUYBACK (a recorded simulated execution).',
    enum: ['DIRECT', 'BUYBACK'],
    example: 'DIRECT',
  })
  source!: string;

  @ApiPropertyOptional({
    description: 'The executed buyback whose quantity was burned. Null for DIRECT burns.',
    example: '3c6f1b2a-8e5d-4a21-b7f4-1d2e3f4a5b6c',
  })
  buybackId!: string | null;

  @ApiProperty({ description: 'EMBER destroyed, at full ledger precision.', example: '1500.000000000000000000' })
  amount!: string;

  @ApiProperty({ description: 'The idempotency key that created this record.', example: '4b556011-9474-4e9b-a3cb-042c99e70ae8' })
  clientRequestId!: string;

  @ApiProperty({ description: 'When the burn committed.', example: '2026-10-18T12:10:00.000Z' })
  burnedAt!: string;

  static from(burn: TokenBurn): TokenBurnResponseDto {
    const dto = new TokenBurnResponseDto();
    dto.burnId = burn.burnId;
    dto.source = burn.source;
    dto.buybackId = burn.buybackId;
    dto.amount = formatDecimal(burn.amount, EMBER_DECIMALS);
    dto.clientRequestId = burn.clientRequestId;
    dto.burnedAt = burn.burnedAt.toISOString();
    return dto;
  }
}
