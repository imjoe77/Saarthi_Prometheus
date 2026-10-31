import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import type { PortfolioHolding } from '../portfolio.types';
import { PortfolioAssetRefDto } from './portfolio-asset-ref.dto';

/** The scale of the underlying column. The schema already forbids anything larger. */
const MAX_DECIMALS = 18;

/**
 * MODULE 04 — one asset's position in a user's portfolio.
 *
 * `total` is sent as a string at the asset's own display precision, computed on
 * the server from `available + locked` in decimal arithmetic. The client is told
 * the answer rather than left to re-derive it: a total recomputed in the browser
 * from two strings is one more place for the numbers to disagree.
 */
export class PortfolioHoldingDto {
  @ApiProperty({ description: 'The asset this holding is denominated in.' })
  asset!: PortfolioAssetRefDto;

  @ApiProperty({ description: 'Spendable balance.', example: '1000.000000' })
  available!: string;

  @ApiProperty({ description: 'Balance reserved against a pending obligation.', example: '250.000000' })
  locked!: string;

  @ApiProperty({
    description: 'available + locked. Derived on the server; never stored.',
    example: '1250.000000',
  })
  total!: string;

  @ApiProperty({
    description: 'False when available and locked are both zero. A drained row is still listed.',
    example: true,
  })
  isFunded!: boolean;

  @ApiProperty({
    description:
      'locked / total, between 0 and 1, or null when the total is zero. Dimensionless, so a number is safe here.',
    example: 0.2,
    nullable: true,
  })
  lockedShare!: number | null;

  /**
   * Renders a stored Decimal as a fixed-point string at the asset's scale.
   *
   * `toFixed` rather than `toString`, because Decimal prints very small
   * magnitudes in exponential form ("1e-18"), which is valid JSON but not a
   * monetary string. `asset.decimals` is constrained to 0-18 by the schema, so the
   * value already sits at this scale and this only pads - it cannot round.
   *
   * Wallet has its own copy of this rule in `wallet/decimal.util.ts`. That
   * duplication is deliberate: the wallet's helper is bundled with its mutation
   * validation and the errors it raises, none of which a read model may depend
   * on. Feature modules are allowed to reach for each other's exported services,
   * not for each other's internals, so two lines are a cheaper price than a
   * portfolio that can throw a domain exception while being read.
   */
  static toAmountString(value: Prisma.Decimal, decimals: number): string {
    return value.toFixed(Math.min(Math.max(decimals, 0), MAX_DECIMALS));
  }

  static from(holding: PortfolioHolding): PortfolioHoldingDto {
    const { decimals } = holding.asset;
    const amount = (value: Prisma.Decimal): string =>
      PortfolioHoldingDto.toAmountString(value, decimals);

    return {
      asset: PortfolioAssetRefDto.from(holding.asset),
      available: amount(holding.available),
      locked: amount(holding.locked),
      total: amount(holding.total),
      isFunded: holding.isFunded,
      lockedShare: holding.lockedShare,
    };
  }
}