import { ApiProperty } from '@nestjs/swagger';
import type { Wallet } from '@prisma/client';

/**
 * MODULE 03 — a wallet as the API exposes it.
 *
 * No balance is embedded: a wallet is a container across many assets, and its
 * balances are their own collection. Dates are ISO-8601 strings so the wire
 * format does not depend on the client's date parsing.
 */
export class WalletResponseDto {
  @ApiProperty({ description: 'Wallet identifier.', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Wallet lifecycle state.', enum: ['ACTIVE', 'FROZEN'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ description: 'Creation time, ISO-8601.', example: '2026-10-02T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'Last update time, ISO-8601.', example: '2026-10-02T10:00:00.000Z' })
  updatedAt!: string;

  static from(wallet: Wallet): WalletResponseDto {
    return {
      id: wallet.id,
      status: wallet.status,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
