import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { UsdtOrderResponseDto } from './usdt-order-response.dto';

/**
 * MODULE 08 — one keyset page of the caller's order history, newest first.
 */
export class UsdtOrderPageDto {
  @ApiProperty({ type: [UsdtOrderResponseDto] })
  items!: UsdtOrderResponseDto[];

  @ApiPropertyOptional({
    description: 'Cursor for the next page; absent when this is the last page.',
    nullable: true,
  })
  nextCursor!: string | null;
}
