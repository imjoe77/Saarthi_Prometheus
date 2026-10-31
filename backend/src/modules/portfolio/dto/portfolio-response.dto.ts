import { ApiProperty } from '@nestjs/swagger';

import type { PortfolioSnapshot } from '../portfolio.types';
import { PortfolioActivityDto } from './portfolio-activity.dto';
import { PortfolioCompositionDto } from './portfolio-composition.dto';
import { PortfolioHoldingDto } from './portfolio-holding.dto';

/** MODULE 04 — the wallet a portfolio describes, reduced to what a client needs. */
export class PortfolioWalletDto {
  @ApiProperty({ description: 'Wallet identifier.', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Wallet lifecycle state.', enum: ['ACTIVE', 'FROZEN'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ description: 'Creation time, ISO-8601.', example: '2026-10-02T10:00:00.000Z' })
  createdAt!: string;
}

/**
 * MODULE 04 — one coherent read model of a user's financial position.
 *
 * Assembled in a single response on purpose. Splitting it into `/holdings` and
 * `/activity` would mean the client renders a portfolio stitched together from
 * two different instants, which is exactly the kind of inconsistency a
 * "portfolio" page must not have.
 *
 * There is no `valuation`, no `pnl` and no `allocation` field. Each would be
 * permanently null today, and a null placeholder reads as "the data failed to
 * load" rather than "this capability does not exist yet". They are added when
 * they can be computed honestly.
 */
export class PortfolioResponseDto {
  @ApiProperty({
    description:
      'The caller’s wallet, or null when they have not created one yet. A null wallet is an empty portfolio, not an error.',
    type: PortfolioWalletDto,
    nullable: true,
  })
  wallet!: PortfolioWalletDto | null;

  @ApiProperty({
    description: 'Every asset balance associated with the wallet, ordered by symbol.',
    type: [PortfolioHoldingDto],
  })
  holdings!: PortfolioHoldingDto[];

  @ApiProperty({ description: 'Categorical composition of the holdings.' })
  composition!: PortfolioCompositionDto;

  @ApiProperty({
    description: 'Movement summary, or null when the wallet has no ledger history yet.',
    type: PortfolioActivityDto,
    nullable: true,
  })
  activity!: PortfolioActivityDto | null;

  @ApiProperty({
    description: 'When this snapshot was assembled.',
    example: '2026-10-02T11:45:47.900Z',
  })
  generatedAt!: string;

  static from(snapshot: PortfolioSnapshot): PortfolioResponseDto {
    return {
      wallet: snapshot.wallet
        ? {
            id: snapshot.wallet.id,
            status: snapshot.wallet.status,
            createdAt: snapshot.wallet.createdAt.toISOString(),
          }
        : null,
      holdings: snapshot.holdings.map((holding) => PortfolioHoldingDto.from(holding)),
      composition: PortfolioCompositionDto.from(snapshot.composition),
      activity: snapshot.activity ? PortfolioActivityDto.from(snapshot.activity) : null,
      generatedAt: snapshot.generatedAt.toISOString(),
    };
  }
}