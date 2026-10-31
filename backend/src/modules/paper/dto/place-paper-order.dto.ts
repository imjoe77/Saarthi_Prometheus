import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class PlacePaperOrderDto {
  @ApiProperty({ description: 'Client-generated UUID to make the request idempotent.', example: '4b556011-9474-4e9b-a3cb-042c99e70ae8' })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({ description: 'Canonical instrument symbol, e.g. AAPL or BTC/USD.', example: 'AAPL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  symbol!: string;

  @ApiProperty({ description: 'BUY or SELL, market order only.', enum: ['BUY', 'SELL'] })
  @IsEnum(['BUY', 'SELL'] as const)
  side!: 'BUY' | 'SELL';

  @ApiProperty({ description: 'Base-asset quantity, to be truncated to 8 places for crypto or the instrument precision.', example: '10' })
  @IsString()
  @IsNotEmpty()
  quantity!: string;
}