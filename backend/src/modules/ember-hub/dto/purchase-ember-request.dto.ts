import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class PurchaseEmberRequestDto {
  @ApiProperty({
    description: 'EMBER to buy at the configured hub price. Ledger precision (up to 18 decimals).',
    example: '500',
  })
  @IsString()
  @MaxLength(40)
  emberAmount!: string;

  @ApiProperty({
    description: 'Client-generated UUID. One purchase outcome per key; a replay returns the original purchase.',
    example: '8d1e9f2a-4b5c-4d6e-8f7a-1b2c3d4e5f6a',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiPropertyOptional({
    description: 'Free-text reference recorded with the purchase.',
    example: 'October portfolio allocation',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
