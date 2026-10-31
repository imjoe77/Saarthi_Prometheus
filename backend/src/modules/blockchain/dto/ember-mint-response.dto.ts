import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EmberMintRequest } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';

export class EmberMintRequestResponseDto {
  @ApiProperty({ description: 'Surrogate key of the request.', example: '9d1e2f3a-4b5c-4d6e-8f7a-1b2c3d4e5f6a' })
  mintRequestId!: string;

  @ApiProperty({ description: 'The idempotency key that created this request.', example: '4b556011-9474-4e9b-a3cb-042c99e70ae8' })
  requestId!: string;

  @ApiProperty({ description: 'EMBER to be minted, at ledger precision.', example: '5000.000000000000000000' })
  amount!: string;

  @ApiProperty({
    description: 'PENDING (accepted), SUBMITTED (broadcast), CONFIRMED (mined successfully), FAILED.',
    enum: ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED'],
    example: 'CONFIRMED',
  })
  status!: string;

  @ApiProperty({ description: 'The platform administrator who initiated the request.', example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' })
  requestedBy!: string;

  @ApiPropertyOptional({ description: 'Free-text justification.', example: 'Hub distribution inventory top-up' })
  reason!: string | null;

  @ApiProperty({ description: 'Chain id the request was submitted against.', example: 31337 })
  chainId!: number;

  @ApiProperty({ description: 'Network label from configuration.', example: 'localhost' })
  network!: string;

  @ApiPropertyOptional({ description: 'Transaction hash, once broadcast.', example: '0x0123...def' })
  txHash!: string | null;

  @ApiPropertyOptional({ description: 'Block the confirmed transaction was mined in.', example: '1250' })
  blockNumber!: string | null;

  @ApiPropertyOptional({ description: 'Why the request FAILED, when it did.', example: 'contract reverted: MaxSupplyExceeded' })
  errorMessage!: string | null;

  @ApiProperty({ description: 'When the request was recorded.', example: '2026-10-21T09:00:00.000Z' })
  requestedAt!: string;

  @ApiPropertyOptional({ description: 'When the transaction was confirmed.', example: '2026-10-21T09:00:04.000Z' })
  confirmedAt!: string | null;

  @ApiPropertyOptional({ description: 'When the request failed.', example: '2026-10-21T09:00:09.000Z' })
  failedAt!: string | null;

  static from(row: EmberMintRequest): EmberMintRequestResponseDto {
    const dto = new EmberMintRequestResponseDto();
    dto.mintRequestId = row.mintRequestId;
    dto.requestId = row.requestId;
    dto.amount = formatDecimal(row.amount, 18);
    dto.status = row.status;
    dto.requestedBy = row.requestedBy;
    dto.reason = row.reason;
    dto.network = row.network;
    dto.chainId = row.chainId;
    dto.txHash = row.txHash;
    dto.blockNumber = row.blockNumber === null ? null : String(row.blockNumber);
    dto.errorMessage = row.errorMessage;
    dto.requestedAt = row.requestedAt.toISOString();
    dto.confirmedAt = row.confirmedAt?.toISOString() ?? null;
    dto.failedAt = row.failedAt?.toISOString() ?? null;
    return dto;
  }
}

export class CreateMintResponseDto {
  @ApiProperty({ type: EmberMintRequestResponseDto })
  request!: EmberMintRequestResponseDto;

  @ApiProperty({ description: 'True when this call created the request; false on an idempotent replay.', example: true })
  created!: boolean;

  static from(view: { request: EmberMintRequest; created: boolean }): CreateMintResponseDto {
    const dto = new CreateMintResponseDto();
    dto.request = EmberMintRequestResponseDto.from(view.request);
    dto.created = view.created;
    return dto;
  }
}

export class EmberMintListResponseDto {
  @ApiProperty({ type: [EmberMintRequestResponseDto] })
  items!: EmberMintRequestResponseDto[];

  static from(rows: EmberMintRequest[]): EmberMintListResponseDto {
    const dto = new EmberMintListResponseDto();
    dto.items = rows.map((row) => EmberMintRequestResponseDto.from(row));
    return dto;
  }
}
