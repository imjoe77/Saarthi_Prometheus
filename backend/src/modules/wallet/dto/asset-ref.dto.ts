import { ApiProperty } from '@nestjs/swagger';
import type { Asset } from '@prisma/client';

/**
 * MODULE 03 — the asset description embedded in wallet responses.
 *
 * A subset of the asset catalogue: enough to render a monetary string, and
 * nothing more. It is defined inside the wallet module rather than imported from
 * `AssetsModule` so the two modules stay independent; the shape happens to be a
 * prefix of `AssetResponseDto`.
 */
export class AssetRefDto {
  @ApiProperty({ description: 'Canonical asset symbol.', example: 'USDT' })
  symbol!: string;

  @ApiProperty({ description: 'Human-readable asset name.', example: 'Tether USD' })
  name!: string;

  @ApiProperty({ description: 'Display precision for monetary fields.', example: 6 })
  decimals!: number;

  static from(asset: Asset): AssetRefDto {
    return { symbol: asset.symbol, name: asset.name, decimals: asset.decimals };
  }
}
