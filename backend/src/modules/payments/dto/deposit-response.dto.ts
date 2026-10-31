import { ApiProperty } from '@nestjs/swagger';

import { AssetRefDto } from '../../wallet/dto/asset-ref.dto';
import { formatDecimal } from '../../wallet/decimal.util';
import type { Asset, WalletDeposit } from '@prisma/client';

/**
 * MODULE 03b — the Razorpay checkout a browser needs to open the payment sheet.
 *
 * The publishable key id is deliberately included: Razorpay's checkout script
 * is loaded in the browser and must be given the key id. The key SECRET is not
 * here and never leaves the backend.
 *
 * `amountPaise` is in paise, because that is the unit Razorpay's Orders API
 * and checkout script both use - one rupee is one hundred paise.
 */
export class DepositCheckoutDto {
  @ApiProperty({ description: 'Razorpay publishable key id.', example: 'rzp_test_1234567890' })
  keyId!: string;

  @ApiProperty({ description: 'Razorpay order id to open the checkout with.', example: 'order_QkXxxxxxxx' })
  orderId!: string;

  @ApiProperty({ description: 'Amount in paise (1 INR = 100 paise).', example: 500000 })
  amountPaise!: number;

  @ApiProperty({ description: 'ISO currency code.', example: 'INR' })
  currency!: string;

  @ApiProperty({ description: 'The deposit this checkout pays for.', example: '0f5a…' })
  depositId!: string;
}

/**
 * MODULE 03b — one wallet top-up.
 *
 * `status` is the deposit's lifecycle, not the ledger's: PENDING means the
 * payment was started but not confirmed, SUCCEEDED is the only state in which
 * the wallet holds the money, and FAILED means the payment was refused. The
 * money itself appears in the wallet's transaction history as a DEPOSIT row the
 * moment it is credited - this resource is the record of the attempt.
 */
export class DepositResponseDto {
  @ApiProperty({ description: 'Deposit id.', example: '0f5ac4e2-1f4a-4a5b-9d0e-1c2b3a4d5e6f' })
  id!: string;

  @ApiProperty({ description: 'The asset credited by this deposit.' })
  asset!: AssetRefDto;

  @ApiProperty({ description: 'Amount in the asset, at the asset display precision.', example: '5000.00' })
  amount!: string;

  @ApiProperty({
    description: 'Where the deposit is in its lifecycle.',
    enum: ['PENDING', 'SUCCEEDED', 'FAILED'],
    example: 'SUCCEEDED',
  })
  status!: string;

  @ApiProperty({ description: 'The payment rail the deposit went through.', example: 'simulated' })
  provider!: string;

  @ApiProperty({ description: 'When the deposit was created.', example: '2026-10-28T09:12:44.201Z' })
  createdAt!: string;

  @ApiProperty({
    description: 'Checkout details, present only when the deposit must still be paid.',
    type: DepositCheckoutDto,
    nullable: true,
  })
  checkout!: DepositCheckoutDto | null;

  static from(
    deposit: WalletDeposit & { asset: Asset },
    checkout: DepositCheckoutDto | null = null,
  ): DepositResponseDto {
    return {
      id: deposit.id,
      asset: AssetRefDto.from(deposit.asset),
      amount: formatDecimal(deposit.amount, deposit.asset.decimals),
      status: deposit.status,
      provider: deposit.provider,
      createdAt: deposit.createdAt.toISOString(),
      checkout,
    };
  }
}
