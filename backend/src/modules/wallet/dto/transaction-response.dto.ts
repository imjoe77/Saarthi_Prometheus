import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { formatDecimal } from '../decimal.util';
import type { TransactionWithAsset } from '../wallet.types';
import { AssetRefDto } from './asset-ref.dto';

/**
 * MODULE 03 — one ledger row.
 *
 * The snapshots (`availableAfter`, `lockedAfter`) are what the running balance
 * was immediately after this movement, so a transaction history can render
 * without replaying every earlier row. They are optional only because the
 * column is nullable at the database level; every row written by this module
 * populates them.
 */
export class TransactionResponseDto {
  @ApiProperty({ description: 'Transaction identifier.', format: 'uuid' })
  id!: string;

  @ApiProperty({
    description: 'Ledger movement kind.',
    enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOCK', 'UNLOCK', 'ADJUSTMENT', 'BURN'],
    example: 'DEPOSIT',
  })
  type!: string;

  @ApiProperty({
    description: 'Settlement state.',
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
    example: 'COMPLETED',
  })
  status!: string;

  @ApiProperty({ description: 'The asset this movement applied to.' })
  asset!: AssetRefDto;

  @ApiProperty({ description: 'Moved amount, multiplicative and always positive.', example: '100.000000' })
  amount!: string;

  @ApiPropertyOptional({ description: 'Available balance after this movement.', example: '1100.000000' })
  availableAfter!: string | null;

  @ApiPropertyOptional({ description: 'Locked balance after this movement.', example: '250.000000' })
  lockedAfter!: string | null;

  @ApiPropertyOptional({ description: 'Operator note. Required for ADJUSTMENT rows.', example: null })
  note!: string | null;

  @ApiProperty({ description: 'When the movement was recorded, ISO-8601.', example: '2026-10-02T10:00:00.000Z' })
  createdAt!: string;

  static from(transaction: TransactionWithAsset): TransactionResponseDto {
    const decimals = transaction.asset.decimals;

    return {
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      asset: AssetRefDto.from(transaction.asset),
      amount: formatDecimal(transaction.amount, decimals),
      availableAfter: transaction.availableAfter
        ? formatDecimal(transaction.availableAfter, decimals)
        : null,
      lockedAfter: transaction.lockedAfter
        ? formatDecimal(transaction.lockedAfter, decimals)
        : null,
      note: transaction.note,
      createdAt: transaction.createdAt.toISOString(),
    };
  }
}
