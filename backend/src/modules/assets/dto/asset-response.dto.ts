import { ApiProperty } from '@nestjs/swagger';
import type { Asset } from '@prisma/client';

/**
 * MODULE 03 — an asset as the API exposes it.
 *
 * `decimals` travels with every asset description because a client cannot render
 * a monetary string correctly without it: "1000.000000" is valid for USDT and
 * meaningless for a 2-decimal currency. Storage precision is always 18 places;
 * this is the display precision the balance and ledger endpoints format to.
 */
export class AssetResponseDto {
  @ApiProperty({ description: 'Canonical asset symbol.', example: 'USDT' })
  symbol!: string;

  @ApiProperty({ description: 'Human-readable asset name.', example: 'Tether USD' })
  name!: string;

  @ApiProperty({
    description: 'Display precision. Also the maximum precision a mutation may carry.',
    example: 6,
  })
  decimals!: number;

  @ApiProperty({ description: 'Asset category.', enum: ['FIAT', 'STABLECOIN', 'TOKEN'], example: 'STABLECOIN' })
  kind!: string;

  static from(asset: Asset): AssetResponseDto {
    return {
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      kind: asset.kind,
    };
  }
}
