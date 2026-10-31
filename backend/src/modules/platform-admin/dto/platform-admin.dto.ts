import { ApiProperty } from '@nestjs/swagger';
import { UserStatus, WalletStatus } from '@prisma/client';
import { IsBoolean, IsIn, IsString, MaxLength } from 'class-validator';

/**
 * Dto for one manual wallet adjustment. `note` is deliberately REQUIRED: the
 * ADJUSTMENT ledger type refuses blank notes (a manual correction without a
 * recorded reason is indistinguishable from a bug), so the contract enforces
 * the same rule at the boundary.
 */
export class WalletMovementRequestDto {
  @ApiProperty({
    description: 'Which kind of adjustment. CREDIT adds to available; DEBIT removes from available.',
    enum: ['CREDIT', 'DEBIT'],
    example: 'CREDIT',
  })
  @IsIn(['CREDIT', 'DEBIT'])
  kind!: 'CREDIT' | 'DEBIT';

  @ApiProperty({
    description: 'Asset symbol of the balance to adjust (e.g. INR, USDT, EMBER). Case-insensitive.',
    example: 'INR',
  })
  @IsString()
  @MaxLength(10)
  assetSymbol!: string;

  @ApiProperty({
    description:
      'Positive amount at the asset display precision. The value is an exact decimal string - ' +
      'more decimal places than the asset allows, zero, negatives and floats are refused.',
    example: '2500.00',
  })
  @IsString()
  @MaxLength(40)
  amount!: string;

  @ApiProperty({
    description: 'Required. Recorded on both the ledger row and the admin audit row.',
    example: 'Manual capital injection approved 2026-10-21',
  })
  @IsString()
  @MaxLength(200)
  note!: string;
}

/** Dto for a manual treasury funding credit. Same rules as a user adjustment. */
export class TreasuryFundingRequestDto {
  @ApiProperty({
    description: 'Asset symbol to fund the treasury with (e.g. EMBER, USDT, INR). Case-insensitive.',
    example: 'EMBER',
  })
  @IsString()
  @MaxLength(10)
  assetSymbol!: string;

  @ApiProperty({
    description: 'Positive amount at the asset display precision.',
    example: '100000',
  })
  @IsString()
  @MaxLength(40)
  amount!: string;

  @ApiProperty({
    description: 'Required justification, recorded on the ledger row and the audit row.',
    example: 'Hub distribution inventory top-up',
  })
  @IsString()
  @MaxLength(200)
  note!: string;
}

/** Dto for setting a user lifecycle status. */
export class UserStatusRequestDto {
  @ApiProperty({ enum: Object.values(UserStatus), example: 'SUSPENDED' })
  @IsIn(Object.values(UserStatus))
  status!: UserStatus;
}

/** Dto for freezing or unfreezing the user's wallet. */
export class WalletStatusRequestDto {
  @ApiProperty({ enum: Object.values(WalletStatus), example: 'FROZEN' })
  @IsIn(Object.values(WalletStatus))
  status!: WalletStatus;
}

/** Dto for a manual treasury debit (removing capital / retiring inventory). */
export class TreasuryWithdrawalRequestDto {
  @ApiProperty({
    description: 'Asset symbol to debit from the treasury (e.g. USDT, INR, EMBER). Case-insensitive.',
    example: 'USDT',
  })
  @IsString()
  @MaxLength(10)
  assetSymbol!: string;

  @ApiProperty({
    description: 'Positive amount at the asset display precision, refused when the balance cannot fund it.',
    example: '50000.00',
  })
  @IsString()
  @MaxLength(40)
  amount!: string;

  @ApiProperty({
    description: 'Required justification, recorded on the ledger row and the audit row.',
    example: 'Capital withdrawn on board resolution 2026-10-22',
  })
  @IsString()
  @MaxLength(200)
  note!: string;
}

/** Dto for retiring (or restoring) an asset for new activity. */
export class AssetStatusRequestDto {
  @ApiProperty({
    description: 'Pass false to retire the asset for new movements; true to restore it.',
    example: false,
  })
  @IsBoolean()
  isActive!: boolean;

  @ApiProperty({
    description: 'Required justification, recorded on the audit row.',
    example: 'Retiring the pilot token ahead of the main distribution',
  })
  @IsString()
  @MaxLength(200)
  note!: string;
}
