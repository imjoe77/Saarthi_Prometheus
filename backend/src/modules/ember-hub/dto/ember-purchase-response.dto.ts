import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EmberPurchase } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';

export class EmberPurchaseResponseDto {
  @ApiProperty({ description: 'Surrogate key of the purchase.', example: '5d3f3a6a-1b2c-4d6e-8f7a-1b2c3d4e5f6a' })
  purchaseId!: string;

  @ApiProperty({ description: 'EMBER delivered to the caller at ledger precision.', example: '500.000000000000000000' })
  emberAmount!: string;

  @ApiProperty({ description: 'The configured hub price (INR per EMBER) at purchase time.', example: '2.450000000000000000' })
  emberPriceInr!: string;

  @ApiProperty({ description: 'The INR total the purchase represents.', example: '1225.000000000000000000' })
  totalInr!: string;

  @ApiPropertyOptional({ description: 'The USDT/INR display rate used for the USDT legs; null when the rate is unavailable.' })
  usdtRateInr!: string | null;

  @ApiPropertyOptional({ description: 'USDT debited from the caller and credited to the treasury.' })
  totalUsdt!: string | null;

  @ApiProperty({ description: 'COMPLETED for a committed purchase, FAILED for a recorded refusal.', enum: ['COMPLETED', 'FAILED'], example: 'COMPLETED' })
  status!: string;

  @ApiProperty({ description: 'The idempotency key of the request.', example: '8d1e9f2a-4b5c-4d6e-8f7a-1b2c3d4e5f6a' })
  clientRequestId!: string;

  @ApiPropertyOptional({ description: 'Why a purchase FAILED, when it did.' })
  failedReason!: string | null;

  @ApiProperty({ description: 'When the purchase committed (or was recorded as failed).', example: '2026-10-21T10:00:00.000Z' })
  purchasedAt!: string;

  static from(row: EmberPurchase): EmberPurchaseResponseDto {
    const dto = new EmberPurchaseResponseDto();
    dto.purchaseId = row.purchaseId;
    dto.emberAmount = formatDecimal(row.emberAmount, 18);
    dto.emberPriceInr = formatDecimal(row.emberPriceInr, 18);
    dto.totalInr = formatDecimal(row.totalInr, 18);
    dto.usdtRateInr = row.usdtRateInr === null ? null : formatDecimal(row.usdtRateInr, 18);
    dto.totalUsdt = row.totalUsdt === null ? null : formatDecimal(row.totalUsdt, 18);
    dto.status = row.status;
    dto.clientRequestId = row.clientRequestId;
    dto.failedReason = row.failedReason;
    dto.purchasedAt = row.purchasedAt.toISOString();
    return dto;
  }
}

export class CreatePurchaseResponseDto {
  @ApiProperty({ type: EmberPurchaseResponseDto })
  purchase!: EmberPurchaseResponseDto;

  @ApiProperty({ description: 'True when this call committed the purchase; false on an idempotent replay.', example: true })
  created!: boolean;

  static from(view: { purchase: EmberPurchase; created: boolean }): CreatePurchaseResponseDto {
    const dto = new CreatePurchaseResponseDto();
    dto.purchase = EmberPurchaseResponseDto.from(view.purchase);
    dto.created = view.created;
    return dto;
  }
}

export class EmberPurchaseListResponseDto {
  @ApiProperty({ type: [EmberPurchaseResponseDto] })
  items!: EmberPurchaseResponseDto[];

  static from(rows: EmberPurchase[]): EmberPurchaseListResponseDto {
    const dto = new EmberPurchaseListResponseDto();
    dto.items = rows.map((row) => EmberPurchaseResponseDto.from(row));
    return dto;
  }
}
