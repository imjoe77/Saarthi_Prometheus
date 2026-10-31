import { ApiProperty } from '@nestjs/swagger';
import type { Asset } from '@prisma/client';

/**
 * MODULE 04 — the asset description embedded in portfolio responses.
 *
 * Wider than the wallet module's `AssetRefDto` because a portfolio has to say
 * two things a balance response does not: what *category* the asset is, and
 * whether it is still active. It is declared here rather than imported from
 * `AssetsModule` or `WalletModule` so each module owns the contract it publishes.
 */
export class PortfolioAssetRefDto {
  @ApiProperty({ description: 'Canonical asset symbol.', example: 'USDT' })
  symbol!: string;

  @ApiProperty({ description: 'Human-readable asset name.', example: 'Tether USD' })
  name!: string;

  @ApiProperty({ description: 'Asset category.', enum: ['FIAT', 'STABLECOIN', 'TOKEN'], example: 'STABLECOIN' })
  kind!: string;

  @ApiProperty({ description: 'Display precision for monetary fields.', example: 6 })
  decimals!: number;

  @ApiProperty({
    description:
      'False once an asset is retired. The holding is still returned: the user still owns it, so hiding it would understate the portfolio.',
    example: true,
  })
  isActive!: boolean;

  static from(asset: Asset): PortfolioAssetRefDto {
    return {
      symbol: asset.symbol,
      name: asset.name,
      kind: asset.kind,
      decimals: asset.decimals,
      isActive: asset.isActive,
    };
  }
}