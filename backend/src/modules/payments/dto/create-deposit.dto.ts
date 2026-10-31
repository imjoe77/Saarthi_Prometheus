import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * MODULE 03b — the request body for POST /payments/deposits.
 *
 * `clientRequestId` makes re-submission idempotent on `(user,
 * clientRequestId)`, exactly like Module 08's USDT orders: a replayed request
 * returns the original deposit instead of crediting the wallet twice.
 *
 * `amountInr` is a STRING, never a JSON number. INR is stored as
 * NUMERIC(38,18), and a float that has already lost its precision cannot be
 * recovered here. The pattern allows at most two decimal places because that is
 * the INR asset's display scale - a rupee is not a sub-rupee instrument.
 */
export class CreateDepositDto {
  @ApiProperty({
    description: 'Client-generated UUID that makes the request idempotent.',
    example: '9c2f1a44-0f0a-4f2f-9b2c-5a6e8f1b3d77',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({
    description: 'Amount to add to the wallet, in INR.',
    example: '5000.00',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amountInr must be a positive decimal string with at most 2 decimal places',
  })
  amountInr!: string;
}
