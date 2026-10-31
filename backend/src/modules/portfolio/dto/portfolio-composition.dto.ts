import { ApiProperty } from '@nestjs/swagger';

import type { PortfolioComposition } from '../portfolio.types';

/**
 * MODULE 04 — how many holdings fall into each asset category.
 *
 * This is a count of assets, not a share of value. There is no percentage here
 * and there will not be one until a legitimate common price source exists: a
 * percentage across INR, USDT and EMBER would require summing incompatible units.
 * The `byKind` name is deliberate — it says what is being counted.
 */
export class PortfolioCompositionByKindDto {
  @ApiProperty({ description: 'Held assets categorised as fiat currency.', example: 1 })
  FIAT!: number;

  @ApiProperty({ description: 'Held assets categorised as stablecoins.', example: 1 })
  STABLECOIN!: number;

  @ApiProperty({ description: 'Held assets categorised as platform tokens.', example: 1 })
  TOKEN!: number;
}

/** The categorical summary shown above the holdings table. */
export class PortfolioCompositionDto {
  @ApiProperty({
    description: 'Balance rows associated with this wallet, including any that are empty.',
    example: 2,
  })
  assetCount!: number;

  @ApiProperty({
    description: 'Of those, how many hold a balance greater than zero.',
    example: 1,
  })
  fundedAssetCount!: number;

  @ApiProperty({ description: 'Holding counts per asset category.' })
  byKind!: PortfolioCompositionByKindDto;

  static from(composition: PortfolioComposition): PortfolioCompositionDto {
    return {
      assetCount: composition.assetCount,
      fundedAssetCount: composition.fundedAssetCount,
      byKind: { ...composition.byKind },
    };
  }
}