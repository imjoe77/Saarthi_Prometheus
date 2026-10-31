import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { TransactionResponseDto } from './transaction-response.dto';

/**
 * MODULE 03 — one keyset page of ledger rows.
 *
 * `nextCursor` is null on the last page. The client passes it back verbatim as
 * `?cursor=`, never constructs or inspects it: its encoding is a server detail
 * that may change without notice.
 */
export class TransactionPageDto {
  @ApiProperty({ description: 'Transactions, newest first.', type: [TransactionResponseDto] })
  items!: TransactionResponseDto[];

  @ApiPropertyOptional({
    description: 'Cursor for the next page, or null when this is the last page.',
    example: 'eyJjcmVhdGVkQXQiOiIyMDI2LTEwLTAyVDEwOjAwOjAwLjAwMFoiLCJpZCI6Ii4uLiJ9',
    nullable: true,
  })
  nextCursor!: string | null;
}
