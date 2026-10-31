import { ApiProperty } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { formatDecimal } from '../../wallet/decimal.util';

/**
 * MODULE 10 — the response of GET /ember/supply.
 *
 * Every figure is derived from existing accounting records (the `transactions`
 * ledger and `wallet_balances`); there is no separate supply table and no
 * number the service invents. Amounts are strings at EMBER's full ledger
 * precision (18 places).
 *
 * LIMITATIONS of the existing accounting model, stated here because the API
 * must not overclaim:
 *  - `burnedSupply` sums every `BURN` ledger leg for EMBER: the leg Module
 *    11 writes when a burn record commits (same transaction as the record,
 *    so the two cannot diverge). With no burns recorded it is zero; nothing
 *    else in the vocabulary destroys EMBER.
 *  - `circulatingSupply` is `totalIssuedSupply - burnedSupply`, so each burn
 *    reduces it exactly once. Tokens locked for LP commitments remain part
 *    of circulating supply - locking moves value between the available and
 *    locked columns of one balance, it does not remove ownership.
 *  - These are application-level ledger figures, not on-chain token supply.
 */
export class EmberSupplyResponseDto {
  @ApiProperty({ description: 'Asset symbol these metrics describe.', example: 'EMBER' })
  asset!: string;

  @ApiProperty({
    description:
      'Total EMBER issuance evidenced by the ledger: DEPOSIT credits minus WITHDRAWAL debits across all wallets. Transfers and locks net to zero by construction.',
    example: '315000.000000000000000000',
  })
  totalIssuedSupply!: string;

  @ApiProperty({
    description: 'Total issued supply minus burned supply. Each burn reduces this exactly once.',
    example: '315000.000000000000000000',
  })
  circulatingSupply!: string;

  @ApiProperty({
    description:
      'Sum of locked EMBER across all wallets, including Module 09 liquidity-provider commitment locks.',
    example: '145000.000000000000000000',
  })
  lockedSupply!: string;

  @ApiProperty({
    description: 'Sum of available EMBER across all wallets. Equals circulating minus locked.',
    example: '170000.000000000000000000',
  })
  availableSupply!: string;

  @ApiProperty({
    description:
      'EMBER destroyed, summed from BURN ledger legs (one leg per Module 11 burn record, written in the same transaction). Zero while no burns are recorded.',
    example: '0.000000000000000000',
  })
  burnedSupply!: string;

  static from(figures: {
    totalIssued: Prisma.Decimal;
    circulating: Prisma.Decimal;
    locked: Prisma.Decimal;
    available: Prisma.Decimal;
    burned: Prisma.Decimal;
  }): EmberSupplyResponseDto {
    const dto = new EmberSupplyResponseDto();
    dto.asset = 'EMBER';
    dto.totalIssuedSupply = formatDecimal(figures.totalIssued, 18);
    dto.circulatingSupply = formatDecimal(figures.circulating, 18);
    dto.lockedSupply = formatDecimal(figures.locked, 18);
    dto.availableSupply = formatDecimal(figures.available, 18);
    dto.burnedSupply = formatDecimal(figures.burned, 18);
    return dto;
  }
}
