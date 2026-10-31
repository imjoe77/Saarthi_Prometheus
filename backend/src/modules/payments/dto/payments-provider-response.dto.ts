import { ApiProperty } from '@nestjs/swagger';

/**
 * MODULE 03b — which payment rail is in force, and how far a single top-up may
 * go.
 *
 * The browser needs this before the user types anything, because the two rails
 * mean different things to the person paying: a `simulated` top-up moves no
 * money outside the platform and says so, while a `razorpay` top-up opens a
 * real payment sheet. Labelling that honestly is the point of this resource.
 */
export class PaymentsProviderResponseDto {
  @ApiProperty({
    description: 'The active payment rail.',
    enum: ['simulated', 'razorpay'],
    example: 'simulated',
  })
  provider!: string;

  @ApiProperty({
    description: 'Largest single top-up accepted, in INR.',
    example: '500000',
  })
  maxDepositInr!: string;

  @ApiProperty({
    description: 'Whether a checkout must be completed before the money is credited.',
    example: false,
  })
  requiresCheckout!: boolean;
}
