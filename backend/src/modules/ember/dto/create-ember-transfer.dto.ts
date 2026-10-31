import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * MODULE 10 — the request body for POST /ember/transfers.
 *
 * The recipient is named by their registered email address: email is unique on
 * `users`, so one address resolves to exactly one account and no address-book
 * or discovery surface is needed. There is no separate asset field - this
 * endpoint moves EMBER and nothing else, so a body that claimed another asset
 * could only ever be a bug.
 *
 * `clientRequestId` makes re-submission idempotent on
 * `(senderUserId, clientRequestId)`, exactly like Module 08's orders: a
 * replayed request returns the original transfer instead of moving balances a
 * second time, and reusing the key with a different payload is refused.
 */
export class CreateEmberTransferDto {
  @ApiProperty({
    description: "Recipient's registered email address.",
    example: 'friend@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  recipientEmail!: string;

  @ApiProperty({ description: 'EMBER amount to send (positive decimal string).', example: '250' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  amount!: string;

  @ApiProperty({
    description: 'Client-generated UUID to make the request idempotent.',
    example: '4b556011-9474-4e9b-a3cb-042c99e70ae8',
  })
  @IsUUID()
  clientRequestId!: string;
}
