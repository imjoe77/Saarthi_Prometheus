import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MODULE 08 — query parameters for a USDT quote.
 *
 * The amount arrives as a string and is validated as one, for the same reason
 * every other decimal in this application does: a body or query field typed as
 * `number` would round before anyone could object. The real rule - digits, at
 * most the USDT scale, strictly greater than zero, and an INR conversion exact
 * at two places - lives in `domain/usdt-pricing.ts`, the one place where the
 * shape and the value are written down together.
 *
 * `side` is required with no default: a BUY quote and a SELL quote differ in
 * the sign of the savings metric, so the caller must say which one it means
 * rather than being silently answered about the other.
 */
export class UsdtQuoteQueryDto {
  @ApiProperty({ description: 'USDT volume to price.', example: '10000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  usdtAmount!: string;

  @ApiProperty({ description: 'Direction of the quote.', enum: ['BUY', 'SELL'] })
  @IsEnum(['BUY', 'SELL'] as const)
  side!: 'BUY' | 'SELL';
}
