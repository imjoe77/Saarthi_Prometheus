import { ApiProperty } from '@nestjs/swagger';

import { formatDecimal } from '../decimal.util';
import type { BalanceWithAsset } from '../wallet.types';
import { AssetRefDto } from './asset-ref.dto';

/**
 * MODULE 03 — one asset's balances within a wallet.
 *
 * `available` and `locked` are fixed-point strings at the asset's display
 * precision. There is no `total` field: it is exactly `available + locked`, and
 * shipping a derived column invites a client to cache a number that can disagree
 * with its parts. A caller that wants the total adds the two strings.
 */
export class BalanceResponseDto {
  @ApiProperty({ description: 'The asset this balance is denominated in.' })
  asset!: AssetRefDto;

  @ApiProperty({ description: 'Funds free to move.', example: '1000.000000' })
  available!: string;

  @ApiProperty({ description: 'Funds held against a pending obligation.', example: '250.000000' })
  locked!: string;

  static from(balance: BalanceWithAsset): BalanceResponseDto {
    return {
      asset: AssetRefDto.from(balance.asset),
      available: formatDecimal(balance.available, balance.asset.decimals),
      locked: formatDecimal(balance.locked, balance.asset.decimals),
    };
  }
}
